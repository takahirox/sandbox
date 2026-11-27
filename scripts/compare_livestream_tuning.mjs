// Run explicitly: node scripts/compare_livestream_tuning.mjs [all|baseline|tuned|small] [output.json]
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus, platform, totalmem } from 'node:os';
import { chromium } from '../workers/persistent-counter/node_modules/playwright/index.mjs';
import { previewServer } from './capture_screenshots.mjs';
import { LLM, MODEL_LIBRARY, SMALL_LLM, SMALL_MODEL_LIBRARY, TUNED_MODEL_URL } from '../projects/ai-livestream/config.mjs';

const root = new URL('../', import.meta.url);
const fixtureDir = new URL('tests/fixtures/ai-livestream/', root);
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const [speech, heldOutBytes] = await Promise.all([
  readJSON(new URL('topics.json', fixtureDir)),
  readFile(new URL('tuning-holdout.json', fixtureDir)),
]);
const heldOut = JSON.parse(heldOutBytes);
const [variant, output] = process.argv.slice(2);
const modes = variant && variant !== 'all' ? [variant] : ['baseline', 'tuned', 'small'];
if (modes.some(model => !['baseline', 'tuned', 'small'].includes(model))) throw Error('Unknown model');
const server = await previewServer(root.pathname);
const report = {
  date: new Date().toISOString(),
  host: { cpu: cpus()[0].model, memoryGiB: totalmem() / 2**30, platform: platform() },
  generationSeed: 42,
  holdoutSha256: createHash('sha256').update(heldOutBytes).digest('hex'),
  modes: [],
};
const runtimeSizes = new Map();

async function samples(file) {
  const wav = await readFile(new URL(file, fixtureDir));
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.toString('ascii', offset, offset + 4) === 'data') {
      return Array.from({ length: Math.min(96000, size / 2) },
        (_, i) => wav.readInt16LE(offset + 8 + 2 * i) / 32768);
    }
    offset += 8 + size + (size % 2);
  }
  throw Error('Missing PCM data');
}

