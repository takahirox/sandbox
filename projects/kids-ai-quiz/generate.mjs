import { verifyRound } from './verify.mjs';

export const attempts = 20;
export const nearWindow = 6;

// Prefer new targets and rotate neighboring types. If coverage is saturated,
// an older correct round can still keep play moving.
export function generateRound(model, recent, random) {
  const seen = new Set(recent.map(item => item.key));
  const near = recent.slice(-nearWindow);
  const groups = new Set(near.map(item => item.group));
  const keys = new Set(near.map(item => item.key));
  const topics = new Set(near.slice(-2).map(item => item.topic));
  let best = null, bestScore = Infinity, invalid = 0;
  for (let i = 1; i <= attempts; i++) {
    const item = verifyRound(model.generate(random), random);
    if (!item) {
      invalid++;
      continue;
    }
    if (keys.has(item.key)) continue;
    const score = 4 * Number(seen.has(item.key)) + 2 * Number(groups.has(item.group))
      + Number(topics.has(item.topic));
    if (score === 0) return { item, attempts: i, invalid };
    if (score < bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return { item: best, attempts, invalid };
}
