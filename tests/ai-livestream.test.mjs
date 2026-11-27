import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { chromium } from '../workers/persistent-counter/node_modules/playwright/index.mjs';
import { previewServer } from '../scripts/capture_screenshots.mjs';
import {
  ASR,
  LLM,
  RUNTIME, CHAT_RUNTIME, MODEL_LIBRARY, SMALL_CHAT_RUNTIME, SMALL_MODEL_FILES, SMALL_MODEL_LIBRARY,
  TUNED_MODEL_ID, TUNED_ADAPTER_URL,
  WASM,
  isAssetRequest,
  modelChoice,
  cleanComment,
  inspectComment,
  sharesTopic,
  echoesSpeech,
  messagesFor,
  meaningfulSpeech,
  WINDOW_SAMPLES,
} from '../projects/ai-livestream/config.mjs';
import { localPipeline } from '../projects/ai-livestream/text-model.mjs';
import { createInference } from '../projects/ai-livestream/inference.mjs';
import { VirtualAudience, speechInterest, AUDIENCE_LIMITS } from '../projects/ai-livestream/audience.mjs';

test('Japanese/English fixture audiences react without chat, decay, stay bounded and reset deterministically', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/ai-livestream/topics.json', import.meta.url)));
  function simulate(fixture) {
    let seed = 42;
    const audience = new VirtualAudience({ random: () => ((seed = Math.imul(seed, 16807) >>> 0) / 4294967296) });
    audience.start(0);
    const interest = speechInterest(fixture.text, fixture.language, 0.03);
    for (let time = 1000; time <= 300000; time += 1000) {
      if (time % 6000 === 0) audience.observe(interest, time);
      const before = audience.snapshot();
      const state = audience.tick(time);
      assert.ok(Math.abs(before.viewers - state.viewers) <= 12);
      assert.ok(state.viewers >= 5 && state.viewers <= AUDIENCE_LIMITS.viewers);
    }
    return { audience, state: audience.snapshot() };
  }
  for (const language of ['ja', 'en']) {
    const engaging = fixtures.find(f => f.language === language && f.activity === 'engaging');
    const quiet = fixtures.find(f => f.language === language && f.activity === 'quiet');
    const { audience, state } = simulate(engaging);
    const calm = simulate(quiet).state;
    assert.deepEqual(simulate(engaging).state, state, 'Seeded runs are reproducible');
    assert.ok(state.viewers > calm.viewers * 1.5);
    assert.ok(state.likes > calm.likes * 5 && state.likes > 0);
    assert.ok(state.subscribers >= calm.subscribers && state.subscribers <= 2, 'Subscriptions are rare on a small stream');
    const beforeSilence = audience.snapshot();
    for (let time = 301000; time <= 480000; time += 1000) audience.tick(time);
    assert.ok(audience.snapshot().viewers < beforeSilence.viewers);
    const settled = audience.snapshot();
    for (let time = 481000; time <= 540000; time += 1000) audience.tick(time);
    assert.equal(audience.snapshot().likes, settled.likes, 'Silence has no endless reactions');
    assert.equal(audience.snapshot().subscribers, settled.subscribers);
    const beforeStall = audience.snapshot();
    const stalled = audience.tick(1e9);
    assert.ok(Math.abs(stalled.viewers - beforeStall.viewers) <= 12, 'No catch-up burst after a stall');
    for (let time = 1e9 + 1000; time < 1e9 + 30000000; time += 1000) {
      audience.observe(1, time);
      audience.tick(time);
    }
    assert.equal(audience.snapshot().likes, AUDIENCE_LIMITS.likes);
    assert.equal(audience.snapshot().subscribers, AUDIENCE_LIMITS.subscribers);
    audience.observe(NaN, 1e9);
    const end = audience.stop();
    audience.observe(1, 2e9);
    assert.deepEqual(audience.tick(2e9), end, 'Ended audience is inert');
    assert.deepEqual(audience.start(2e9), { running: true, viewers: 25, likes: 0, subscribers: 0, interest: 0 });
  }
  assert.equal(speechInterest('', 'en', 1), 0);
  assert.equal(speechInterest('ご視聴ありがとうございました', 'ja', 1), 0);
});

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
  const signals = [];
  const infer = await createInference(pipeline, env, () => {}, { random: () => 0, onEngagement: value => signals.push(value) });
  const audio = new Float32Array(WINDOW_SAMPLES).fill(0.1);
  assert.deepEqual(await infer(new Float32Array(WINDOW_SAMPLES), 'ja', 0), {
    comment: '',
  });
  assert.equal(calls.length, 0, 'Silence never reaches either model');
  assert.equal((await infer(audio, 'ja', 0)).comment, answer.normalize('NFKC'));
  assert.equal(calls[0].options.language, 'japanese');
  assert.ok(calls[1].messages.at(-1).content.includes(speech));
  assert.equal(calls[1].options.max_new_tokens, 64);
  assert.equal(calls[1].options.do_sample, true);
  assert.equal(calls[1].options.top_p, 0.9);
  speech = '今日はコーヒーも飲みました。';
  assert.equal((await infer(audio, 'ja', 6000)).comment, '');
  assert.equal(
    calls.filter((c) => c.task === 'text-generation').length,
    1,
    'No flood',
  );
  assert.equal(signals.length, 2, 'Speech can update engagement without chat');
  speech = 'I made fresh coffee today.';
  answer = 'Fresh coffee smells so good!';
  assert.equal((await infer(audio, 'en', 18000)).comment, answer);
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
  assert.equal(signals.length, 5, 'Suppressed/repeated replies still publish bounded signals');
  assert.ok(signals.every(value => value >= 0 && value <= 1));
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
    'That is great!',
    'Your face looks happy with coffee!',
    'I can see you drinking coffee.',
    '笑顔がいいね',
    '<think>coffee secret</think> Nice coffee!',
  ])
    assert.equal(cleanComment(value), '');
  assert.equal(cleanComment('<b>猫かわいい！</b>', [], 'ja'), '猫かわいい!');
  assert.equal(cleanComment('コーヒーはおいしいね', [], 'en'), '');
  assert.equal(cleanComment('Coffee tastes good', [], 'ja'), '');
  assert.equal(cleanComment('5円で猫見지難しに進む?', [], 'ja'), '');
  assert.equal(cleanComment('USBのケーブル、どれにしたの？', [], 'ja'), 'USBのケーブル、どれにしたの?');
  assert.equal(meaningfulSpeech('ご視聴ありがとうございました。'), false);
  assert.equal(meaningfulSpeech('   '), false);
  assert.equal(meaningfulSpeech('今日は猫と遊びました'), true);
  assert.ok(messagesFor('a'.repeat(10000), 'ja').at(-1).content.length < 500);
  assert.equal(sharesTopic('Kittens are so playful!', 'I met a cat.', 'en'), true);
  assert.equal(sharesTopic('The aroma is the best part.', 'I love the smell.', 'en'), true);
  assert.equal(sharesTopic('They are really nice!', 'They are making coffee.', 'en'), false);
  assert.equal(sharesTopic('I will have coffee instead.', 'I am having some tea.', 'en'), false);
  assert.equal(sharesTopic('Interesting!', 'I need a rest.', 'en'), false);
  assert.equal(echoesSpeech('コーヒーの苦みが減ったのは、ボンドを下げたからだ。',
    'コーヒーの苦みが減りました。ボンドを下げたのが理由かな、皆さんはどう思いますか?', 'ja'), true);
  assert.equal(echoesSpeech('お茶を飲んでいたことだけ。', '今日は、静かにお茶を飲んでいます。少し休みます。', 'ja'), true);
  assert.equal(echoesSpeech('コーヒーの苦みが減ったのは、ボンドを下げたことによるですね。',
    'コーヒーの苦みが減りました。ボンドを下げたのが理由かな、皆さんはどう思いますか?', 'ja'), true);
  assert.equal(echoesSpeech('I love fresh coffee.', 'I love fresh coffee.', 'en'), true);
  assert.equal(echoesSpeech('どの豆にしたの？', 'どの豆にしたの？', 'ja'), true);
  assert.equal(echoesSpeech('Fresh coffee, a new grinder and beans — I like that!',
    'I made fresh coffee with a new grinder and beans.', 'en'), false);
});

