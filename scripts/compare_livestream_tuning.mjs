// node scripts/compare_livestream_tuning.mjs [all|baseline|tuned|small] [output.json]
// Append --follow-up or --expanded and the candidate GGUF for a three-arm comparison.
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus, platform, release, totalmem } from 'node:os';
import { chromium } from '../workers/persistent-counter/node_modules/playwright/index.mjs';
import { previewServer } from './capture_screenshots.mjs';
import { LLM, MODEL_LIBRARY, SMALL_LLM, SMALL_MODEL_FILES, TUNED_ADAPTER_URL } from '../projects/ai-livestream/config.mjs';

const root = new URL('../', import.meta.url);
const fixtureDir = new URL('tests/fixtures/ai-livestream/', root);
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const [variant, output, flag, candidatePath] = process.argv.slice(2);
const compareAdapters = ['--follow-up', '--expanded'].includes(flag) && Boolean(candidatePath);
if (flag && !compareAdapters) throw Error('Expected --follow-up or --expanded and a candidate GGUF');
const modes = variant && variant !== 'all' ? [variant]
  : compareAdapters ? ['baseline', 'tuned', 'candidate'] : ['baseline', 'tuned', 'small'];
if (modes.some(model => !['baseline', 'tuned', compareAdapters ? 'candidate' : 'small'].includes(model)))
  throw Error('Unknown model');
const oldAdapter = new URL('projects/ai-livestream/models/resolve/e3866302664199c2/livestream.gguf', root);
const adapters = compareAdapters ? {
  tuned: await readFile(oldAdapter),
  candidate: await readFile(candidatePath),
} : {};
const holdoutPath = flag === '--expanded' ? 'expanded-holdout.json'
  : compareAdapters ? 'follow-up-holdout.json' : 'tuning-holdout.json';
const [originalSpeech, confirmationSpeech, heldOutBytes] = await Promise.all([
  readJSON(new URL('topics.json', fixtureDir)),
  readJSON(new URL('tuning-audio.json', fixtureDir)),
  readFile(new URL(holdoutPath, fixtureDir)),
]);
const speech = [...originalSpeech, ...confirmationSpeech];
const heldOut = JSON.parse(heldOutBytes);
const server = await previewServer(root.pathname);
const report = {
  date: new Date().toISOString(),
  host: { cpu: cpus()[0].model, memoryGiB: totalmem() / 2**30, platform: platform(), release: release() },
  generationSeed: 42,
  ...(compareAdapters ? { holdout: holdoutPath, transcriptFirst: true } : {}),
  holdoutSha256: sha256(heldOutBytes),
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
    const adapterPath = new URL(TUNED_ADAPTER_URL).pathname.slice(root.pathname.length);
    const adapterURL = `${server.origin}/sandbox/${adapterPath}`;
    const adapter = adapters[mode];
    // Serve the comparison bytes at the exact URL the production engine requests.
    // Keep the production allowlist and loading path identical for both adapters.
    if (adapter) await page.route(adapterURL, route => route.fulfill({
      status: 200, contentType: 'application/octet-stream', body: adapter,
    }));
    const requests = [];
    page.on('request', request => {
      requests.push({ url: request.url(), method: request.method(), body: request.postData(),
        redirectedFrom: request.redirectedFrom()?.url() });
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
      }, mode === 'candidate' ? 'tuned' : mode);
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
    const audio = [], text = [];
    const runAudio = async () => {
      for (const [index, fixture] of speech.entries()) {
        const result = await feed(await samples(fixture.file), fixture.language, index * 120000);
        audio.push({ file: fixture.file, language: fixture.language, expected: fixture.text,
          ...(fixture.confirmation ? { confirmation: true } : {}), ...result });
      }
    };
    if (!compareAdapters) await runAudio();
    const voiced = Array(96000).fill(0.02);
    for (const [index, fixture] of heldOut.entries()) {
      const turns = [];
      for (const [turn, transcript] of fixture.turns.entries()) {
        const now = (index + (compareAdapters ? 0 : speech.length)) * 120000 + turn * 12000;
        turns.push(await feed(transcript === null ? null : voiced, fixture.language, now, transcript));
      }
      text.push({ id: fixture.id, turns });
    }
    const cameraDuringJobs = await frames();
    console.log(`${mode}: warm load`);
    const warm = await load();
    const cameraDuringWarm = await frames();
    if (compareAdapters) await runAudio();
    const cameraDuringAudio = compareAdapters ? await frames() : undefined;
    const baseline = mode === 'baseline';
    const selected = baseline ? LLM : SMALL_LLM;
    const assets = {
      asr: Object.values(cold.assets).reduce((total, size) => total + size, 0),
    };
    if (baseline) {
      const modelURL = `https://huggingface.co/${selected.id}/resolve/${selected.revision}/`;
      const manifestText = await (await fetch(modelURL + 'tensor-cache.json')).text();
      const manifest = JSON.parse(manifestText);
      Object.assign(assets, {
        textShards: manifest.records.reduce((total, shard) => total + shard.nbytes, 0),
        textTokenizer: 11422654,
        modelLibrary: 5566554,
        textConfig: (await (await fetch(modelURL + 'mlc-chat-config.json')).arrayBuffer()).byteLength,
        textManifest: Buffer.byteLength(manifestText),
      });
    } else {
      assets.textShards = 325085216 + 314362336; // Both pinned GGUF shards include model metadata.
      if (mode !== 'small')
        assets.textAdapter = (adapter ?? await readFile(new URL(TUNED_ADAPTER_URL))).byteLength;
    }
    for (const request of requests) {
      const url = new URL(request.url);
      const shardHead = request.method === 'HEAD' && (SMALL_MODEL_FILES.includes(url.href) ||
        (url.hostname.endsWith('.hf.co') && SMALL_MODEL_FILES.includes(request.redirectedFrom)));
      if ((request.method !== 'GET' && !shardHead) || request.body !== null ||
          !(url.origin === server.origin || url.href === MODEL_LIBRARY ||
            url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'huggingface.co' || url.hostname.endsWith('.hf.co')))
        throw Error('Unexpected browser traffic ' + request.method + ' ' + url.origin);
    }
    const adapterRequests = requests.filter(({ url }) => url === adapterURL).length;
    if (adapterRequests !== (assets.textAdapter ? 2 : 0))
      throw Error('Unexpected trained adapter requests');
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
      ...(assets.textAdapter ? {
        overlay: adapter ? sha256(adapter).slice(0, 16) : adapterPath.split('/').at(-2),
        adapter: adapterPath.split('/').at(-1),
        ...(adapter ? { adapterSha256: sha256(adapter) } : {}),
      } : {}),
      assetBytes: [...Object.values(assets), ...Object.values(runtimeAssets)].reduce((total, size) => total + size, 0),
      runtimeAssets,
      coldLoadMs: cold.loadMs, warmLoadMs: warm.loadMs, peakBrowserRssMiB: peakKiB / 1024,
      cameraIdle, cameraDuringCold, cameraDuringJobs, cameraDuringWarm, cameraDuringAudio, audio, text };
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
