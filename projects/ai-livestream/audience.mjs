// Engagement represents a small fictional stream, never a number of AI jobs.
// Pure state with an injected clock/random source; no timers, storage or networking.
import { meaningfulSpeech } from './config.mjs';

const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
export const AUDIENCE_LIMITS = Object.freeze({ viewers: 180, likes: 500, subscribers: 30 });

export function speechInterest(text, language, rms = 0) {
  if (!meaningfulSpeech(text)) return 0;
  const words = [...new Intl.Segmenter(language, { granularity: 'word' }).segment(text)]
    .filter(w => w.isWordLike).map(w => w.segment.toLowerCase());
  const variety = new Set(words).size / Math.max(1, words.length);
  const detail = Math.min(1, words.length / 18) * variety;
  const curiosity = /[?？]|\b(why|how|what|wonder|try|because|discovered|fixed)\b|なぜ|どう|理由|発見|試|かな/iu.test(text);
  const invitation = /\b(you|everyone|anyone)\b|皆|みんな/iu.test(text);
  const subdued = /\b(quiet|break|rest|waiting|nothing)\b|静か|休|待って|特にない/iu.test(text);
  // Volume is only a small non-content feature, never emotion or video analysis.
  return clamp(0.15 + detail * 0.28 + Number(curiosity) * 0.25 +
    Number(invitation) * 0.14 + Number(/[!！]/u.test(text)) * 0.08 +
    clamp(rms, 0, 0.1) - Number(subdued) * 0.18, 0.05, 0.95);
}

export class VirtualAudience {
  constructor({ random = Math.random } = {}) {
    this.random = random;
    this.stop();
  }
  start(now) {
    this.stop();
    this.running = true;
    this.lastTick = now;
    this.viewers = this.displayedViewers = 25;
    this.lastDisplay = now;
    return this.snapshot();
  }
  observe(interest, now) {
    if (!this.running || !Number.isFinite(interest) || !Number.isFinite(now)) return;
    this.signal = clamp(interest, 0, 1);
    this.lastSpeech = now;
  }
  tick(now) {
    if (!this.running || !Number.isFinite(now) || now <= this.lastTick) return this.snapshot();
    // Background stalls cannot create a catch-up burst of viewers or reactions.
    const seconds = Math.min(2, (now - this.lastTick) / 1000);
    this.lastTick = now;
    const fresh = clamp(1 - Math.max(0, now - this.lastSpeech - 6000) / 12000, 0, 1);
    const targetInterest = this.signal * fresh;
    this.interest += (targetInterest - this.interest) * (1 - Math.exp(-seconds / 5));
    const target = 9 + 150 * this.interest;
    this.viewers = clamp(this.viewers + clamp((target - this.viewers) * 0.04,
      -0.8, 0.6) * seconds,
      Math.max(5, this.displayedViewers - 3),
      Math.min(AUDIENCE_LIMITS.viewers, this.displayedViewers + 4));
    // Publish at most one gentle change per 25 seconds, including after a stall.
    if (now - this.lastDisplay >= 25000) {
      this.lastDisplay = now;
      const variation = this.random();
      const drift = Math.round((variation - 0.5) * 2);
      const change = clamp(Math.round(this.viewers) - this.displayedViewers + drift, -3, 4);
      // Some viewers leave even during engaging speech.
      this.displayedViewers = clamp(this.displayedViewers +
        (change > 0 && variation < 0.12 ? -1 : change),
        5, AUDIENCE_LIMITS.viewers);
    }
    // Fractional credit avoids a coin flip every frame. Counts stay independent of chat.
    const units = this.viewers / 100;
    this.likeCredit += seconds * units * this.interest ** 2 * 0.16;
    this.subCredit += seconds * units * Math.max(0, this.interest - 0.55) * 0.02;
    if (this.likeCredit >= this.nextLike) {
      this.likes = Math.min(AUDIENCE_LIMITS.likes, this.likes + 1);
      this.likeCredit = 0;
      this.nextLike = 0.8 + this.random() * 0.4;
    }
    if (this.subCredit >= this.nextSub) {
      this.subscribers = Math.min(AUDIENCE_LIMITS.subscribers, this.subscribers + 1);
      this.subCredit = 0;
      this.nextSub = 0.8 + this.random() * 0.4;
    }
    return this.snapshot();
  }
  stop() {
    this.running = false;
    this.displayedViewers = 0;
    this.viewers = this.likes = this.subscribers = this.interest = this.signal = 0;
    this.likeCredit = this.subCredit = 0;
    this.nextLike = this.nextSub = 1;
    this.lastSpeech = -Infinity;
    this.lastTick = 0;
    return this.snapshot();
  }
  snapshot() {
    return { running: this.running, viewers: this.displayedViewers,
      likes: this.likes, subscribers: this.subscribers, interest: this.interest };
  }
}