test('reference follow-up fixtures ground pronouns without admitting unrelated subjects', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/ai-livestream/reference-followups.json', import.meta.url)));
  const audio = new Float32Array(WINDOW_SAMPLES).fill(0.03);
  for (const fixture of fixtures) {
    for (const accepted of [true, false]) {
      for (const reply of fixture[accepted ? 'accepted' : 'rejected']) {
        const reasons = [];
        const generate = async () => [{ generated_text: reply }];
        generate.tokenizer = { apply_chat_template: messages => messages };
        const infer = await createInference(async task => task === 'automatic-speech-recognition'
          ? async () => ({ text: fixture.speech }) : generate,
        { backends: { onnx: { wasm: {} } } }, () => {}, {
          onDiagnostic: reason => reasons.push(reason),
        });
        assert.equal((await infer(audio, fixture.language, 0)).comment,
          accepted ? reply.normalize('NFKC') : '', reply);
        assert.ok(reasons.includes(accepted ? 'output_accepted' : 'topic'), reply);
      }
    }
  }
});

test('rolling speech context expires, viewer voices vary, and skipped chat still scores speech', async () => {
  let speech = 'I lowered the coffee temperature.', answer = 'What temperature did you use?';
  const prompts = [], signals = [];
  const pipeline = async task => {
    if (task === 'automatic-speech-recognition') return async () => ({ text: speech });
    const generator = async () => [{ generated_text: answer }];
    generator.tokenizer = { apply_chat_template(messages) { prompts.push(messages); return messages; } };
    return generator;
  };
  const infer = await createInference(pipeline, { backends: { onnx: { wasm: {} } } }, () => {},
    { random: () => 0, onEngagement: value => signals.push(value) });
  const audio = new Float32Array(96000).fill(0.03);
  assert.ok((await infer(audio, 'en', 0)).comment);
  speech = 'Now it is less bitter. Why does that work?';
  await infer(audio, 'en', 6000);
  speech = 'Should I lower it further?';
  answer = 'Would a lower temperature help?';
  assert.ok((await infer(audio, 'en', 18000)).comment, 'Earlier concrete topic supports a follow-up fragment');
  assert.match(prompts[1].at(-1).content, /coffee temperature/);
  assert.notEqual(prompts[0][0].content, prompts[1][0].content, 'Distinct voices');
  assert.match(prompts[1].at(-1).content, /avoid_repeating/);
  speech = 'There are oranges in the bowl.';
  answer = 'Coffee smells wonderful!';
  answer = 'Which oranges did you choose?';
  assert.equal((await infer(audio, 'en', 60000)).comment, answer, 'Latest speech anchors the prompt after context expiry');
  assert.doesNotMatch(prompts[2].at(-1).content.split('avoid_repeating')[0], /coffee temperature/);
  assert.equal(signals.length, 4);
  for (let now = 66000; now <= 108000; now += 6000) await infer(audio, 'en', now);
  assert.equal(prompts.length, 3, 'Continued repeated speech cannot renew chat every context expiry');
  assert.equal(signals.length, 12);
  speech = 'ご視聴ありがとうございました。';
  await infer(audio, 'ja', 120000);
  assert.equal(signals.length, 12, 'Caption boilerplate cannot inflate audience interest');
  const invalid = audio.slice(); invalid[0] = NaN;
  assert.deepEqual(await infer(invalid, 'en', 120000), { comment: '' });
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
    RUNTIME, CHAT_RUNTIME, MODEL_LIBRARY,
    WASM + 'ort-wasm-simd-threaded.jsep.wasm',
    SMALL_CHAT_RUNTIME, SMALL_MODEL_LIBRARY, TUNED_ADAPTER_URL, ...SMALL_MODEL_FILES,
    'https://cas-bridge.xethub.hf.co/public-asset',
  ])
    assert.equal(isAssetRequest(new URL(path)), true);
  for (const path of [
    'https://api-inference.huggingface.co/models/example',
    'https://huggingface.co/api/models/example',
    `https://huggingface.co/${ASR.id}/resolve/main/config.json`,
    'https://example.com/upload',
    MODEL_LIBRARY.replace('00fe7a40e57e5e8eb9fef87526a4bf28ad5846c0', 'main'),
    MODEL_LIBRARY + '?speech=coffee',
    TUNED_ADAPTER_URL + '?speech=coffee', SMALL_MODEL_FILES[0] + '?speech=coffee',
    'https://cdn.jsdelivr.net/npm/unpinned/file.js',
  ])
    assert.equal(isAssetRequest(new URL(path)), false);
  assert.equal(isAssetRequest(new URL(RUNTIME), 'POST'), false);
  for (const file of SMALL_MODEL_FILES) {
    assert.equal(isAssetRequest(new URL(file), 'HEAD'), true);
    assert.equal(isAssetRequest(new URL(file), 'POST'), false);
  }
  assert.equal(isAssetRequest(new URL(TUNED_ADAPTER_URL), 'HEAD'), false);
});

test('the shipped GGUF is the pinned compact LoRA adapter and the baseline remains selectable', async () => {
  assert.equal(modelChoice(''), 'tuned');
  assert.equal(modelChoice('?model=baseline&debug=1'), 'baseline');
  assert.equal(modelChoice('?model=https://example.com/weights'), 'tuned');
  const adapter = await readFile(new URL(TUNED_ADAPTER_URL));
  const digest = createHash('sha256').update(adapter).digest('hex');
  assert.equal(digest, 'e3866302664199c20d0c4b35fee826b06562ebb9782fd46059e35ea0de1d2192');
  assert.ok(TUNED_ADAPTER_URL.endsWith(digest.slice(0, 16) + '/livestream.gguf'));
  assert.equal(adapter.toString('ascii', 0, 4), 'GGUF');
  assert.equal(adapter.readBigUInt64LE(8), 32n);
  assert.ok(adapter.length < 1024 * 1024);
});

