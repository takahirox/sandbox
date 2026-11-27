import { SAMPLE_RATE, MIN_SEGMENT_SAMPLES, MAX_SEGMENT_SAMPLES } from './audio-format.mjs';

const FRAME = SAMPLE_RATE * 0.02;
const ONSET_FRAMES = 3;
const PRE_ROLL = SAMPLE_RATE * 0.2 + (ONSET_FRAMES - 1) * FRAME;
const END_PAUSE = SAMPLE_RATE * 0.6;
const TAIL = SAMPLE_RATE * 0.16;
const MIN_VOICED_FRAMES = MIN_SEGMENT_SAMPLES / FRAME;
const PITCH_STEP = 4;
const MIN_PITCH_LAG = SAMPLE_RATE / 400;
const MAX_PITCH_LAG = SAMPLE_RATE / 80;
const HUM_PERIODS = [100, 120].map(hz => {
  const lag = Math.round(SAMPLE_RATE / hz);
  const length = Math.round(lag / PITCH_STEP);
  return {
    lag,
    sine: Float32Array.from({ length }, (_, i) => Math.sin(2 * Math.PI * i / length)),
    cosine: Float32Array.from({ length }, (_, i) => Math.cos(2 * Math.PI * i / length)),
  };
});

function hasMainsHum(frame, power) {
  for (const { lag, sine, cosine } of HUM_PERIODS) {
    const count = FRAME - lag;
    let periodError = 0;
    for (let i = 0; i < count; i += PITCH_STEP) {
      periodError += (frame[i] - frame[i + lag]) ** 2;
    }
    if (periodError >= 0.025 * Math.ceil(count / PITCH_STEP) * power) continue;

    // Higher pitches can also repeat at a mains period. Project one cycle
    // onto the fundamental and require it to account for about half the power.
    let inPhase = 0, quadrature = 0;
    for (let i = 0; i < sine.length; i++) {
      inPhase += frame[i * PITCH_STEP] * cosine[i];
      quadrature += frame[i * PITCH_STEP] * sine[i];
    }
    if (inPhase ** 2 + quadrature ** 2 > 0.25 * sine.length ** 2 * power) return true;
  }
  return false;
}

function hasPeriodicSignal(frame, mean) {
  // Use the same starting samples for each lag and skip three of every four
  // samples. This checks for repetition in the 80–400 Hz pitch range.
  const count = FRAME - MAX_PITCH_LAG;
  let energy = 0;
  for (let i = 0; i < count; i += PITCH_STEP) {
    const value = frame[i] - mean;
    energy += value * value;
  }
  for (let lag = MIN_PITCH_LAG; lag <= MAX_PITCH_LAG; lag += PITCH_STEP) {
    let correlation = 0, lagEnergy = 0;
    for (let i = 0; i < count; i += PITCH_STEP) {
      const shifted = frame[i + lag] - mean;
      correlation += (frame[i] - mean) * shifted;
      lagEnergy += shifted * shifted;
    }
    if (correlation > 0 && correlation ** 2 >= 0.6 ** 2 * energy * lagEnergy) return true;
  }
  return false;
}

