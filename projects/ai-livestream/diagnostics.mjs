import { ASR, LLM, TUNED_MODEL_ID } from './config.mjs';

// Closed vocabulary: runtime exceptions, speech and arbitrary worker fields
// cannot become diagnostic text. Counts are ephemeral and bounded.
const events = new Set(`audio_windows vad_silence vad_busy audio_submitted audio_pending
  audio_received invalid_audio silence asr_attempt asr_error meaningless_speech
  transcription_accepted repeated_speech cadence generation_attempt generation_error
  reasoning format safety visual length awaiting_context stale_candidate
  output_discarded output_accepted worker_result
  ui_comment ui_discard engagement_tick`.split(/\s+/));
export class Diagnostics {
  constructor(model = 'tuned') {
    this.backend = model === 'baseline' ? 'WebLLM 0.2.85' : 'wllama 4.0.0';
    this.model = model === 'baseline' ? LLM.id : TUNED_MODEL_ID;
    this.counts = {};
    this.timings = {};
    this.lastComment = null;
  }
  record(event, value, now = performance.now()) {
    if (events.has(event)) this.counts[event] = Math.min(1e9, (this.counts[event] || 0) + 1);
    if (['asr_ms', 'generation_ms'].includes(event) && Number.isFinite(value))
      this.timings[event] = Math.round(Math.max(0, Math.min(90000, value)));
    if (event === 'ui_comment') this.lastComment = now;
  }
  summary(now = performance.now()) {
    return JSON.stringify({ asr: `${ASR.id} / q8 WASM`,
      model: `${this.model} / ${this.backend} WebGPU`,
      counts: this.counts, timings: this.timings,
      secondsSinceComment: this.lastComment === null ? null : Math.floor((now - this.lastComment) / 1000) });
  }
}