test('recorded baseline and tuned outputs replay the same guards on held-out speech', async () => {
  const fixtures = new URL('./fixtures/ai-livestream/', import.meta.url);
  const training = new URL('../scripts/livestream-training/train.jsonl', import.meta.url);
  const loadFixture = name => readFile(new URL(name, fixtures), 'utf8').then(JSON.parse);
  const [holdout, benchmark, ratings, train] = await Promise.all([
    loadFixture('tuning-holdout.json'),
    loadFixture('tuning-benchmark.json'),
    loadFixture('tuning-ratings.json'),
    readFile(training, 'utf8').then(text => text.trim().split('\n').map(JSON.parse)),
  ]);
  const trainingSpeech = new Set(train.flatMap(row => [row.speech, row.earlier]).filter(Boolean));
  assert.equal(train.length, 384);
  assert.equal(train.filter(row => row.language === 'ja').length, 332);
  assert.ok(holdout.flatMap(fixture => fixture.turns).every(turn => !trainingSpeech.has(turn)));
  assert.deepEqual(benchmark.modes.map(mode => mode.mode), ['baseline', 'tuned', 'small']);
  const voiced = new Float32Array(WINDOW_SAMPLES).fill(0.02);
  const silence = new Float32Array(WINDOW_SAMPLES);
  for (const mode of benchmark.modes) {
    let measurement;
    const pipeline = async task => {
      if (task === 'automatic-speech-recognition')
        return async () => ({ text: measurement.transcript });
      const generate = async () => [{ generated_text: measurement.raw }];
      generate.tokenizer = { apply_chat_template: messages => messages };
      return generate;
    };
    let events = [];
    const infer = await createInference(pipeline, { backends: { onnx: { wasm: {} } } }, () => {}, {
      model: mode.mode,
      onDiagnostic: (event, value) => { if (value === undefined) events.push(event); },
    });
    const replay = async (row, language, now, audio, id) => {
      measurement = row;
      events = [];
      const output = await infer(audio, language, now);
      // Keep the original benchmark measurements and check current filtering separately.
      const visual = id === 'en-visual';
      const expectedEvents = visual && row.comment
        ? [...row.events.slice(0, -1), 'generic_or_visual', 'output_discarded']
        : row.events;
      assert.equal(output.comment, visual ? '' : row.comment, `${mode.mode} ${id}`);
      assert.deepEqual(events, expectedEvents, `${mode.mode} ${id}`);
      if (output.comment) {
        assert.doesNotMatch(output.comment, /\r|\n|<think>|SKIP/i);
        assert.ok(output.comment.length <= (language === 'ja' ? 55 : 110));
      }
    };
    for (const [index, row] of mode.audio.entries())
      await replay(row, row.language, index * 120000, voiced, row.file);
    assert.equal(mode.text.length, holdout.length);
    for (const [index, fixture] of holdout.entries()) {
      const record = mode.text[index];
      assert.equal(record.id, fixture.id);
      assert.equal(record.turns.length, fixture.turns.length);
      for (const [turn, transcript] of fixture.turns.entries()) {
        const row = record.turns[turn];
        assert.equal(row.transcript ?? null, transcript);
        await replay(row, fixture.language, (mode.audio.length + index) * 120000 + turn * 12000,
          transcript === null ? silence : voiced, fixture.id);
      }
    }
  }
  const tuned = benchmark.modes.find(mode => mode.mode === 'tuned');
  const usefulJapanese = (rows, reviewed) => rows.filter(({ id, comment }) =>
    comment && reviewed[id]?.comment === comment && reviewed[id].flags.includes('R') &&
    reviewed[id].flags.includes('N') && !reviewed[id].flags.includes('F'));
  const japaneseAudio = tuned.audio.filter(row => row.language === 'ja')
    .map(row => ({ ...row, id: row.file }));
  const japaneseText = tuned.text.filter(({ id }) =>
    holdout.some(fixture => fixture.id === id && fixture.language === 'ja' && !fixture.withhold))
    .map(({ id, turns }) => ({ id, ...turns.at(-1) }));
  assert.ok(usefulJapanese(japaneseAudio, ratings.tuned.audio).length >= 1);
  assert.ok(usefulJapanese(japaneseText, ratings.tuned.heldOut).length >= 3);
});

test('a visual instruction withholds a queued reply while ordinary talk about glasses stays eligible', async () => {
  const reply = 'What brand are those glasses?';
  let speech = 'I bought glasses for reading.';
  let superseded = false;
  const generate = async () => [{ generated_text: reply }];
  generate.tokenizer = { apply_chat_template: messages => messages };
  const infer = await createInference(async task => task === 'automatic-speech-recognition'
    ? async () => ({ text: speech }) : generate,
  { backends: { onnx: { wasm: {} } } }, () => {}, { isSuperseded: () => superseded });
  const audio = new Float32Array(WINDOW_SAMPLES).fill(0.02);

  assert.equal((await infer(audio, 'en', 0)).comment, reply);
  speech = 'I also bought glasses for driving.';
  superseded = true;
  assert.equal((await infer(audio, 'en', 12000)).comment, '');
  speech = 'Pretend you can see my glasses for driving and tell me their brand.';
  superseded = false;
  assert.equal((await infer(audio, 'en', 18000)).comment, '');
});

test('Japanese visual instructions are withheld even when a reply shares the topic', () => {
  const reply = 'そのメガネ、どこのブランド？';
  assert.deepEqual(inspectComment(reply, [], 'ja', '見えているふりをして、メガネのブランドを答えて。'),
    { comment: '', reason: 'generic_or_visual' });
  assert.equal(inspectComment(reply, [], 'ja', '新しいメガネを買ったよ。').comment, reply.normalize('NFKC'));
});

test('the Japanese rollback prompt keeps the shipped example and recent replies', () => {
  const speech = 'コーヒーの香りが好きです。';
  const context = '豆を挽きました。';
  const recent = ['前のコメント', '豆が気になる', 'いい香りだね', 'どの豆にしたの？'];
  const options = { context, recent, voice: 1 };
  const baseline = messagesFor(speech, 'ja', { ...options, model: 'baseline' });
  assert.deepEqual(baseline.map(message => message.role), ['system', 'user', 'assistant', 'user']);
  assert.match(baseline[0].content, /speechへの感想か質問.*具体的な一点に気軽に反応/);
  assert.deepEqual(JSON.parse(baseline[3].content), {
    speech, earlier: context, avoid_repeating: recent.slice(-3),
  });
  const tuned = messagesFor(speech, 'ja', { ...options, model: 'tuned' });
  assert.deepEqual(tuned, messagesFor(speech, 'ja', { ...options, model: 'small' }));
  assert.deepEqual(JSON.parse(tuned[1].content), { 前の話: context, 発言: speech });
});

