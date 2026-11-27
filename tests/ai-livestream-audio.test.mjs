import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  SAMPLE_RATE, MIN_SEGMENT_SAMPLES, MAX_SEGMENT_SAMPLES,
} from '../projects/ai-livestream/audio-format.mjs';
import { createInference } from '../projects/ai-livestream/inference.mjs';
import { makeCapture, roundSeconds, synthesize } from './fixtures/ai-livestream/capture.mjs';

const bounds = ({ start, end, submitted }) => [start, end, submitted].map(roundSeconds);

function record(rate, duration, speech, noise) {
  const pcm = synthesize(rate, duration, speech, noise);
  return { pcm, segments: recordPcm(rate, pcm) };
}

function recordPcm(rate, pcm) {
  const segments = [];
  const capture = makeCapture(rate, segment => segments.push(segment));
  for (let offset = 0; offset < pcm.length; offset += 128) {
    capture.feed(pcm.subarray(offset, offset + 128));
    capture.ack();
  }
  return segments;
}

function filteredNoise(duration, smoothing, rms) {
  const noise = synthesize(SAMPLE_RATE, duration, [], 1);
  let filtered = 0, energy = 0;
  for (let i = 0; i < noise.length; i++) {
    filtered = smoothing * filtered + (1 - smoothing) * noise[i];
    noise[i] = filtered;
    energy += filtered * filtered;
  }
  const scale = rms / Math.sqrt(energy / noise.length);
  return noise.map(sample => sample * scale);
}

test('short quiet speech reaches recognition after its pause, with onset and tail PCM intact', async () => {
  const { pcm, segments } = record(SAMPLE_RATE, 2, [
    [0.36, 0.4, 0.0018], [0.4, 0.54, 0.005], [0.54, 0.58, 0.0018],
  ], 0.0005);
  assert.deepEqual(segments.map(bounds), [[0.2, 0.7, 1.144]]);
  const [{ audio, transfer }] = segments;
  assert.deepEqual(audio, pcm.slice(0.2 * SAMPLE_RATE, 0.7 * SAMPLE_RATE));
  assert.equal(transfer[0], audio.buffer);

  const received = [], diagnostics = [];
  const infer = await createInference(async task => {
    if (task === 'automatic-speech-recognition') return async (audio, options) => {
      received.push({ length: audio.length, language: options.language });
      return { text: 'I brewed fresh coffee.' };
    };
    const generate = async () => [{ generated_text: 'Nice!' }];
    generate.tokenizer = { apply_chat_template: messages => messages };
    return generate;
  }, { backends: { onnx: { wasm: {} } } }, () => {}, {
    onDiagnostic: event => diagnostics.push(event),
  });
  assert.equal((await infer(audio, 'en')).comment, 'Nice!');
  assert.deepEqual(received, [{ length: 8000, language: 'english' }]);
  const smallest = new Float32Array(MIN_SEGMENT_SAMPLES).fill(0.003);
  await infer(smallest, 'ja');
  assert.deepEqual(received.at(-1), { length: MIN_SEGMENT_SAMPLES, language: 'japanese' });
  const nonfinite = smallest.slice();
  nonfinite[0] = NaN;
  for (const bad of [smallest.slice(1), new Float32Array(MAX_SEGMENT_SAMPLES + 1), nonfinite, [0.1]]) {
    await infer(bad, 'en');
    assert.equal(diagnostics.at(-1), 'invalid_audio');
  }
  await infer(new Float32Array(MIN_SEGMENT_SAMPLES), 'en');
  assert.equal(diagnostics.at(-1), 'silence');
  assert.equal(received.length, 2);
});

test('brief internal pauses stay in an utterance and longer pauses close it at common input rates', () => {
  for (const rate of [8000, 16000, 44100, 48000]) {
    const { segments } = record(rate, 5, [[0.8, 1.42], [1.8, 2.36], [3.2, 3.5]]);
    assert.equal(segments.length, 2, `${rate} Hz`);
    for (const [i, [start, end, endpoint]] of [[0.6, 2.52, 2.96], [3, 3.66, 4.1]].entries()) {
      const segment = segments[i];
      assert.deepEqual(bounds(segment).slice(0, 2), [start, end]);
      assert.ok(segment.submitted >= endpoint && segment.submitted < endpoint + 128 / rate);
      assert.equal(segment.audio.length, Math.round((end - start) * SAMPLE_RATE));
    }
  }
});

