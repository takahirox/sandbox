import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { chromium } from '../workers/persistent-counter/node_modules/playwright/index.mjs';
import { previewServer } from '../scripts/capture_screenshots.mjs';
import {
  ASR,
  LLM,
  RUNTIME,
  WASM,
  isAssetRequest,
  cleanComment,
  sharesTopic,
  messagesFor,
  meaningfulSpeech,
  WINDOW_SAMPLES,
} from '../projects/ai-livestream/config.mjs';
import { createInference } from '../projects/ai-livestream/inference.mjs';

test('local inference uses Japanese/English ASR, actual generator context, silence gating and cadence', async () => {
  const calls = [];
  let speech = '今日は公園で猫を見ました。';
  let answer = '公園の猫、かわいいね！';
  const pipeline = async (task, model, options) => {
    assert.match(options.revision, /^[a-f0-9]{40}$/);
    if (task === 'automatic-speech-recognition') {
      assert.equal(options.device, 'wasm');
      assert.equal(options.dtype, 'q8');
      return async (audio, options) => {
        calls.push({ task, options });
        return { text: speech };
      };
    }
    assert.equal(options.device, 'webgpu');
    assert.equal(options.dtype, 'q4f16');
    const generate = async (messages, options) => {
      calls.push({ task, messages, options });
      return [{ generated_text: answer }];
    };
    generate.tokenizer = {
      apply_chat_template: (messages, options) => {
        assert.equal(options.enable_thinking, false);
        return messages;
      },
    };
    return generate;
  };
  const env = { backends: { onnx: { wasm: {} } } };
  const infer = await createInference(pipeline, env, () => {});
  const audio = new Float32Array(WINDOW_SAMPLES).fill(0.1);
  assert.deepEqual(await infer(new Float32Array(WINDOW_SAMPLES), 'ja', 0), {
    comment: '',
  });
  assert.equal(calls.length, 0, 'Silence never reaches either model');
  assert.equal((await infer(audio, 'ja', 0)).comment, answer.normalize('NFKC'));
  assert.equal(calls[0].options.language, 'japanese');
  assert.ok(calls[1].messages.at(-1).content.includes(speech));
  assert.equal(calls[1].options.max_new_tokens, 64);
  speech = '今日はコーヒーも飲みました。';
  assert.equal((await infer(audio, 'ja', 6000)).comment, '');
  assert.equal(
    calls.filter((c) => c.task === 'text-generation').length,
    1,
    'No flood',
  );
  speech = 'I made fresh coffee today.';
  answer = 'Fresh coffee smells so good!';
  assert.equal((await infer(audio, 'en', 12000)).comment, answer);
  assert.equal(calls.at(-2).options.language, 'english');
  assert.equal(
    (await infer(audio, 'en', 24000)).comment,
    '',
    'No repeated transcript generation',
  );
  speech = 'I am eating oranges today.';
  answer = 'Tomatoes are lovely!';
  assert.equal(
    (await infer(audio, 'en', 36000)).comment,
    '',
    'Off-topic model output is suppressed without a canned substitute',
  );
  assert.equal(env.backends.onnx.wasm.numThreads, 1);
  assert.equal(env.allowLocalModels, false);
});

test('comment safety, bounded prompts, and hallucinated caption filtering', () => {
  assert.equal(
    sharesTopic('猫かわいいね！', '猫と公園で遊びました。', 'ja'),
    true,
  );
  assert.equal(
    sharesTopic('朝ごはんのパン！', '猫と公園で遊びました。', 'ja'),
    false,
  );
  assert.equal(
    sharesTopic('Fresh coffee smells good!', 'I made coffee.', 'en'),
    true,
  );
  assert.equal(
    sharesTopic('That is really nice!', 'I made coffee.', 'en'),
    false,
  );
  assert.equal(cleanComment('Nice coffee!', ['Nice coffee']), '');
  for (const value of [
    'SKIP',
    'You are ugly',
    '死ね',
    'https://evil.example',
    'Hi\nSecond reply',
    'x'.repeat(111),
  ])
    assert.equal(cleanComment(value), '');
  assert.equal(cleanComment('<b>猫かわいい！</b>'), '猫かわいい!');
  assert.equal(meaningfulSpeech('ご視聴ありがとうございました。'), false);
  assert.equal(meaningfulSpeech('   '), false);
  assert.equal(meaningfulSpeech('今日は猫と遊びました'), true);
  assert.ok(messagesFor('a'.repeat(10000), 'ja').at(-1).content.length < 500);
});