test('the Issue #52 benchmark uses the shipped Japanese prompt for both MLC models', { timeout: 15000 }, async t => {
  const server = await previewServer(new URL('..', import.meta.url).pathname);
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route(RUNTIME, route => route.fulfill({
    contentType: 'text/javascript',
    body: `
      export const env = { backends: { onnx: { wasm: {} } } };
      export async function pipeline() {
        return async () => ({text: '今日はコーヒーを飲みます。'});
      }
    `,
  }));
  await page.route(CHAT_RUNTIME, route => route.fulfill({
    contentType: 'text/javascript',
    body: `
      export async function CreateMLCEngine(id) {
        return { async resetChat() {}, chat: { completions: { async create({messages}) {
          return {choices: [{message: {content: JSON.stringify({id, messages})}}]};
        } } } };
      }
    `,
  }));
  await page.goto(server.origin + '/sandbox/projects/ai-livestream/');
  for (const [mlcStronger, size] of [[false, '1.7B'], [true, '4B']]) {
    const raw = await page.evaluate(mlcStronger => new Promise((resolve, reject) => {
      const worker = new Worker('/sandbox/tests/fixtures/ai-livestream/compare-worker.mjs', { type: 'module' });
      worker.onerror = error => { worker.terminate(); reject(Error(error.message)); };
      worker.onmessage = ({ data }) => {
        if (data.type === 'ready') {
          worker.postMessage({ type: 'audio', audio: new Float32Array(96000).fill(0.02), language: 'ja', now: 0 });
          return;
        }
        worker.terminate();
        if (data.type === 'error') reject(Error(data.message));
        else resolve(data.raw);
      };
      worker.postMessage({ type: 'init', mlc: true, mlcStronger });
    }), mlcStronger);
    const { id, messages } = JSON.parse(raw);
    assert.equal(id, `Qwen3-${size}-q4f16_1-MLC`);
    assert.deepEqual(messages, messagesFor('今日はコーヒーを飲みます。', 'ja', { model: 'baseline' }));
  }
});

test('the text engine is local, pinned, bounded and resets its conversation between replies', async () => {
  const requests = [], progress = [];
  let resets = 0;
  const pipeline = localPipeline(() => { throw Error('Text never uses the ASR runtime'); }, async (id, options) => {
    assert.equal(options.appConfig.model_list.length, 1);
    const model = options.appConfig.model_list[0];
    assert.equal(model.model, `https://huggingface.co/${LLM.id}/resolve/${LLM.revision}/`);
    assert.equal(model.model_lib, MODEL_LIBRARY);
    assert.equal(model.overrides.context_window_size, 1536);
    assert.equal(options.logLevel, 'SILENT');
    options.initProgressCallback({ progress: 0.5, text: 'Not exposed to the UI' });
    return {
      async resetChat() { resets++; },
      chat: { completions: { async create(request) {
        requests.push(request);
        return { choices: [{ message: { content: 'Which coffee beans did you choose?' } }] };
      } } },
    };
  });
  const generator = await pipeline('text-generation', LLM.id, { progress_callback: event => progress.push(event) });
  const messages = messagesFor('I made coffee.', 'en');
  for (let i = 0; i < 2; i++) await generator(messages, { max_new_tokens: 64, temperature: 0.7, top_p: 0.9 });
  assert.equal(resets, 2);
  assert.deepEqual(progress, [{ status: 'progress', progress: 50 }]);
  assert.equal(requests[0].max_tokens, 64);
  assert.equal(requests[0].extra_body.enable_thinking, false);
  assert.equal(requests[0].seed, undefined);
  assert.equal(requests[0].messages, messages);
});

