import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '../workers/persistent-counter/node_modules/playwright/index.mjs';
import { MODEL_LIBRARY, sharesTopic } from '../projects/ai-livestream/config.mjs';
import { previewServer } from '../scripts/capture_screenshots.mjs';

// Explicit opt-in: downloads ~1.1 GB; no credentials, camera, mic or remote inference.
test(
  'real browser-local Japanese/English speech → relevant generated chat',
  { skip: process.env.LOCAL_AI_SMOKE !== '1', timeout: 420000 },
  async (t) => {
    const server = await previewServer(new URL('..', import.meta.url).pathname);
    t.after(() => server.close());
    const browser = await chromium.launch({
      args: [
        '--enable-unsafe-webgpu',
        ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
      ],
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const traffic = [];
    page.on('request', (request) =>
      traffic.push({
        url: request.url(),
        method: request.method(),
        body: request.postData(),
      }),
    );
    page.on('console', (message) => {
      if (message.type() === 'log') console.log(message.text());
    });
    await page.goto(server.origin + '/sandbox/projects/ai-livestream/');
    assert.equal(
      await page.evaluate(async () =>
        (await navigator.gpu?.requestAdapter())?.features.has('shader-f16'),
      ),
      true,
      'Smoke host needs WebGPU with shader-f16',
    );
    await page.evaluate(() => {
      window.smoke = { results: [], error: '' };
      smoke.worker = new Worker(
        '/sandbox/tests/fixtures/ai-livestream/smoke-worker.mjs',
        { type: 'module' },
      );
      smoke.worker.onmessage = ({ data }) => {
        if (data.type === 'ready') smoke.ready = true;
        if (data.type === 'error') smoke.error = data.message;
        if (data.type === 'progress')
          console.log(`Loading ${data.stage}: ${data.file}`);
        if (data.type === 'result') smoke.results.push(data);
      };
      smoke.worker.postMessage({ type: 'init' });
    });
    await page.waitForFunction(() => smoke.ready || smoke.error, null, {
      timeout: 300000,
    });
    assert.equal(await page.evaluate(() => smoke.error), '');
    for (const [index, language, filename, topic] of [
      [0, 'ja', 'japanese.wav', /猫|公園/],
      [1, 'en', 'english.wav', /coffee/i],
    ]) {
      const bytes = await readFile(
        new URL('./fixtures/ai-livestream/' + filename, import.meta.url),
      );
      // Parse the RIFF data chunk rather than assuming a fixed WAV header size.
      let offset = 12,
        pcm;
      while (offset + 8 <= bytes.length) {
        const length = bytes.readUInt32LE(offset + 4);
        if (bytes.toString('ascii', offset, offset + 4) === 'data') {
          pcm = bytes.subarray(offset + 8, offset + 8 + length);
          break;
        }
        offset += 8 + length + (length % 2);
      }
      assert.ok(pcm);
      const audio = Array.from(
        { length: Math.min(96000, pcm.length / 2) },
        (_, i) => pcm.readInt16LE(i * 2) / 32768,
      );
      await page.evaluate(
        ({ audio, language, now }) => {
          const samples = new Float32Array(audio);
          smoke.worker.postMessage(
            { type: 'audio', audio: samples, language, now },
            [samples.buffer],
          );
        },
        { audio, language, now: index * 120000 },
      );
      await page.waitForFunction(
        (count) => smoke.results.length === count || smoke.error,
        index + 1,
        { timeout: 90000 },
      );
      assert.equal(await page.evaluate(() => smoke.error), '');
      const result = await page.evaluate(
        (index) => smoke.results[index],
        index,
      );
      console.log(
        `${language}: ${JSON.stringify({ transcript: result.transcript, comment: result.comment })}`,
      );
      assert.match(result.transcript, topic);
      assert.ok(result.comment.length > 0 && result.comment.length <= 110);
      assert.equal(sharesTopic(result.comment, result.transcript, language), true, 'Generated comment reacts to fixture topic');
    }
    await page.evaluate(() => smoke.worker.terminate());
    for (const request of traffic) {
      assert.equal(request.method, 'GET');
      assert.equal(request.body, null);
      const url = new URL(request.url);
      assert.ok(
        url.origin === server.origin ||
          ['cdn.jsdelivr.net', 'huggingface.co'].includes(url.hostname) ||
          url.hostname.endsWith('.hf.co') || request.url === MODEL_LIBRARY,
        `Static asset origin: ${url.origin}`,
      );
      assert.ok(
        !url.hostname.startsWith('api-inference.'),
        'No remote inference endpoint',
      );
      if (url.pathname.startsWith('/api/'))
        assert.match(
          url.pathname,
          /^\/api\/resolve-cache\/models\/(Xenova\/whisper-base|mlc-ai\/Qwen3-1\.7B-q4f16_1-MLC)\/[a-f0-9]{40}\//,
          'Only static asset metadata redirects',
        );
    }
  },
);