async function run(mode) {
  const browser = await chromium.launch({
    args: ['--enable-unsafe-webgpu', '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])],
  });
  const cdp = await browser.newBrowserCDPSession();
  let peakKiB = 0, sampling = false;
  const timer = setInterval(async () => {
    if (sampling) return;
    sampling = true;
    try {
      const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
      const rows = execFileSync('ps', ['-o', 'rss=', '-p', processInfo.map(x => x.id).join(',')], {
        encoding: 'utf8',
      });
      peakKiB = Math.max(peakKiB, rows.trim().split(/\s+/).reduce((sum, row) => sum + Number(row), 0));
    } catch {} finally { sampling = false; }
  }, 1000);
  try {
    const page = await browser.newPage({ permissions: ['camera'] });
    const requests = [];
    page.on('request', request => {
      requests.push({ url: request.url(), method: request.method(), body: request.postData() });
    });
    await page.goto(server.origin + '/sandbox/projects/ai-livestream/');
    const gpu = await page.evaluate(async () => {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter?.features.has('shader-f16')) throw Error('The benchmark needs WebGPU shader-f16');
      const video = document.getElementById('camera');
      video.srcObject = await navigator.mediaDevices.getUserMedia({ video: true });
      await video.play();
      document.getElementById('player').classList.add('has-camera');
      window.benchmark = { results: [], frames: [] };
      const frame = now => {
        benchmark.frames.push(now);
        video.requestVideoFrameCallback(frame);
      };
      video.requestVideoFrameCallback(frame);
      return { vendor: adapter.info.vendor, architecture: adapter.info.architecture };
    });
    const load = async () => {
      await page.evaluate(model => {
        benchmark.frames.length = 0;
        benchmark.worker?.terminate();
        benchmark.status = null;
        benchmark.worker = new Worker(
          '/sandbox/tests/fixtures/ai-livestream/tuning-worker.mjs', { type: 'module' },
        );
        benchmark.worker.onmessage = ({ data }) => {
          if (data.type !== 'result') {
            benchmark.status = data;
            return;
          }
          if (data.comment) {
            const comment = document.createElement('div');
            comment.textContent = data.comment;
            document.getElementById('messages').append(comment);
          }
          benchmark.results.push({ ...data, jobMs: performance.now() - benchmark.jobStarted });
        };
        benchmark.worker.postMessage({ type: 'init', model });
      }, mode);
      await page.waitForFunction(() => benchmark.status, null, { timeout: 300000 });
      const result = await page.evaluate(() => benchmark.status);
      if (result.type === 'error') throw Error(result.message);
      return result;
    };
    const frames = () => page.evaluate(() => {
      const times = benchmark.frames.splice(0);
      const gaps = times.slice(1).map((time, index) => time - times[index]).sort((a, b) => a - b);
      return {
        frameCallbacks: times.length,
        p95GapMs: gaps[Math.floor(gaps.length * 0.95)] ?? null,
        maxGapMs: gaps.at(-1) ?? null,
      };
    });
    const feed = async (audio, language, now, transcript) => {
      const count = await page.evaluate(({ audio, language, now, transcript }) => {
        const copy = new Float32Array(audio ?? 96000);
        const count = benchmark.results.length + 1;
        benchmark.jobStarted = performance.now();
        benchmark.worker.postMessage({
          type: 'audio', audio: copy, language, now, transcript,
        }, [copy.buffer]);
        return count;
      }, { audio, language, now, transcript });
      await page.waitForFunction(n => benchmark.results.length === n || benchmark.status.type === 'error',
        count, { timeout: 90000 });
      const status = await page.evaluate(() => benchmark.status);
      if (status.type === 'error') throw Error(status.message);
      return page.evaluate(() => benchmark.results.at(-1));
    };

    console.log(`${mode}: cold load`);
    const cold = await load();
    const cameraDuringCold = await frames();
    const cameraIdle = await (async () => {
      await page.waitForTimeout(2000);
      return frames();
    })();
    const audio = [];
    const text = [];
    for (const [index, fixture] of speech.entries()) {
      const result = await feed(await samples(fixture.file), fixture.language, index * 120000);
      audio.push({ file: fixture.file, language: fixture.language, expected: fixture.text, ...result });
    }
    const voiced = Array(96000).fill(0.02);
    for (const [index, fixture] of heldOut.entries()) {
      const turns = [];
      for (const [turn, transcript] of fixture.turns.entries()) {
        const now = (index + speech.length) * 120000 + turn * 12000;
        turns.push(await feed(transcript === null ? null : voiced, fixture.language, now, transcript));
      }
      text.push({ id: fixture.id, turns });
    }
    const cameraDuringJobs = await frames();
    console.log(`${mode}: warm load`);
    const warm = await load();
    const cameraDuringWarm = await frames();
    const selected = mode === 'baseline' ? LLM : SMALL_LLM;
    const modelURL = `https://huggingface.co/${selected.id}/resolve/${selected.revision}/`;
    const baseManifestText = await (await fetch(modelURL + 'tensor-cache.json')).text();
    const baseManifest = JSON.parse(baseManifestText);
    const overlayManifest = mode === 'tuned'
      ? (await readFile(new URL('tensor-cache.json', TUNED_MODEL_URL))).byteLength : 0;
    const assets = {
      asr: Object.values(cold.assets).reduce((total, size) => total + size, 0),
      textShards: baseManifest.records.reduce((total, shard) => total + shard.nbytes, 0),
      textOverlay: mode === 'tuned' ? (await readFile(new URL('norms.bin', TUNED_MODEL_URL))).byteLength : 0,
      textTokenizer: 11422654,
      modelLibrary: mode === 'baseline' ? 5566554 : 5535989,
      textConfig: (await (await fetch(modelURL + 'mlc-chat-config.json')).arrayBuffer()).byteLength,
      textManifest: overlayManifest || Buffer.byteLength(baseManifestText),
    };
    // Requests from the harness are restricted to fixtures, static site files and public assets.
    for (const request of requests) {
      const url = new URL(request.url);
      if (request.method !== 'GET' || request.body !== null ||
          !(url.origin === server.origin || url.href === (mode === 'baseline' ? MODEL_LIBRARY : SMALL_MODEL_LIBRARY) ||
            url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'huggingface.co' || url.hostname.endsWith('.hf.co')))
        throw Error('Unexpected browser traffic');
    }
    const overlay = new URL(TUNED_MODEL_URL).pathname.split('/').at(-2);
    const overlayFiles = await page.evaluate(async version => {
      const cache = await caches.open('webllm/model');
      const files = [];
      for (const name of ['norms.bin', 'tensor-cache.json']) {
        if (await cache.match(new URL('models/resolve/' + version + '/' + name, location.href)))
          files.push(name);
      }
      return files;
    }, overlay);
    if (overlayFiles.length !== (mode === 'tuned' ? 2 : 0))
      throw Error('Unexpected trained artifact requests');
    const runtimeURLs = new Set(requests.filter(request =>
      request.url.startsWith('https://cdn.jsdelivr.net/npm/')).map(request => request.url));
    const runtimeAssets = Object.fromEntries(await Promise.all([...runtimeURLs].map(async url => {
      if (!runtimeSizes.has(url)) {
        const response = await fetch(url);
        if (!response.ok) throw Error('Could not size runtime asset ' + url);
        runtimeSizes.set(url, (await response.arrayBuffer()).byteLength);
      }
      return [url.split('/').at(-1), runtimeSizes.get(url)];
    })));
    return { mode, browser: browser.version(), gpu, assets,
      baseRevision: selected.revision,
      ...(mode === 'tuned' ? { overlay, overlayFiles } : {}),
      assetBytes: Object.values(assets).reduce((total, size) => total + size, 0),
      runtimeAssets,
      coldLoadMs: cold.loadMs, warmLoadMs: warm.loadMs, peakBrowserRssMiB: peakKiB / 1024,
      cameraIdle, cameraDuringCold, cameraDuringJobs, cameraDuringWarm, audio, text };
  } finally {
    clearInterval(timer);
    await browser.close();
  }
}

try {
  for (const mode of modes) {
    report.modes.push(await run(mode));
    if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
  if (!output) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally {
  await server.close();
}