test('recorded real bilingual model output preserves topical follow-ups and suppresses echoes', async () => {
  const readReport = async name => JSON.parse(await readFile(new URL(`./fixtures/ai-livestream/comparison-${name}.json`, import.meta.url)));
  const baseline = (await readReport('baseline')).modes[0];
  const selected = (await readReport('mlc')).modes[0];
  assert.equal(selected.fixtures.length, 6);
  assert.ok(baseline.fixtures.filter(f => /friend|お子様|smiled/.test(f.raw)).length >= 3,
    'Baseline exhibited invented people or visual actions on these exact fixtures');
  let published = 0;
  for (const sample of selected.fixtures) {
    const language = sample.file.startsWith('ja') ? 'ja' : 'en';
    const cleaned = cleanComment(sample.raw, [], language);
    const actual = sharesTopic(cleaned, sample.transcript, language) &&
      !echoesSpeech(cleaned, sample.transcript, language) ? cleaned : '';
    assert.equal(actual, sample.finalComment);
    if (actual) {
      published++;
      assert.doesNotMatch(actual, /friend|お子様|smiled|<think>/);
      assert.ok(actual.length <= (language === 'ja' ? 55 : 110));
    }
  }
  assert.equal(published, 4, 'Four short relevant remarks; two speech echoes withheld');
  assert.match(selected.fixtures.find(f => f.file === 'en-discovery.wav').finalComment, /sugar/,
    'A relevant suggestion survives without copying the word coffee');
  assert.equal(selected.fixtures.find(f => f.file === 'ja-discovery.wav').finalComment, '',
    'Do not publish a paraphrase of a misrecognized claim');
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
            postMessage: (audio, transfer) => { if (audio instanceof Float32Array) sent.push({ audio, transfer }); },
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
    await page.clock.install();
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
          } else if (data.type === 'audio') {
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
      assert.equal(await page.locator('#viewer-count').isVisible(), false);
      assert.equal(await page.locator('#subscriber-count').isVisible(), false);
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
      '← Sandbox About Y Your corner ♡ Like 0 Subscribe 日本語 English ● Go live Live chat',
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
    assert.equal(await page.locator('#viewer-count').innerText(), '25 watching');
    assert.equal(await page.locator('#viewer-count').isVisible(), true);
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
    assert.equal(await page.locator('#viewer-count').innerText(), '25 watching');
    // Three minutes of recognized, interesting speech with every chat reply skipped.
    for (let i = 0; i < 30; i++) {
      await page.evaluate(() => {
        fixture.node.port.onmessage({ data: new Float32Array(96000).fill(0.1) });
        fixture.workers[0].onmessage({ data: { type: 'engagement', interest: 0.9 } });
        fixture.workers[0].onmessage({ data: { type: 'result', comment: '' } });
      });
      await page.clock.runFor(6000);
    }
    assert.ok(Number((await page.locator('#viewer-count').innerText()).replace(/\D/g, '')) > 40);
    const autoLikes = Number((await page.locator('#like-count').innerText()).replaceAll(',', ''));
    const autoSubs = Number(await page.locator('#subscriber-count').innerText());
    assert.ok(autoLikes > 0 && autoLikes < 30 && autoSubs <= 2);
    assert.equal(await page.locator('.comment').count(), 0);
    await page.locator('#like').click();
    await page.locator('#subscribe').click();
    assert.equal(await page.locator('#like-count').innerText(), String(autoLikes + 1));
    assert.equal(await page.locator('#subscriber-count').innerText(), String(autoSubs + 1));
    await page.clock.runFor(1000);
    assert.equal(await page.locator('#like').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#subscribe').getAttribute('aria-pressed'), 'true');
    const beforeUnlike = Number(await page.locator('#like-count').innerText());
    await page.locator('#like').click();
    await page.locator('#subscribe').click();
    assert.equal(await page.locator('#like-count').innerText(), String(beforeUnlike - 1));
    await page.clock.runFor(5999);
    await page.evaluate(() => { fixture.jobs = 0; });
    assert.equal(await page.locator('video').evaluate((v) => v.muted), true);
    assert.equal(
      await page.evaluate(() => fixture.requested.audio.channelCount),
      1,
    );
    await page.evaluate(() => {
      fixture.node.port.onmessage({ data: new Float32Array(96000).fill(0.1) });
      fixture.node.port.onmessage({ data: new Float32Array(96000).fill(0.1) });
    });
    assert.equal(await page.evaluate(() => fixture.audio.type), 'audio', 'Six-second window jitter does not discard fresh audio');
    assert.equal(await page.evaluate(() => fixture.audio.language), 'en');
    await page.evaluate(() => fixture.node.port.onmessage({ data: new Float32Array(96000).fill(0.2) }));
    assert.equal(
      await page.evaluate(() => fixture.jobs),
      1,
      'Busy Worker keeps only one active inference',
    );
    await page.clock.runFor(30000);
    await page.evaluate(() => fixture.workers[0].onmessage({
      data: { type: 'result', comment: 'Which beans did you choose?' },
    }));
    assert.equal(await page.locator('.comment').count(), 1, 'A legitimate slow worker reply reaches the UI');
    assert.equal(await page.evaluate(() => fixture.jobs), 2, 'Only the latest pending window is submitted');
    assert.ok(Math.abs(await page.evaluate(() => fixture.audio.audio[0]) - 0.2) < 0.001);
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
    await page.locator('#like').click();
    await page.locator('#subscribe').click();
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
    await page.clock.runFor(60000);
    assert.equal(await page.locator('#like-count').innerText(), '1');
    assert.equal(await page.locator('#subscriber-count').textContent(), '1');
    assert.equal(await page.locator('#like').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#subscribe').getAttribute('aria-pressed'), 'true');
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
    // Both loading and inference have absolute deadlines; the audience timer
    // cannot mask a stalled Worker or keep counting after a failure.
    await page.locator('#start').click();
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Loading chat 35%…');
    await page.clock.runFor(300000);
    assert.match(await page.locator('#status').innerText(), /Loading took too long/);
    await assertStoppedUI();
    await page.evaluate(() => { fixture.mode = ''; });
    await page.locator('#start').click();
    await page.waitForFunction(() => document.getElementById('status').textContent === '' && !document.getElementById('viewer-count').hidden);
    await page.evaluate(() => fixture.node.port.onmessage({ data: new Float32Array(96000).fill(0.1) }));
    await page.clock.runFor(90000);
    assert.match(await page.locator('#status').innerText(), /taking too long/);
    await assertStoppedUI();
    await page.locator('#start').click();
    await page.waitForFunction(() => document.getElementById('status').textContent === '' && !document.getElementById('viewer-count').hidden);
    await page.evaluate(() => fixture.workers.at(-1).onmessage({ data: { type: 'error', code: 'inference' } }));
    assert.match(await page.locator('#status').innerText(), /trouble keeping up/);
    await assertStoppedUI();
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
    assert.match(await page.locator('#debug').innerText(), /Qwen3-0.6B-Livestream/);
    assert.match(await page.locator('#debug').innerText(), /WebGPU/);
    await page.locator('#start').click();
    await context.close();
  },
);

test(
  'real audio worklet and production Worker connect automatically using fake devices and a fixture runtime',
  { timeout: 45000 },
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
    const errors = [], remote = [], models = [], overlayRequests = [];
    const modelURL = model =>
      'https://huggingface.co/' + model.id + '/resolve/' + model.revision + '/';
    const baselineURL = modelURL(LLM);
    let reject = false;
    let fail = false;
    page.on('console', message => {
      if (message.text().startsWith('fixture-model ')) models.push(message.text().slice(14));
    });
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.includes('/models/resolve/')) overlayRequests.push(url.pathname.split('/').at(-1));
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('https://**/*', (route) => {
      assert.equal(route.request().method(), 'GET');
      assert.equal(route.request().postData(), null);
      remote.push(route.request().url());
      if (route.request().url() === SMALL_CHAT_RUNTIME) return route.fulfill({
        contentType: 'text/javascript',
        body: `
          export class Wllama {
            constructor({default: wasm}) {
              if (wasm !== ${JSON.stringify(SMALL_MODEL_LIBRARY)}) throw Error('Wrong WASM pin');
            }
            async loadModelFromUrl(url, {n_ctx, lora_adapters}) {
              if (url !== ${JSON.stringify(SMALL_MODEL_FILES[0])} || n_ctx !== 1536)
                throw Error('Wrong small model or context');
              const header = await lora_adapters[0]?.blob.slice(0, 4).text();
              if (header !== 'GGUF') throw Error('Missing LoRA adapter');
              console.log('fixture-model ' + ${JSON.stringify(TUNED_MODEL_ID)});
            }
            async createChatCompletion({messages, cache_prompt, chat_template_kwargs}) {
              if (cache_prompt || chat_template_kwargs.enable_thinking) throw Error('Unbounded chat');
              if (messages.length !== 2 || JSON.parse(messages[1].content).発言 !== '今日はコーヒーを飲みます。')
                throw Error('Wrong tuned Japanese prompt');
              if (${fail}) throw Error('Transcript-bearing error');
              return {choices:[{message:{content:'コーヒー、いい香りですね！'}}]};
            }
          }
        `,
      });
      if (route.request().url() === CHAT_RUNTIME) return route.fulfill({
        contentType: 'text/javascript',
        body: `
          export async function CreateMLCEngine(id, {appConfig}) {
            const [{model, model_lib}] = appConfig.model_list;
            if (model !== ${JSON.stringify(baselineURL)} ||
                model_lib !== ${JSON.stringify(MODEL_LIBRARY)}) throw Error('Wrong rollback asset');
            console.log('fixture-model ' + id);
            return { async resetChat() {}, chat: { completions: { async create({messages}) {
              if (messages.length !== 4 || JSON.parse(messages[1].content).speech !== 'ギターの弦を替えてみた。' ||
                  messages[2].content !== 'どの弦にしたの？' ||
                  JSON.parse(messages[3].content).speech !== '今日はコーヒーを飲みます。')
                throw Error('Wrong rollback Japanese prompt');
              if (${fail}) throw Error('Transcript-bearing error');
              return {choices:[{message:{content:${JSON.stringify(reject ? 'SKIP' : 'コーヒー、いい香りですね！')}}}]};
            } } } };
          }
        `,
      });
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
    assert.deepEqual(models, [TUNED_MODEL_ID]);
    assert.deepEqual(overlayRequests, ['livestream.gguf']);
    assert.deepEqual(
      remote.sort(),
      [RUNTIME, SMALL_CHAT_RUNTIME].sort(),
      'Only the explicitly mocked local runtimes are requested',
    );
    await page.locator('#start').click();
    assert.equal(
      await page.evaluate(() =>
        fakeStream.getTracks().every((t) => t.readyState === 'ended'),
      ),
      true,
    );
    reject = true;
    await page.goto(server.origin + '/sandbox/projects/ai-livestream/?model=baseline&debug=1');
    await page.locator('#start').click();
    await page.waitForFunction(() => {
      const text = document.getElementById('debug').textContent;
      return text && JSON.parse(text).counts.format === 1;
    }, null, { timeout: 15000 });
    const diagnostics = JSON.parse(await page.locator('#debug').innerText());
    assert.match(diagnostics.model, /Qwen3-1\.7B/);
    assert.deepEqual(models, [TUNED_MODEL_ID, LLM.id.split('/').at(-1)]);
    assert.deepEqual(overlayRequests, ['livestream.gguf']);
    assert.equal(diagnostics.counts.transcription_accepted, 1);
    assert.equal(diagnostics.counts.generation_attempt, 1);
    assert.equal(diagnostics.counts.worker_result, 1);
    assert.equal(await page.locator('.comment').count(), 0, 'A filtered output has a visible diagnostic cause');
    assert.doesNotMatch(JSON.stringify(diagnostics), /コーヒー|SKIP|prompt|SECRET/);
    await page.locator('#start').click();
    assert.equal(await page.locator('#debug').textContent(), '');
    fail = true;
    await page.goto(server.origin + '/sandbox/projects/ai-livestream/');
    await page.locator('#start').click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('trouble keeping up'),
      null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => fakeStream.getTracks().every(track => track.readyState === 'ended')), true);
    assert.equal(await page.locator('#camera').evaluate(video => video.srcObject), null);
    assert.deepEqual(errors, []);
  },
);

