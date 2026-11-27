import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SAMPLE_RATE } from '../../../projects/ai-livestream/audio-format.mjs';

class Worklet {
  port = {};
}

let Processor;
try {
  globalThis.AudioWorkletProcessor = Worklet;
  globalThis.registerProcessor = (_, constructor) => { Processor = constructor; };
  await import('../../../projects/ai-livestream/audio-worklet.js');
} finally {
  delete globalThis.AudioWorkletProcessor;
  delete globalThis.registerProcessor;
}

export function makeCapture(rate, receive, Legacy) {
  let processor;
  if (Legacy) {
    processor = new Legacy();
  } else {
    try {
      globalThis.sampleRate = rate;
      processor = new Processor();
    } finally {
      delete globalThis.sampleRate;
    }
  }
  let samples = 0;
  processor.port.postMessage = (data, transfer) => {
    const audio = Legacy ? data : data.audio;
    if (!(audio instanceof Float32Array)) return;
    const submitted = samples / rate;
    // Messages are observed at the end of a render quantum. The capture clock
    // itself advances in 20 ms frames, or six seconds for the old implementation.
    const frameSeconds = Legacy ? 6 : 0.02;
    const cut = Math.floor((submitted + 1e-9) / frameSeconds) * frameSeconds;
    const start = cut - (Legacy ? audio.length : processor.length) / SAMPLE_RATE;
    receive({
      audio, transfer, dropped: data.dropped,
      start, end: start + audio.length / SAMPLE_RATE, submitted,
    });
  };
  return {
    processor,
    ack: () => processor.port.onmessage({ data: 'ack' }),
    feed(pcm) {
      for (let offset = 0; offset < pcm.length; offset += 128) {
        const block = pcm.subarray(offset, offset + 128);
        samples += block.length;
        processor.process([[block]]);
      }
    },
  };
}

export function synthesize(rate, duration, speech, noise = 0) {
  const pcm = new Float32Array(Math.round(duration * rate));
  let seed = 66;
  if (noise) {
    for (let i = 0; i < pcm.length; i++) {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      pcm[i] = noise * (seed / 2 ** 31 - 1);
    }
  }
  // A few harmonics exercise the energy gate without embedding recordings.
  for (const [start, end, peak = 0.05] of speech) {
    for (let i = Math.round(start * rate); i < Math.round(end * rate); i++) {
      const phase = i / rate * 2 * Math.PI * 200;
      pcm[i] += peak * (Math.sin(phase) + 0.25 * Math.sin(3 * phase));
    }
  }
  return pcm;
}

export const roundSeconds = value => Number(value.toFixed(3));

if (process.argv[2] === '--compare' && process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = execFileSync('git', [
    'show', 'dbf8bdef574bbb48868786b06ac291a731588057:projects/ai-livestream/audio-worklet.js',
  ], { encoding: 'utf8' });
  let Legacy;
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source)(
    Worklet, (_, constructor) => { Legacy = constructor; }, SAMPLE_RATE,
  );
  const patterns = [
    { name: 'Short', duration: 6.4, speech: [[0.4, 0.54]] },
    { name: 'Internal pause', duration: 6.4, speech: [[0.8, 1.42], [1.8, 2.36]] },
    { name: 'Boundary and multiple utterances', duration: 12.8, speech: [[5.52, 6.44], [7.7, 8.6], [10, 11]] },
    { name: 'Continuous', duration: 18.4, speech: [[0.4, 15.4]] },
    { name: 'Noise', duration: 6.4, speech: [], noise: 0.05 },
  ].map(pattern => ({
    ...pattern, pcm: synthesize(SAMPLE_RATE, pattern.duration, pattern.speech, pattern.noise),
  }));
  for (const legacy of [Legacy, undefined]) {
    function replay(pattern, receive = () => {}) {
      let acknowledge = false;
      const capture = makeCapture(SAMPLE_RATE, segment => {
        acknowledge = true;
        receive(segment);
      }, legacy);
      // Simulate an idle ASR worker and a UI acknowledging each quantum.
      for (let i = 0; i < pattern.pcm.length; i += 128) {
        capture.feed(pattern.pcm.subarray(i, i + 128));
        if (acknowledge) {
          capture.ack();
          acknowledge = false;
        }
      }
    }
    console.log(legacy ? 'Fixed windows' : 'Utterance endpointing');
    for (const pattern of patterns) {
      const segments = [];
      replay(pattern, ({ audio, start, end, submitted }) => {
        // The historical worker also rejected windows below RMS 0.006.
        if (legacy && Math.sqrt(audio.reduce((sum, x) => sum + x * x, 0) / audio.length) < 0.006) return;
        const lastVoice = pattern.speech.filter(([from]) => from < end).at(-1);
        segments.push({
          start: roundSeconds(start), end: roundSeconds(end), submitted: roundSeconds(submitted),
          afterLastVoice: lastVoice ? roundSeconds(submitted - Math.min(end, lastVoice[1])) : null,
          seconds: audio.length / SAMPLE_RATE,
        });
      });
      console.log(pattern.name, JSON.stringify({
        segments, calls: segments.length,
        audioSeconds: roundSeconds(segments.reduce((total, segment) => total + segment.seconds, 0)),
      }));
    }
    const rounds = 100;
    for (let i = 0; i < 10; i++) for (const pattern of patterns) replay(pattern);
    const started = performance.now();
    const cpuStarted = process.cpuUsage();
    for (let i = 0; i < rounds; i++) for (const pattern of patterns) replay(pattern);
    const cpu = process.cpuUsage(cpuStarted);
    console.log(JSON.stringify({ inputSeconds: rounds * patterns.reduce((sum, p) => sum + p.duration, 0),
      elapsedMs: roundSeconds(performance.now() - started), cpuMs: (cpu.user + cpu.system) / 1000 }));
  }
}
