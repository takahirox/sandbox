// Replay saved generation for quality scoring and report the original run timings.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WINDOW_SAMPLES } from '../projects/ai-livestream/config.mjs';
import { createInference } from '../projects/ai-livestream/inference.mjs';

const fixtures = new URL('../tests/fixtures/ai-livestream/', import.meta.url);
const json = async path => JSON.parse(await readFile(path, 'utf8'));

export async function replayTuningMode(mode, holdout, { transcriptFirst = false } = {}) {
  let row, events;
  const generate = async () => {
    if (typeof row.raw !== 'string') throw Error('Missing saved model output for replay');
    return [{ generated_text: row.raw }];
  };
  generate.tokenizer = { apply_chat_template: messages => messages };
  const createReplay = () => createInference(async task => task === 'automatic-speech-recognition'
    ? async () => ({ text: row.transcript }) : generate,
  { backends: { onnx: { wasm: {} } } }, () => {}, {
    model: mode.mode === 'candidate' ? 'tuned' : mode.mode,
    failOnGenerationError: true,
    onDiagnostic: (event, value) => { if (value === undefined) events.push(event); },
  });
  const infer = await createReplay();
  const voiced = new Float32Array(WINDOW_SAMPLES).fill(0.02);
  const silence = new Float32Array(WINDOW_SAMPLES);
  const replay = async (infer, record, language, now, audio) => {
    row = record;
    events = [];
    const { comment } = await infer(audio, language, now);
    return { ...record, comment, events };
  };
  const audio = [], text = [];
  const replayAudio = async instance => {
    for (const [index, record] of mode.audio.entries())
      audio.push(await replay(instance, record, record.language, index * 120000, voiced));
  };
  if (!transcriptFirst) await replayAudio(infer);
  for (const [index, { id, turns }] of mode.text.entries()) {
    const fixture = holdout.find(item => item.id === id);
    const replayed = [];
    for (const [turn, record] of turns.entries()) {
      const now = (index + (transcriptFirst ? 0 : mode.audio.length)) * 120000 + turn * 12000;
      replayed.push(await replay(infer, record, fixture.language, now,
        fixture.turns[turn] === null ? silence : voiced));
    }
    text.push({ id, turns: replayed });
  }
  if (transcriptFirst) await replayAudio(await createReplay());
  return { audio, text };
}

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
  };
}

function recordedTimings(rows) {
  return {
    medianGenerationMs: median(rows.map(row => row.generation_ms)),
    medianVisibleMs: median(rows.filter(row => row.comment).map(row => row.jobMs)),
  };
}

export async function scoreTuningMode(mode, reviewed, holdout) {
  // Historical ratings describe what was displayed during the recorded run.
  const audio = mode.audio.map(row => ({ ...row, id: row.file }));
  const heldOut = mode.text.map(({ id, turns }) => {
    const { language, withhold, confirmation } = holdout.find(row => row.id === id);
    const row = turns.at(-1);
    // The initial tuning review applied the camera-question fix to this case.
    const comment = id === 'en-visual' && withhold && !reviewed.heldOut[id] ? '' : row.comment;
    return { id, language, withhold, confirmation, ...row, comment };
  });
  const subset = (rows, annotations) => quality(
    rows, Object.fromEntries(rows.filter(row => row.comment).map(({ id }) => [id, annotations[id]])),
  );
  return {
    mode: mode.mode,
    recordedTimings: {
      audio: recordedTimings(mode.audio),
      heldOut: recordedTimings(mode.text.map(({ turns }) => turns.at(-1))),
    },
    audio: quality(audio, reviewed.audio),
    heldOut: quality(heldOut, reviewed.heldOut),
    japaneseAudio: subset(audio.filter(row => row.language === 'ja' && !row.confirmation), reviewed.audio),
    japaneseConfirmationAudio: subset(audio.filter(row => row.confirmation), reviewed.audio),
    japaneseHeldOut: subset(heldOut.filter(row => row.language === 'ja' && !row.confirmation), reviewed.heldOut),
    englishHeldOut: subset(heldOut.filter(row => row.language === 'en'), reviewed.heldOut),
    japaneseConfirmation: subset(heldOut.filter(row => row.confirmation), reviewed.heldOut),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [reportPath = new URL('tuning-benchmark.json', fixtures),
    ratingsPath = new URL('tuning-ratings.json', fixtures)] = process.argv.slice(2);
  const [report, ratings] = await Promise.all([json(reportPath), json(ratingsPath)]);
  const holdoutBytes = await readFile(new URL(report.holdout ?? 'tuning-holdout.json', fixtures));
  if (createHash('sha256').update(holdoutBytes).digest('hex') !== report.holdoutSha256)
    throw Error('Holdout does not match the recorded run');
  const holdout = JSON.parse(holdoutBytes);
  for (const mode of report.modes) {
    console.log(JSON.stringify(await scoreTuningMode(mode, ratings[mode.mode], holdout), null, 2));
  }
}