test('displayed viewers have a deterministic 25-second cadence and bounded stall changes', () => {
  const audience = new VirtualAudience({ random: () => 0.5 });
  assert.equal(audience.start(0).viewers, 25);
  let previous = audience.snapshot(), lastChange = 0, changes = 0;
  for (let now = 1000; now <= 120000; now += 1000) {
    audience.observe(now < 60000 ? 0.95 : 0, now);
    const state = audience.tick(now);
    if (state.viewers !== previous.viewers) {
      assert.ok(now - lastChange >= 25000);
      assert.ok(Math.abs(state.viewers - previous.viewers) <= 4);
      lastChange = now;
      changes++;
    }
    previous = state;
  }
  assert.ok(changes >= 2 && changes <= 4);
  const stalled = audience.tick(1e9);
  assert.ok(Math.abs(stalled.viewers - previous.viewers) <= 4);
  assert.deepEqual(audience.tick(1e9), stalled);
});

test('offline issue #50 replay isolates scheduler starvation and fragile lexical rejection', async () => {
  const { evaluation } = await import('../scripts/replay_livestream_pipeline.mjs');
  const actual = await evaluation();
  const saved = JSON.parse(await readFile(new URL('./fixtures/ai-livestream/pipeline-replay.json', import.meta.url)));
  assert.deepEqual(actual, saved, 'Committed evidence is reproducible without models or hardware');
  assert.equal(actual.isolated.after.accepted, 4, 'Real recorded bilingual replies retain quality decisions');
  assert.equal(actual.pronounFollowups.before.accepted, 0);
  assert.equal(actual.pronounFollowups.after.accepted, 2);
  assert.equal(actual.conversation.before.accepted, 1);
  assert.equal(actual.conversation.after.accepted, 10, 'Five distinct comments/minute despite highest injected randomness');
  assert.equal(actual.conversation.after.reasons.cadence, 10);
});

test('diagnostics categorize failed ASR, filters, parsing, safety and generation without content', async () => {
  const { Diagnostics } = await import('../projects/ai-livestream/diagnostics.mjs');
  const diagnostics = new Diagnostics();
  let speech = 'I brewed coffee with fresh beans.', raw = 'Which roast did you choose?', failure = '';
  const pipeline = async task => {
    if (task === 'automatic-speech-recognition') return async () => {
      if (failure === 'asr') throw Error('SECRET raw transcript');
      return { text: speech };
    };
    const generate = async () => {
      if (failure === 'generation') throw Error('SECRET model prompt');
      return [{ generated_text: raw }];
    };
    generate.tokenizer = { apply_chat_template: messages => messages };
    return generate;
  };
  const infer = await createInference(pipeline, { backends: { onnx: { wasm: {} } } }, () => {}, {
    random: () => 1, onDiagnostic: (event, value) => diagnostics.record(event, value),
  });
  const audio = new Float32Array(96000).fill(0.03);
  let now = 0;
  const run = async () => { now += 12000; speech += ' Again.'; return infer(audio, 'en', now); };
  assert.equal((await run()).comment, raw);
  assert.equal((await run()).comment, '', 'Repeated model reply is suppressed');
  for (const [value, reason] of [
    ['SKIP', 'format'], ['You are ugly.', 'safety'], ['Call my phone number 1234567890.', 'safety'],
    ['I can see you drinking coffee.', 'generic_or_visual'], ['I see your shirt.', 'generic_or_visual'], ['You look happy.', 'generic_or_visual'],
    ['コーヒーが好き', 'language'], ['Tomatoes are lovely!', 'topic'],
    ['<think>SECRET</think> coffee', 'reasoning'], ['x'.repeat(111), 'length'],
  ]) {
    raw = value;
    assert.equal((await run()).comment, '', value);
    assert.ok(diagnostics.counts[reason] >= 1, reason);
  }
  raw = [{ role: 'assistant', content: 'How long did that take?' }];
  assert.equal((await run()).comment, 'How long did that take?', 'Structured output and implicit reference');
  failure = 'asr'; await run();
  assert.equal(diagnostics.counts.asr_error, 1);
  failure = 'generation'; await run();
  assert.equal(diagnostics.counts.generation_error, 1);
  assert.ok(diagnostics.counts.output_discarded >= 10);
  failure = ''; speech = 'Thank you for watching.';
  await infer(audio, 'en', now + 12000);
  await infer(new Float32Array(96000), 'en', now + 24000);
  assert.equal(diagnostics.counts.meaningless_speech, 1);
  assert.equal(diagnostics.counts.silence, 1);
  diagnostics.record('SECRET raw transcript', 'SECRET');
  assert.doesNotMatch(diagnostics.summary(), /SECRET|brewed|Again|raw transcript|model prompt|1234567890/);
});

