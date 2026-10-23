import { ASR, LLM } from './config.mjs';

// Closed vocabulary: runtime exceptions, speech and arbitrary worker fields
// cannot become diagnostic text. Counts are ephemeral and bounded.
const events = new Set(`audio_windows vad_silence vad_busy audio_submitted audio_pending
  audio_received invalid_audio silence asr_attempt asr_error meaningless_speech
  transcription_accepted repeated_speech cadence generation_attempt generation_error
  reasoning format language safety generic_or_visual length duplicate echo topic
  no_lexical_overlap awaiting_context stale_topic output_discarded output_accepted worker_result
  ui_comment ui_discard engagement_tick`.split(/\s+/));
export class Diagnostics {
  constructor() { this.counts = {}; this.timings = {}; this.lastComment = null; }
  record(event, value, now = performance.now()) {
    if (events.has(event)) this.counts[event] = Math.min(1e9, (this.counts[event] || 0) + 1);
    if (['asr_ms', 'generation_ms'].includes(event) && Number.isFinite(value))
      this.timings[event] = Math.round(Math.max(0, Math.min(90000, value)));
    if (event === 'ui_comment') this.lastComment = now;
  }
  summary(now = performance.now()) {
    return JSON.stringify({ asr: `${ASR.id} / q8 WASM`,
      model: `${LLM.id} / WebLLM 0.2.85 WebGPU`,
      counts: this.counts, timings: this.timings,
      secondsSinceComment: this.lastComment === null ? null : Math.floor((now - this.lastComment) / 1000) });
  }
}