test('Worker fetch policy allows only pinned public assets and rejects inference or writes', () => {
  for (const model of [ASR, LLM])
    assert.equal(
      isAssetRequest(
        new URL(
          `https://huggingface.co/${model.id}/resolve/${model.revision}/config.json`,
        ),
      ),
      true,
    );
  for (const path of [
    RUNTIME,
    WASM + 'ort-wasm-simd-threaded.jsep.wasm',
    'https://cas-bridge.xethub.hf.co/public-asset',
  ])
    assert.equal(isAssetRequest(new URL(path)), true);
  for (const path of [
    'https://api-inference.huggingface.co/models/example',
    'https://huggingface.co/api/models/example',
    `https://huggingface.co/${ASR.id}/resolve/main/config.json`,
    'https://example.com/upload',
    'https://cdn.jsdelivr.net/npm/unpinned/file.js',
  ])
    assert.equal(isAssetRequest(new URL(path)), false);
  assert.equal(isAssetRequest(new URL(RUNTIME), 'POST'), false);
});

test('audio worklet bounds, downsampling, voice gating, and transfer', async () => {
  const source = await readFile(
    new URL('../projects/ai-livestream/audio-worklet.js', import.meta.url),
    'utf8',
  );
  for (const rate of [16000, 48000]) {
    let Processor;
    const sent = [];
    const sandbox = {
      sampleRate: rate,
      Float32Array,
      AudioWorkletProcessor: class {
        constructor() {
          this.port = {
            postMessage: (audio, transfer) => sent.push({ audio, transfer }),
          };
        }
      },
      registerProcessor: (_, ctor) => {
        Processor = ctor;
      },
    };
    vm.runInNewContext(source, sandbox);
    const processor = new Processor();
    for (let i = 0; i < (rate * 12) / 128; i++)
      processor.process([[new Float32Array(128)]]);
    assert.equal(sent.length, 0, 'No speech from silent microphone');
    for (let i = 0; i < (rate * 12) / 128; i++)
      processor.process([[new Float32Array(128).fill(0.1)]]);
    assert.equal(sent.length, 1, 'At most one audio message waits for the UI');
    processor.port.onmessage({ data: 'ack' });
    for (let i = 0; i < (rate * 6) / 128; i++)
      processor.process([[new Float32Array(128).fill(0.1)]]);
    assert.equal(sent.length, 2, 'Acknowledgement permits the next window');
    for (const { audio, transfer } of sent) {
      assert.equal(audio.length, WINDOW_SAMPLES);
      assert.equal(transfer[0], audio.buffer);
    }
    assert.ok(processor.position < WINDOW_SAMPLES);
  }
});

