// Offline only: replay recorded synthetic model output, never live user content.
import { readFile, writeFile } from 'node:fs/promises';
import { createInference as before } from '../tests/fixtures/ai-livestream/issue50/inference.mjs';
import { createInference as after } from '../projects/ai-livestream/inference.mjs';
import { VirtualAudience, speechInterest } from '../projects/ai-livestream/audience.mjs';
const directory = new URL('../tests/fixtures/ai-livestream/', import.meta.url);
const recorded = JSON.parse(await readFile(new URL('comparison-mlc.json', directory))).modes[0];
const topics = JSON.parse(await readFile(new URL('topics.json', directory)));
const audio = new Float32Array(96000).fill(0.03);
const env = () => ({ backends: { onnx: { wasm: {} } } });
export async function replay(create, samples, interval, random = () => 0.99) {
  let sample, attempts = 0;
  const reasons = {};
  const generate = async () => { attempts++; return [{ generated_text: sample.raw }]; };
  generate.tokenizer = { apply_chat_template: messages => messages };
  const infer = await create(async task => task === 'automatic-speech-recognition'
    ? async () => ({ text: sample.transcript }) : generate, env(), () => {}, {
    random, onDiagnostic: event => { reasons[event] = (reasons[event] || 0) + 1; },
  });
  const results = [];
  for (let i = 0; i < samples.length; i++) {
    sample = samples[i];
    const result = await infer(audio, sample.language || (sample.file.startsWith('ja') ? 'ja' : 'en'), i * interval);
    results.push({ file: sample.file, atMs: i * interval, comment: result.comment });
  }
  return { recognized: samples.length, attempts, accepted: results.filter(r => r.comment).length, reasons, results };
}
export async function evaluation() {
  const samples = recorded.fixtures;
  // A scripted sequence of distinct recognized windows, keeping measured raw
  // model replies unchanged. Scheduler replay, not another real model benchmark.
  const conversation = Array.from({ length: 20 }, (_, i) => ({
    ...samples[1], transcript: `${samples[1].transcript} Batch ${i}.`,
    raw: `Would you brew that again with batch ${i}?`,
  }));
  const paraphrases = [
    { file: 'english.wav', language: 'en', transcript: samples[1].transcript, raw: 'How long did that take?' },
    { file: 'japanese.wav', language: 'ja', transcript: samples[0].transcript, raw: 'それ、人懐っこい子だった？' },
  ];
  const audience = topics.filter(t => t.activity !== 'ordinary').map(topic => {
    let seed = 42;
    const state = new VirtualAudience({ random: () => ((seed = Math.imul(seed, 16807) >>> 0) / 4294967296) });
    state.start(0);
    for (let now = 1000; now <= 300000; now += 1000) {
      if (now % 6000 === 0) state.observe(speechInterest(topic.text, topic.language, 0.03), now);
      state.tick(now);
    }
    return { file: topic.file, ...state.snapshot() };
  });
  return {
    method: 'Offline deterministic replay of synthetic recorded Qwen3 1.7B outputs; no new model quality or wall-time measurement.',
    model: 'mlc-ai/Qwen3-1.7B-q4f16_1-MLC / WebLLM 0.2.85 WebGPU; ASR whisper-base q8 WASM',
    isolated: { before: await replay(before, samples, 120000, () => 0), after: await replay(after, samples, 120000) },
    pronounFollowups: { before: await replay(before, paraphrases, 120000, () => 0), after: await replay(after, paraphrases, 120000) },
    conversation: { before: await replay(before, conversation, 6000), after: await replay(after, conversation, 6000) },
    audience,
  };
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const result = await evaluation();
  await writeFile(new URL('pipeline-replay.json', directory), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(Object.fromEntries(['isolated', 'pronounFollowups', 'conversation'].map(key =>
    [key, Object.fromEntries(Object.entries(result[key]).map(([k,v]) => [k, { recognized: v.recognized, attempts: v.attempts, accepted: v.accepted }]))])), null, 2));
}
