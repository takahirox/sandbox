// Summarize a measurement run and its separately reviewed quality annotations.
import { readFile } from 'node:fs/promises';

const fixtures = new URL('../tests/fixtures/ai-livestream/', import.meta.url);
const [reportPath = new URL('tuning-benchmark.json', fixtures),
  ratingsPath = new URL('tuning-ratings.json', fixtures)] = process.argv.slice(2);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const [report, ratings, holdout] = await Promise.all([
  json(reportPath), json(ratingsPath), json(new URL('tuning-holdout.json', fixtures)),
]);

const outputKey = text => text?.replace(/^<think>\s*<\/think>/i, '')
  .normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\p{S}\s]/gu, '');
function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (!sorted.length) return null;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function quality(rows, reviewed) {
  const shown = rows.filter(row => row.comment);
  if (Object.keys(reviewed).length !== shown.length ||
      shown.some(({ id, comment }) => reviewed[id]?.comment !== comment)) {
    throw Error('Re-review the displayed comments before applying the quality annotations');
  }
  const flags = shown.map(({ id }) => reviewed[id].flags);
  const raw = rows.map(row => outputKey(row.raw)).filter(key => key && key !== 'skip');
  return {
    opportunities: rows.filter(row => !row.withhold).length,
    shown: shown.length,
    relevant: flags.filter(flag => flag.includes('R')).length,
    natural: flags.filter(flag => flag.includes('N')).length,
    unsupported: flags.filter(flag => flag.includes('F')).length,
    useful: shown.filter(({ id, withhold }) => !withhold && reviewed[id].flags.includes('R') &&
      reviewed[id].flags.includes('N') && !reviewed[id].flags.includes('F')).length,
    withhold: rows.filter(row => row.withhold).length,
    correctlyWithheld: rows.filter(row => row.withhold && !row.comment).length,
    questions: shown.filter(row => /[?？]/u.test(row.comment)).length,
    exactRawDuplicates: raw.length - new Set(raw).size,
    exactShownDuplicates: shown.length - new Set(shown.map(row => outputKey(row.comment))).size,
    medianGenerationMs: median(rows.map(row => row.generation_ms)),
    medianVisibleMs: median(shown.map(row => row.jobMs)),
  };
}

for (const mode of report.modes) {
  const reviewed = ratings[mode.mode];
  const audio = mode.audio.map(row => ({ ...row, id: row.file }));
  const heldOut = mode.text.map(({ id, turns }) => ({
    id, withhold: holdout.find(row => row.id === id).withhold, ...turns.at(-1),
  }));
  console.log(JSON.stringify({
    mode: mode.mode,
    audio: quality(audio, reviewed.audio),
    heldOut: quality(heldOut, reviewed.heldOut),
  }, null, 2));
}
