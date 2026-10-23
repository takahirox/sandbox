// Six seconds maximum, no recording, storage, or growing queue. Runs off the UI thread.
class SpeechWindow extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(96000);
    this.position = 0;
    this.voiced = 0;
    this.sum = 0;
    this.count = 0;
    this.phase = 0;
    this.pending = false;
    this.port.onmessage = ({ data }) => {
      if (data === 'ack') this.pending = false;
    };
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    let energy = 0;
    for (const value of input) energy += value * value;
    const speech = Math.sqrt(energy / input.length) > 0.012;
    // Average down to 16 kHz even if the device ignores the requested sample rate.
    for (const value of input) {
      this.sum += value;
      this.count++;
      this.phase += 16000;
      if (this.phase < sampleRate) continue;
      this.phase -= sampleRate;
      this.buffer[this.position++] = this.sum / this.count;
      this.sum = 0;
      this.count = 0;
      if (speech) this.voiced++;
      if (this.position === this.buffer.length) {
        if (this.voiced >= 5600 && !this.pending) {
          this.pending = true;
          this.port.postMessage(this.buffer, [this.buffer.buffer]);
        }
        this.buffer = new Float32Array(96000);
        this.position = 0;
        this.voiced = 0;
      }
    }
    return true;
  }
}
registerProcessor('speech-window', SpeechWindow);