// All capture state stays on the audio thread, with one transferable message in flight.
class SpeechSegment extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputRate = sampleRate;
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
    this.frame = new Float32Array(FRAME);
    this.frameLength = 0;
    this.history = new Float32Array(PRE_ROLL);
    this.historyEnd = 0;
    this.historyLength = 0;
    this.buffer = new Float32Array(MAX_SEGMENT_SAMPLES);
    this.length = 0;
    this.noisePower = 0.001 ** 2;
    this.previousNoisePower = 0;
    this.olderNoisePower = 0;
    this.onset = 0;
    this.voicedFrames = 0;
    this.lastVoice = 0;
    this.continuation = false;
    this.inFlight = false;
    this.dropped = 0;
    this.port.onmessage = ({ data }) => {
      if (data === 'ack') this.inFlight = false;
    };
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i];
      this.count++;
      this.phase += SAMPLE_RATE;
      if (this.phase < this.inputRate) continue;
      // Average while downsampling, repeat if the input rate is below 16 kHz.
      const value = this.sum / this.count;
      this.sum = 0;
      this.count = 0;
      do {
        this.phase -= this.inputRate;
        this.frame[this.frameLength++] = value;
        if (this.frameLength === FRAME) {
          this.processFrame();
          this.frameLength = 0;
        }
      } while (this.phase >= this.inputRate);
    }
    return true;
  }

  processFrame() {
    let sum = 0, energy = 0, differenceEnergy = 0, previous = this.frame[0];
    for (let i = 0; i < FRAME; i++) {
      const value = this.frame[i];
      const difference = value - previous;
      previous = value;
      sum += value;
      energy += value * value;
      differenceEnergy += difference * difference;
    }
    // Remove DC from the power estimate. Adjacent samples in broadband noise
    // differ much more than samples in the lower-frequency part of speech.
    const mean = sum / FRAME;
    const power = Math.max(0, energy / FRAME - mean ** 2);
    const threshold = this.length
      ? Math.max(0.002 ** 2, 1.7 ** 2 * this.noisePower)
      : Math.max(0.003 ** 2, 2.5 ** 2 * this.noisePower);
    const broadband = differenceEnergy >= 1.5 * FRAME * power;
    const voiced = power >= threshold && !broadband && !hasMainsHum(this.frame, power);
    // Smooth background noise can clear the voice gate. Learn its level when
    // the frame lacks pitch repetition, without imposing a pitch gate on speech.
    const rough = differenceEnergy >= 0.5 * FRAME * power;
    const learnNoise = !voiced || rough || !hasPeriodicSignal(this.frame, mean);
    const candidate = learnNoise ? power : this.noisePower;
    // A 20 ms burst can span two frames. Confirm broadband noise and large
    // jumps (over three times the voice-gate RMS) across three frames before
    // raising the floor. Smooth background noise near the gate adapts faster.
    const sustained = broadband || candidate > 3 ** 2 * threshold
      ? Math.min(candidate, this.previousNoisePower, this.olderNoisePower)
      : candidate;
    this.olderNoisePower = this.previousNoisePower;
    this.previousNoisePower = candidate;
    if (learnNoise) {
      // During speech, raise the floor more slowly for smooth frames so a
      // speech frame without a clear pitch has less effect on the endpoint.
      const rise = voiced && (rough || !this.length) ? 0.15 : 0.05;
      this.noisePower += candidate > this.noisePower
        ? Math.max(0, sustained - this.noisePower) * rise
        : (candidate - this.noisePower) * 0.01;
    }

    if (!this.length) {
      this.onset = voiced ? this.onset + 1 : 0;
      if (this.onset === ONSET_FRAMES) {
        const start = (this.historyEnd + PRE_ROLL - this.historyLength) % PRE_ROLL;
        const first = Math.min(this.historyLength, PRE_ROLL - start);
        this.buffer.set(this.history.subarray(start, start + first));
        this.buffer.set(this.history.subarray(0, this.historyLength - first), first);
        this.length = this.historyLength;
        this.voicedFrames = ONSET_FRAMES - 1;
      }
    }
    this.history.set(this.frame, this.historyEnd);
    this.historyEnd = (this.historyEnd + FRAME) % PRE_ROLL;
    this.historyLength = Math.min(PRE_ROLL, this.historyLength + FRAME);

    if (!this.length) return;
    this.buffer.set(this.frame, this.length);
    this.length += FRAME;
    if (voiced) {
      this.lastVoice = this.length;
      this.voicedFrames++;
    }
    const quiet = this.length - this.lastVoice;
    if (quiet < END_PAUSE && this.length < MAX_SEGMENT_SAMPLES) return;

    if (this.voicedFrames >= (this.continuation ? 1 : MIN_VOICED_FRAMES)) {
      if (this.inFlight) {
        this.dropped = Math.min(1e9, this.dropped + 1);
      } else {
        const audio = this.buffer.slice(0, Math.min(this.length, this.lastVoice + TAIL));
        this.inFlight = true;
        this.port.postMessage({ type: 'segment', audio, dropped: this.dropped }, [audio.buffer]);
        this.dropped = 0;
      }
    }
    this.voicedFrames = 0;
    this.onset = 0;
    // At the cap, split at the quiet tail if present. During sustained speech,
    // carry a short overlap across the cut so decoding can recover cut syllables.
    this.continuation = quiet < TAIL;
    if (this.continuation) {
      this.buffer.copyWithin(0, this.length - TAIL, this.length);
      this.length = TAIL;
      this.lastVoice = TAIL - quiet;
    } else {
      this.length = 0;
      this.lastVoice = 0;
    }
  }
}

registerProcessor('speech-segment', SpeechSegment);