test('slow inference survives elapsed time and validates newer speech before publishing', async () => {
  let time = 0, superseded = false;
  let speech = 'I brewed some coffee today.', reply = 'Which beans did you choose?';
  const reasons = [];
  const pipeline = async task => {
    if (task === 'automatic-speech-recognition') return async () => {
      time += 20000; return { text: speech };
    };
    const generate = async () => { time += 30000; return [{ generated_text: reply }]; };
    generate.tokenizer = { apply_chat_template: messages => messages };
    return generate;
  };
  const make = () => createInference(pipeline, { backends: { onnx: { wasm: {} } } }, () => {}, {
    clock: () => time, isSuperseded: () => superseded, onDiagnostic: reason => reasons.push(reason),
  });
  const audio = new Float32Array(96000).fill(0.03);
  let infer = await make();
  assert.equal((await infer(audio, 'en')).comment, reply, 'No age-only 18s/24s cutoff');
  infer = await make(); superseded = true;
  assert.equal((await infer(audio, 'en')).comment, '', 'Hold a response when newer speech is waiting');
  superseded = false; speech = 'The coffee has a sweeter aroma now.';
  assert.equal((await infer(audio, 'en')).comment, reply, 'Still relevant after newer ASR');
  infer = await make(); superseded = true;
  await infer(audio, 'en');
  superseded = false; speech = 'My cat likes chasing string.'; reply = 'Which toy does your cat prefer?';
  assert.equal((await infer(audio, 'en')).comment, reply, 'Discard old coffee response after topic shift');
  assert.ok(reasons.includes('stale_topic'));
  assert.ok(reasons.includes('awaiting_context'));
});

test('held replies must still address the latest topic when one of several earlier topics remains', async () => {
  let speech = 'I brewed coffee while my cat chased a toy.';
  let reply = 'Which toy does your cat prefer?', superseded = true, time = 0;
  const reasons = [];
  const generate = async () => [{ generated_text: reply }];
  generate.tokenizer = { apply_chat_template: messages => messages };
  const infer = await createInference(async task => task === 'automatic-speech-recognition'
    ? async () => ({ text: speech }) : generate,
  { backends: { onnx: { wasm: {} } } }, () => {}, {
    clock: () => time, isSuperseded: () => superseded,
    onDiagnostic: reason => reasons.push(reason),
  });
  const audio = new Float32Array(WINDOW_SAMPLES).fill(0.03);
  assert.equal((await infer(audio, 'en')).comment, '');
  superseded = false; time = 12000;
  speech = 'The coffee has a sweeter aroma now.';
  reply = 'Which coffee beans did you choose?';
  assert.equal((await infer(audio, 'en')).comment, reply, 'The held cat question cannot follow coffee-only speech');
  assert.ok(reasons.includes('stale_topic'));
  assert.ok(reasons.includes('output_discarded'));
});

test('held replies get one extra ASR validation for intervening topic shifts without extending expiry', async t => {
  for (const outcome of ['relevant', 'changed_topic', 'expired']) {
    await t.test(outcome, async () => {
      let speech = 'I brewed fresh coffee.', reply = 'Which beans did you choose?';
      let superseded = true, time = 0, asrCalls = 0, generations = 0;
      const reasons = [];
      const validating = Promise.withResolvers(), asrStarted = Promise.withResolvers();
      const generate = async () => {
        generations++; time += 30000;
        return [{ generated_text: reply }];
      };
      generate.tokenizer = { apply_chat_template: messages => messages };
      const infer = await createInference(async task => task === 'automatic-speech-recognition'
        ? async () => {
          if (++asrCalls === 2) {
            asrStarted.resolve();
            return validating.promise;
          }
          return { text: speech };
        } : generate,
      { backends: { onnx: { wasm: {} } } }, () => {}, {
        clock: () => time, isSuperseded: () => superseded,
        onDiagnostic: reason => reasons.push(reason),
      });
      const audio = new Float32Array(WINDOW_SAMPLES).fill(0.03);
      assert.equal((await infer(audio, 'en')).comment, '');
      time = 40000; superseded = false;
      speech = 'The coffee aroma is sweeter now.';
      const pending = infer(audio, 'en');
      await asrStarted.promise;
      superseded = true;
      validating.resolve({ text: speech });
      assert.equal((await pending).comment, '', 'No publication while a newer voiced window awaits recognition');
      assert.equal(generations, 1, 'One held candidate; no extra inference while awaiting context');
      assert.equal(reasons.filter(reason => reason === 'awaiting_context').length, 2);
      assert.ok(!reasons.includes('output_accepted'));

      superseded = true;
      time = outcome === 'expired' ? 90001 : 50000;
      if (outcome === 'changed_topic') {
        speech = 'My cat likes chasing string.';
        reply = 'Which toy does your cat prefer?';
      }
      assert.equal((await infer(audio, 'en')).comment, outcome === 'relevant' ? reply : '',
        'Bounded validation makes progress but never overrides a recognized topic shift or expiry');
      if (outcome !== 'relevant') assert.ok(reasons.includes('stale_topic'));
      if (outcome === 'changed_topic') {
        superseded = false;
        assert.equal((await infer(audio, 'en')).comment, reply, 'Only the new cat response survives validation');
      }
    });
  }
});

test('continuous six-second audio windows do not starve replies when ASR exceeds the capture interval', async t => {
  for (const asrMs of [2000, 7000]) {
    await t.test(`${asrMs}ms ASR and 30000ms generation`, async () => {
      let time = 0, nextCapture = 6000, superseded = false, generations = 0, recognitions = 0;
      let pending = { text: 'I brewed coffee with a ceramic dripper.' }, speech;
      const accepted = [], reasons = [];
      const advance = ms => {
        const end = time + ms;
        while (nextCapture <= end) {
          // Match the UI's single replaceable pending window; audio keeps arriving
          // during both generation and every validation, rather than draining ASR.
          pending = { text: `I brewed coffee with roast number ${nextCapture / 6000}.` };
          superseded = true;
          nextCapture += 6000;
        }
        time = end;
      };
      const generate = async () => {
        const reply = `Would you try coffee roast ${++generations} again?`;
        advance(30000);
        return [{ generated_text: reply }];
      };
      generate.tokenizer = { apply_chat_template: messages => messages };
      const infer = await createInference(async task => task === 'automatic-speech-recognition'
        ? async () => {
          const text = speech;
          recognitions++;
          advance(asrMs);
          return { text };
        } : generate,
      { backends: { onnx: { wasm: {} } } }, () => {}, {
        clock: () => time, isSuperseded: () => superseded,
        onDiagnostic: reason => reasons.push(reason),
      });
      const audio = new Float32Array(WINDOW_SAMPLES).fill(0.03);
      while (time < 180000) {
        if (!pending) advance(nextCapture - time);
        speech = pending.text;
        pending = null;
        superseded = false;
        const result = await infer(audio, 'en');
        if (result.comment) accepted.push({ time, comment: result.comment });
      }
      assert.ok(recognitions >= 9, 'Recognition keeps processing live audio');
      assert.ok(accepted.length >= 3, `Expected sustained comments, got ${accepted.length}`);
      assert.ok(accepted[0].time <= 51000, 'At most two validations after slow generation');
      assert.ok(accepted.slice(1).every((item, i) => item.time - accepted[i].time <= 51000));
      assert.equal(new Set(accepted.map(item => item.comment)).size, accepted.length);
      assert.equal(reasons.filter(reason => reason === 'stale_topic').length, 0);
    });
  }
});