test('continuous speech splits with bounded overlap and a quiet frame can finish a capped segment', () => {
  const { segments } = record(SAMPLE_RATE, 18, [[0.4, 15.4]]);
  assert.deepEqual(segments.map(bounds), [
    [0.2, 6.2, 6.2], [6.04, 12.04, 12.04], [11.88, 15.56, 16],
  ]);
  assert.deepEqual(segments.map(({ audio }) => audio.length), [96000, 96000, 58880]);
  assert.deepEqual(segments[0].audio.slice(-2560), segments[1].audio.slice(0, 2560));
  assert.deepEqual(segments[1].audio.slice(-2560), segments[2].audio.slice(0, 2560));

  const { segments: pausedAtCap } = record(SAMPLE_RATE, 8, [[0.2, 5.8], [6.1, 6.8]]);
  assert.deepEqual(pausedAtCap.map(bounds), [[0, 5.96, 6], [5.9, 6.96, 7.4]]);
  const { segments: stoppedAtCap } = record(SAMPLE_RATE, 8, [[0, 6]]);
  assert.deepEqual(stoppedAtCap.map(bounds), [[0, 6, 6]], 'Overlap alone never triggers a second job');
  const { segments: shortRemainder } = record(SAMPLE_RATE, 8, [[0, 6.04]]);
  assert.deepEqual(shortRemainder.map(bounds), [[0, 6, 6], [5.84, 6.2, 6.64]]);
});

test('silence, DC, broadband noise and transients do not submit PCM', () => {
  const capture = makeCapture(SAMPLE_RATE, () => assert.fail('Unexpected audio'));
  capture.feed(new Float32Array(SAMPLE_RATE * 7));
  capture.feed(new Float32Array(SAMPLE_RATE).fill(0.03));
  capture.feed(synthesize(SAMPLE_RATE, 7, [[1, 1.04], [2, 2.1]]));
  capture.feed(synthesize(SAMPLE_RATE, 8, [], 0.05));
  assert.equal(capture.processor.length, 0);
  assert.equal(capture.processor.buffer.length, MAX_SEGMENT_SAMPLES);
  assert.equal(capture.processor.history.length, 3840);
  assert.equal(capture.processor.frame.length, 320);
});

test('the noise estimate follows the room while quiet speech above it can still start a segment', () => {
  const { segments } = record(SAMPLE_RATE, 5, [[2, 2.3, 0.008]], 0.003);
  assert.deepEqual(segments.map(bounds), [[1.8, 2.46, 2.904]]);
});

for (const smoothing of [0.6, 0.9]) {
  test(`steady filtered noise (smoothing ${smoothing}) stays quiet and does not mask utterance endpoints`, () => {
    const duration = 20;
    const noise = filteredNoise(duration, smoothing, 0.006);
    const speech = synthesize(SAMPLE_RATE, duration, [[2, 2.4, 0.025], [11, 11.4, 0.025]]);
    const withLateNoise = speech.slice();
    for (let i = 0; i < noise.length; i++) speech[i] += noise[i];

    assert.deepEqual(recordPcm(SAMPLE_RATE, noise).map(bounds), [], 'Noise alone never submits');
    assert.deepEqual(recordPcm(SAMPLE_RATE, speech).map(bounds), [[1.8, 2.56, 3], [10.8, 11.56, 12]]);

    // Speech ends at 2.4 s. Allow up to 200 ms of noise adaptation on top of
    // the 600 ms endpoint pause, and verify that the next utterance can start.
    const lateNoiseStart = 2.2 * SAMPLE_RATE;
    withLateNoise.set(speech.subarray(lateNoiseStart), lateNoiseStart);
    const [first, ...remaining] = recordPcm(SAMPLE_RATE, withLateNoise);
    assert.deepEqual(remaining.map(bounds), [[10.8, 11.56, 12]]);
    assert.equal(roundSeconds(first.start), 1.8);
    assert.ok(first.submitted >= 3 && first.submitted < 3.2);
  });
}

