// Review anonymous synthetic examples with --review, then score the saved flags.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { replayTuningMode } from './score_livestream_tuning.mjs';

const [reportPath, ratingsPath] = process.argv.slice(2);
if (!reportPath || !ratingsPath)
  throw Error('Usage: node scripts/score_livestream_expanded.mjs <benchmark.json> <ratings.json|--review>');
const bytes = await readFile(reportPath);
const report = JSON.parse(bytes);
const fixture = await readFile(new URL('../tests/fixtures/ai-livestream/expanded-holdout.json', import.meta.url));
const digest = data => createHash('sha256').update(data).digest('hex');
if (digest(fixture) !== report.holdoutSha256) throw Error('Transcript fixture changed');
const holdout = JSON.parse(fixture);
const clean = raw => raw?.replace(/^\s*<think>\s*<\/think>/i, '').trim() ?? '';
const isReply = text => Boolean(text) && !/^skip$/i.test(text);
const canonical = text => text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\p{S}\s]/gu, '');
const same = (a, b) => a.normalize('NFKC') === b.normalize('NFKC');
const rows = [];
for (const mode of report.modes) {
  const replay = await replayTuningMode(mode, holdout, { transcriptFirst: true });
  for (const [index, sample] of replay.text.entries()) {
    const fixture = holdout[index];
    if (sample.id !== fixture.id) throw Error('Transcript fixture order changed');
    const row = sample.turns.at(-1);
    const stored = mode.text[index].turns.at(-1);
    if (row.comment !== stored.comment || JSON.stringify(row.events) !== JSON.stringify(stored.events))
      throw Error(`Pipeline replay diverged for ${mode.mode} / ${row.transcript}`);
    rows.push({ ...fixture, mode: mode.mode, raw: clean(row.raw), comment: row.comment,
      generationMs: stored.generation_ms, visibleMs: row.comment ? stored.jobMs : undefined });
  }
}

const shuffled = [...rows].sort((a, b) =>
  digest(a.id + a.mode).localeCompare(digest(b.id + b.mode)));
shuffled.forEach((row, index) => { row.reviewId = index + 1; });
if (ratingsPath === '--review') {
  for (const row of shuffled) {
    console.log(JSON.stringify({
      id: row.reviewId, turns: row.turns, withhold: row.withhold,
      raw: row.raw, shown: row.comment,
    }));
  }
} else {
  const { benchmarkSha256, flags } = JSON.parse(await readFile(ratingsPath, 'utf8'));
  if (digest(bytes) !== benchmarkSha256) throw Error('Benchmark changed since rating');
  for (const row of rows) {
    const rated = flags[row.reviewId];
    const sides = isReply(row.raw) && isReply(row.comment) && !same(row.raw, row.comment) ? 2 : 1;
    if ((isReply(row.raw) || isReply(row.comment)) &&
        (typeof rated !== 'string' || rated.split('/').length !== sides || !/^[RNFIQ-]+(?:\/[RNFIQ-]+)?$/.test(rated)))
      throw Error(`Missing or invalid rating for item ${row.reviewId}`);
    row.rawGrade = isReply(row.raw) ? rated.split('/')[0] : '';
    row.shownGrade = isReply(row.comment) ? rated.split('/').at(-1) : '';
  }
  const median = values => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length ? (sorted[mid] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2 : null;
  };
  const metrics = (examples, field, grade) => {
    const replies = examples.filter(row => isReply(row[field]));
    const flags = letter => replies.filter(row => row[grade].includes(letter)).length;
    const unique = new Set(replies.map(row => canonical(row[field]))).size;
    const isQuestion = row => /[?？]/u.test(row[field]) || row[grade].includes('Q');
    const questions = replies.filter(isQuestion).length;
    const useful = replies.filter(row => !row.withhold && row[grade].includes('R') &&
      row[grade].includes('N') && !/[FI]/.test(row[grade]));
    const usefulQuestions = useful.filter(isQuestion).length;
    return {
      opportunities: examples.filter(row => !row.withhold).length,
      responses: replies.length,
      relevant: flags('R'), natural: flags('N'), unsupported: flags('F'), inappropriate: flags('I'),
      useful: useful.length,
      usefulQuestions, usefulReactions: useful.length - usefulQuestions,
      withheld: examples.filter(row => row.withhold && !isReply(row[field])).length,
      withholdingCases: examples.filter(row => row.withhold).length,
      unique, repeats: replies.length - unique, questions, otherReplies: replies.length - questions,
      japaneseNeEndings: replies.filter(row => row.language === 'ja' && /ね[。！!？?\s]*$/u.test(row[field])).length,
    };
  };
  for (const mode of report.modes) {
    const examples = rows.filter(row => row.mode === mode.mode);
    console.log(JSON.stringify({
      model: mode.mode,
      generationMs: median(examples.map(row => row.generationMs)),
      visibleMs: median(examples.map(row => row.visibleMs)),
      languages: Object.fromEntries(['ja', 'en'].map(language => {
        const subset = examples.filter(row => row.language === language);
        return [language, {
          raw: metrics(subset, 'raw', 'rawGrade'),
          displayed: metrics(subset, 'comment', 'shownGrade'),
          usefulFiltered: subset.filter(row => !row.withhold && !row.comment &&
            row.rawGrade.includes('R') && row.rawGrade.includes('N') && !/[FI]/.test(row.rawGrade)).length,
        }];
      })),
    }, null, 2));
  }
}