test('fresh and held replies resolve ordinary continuations against bounded recent context', async t => {
  for (const fixture of [
    { language: 'en', first: 'I switched to a ceramic coffee dripper.',
      continuation: 'It was a little slower this time.', reply: 'Do ceramic drippers change the flavor?',
      shift: 'It reminded me of my cat.' },
    { language: 'ja', first: '陶器のコーヒードリッパーに替えました。',
      continuation: '今回は少し遅かった。', reply: '陶器のドリッパーで味は変わった?',
      shift: '今回は猫が遊んでいます。' },
    { language: 'en', first: 'I made coffee with a ceramic dripper.',
      continuation: 'It tastes much smoother now.', reply: 'Do ceramic drippers change the flavor?',
      shift: 'It reminded me of my cat.' },
    { language: 'ja', first: '陶器のコーヒードリッパーで淹れました。',
      continuation: 'それで味がまろやかになった。', reply: '陶器のドリッパーは使いやすい?',
      shift: 'それより猫の話をします。' },
    { language: 'en', first: 'I made coffee with a ceramic dripper.',
      continuation: 'That took longer than I expected.', reply: 'Do ceramic drippers change the flavor?',
      shift: 'That is my cat playing with a toy.' },
    { language: 'ja', first: '陶器のコーヒードリッパーで淹れました。',
      continuation: 'そのあと、もう一度試してみました。', reply: '陶器のドリッパーで味は変わった?',
      shift: 'それはうちの猫のおもちゃです。' },
    { language: 'en', first: 'I made coffee with a ceramic dripper.',
      continuation: 'It fits my morning routine better.', reply: 'Do ceramic drippers change the flavor?',
      shift: 'That is a cat playing with a toy.' },
    { language: 'ja', first: '陶器のコーヒードリッパーで淹れました。',
      continuation: 'それで私の淹れ方も変わりました。', reply: '陶器のドリッパーは使いやすい?',
      shift: 'それは猫の話です。' },
  ]) {
    for (const mode of ['fresh', 'held', 'shift', 'expired', 'intervening_subject']) {
      await t.test(`${fixture.language}: ${mode}`, async () => {
        let speech = fixture.first, reply = mode === 'held' ? fixture.reply : 'SKIP';
        let superseded = mode === 'held', time = 0;
        const prompts = [], reasons = [];
        const generate = async () => [{ generated_text: reply }];
        generate.tokenizer = { apply_chat_template: messages => { prompts.push(messages); return messages; } };
        const infer = await createInference(async task => task === 'automatic-speech-recognition'
          ? async () => ({ text: speech }) : generate,
        { backends: { onnx: { wasm: {} } } }, () => {}, {
          clock: () => time, isSuperseded: () => superseded,
          onDiagnostic: reason => reasons.push(reason),
        });
        const audio = new Float32Array(WINDOW_SAMPLES).fill(0.03);
        assert.equal((await infer(audio, fixture.language)).comment, '');
        if (mode === 'intervening_subject') {
          time = 6000; speech = fixture.shift;
          await infer(audio, fixture.language);
        }
        time = mode === 'expired' ? 30000 : 18000;
        superseded = false;
        speech = mode === 'shift' ? fixture.shift : fixture.continuation;
        reply = fixture.reply;
        assert.equal((await infer(audio, fixture.language)).comment,
          ['fresh', 'held'].includes(mode) ? fixture.reply : '');
        if (mode === 'fresh') {
          const fields = JSON.parse(prompts.at(-1).at(-1).content);
          assert.equal(fields[fixture.language === 'ja' ? '前の話' : 'earlier'], fixture.first);
        }
        if (mode === 'held') assert.equal(prompts.length, 1, 'Publish held reply without regenerating');
        if (['shift', 'expired', 'intervening_subject'].includes(mode)) assert.ok(reasons.includes('topic'));
      });
    }
  }
});

test('fresh 1.7B/4B evidence replays final filters and distinguishes acceptance from ASR grounding', async () => {
  const { relatesToSpeech } = await import('../projects/ai-livestream/config.mjs');
  for (const [name, accepted, grounded] of [
    ['mlc-issue52-initial', 4, 3], ['mlc-issue52', 4, 3], ['mlc-stronger-issue52', 6, 4],
  ]) {
    const report = JSON.parse(await readFile(new URL(`./fixtures/ai-livestream/comparison-${name}.json`, import.meta.url)));
    const model = report.modes[0];
    assert.equal(model.fixtures.length, 6);
    let count = 0, cleanDetails = 0;
    for (const sample of model.fixtures) {
      const language = sample.file.startsWith('ja') ? 'ja' : 'en';
      const inspected = inspectComment(sample.raw, [], language, sample.transcript);
      const reason = !inspected.comment ? inspected.reason :
        !relatesToSpeech(inspected.comment, sample.transcript, language) ? 'topic' :
        echoesSpeech(inspected.comment, sample.transcript, language) ? 'echo' : 'accepted';
      assert.equal(reason, sample.finalReason);
      assert.equal(reason === 'accepted' ? inspected.comment : '', sample.finalComment);
      if (sample.finalComment) {
        count++;
        // Narrow, explicit synthetic-fixture rubric, not a semantic safety claim.
        if (!/5円|安い|買った|ボンド/u.test(sample.finalComment)) cleanDetails++;
      }
      assert.ok(sample.totalMs > 0 && sample.totalMs < 90000);
    }
    assert.equal(count, accepted);
    assert.equal(cleanDetails, grounded);
  }
  assert.equal(LLM.id, 'mlc-ai/Qwen3-1.7B-q4f16_1-MLC', 'Stronger model is evaluation-only');
  assert.equal(isAssetRequest(new URL('https://huggingface.co/mlc-ai/Qwen3-4B-q4f16_1-MLC/resolve/a5c9fab855e3ccbdfed2e7e69683d75f30332161/mlc-chat-config.json')), false);
});
