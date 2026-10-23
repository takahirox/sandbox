// A few engagement units represent hundreds of fictional viewers, never AI jobs.
// Pure state with an injected clock/random source; no timers, storage or networking.
import { meaningfulSpeech } from './config.mjs';

const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
export const AUDIENCE_LIMITS = Object.freeze({ viewers: 2400, likes: 10000, subscribers: 500 });

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
    this.viewers = 300;
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
    const target = 90 + 2100 * this.interest;
    this.viewers = clamp(this.viewers + clamp((target - this.viewers) * 0.04,
      -6, 12) * seconds, 50, AUDIENCE_LIMITS.viewers);
    // Fractional credit avoids a coin flip every frame. Counts stay independent of chat.
    const units = this.viewers / 100;
    this.likeCredit += seconds * units * this.interest ** 2 * 0.16;
    this.subCredit += seconds * units * Math.max(0, this.interest - 0.55) * 0.008;
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
    this.viewers = this.likes = this.subscribers = this.interest = this.signal = 0;
    this.likeCredit = this.subCredit = 0;
    this.nextLike = this.nextSub = 1;
    this.lastSpeech = -Infinity;
    this.lastTick = 0;
    return this.snapshot();
  }
  snapshot() {
    return { running: this.running, viewers: Math.round(this.viewers),
      likes: this.likes, subscribers: this.subscribers, interest: this.interest };
  }
}