test(
  'browser lifecycle, privacy, layout and failure recovery with fake media only',
  { timeout: 90000 },
  async (t) => {
    const server = await previewServer(new URL('..', import.meta.url).pathname);
    t.after(() => server.close());
    const browser = await chromium.launch({
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    });
    t.after(() => browser.close());
    const context = await browser.newContext({
      permissions: ['camera', 'microphone'],
      reducedMotion: 'reduce',
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = [],
      requests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) =>
      requests.push({ url: request.url(), method: request.method() }),
    );
    await page.addInitScript(() => {
      window.fixture = {
        streams: [],
        workers: [],
        mode: '',
        sources: [],
        contexts: [],
      };
      Object.defineProperty(navigator, 'gpu', {
        configurable: true,
        value: {
          requestAdapter: async () => ({ features: new Set(['shader-f16']) }),
        },
      });
      const getMedia = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (options) => {
        fixture.requested = options;
        if (fixture.mode === 'denied')
          throw new DOMException('', 'NotAllowedError');
        if (fixture.mode === 'missing')
          throw new DOMException('', 'NotFoundError');
        if (fixture.mode === 'delayed')
          await new Promise((resolve) => {
            fixture.allowMedia = resolve;
          });
        const stream = await getMedia(options);
        fixture.streams.push(stream);
        return stream;
      };
      window.Worker = class {
        constructor() {
          fixture.workers.push(this);
        }
        postMessage(data) {
          if (data.type === 'init') {
            if (fixture.mode === 'loading') {
              this.onmessage({ data: { type: 'progress', stage: 'Chat', progress: 35 } });
              fixture.finishLoading = () => this.onmessage({ data: { type: 'ready' } });
            } else {
              setTimeout(
                () => this.onmessage?.({
                  data: fixture.mode === 'download'
                    ? { type: 'error', code: 'load' }
                    : { type: 'ready' },
                }),
                20,
              );
            }
          } else {
            fixture.audio = data;
            fixture.jobs = (fixture.jobs || 0) + 1;
          }
        }
        terminate() {
          this.terminated = true;
        }
      };
      window.AudioContext = class {
        constructor() {
          this.sampleRate = 16000;
          this.audioWorklet = { addModule: async () => {} };
          fixture.contexts.push(this);
        }
        async resume() {}
        async close() {
          this.closed = true;
        }
        createGain() {
          return { gain: {}, connect() {}, disconnect() {} };
        }
        createMediaStreamSource() {
          const source = {
            connect() {},
            disconnect() {
              this.disconnected = true;
            },
          };
          fixture.sources.push(source);
          return source;
        }
      };
      window.AudioWorkletNode = class {
        constructor() {
          this.port = { postMessage() {}, close() {} };
          fixture.node = this;
        }
        connect() {}
        disconnect() {
          this.disconnected = true;
        }
      };
    });
    const assertMinimalUI = async () => {
      const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      for (const phrase of [
        'little stage', 'Just for you', 'Make yourself at home.',
        'AI · simulated', 'THE EVERYDAY SESSIONS', 'A moment, live from my corner',
        'A little company.', 'Your AI chat joins when you go live.',
        'Fictional voices. Your real moment.', 'A little space to be yourself.',
        'YOUR STAGE', 'Local livestream simulation', 'ONLY ON YOUR DEVICE',
        'OFF AIR', 'GETTING READY', 'You’re live. Take your time.',
        'Say something. We’re listening.',
      ]) assert.ok(!text.toLowerCase().includes(phrase.toLowerCase()), phrase);
      assert.doesNotMatch(text, /\b(?:AI|simulated|fictional|viewers?|audience)\b/i);
      assert.equal(await page.locator('.chat-heading').innerText(), 'Live chat');
      assert.equal(await page.locator('#debug').isVisible(), false);
    };
    const assertStoppedUI = async () => {
      assert.equal(await page.locator('#session-label').isVisible(), false);
      assert.equal(await page.locator('video').isVisible(), false);
      assert.equal(await page.locator('#language').isEnabled(), true);
      assert.equal(await page.locator('#start').innerText(), '● Go live');
      assert.equal(await page.locator('.chat').innerText(), 'Live chat');
      await assertMinimalUI();
    };
    const url = server.origin + '/sandbox/projects/ai-livestream/';
    await page.goto(url);
    await page.waitForTimeout(150);
    assert.equal(
      await page.evaluate(
        () => fixture.streams.length + fixture.workers.length,
      ),
      0,
      'Preview never requests media or initializes models',
    );
    assert.ok(
      requests.every(
        (r) => r.url.startsWith(server.origin) && r.method === 'GET',
      ),
    );
    assert.equal(await page.evaluate(() => fixture.requested), undefined);
    await assertStoppedUI();
    assert.equal(await page.locator('details').count(), 1);
    assert.equal(await page.locator('#status').innerText(), '');
    assert.equal(await page.locator('.player').innerText(), '');
    assert.deepEqual(await page.locator('h1, h2').allInnerTexts(), ['Your corner', 'Live chat']);
    assert.equal(
      (await page.locator('body').innerText()).replace('Spoken language', '').replace(/\s+/g, ' ').trim(),
      '← Sandbox About Y Your corner ♡ Like Subscribe 日本語 English ● Go live Live chat',
      'Default UI contains only navigation, identity and controls',
    );
    const about = page.locator('summary');
    await about.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.about-content').isVisible(), true);
    assert.match(await page.locator('.about-content').innerText(), /AI-generated fictional voices/);
    assert.match(await page.locator('.about-content').innerText(), /no broadcast or connected audience/);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.about-content').isVisible(), false);
    await page.getByRole('button', { name: 'Like (local demo only)' }).click();
    await page
      .getByRole('button', { name: 'Subscribe (local demo only)' })
      .click();
    assert.equal(
      await page.locator('#like').getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(
      await page.locator('#subscribe').getAttribute('aria-pressed'),
      'true',
    );
    for (const width of [1600, 1280, 1024, 900, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const player = await page.locator('.player').boundingBox(),
        chat = await page.locator('.chat').boundingBox();
      await assertMinimalUI();
      assert.ok(Math.abs(player.width / player.height - 16 / 9) < 0.02);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        `No horizontal overflow at ${width}`,
      );
      for (const control of await page.locator('.controls button, select').all()) {
        const box = await control.boundingBox();
        assert.ok(box.height >= 44 && box.width >= 44, 'Touch targets remain usable');
        assert.ok(box.x >= 0 && box.x + box.width <= width, 'Controls fit the viewport');
        assert.ok(box.y >= player.y + player.height, 'Controls stay below the player');
      }
      assert.ok(
        width > 900
          ? chat.x > player.x + player.width
          : chat.y > player.y + player.height,
      );
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#like').tap();
    assert.equal(await page.locator('#like').getAttribute('aria-pressed'), 'false');
    await page.locator('#subscribe').tap();
    assert.equal(await page.locator('#subscribe').getAttribute('aria-pressed'), 'false');
    await page.setViewportSize({ width: 1280, height: 720 });
    const player = await page.locator('.player').boundingBox();
    const chat = await page.locator('.chat').boundingBox();
    assert.ok(player.width > chat.width * 3, 'Video dominates desktop composition');
    assert.ok(player.y < 80, 'Discreet navigation leaves space for video');
    await page.locator('#language').selectOption('en');
    await page.evaluate(() => { fixture.mode = 'loading'; });
    await page.locator('#language').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#start').evaluate(el => document.activeElement === el), true);
    assert.equal(await page.locator('#start').evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
    assert.equal(await page.locator('#start').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Loading chat 35%…');
    assert.equal(await page.locator('#session-label').innerText(), 'Camera & mic on');
    assert.equal(await page.locator('#session-label').isVisible(), true);
    assert.equal(await page.locator('#language').isDisabled(), true);
    assert.equal(await page.locator('#start').innerText(), 'End');
    assert.equal(await page.locator('.chat').innerText(), 'Live chat');
    await assertMinimalUI();
    await page.evaluate(() => { fixture.finishLoading(); fixture.mode = ''; });
    await page.waitForFunction(
      () =>
        document.getElementById('status').textContent === '' &&
        !document.getElementById('session-label').hidden,
    );
    await assertMinimalUI();
    assert.equal(await page.locator('#session-label').isVisible(), true);
    assert.equal(await page.locator('#status').innerText(), '');
    assert.equal(
      await page.locator('.comment').count(),
      0,
      'No fabricated chat before speech',
    );
    assert.equal(await page.locator('video').evaluate((v) => v.muted), true);
    assert.equal(
      await page.evaluate(() => fixture.requested.audio.channelCount),
      1,
    );
    await page.evaluate(() => {
      fixture.node.port.onmessage({ data: new Float32Array(96000).fill(0.1) });
      fixture.node.port.onmessage({ data: new Float32Array(96000).fill(0.1) });
    });
    assert.equal(await page.evaluate(() => fixture.audio.type), 'audio');
    assert.equal(await page.evaluate(() => fixture.audio.language), 'en');
    assert.equal(
      await page.evaluate(() => fixture.jobs),
      1,
      'Busy Worker never accumulates queued audio',
    );
    for (let i = 0; i < 65; i++)
      await page.evaluate(
        (i) =>
          fixture.workers[0].onmessage({
            data: { type: 'result', comment: '猫の話、いいね ' + i },
          }),
        i,
      );
    assert.equal(await page.locator('.comment').count(), 60);
    assert.equal(await page.locator('.comment').first().evaluate(el => getComputedStyle(el).animationName), 'none');
    await assertMinimalUI();
    await page.locator('#start').click();
    assert.equal(
      await page.evaluate(() =>
        fixture.streams.every((s) =>
          s.getTracks().every((t) => t.readyState === 'ended'),
        ),
      ),
      true,
    );
    assert.equal(
      await page.evaluate(
        () =>
          fixture.workers.every((w) => w.terminated) &&
          fixture.contexts.every((c) => c.closed),
      ),
      true,
    );
    assert.equal(await page.locator('.comment').count(), 0);
    assert.equal(
      await page.locator('video').evaluate((v) => v.srcObject),
      null,
    );
    await page.evaluate(() =>
      fixture.workers[0].onmessage({
        data: { type: 'result', comment: 'Late result' },
      }),
    );
    assert.equal(
      await page.locator('.comment').count(),
      0,
      'Late inference results after End are ignored',
    );
    await assertStoppedUI();
    assert.equal(await page.locator('#status').innerText(), 'Camera & mic off.');
    // End remains available during model loading and releases capture immediately.
    await page.evaluate(() => { fixture.mode = 'loading'; });
    await page.locator('#start').click();
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Loading chat 35%…');
    await page.locator('#start').click();
    await assertStoppedUI();
    assert.equal(await page.evaluate(() =>
      fixture.streams.at(-1).getTracks().every(track => track.readyState === 'ended') &&
      fixture.workers.at(-1).terminated && fixture.contexts.at(-1).closed,
    ), true);
    for (const [mode, message] of [
      ['denied', /permission was denied/],
      ['missing', /camera and microphone are needed/],
      ['download', /Chat couldn’t load/],
    ]) {
      await page.evaluate((mode) => {
        fixture.mode = mode;
      }, mode);
      await page.locator('#start').click();
      await page.waitForFunction(() =>
        document.getElementById('status').classList.contains('error'),
      );
      assert.match(await page.locator('#status').innerText(), message);
      await assertStoppedUI();
    }
    await page.evaluate(() => {
      fixture.mode = 'delayed';
    });
    await page.locator('#start').click();
    await page.waitForFunction(() => !!fixture.allowMedia);
    assert.equal(await page.locator('#status').innerText(), 'Allow camera & microphone access.');
    assert.equal(await page.locator('#session-label').isVisible(), false);
    assert.equal(await page.locator('#start').innerText(), 'End');
    await assertMinimalUI();
    await page.locator('#start').click();
    await page.evaluate(() => fixture.allowMedia());
    await page.waitForFunction(() =>
      fixture.streams
        .at(-1)
        .getTracks()
        .every((t) => t.readyState === 'ended'),
    );
    await page.evaluate(() => {
      fixture.mode = '';
      navigator.gpu.requestAdapter = async () => null;
    });
    await page.locator('#start').click();
    await page.waitForFunction(() =>
      document.getElementById('status').textContent.includes('can’t run'),
    );
    await page.evaluate(() => {
      navigator.gpu.requestAdapter = async () => ({
        features: new Set(['shader-f16']),
      });
    });
    await page.locator('#start').click();
    await page.waitForFunction(
      () =>
        document.getElementById('status').textContent === '' &&
        !document.getElementById('session-label').hidden,
    );
    await page.evaluate(() =>
      fixture.streams.at(-1).getTracks()[0].dispatchEvent(new Event('ended')),
    );
    await page.waitForFunction(() =>
      document.getElementById('status').textContent.includes('disconnected'),
    );
    assert.equal(
      await page.evaluate(() =>
        fixture.streams.every((s) =>
          s.getTracks().every((t) => t.readyState === 'ended'),
        ),
      ),
      true,
    );
    await page.locator('#start').click();
    await page.waitForFunction(
      () =>
        document.getElementById('status').textContent === '' &&
        !document.getElementById('session-label').hidden,
    );
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    assert.equal(
      await page.evaluate(() =>
        fixture.streams.every((s) =>
          s.getTracks().every((t) => t.readyState === 'ended'),
        ),
      ),
      true,
    );
    await assertStoppedUI();
    assert.deepEqual(errors, []);
    assert.ok(
      requests.every(
        (r) => r.url.startsWith(server.origin) && r.method === 'GET',
      ),
      'No user content or external requests, including after starting',
    );
    await page.goto(url + '?debug=1');
    await page.locator('#start').click();
    await page.locator('#debug').waitFor({ state: 'visible' });
    assert.match(await page.locator('#debug').innerText(), /Worker: ready; busy: false; audio rate: 16000 Hz/);
    await page.locator('#start').click();
    await context.close();
  },
);

test(
  'real audio worklet and production Worker connect automatically using fake devices and a fixture runtime',
  { timeout: 25000 },
  async (t) => {
    const server = await previewServer(new URL('..', import.meta.url).pathname);
    t.after(() => server.close());
    const browser = await chromium.launch({
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    });
    t.after(() => browser.close());
    const page = await browser.newPage({
      permissions: ['camera', 'microphone'],
    });
    const errors = [],
      remote = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('https://**/*', (route) => {
      remote.push(route.request().url());
      if (route.request().url() !== RUNTIME) return route.abort();
      return route.fulfill({
        contentType: 'text/javascript',
        body: `
      export const env = { backends: { onnx: { wasm: {} } } };
      export async function pipeline(task) {
        if (task === 'automatic-speech-recognition') return async () => ({text: '今日はコーヒーを飲みます。'});
        const generate = async () => [{generated_text: 'コーヒー、いい香りですね！'}];
        generate.tokenizer = {apply_chat_template: () => 'fixture prompt'};
        return generate;
      }
    `,
      });
    });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'gpu', {
        value: {
          requestAdapter: async () => ({ features: new Set(['shader-f16']) }),
        },
      });
      const getMedia = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (options) => {
        window.fakeStream = await getMedia(options);
        return fakeStream;
      };
    });
    await page.goto(server.origin + '/sandbox/projects/ai-livestream/');
    assert.deepEqual(
      remote,
      [],
      'Inert preview does not import even the fixture runtime',
    );
    await page.locator('#start').click();
    await page.locator('.comment').waitFor({ timeout: 15000 });
    assert.match(await page.locator('.comment').innerText(), /コーヒー/);
    assert.deepEqual(
      remote,
      [RUNTIME],
      'Only the explicitly mocked runtime is requested',
    );
    await page.locator('#start').click();
    assert.equal(
      await page.evaluate(() =>
        fakeStream.getTracks().every((t) => t.readyState === 'ended'),
      ),
      true,
    );
    assert.deepEqual(errors, []);
  },
);