test('steady mains hum is silent by itself and preserves endpoints in mixed speech', () => {
  const duration = 13;
  for (const frequency of [120, 100]) {
    const hum = synthesize(SAMPLE_RATE, duration, [], 0.0003);
    const speech = synthesize(SAMPLE_RATE, duration, [[2.2, 2.8, 0.025], [8.4, 8.8, 0.025]]);
    for (let i = 0; i < hum.length; i++) {
      const phase = i / SAMPLE_RATE * 2 * Math.PI * frequency;
      hum[i] += 0.006 * Math.sin(phase) + 0.0018 * Math.sin(2 * phase);
      speech[i] += hum[i];
    }
    assert.deepEqual(recordPcm(SAMPLE_RATE, hum).map(bounds), [], `${frequency} Hz hum alone`);
    assert.deepEqual(recordPcm(SAMPLE_RATE, speech).map(bounds), [
      [2, 2.96, 3.4], [8.2, 8.96, 9.4],
    ], `Speech over ${frequency} Hz hum`);
  }

  // These pitches also repeat at a mains period but have no mains fundamental.
  for (const frequency of [200, 300, 360]) {
    const pcm = new Float32Array(2 * SAMPLE_RATE);
    for (let i = 0.4 * SAMPLE_RATE; i < 0.8 * SAMPLE_RATE; i++) {
      pcm[i] = 0.006 * Math.sin(i / SAMPLE_RATE * 2 * Math.PI * frequency);
    }
    assert.deepEqual(
      recordPcm(SAMPLE_RATE, pcm).map(bounds), [[0.2, 0.96, 1.4]], `${frequency} Hz voice proxy`,
    );
  }
});

test('quiet recorded speech reaches recognition after a broadband or filtered noise burst', async () => {
  const wav = readFileSync(new URL('./fixtures/ai-livestream/en-quiet.wav', import.meta.url));
  let speech;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.toString('ascii', offset, offset + 4) === 'data') {
      speech = Float32Array.from({ length: size / 2 }, (_, i) =>
        wav.readInt16LE(offset + 8 + 2 * i));
      break;
    }
    offset += 8 + size + (size % 2);
  }
  assert.ok(speech);
  const rms = Math.sqrt(speech.reduce((sum, sample) => sum + sample ** 2, 0) / speech.length);
  const quiet = new Float32Array(6 * SAMPLE_RATE);
  quiet.set(speech.map(sample => sample * 0.02 / rms), 0.7 * SAMPLE_RATE);
  const baseline = recordPcm(SAMPLE_RATE, quiet);
  assert.equal(baseline.length, 1);
  const [clean] = baseline;
  assert.equal(roundSeconds(clean.submitted), 4.144);

  const received = [];
  const infer = await createInference(async task => {
    if (task === 'automatic-speech-recognition') return async (audio, options) => {
      received.push({ audio, language: options.language });
      return { text: '' };
    };
  }, { backends: { onnx: { wasm: {} } } }, () => {});
  const bursts = [
    ['broadband', synthesize(SAMPLE_RATE, 0.02, [], 0.7), [0.5, 0.51]],
    ['filtered', filteredNoise(0.02, 0.6, 0.1), [0.3, 0.31]],
  ];
  for (const [type, burst, starts] of bursts) {
    for (const start of starts) {
      const pcm = quiet.slice();
      pcm.set(burst, start * SAMPLE_RATE);
      const segments = recordPcm(SAMPLE_RATE, pcm);
      assert.deepEqual(segments.map(bounds), [bounds(clean)], `${type} burst at ${start} s`);
      const [segment] = segments;
      if (type === 'filtered') assert.deepEqual(segment.audio, clean.audio);
      await infer(segment.audio, 'en');
      const result = received.shift();
      assert.equal(result?.audio, segment.audio);
      assert.equal(result.language, 'english');
      assert.equal(received.length, 0);
    }
  }
});

test('a stalled UI holds only one transferred segment and capture resumes on acknowledgement', () => {
  const messages = [];
  const capture = makeCapture(SAMPLE_RATE, segment => messages.push(segment));
  capture.feed(synthesize(SAMPLE_RATE, 22, [[0.4, 21.4]]));
  assert.equal(messages.length, 1);
  assert.ok(capture.processor.length < MAX_SEGMENT_SAMPLES);
  assert.equal(capture.processor.buffer.length, MAX_SEGMENT_SAMPLES);
  capture.ack();
  capture.feed(synthesize(SAMPLE_RATE, 2, [[0.2, 0.5]]));
  assert.equal(messages.length, 2);
  assert.equal(messages[1].dropped, 3);
  assert.deepEqual(bounds(messages[1]), [22, 22.66, 23.104]);
});
