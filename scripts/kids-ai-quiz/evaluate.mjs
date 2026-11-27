import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { facts, starter } from '../../projects/kids-ai-quiz/content.mjs';
import { attempts, generateTokens, instantiateModel, modelURL } from '../../projects/kids-ai-quiz/model.mjs';
import { createSession, decode, hasStructure, validate } from '../../projects/kids-ai-quiz/quiz.mjs';
import { benchmarkAnswers, independentAnswers } from './answer-key.mjs';
import { heldOut, seeded } from './dataset.mjs';

assert.deepEqual(new Set(Object.keys(benchmarkAnswers)), heldOut);

const roundsPerFact = 60;
const benchmarkFacts = facts.filter(fact => heldOut.has(fact.id));
const shortJapanese = /^[ぁ-ゖー0-9 「」、。！？]+$/u;

function example(item, tokens, failedChecks = []) {
  return {
    question: item.question,
    choices: item.choices.map(choice => choice.label),
    correctChoice: item.choices[item.correct].label,
    tokens,
    failedChecks,
  };
}

async function measure(bytes) {
  const start = performance.now();
  const { sample, memoryBytes } = await instantiateModel(bytes);
  const loadMs = performance.now() - start;
  const random = seeded(64064);
  // Warm the sampler with a separate seed.
  const warmup = seeded(6464);
  for (let i = 0; i < 100; i++) generateTokens(sample, i % 7, warmup);

  const counts = { structured: 0, singleAnswer: 0, childLanguage: 0, relevant: 0, accepted: 0, playableRounds: 0 };
  const examples = {};
  let closeRepeats = 0, combinations = 0;
  const timings = [];
  for (const fact of benchmarkFacts) {
    const expectedLabel = benchmarkAnswers[fact.id][2];
    const recent = [], unique = new Set();
    for (let i = 0; i < roundsPerFact; i++) {
      let playable = false;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const before = performance.now();
        const tokens = generateTokens(sample, fact.topic, random);
        timings.push((performance.now() - before) * 1000);
        if (!hasStructure(tokens)) continue;
        counts.structured++;
        const item = decode(fact, tokens);
        const labels = item.choices.map(choice => choice.label);
        const matches = independentAnswers(item);
        const singleAnswer = new Set(labels).size === 3 && matches.length === 1
          && matches[0] === item.choices[item.correct] && matches[0].label === expectedLabel;
        const childLanguage = shortJapanese.test(item.question) && [...item.question].length <= 45;
        const relevant = item.choices.every(choice => choice.topic === fact.topic);
        const passed = { singleAnswer, childLanguage, relevant };
        for (const [check, ok] of Object.entries(passed)) counts[check] += Number(ok);

        const accepted = Object.values(passed).every(Boolean);
        assert.equal(Boolean(validate(fact, tokens)), accepted);
        if (accepted) {
          counts.accepted++;
          playable = true;
          const pair = labels.filter(label => label !== expectedLabel).sort().join('|');
          if (recent.includes(pair)) closeRepeats++;
          recent.push(pair);
          if (recent.length > 4) recent.shift();
          unique.add(pair);
          examples.accepted ??= example(item, tokens);
        } else {
          for (const [check, ok] of Object.entries(passed)) {
            if (!ok) examples[check] ??= example(item, tokens, Object.keys(passed).filter(key => !passed[key]));
          }
        }
      }
      counts.playableRounds += Number(playable);
    }
    combinations += unique.size;
  }
  timings.sort((a, b) => a - b);
  const quantile = p => Number(timings[Math.floor(p * (timings.length - 1))].toFixed(3));
  return {
    counts,
    meanDistinctAcceptedPairsPerFact: combinations / benchmarkFacts.length,
    repeatedAcceptedPairInLastFour: closeRepeats,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    wasmLinearMemoryBytes: memoryBytes,
    instantiateMs: Number(loadMs.toFixed(3)),
    tokenSamplingMicroseconds: { median: quantile(0.5), p95: quantile(0.95) },
    examples,
  };
}

const scratch = await mkdtemp(join(tmpdir(), 'kids-quiz-'));
try {
  const baselinePath = join(scratch, 'baseline.wasm');
  const rebuiltPath = join(scratch, 'adapted.wasm');
  execFileSync('python3', [fileURLToPath(new URL('./train.py', import.meta.url)), '--output', rebuiltPath, '--baseline', baselinePath]);
  const [baselineBytes, rebuiltBytes, shippedBytes] = await Promise.all([
    readFile(baselinePath), readFile(rebuiltPath), readFile(modelURL),
  ]);
  assert.deepEqual(rebuiltBytes, shippedBytes, 'The shipped version must match reproducible training');
  const baseline = await measure(baselineBytes);
  const adapted = await measure(shippedBytes);

  const session = createSession(seeded(64064));
  const rounds = [starter, ...Array.from({ length: 489 }, () => session.next())];
  let adjacentTopics = 0, recentFacts = 0;
  for (let i = 1; i < rounds.length; i++) {
    adjacentTopics += Number(rounds[i].topic === rounds[i - 1].topic);
    recentFacts += Number(rounds.slice(Math.max(0, i - 12), i).includes(rounds[i]));
  }
  console.log(JSON.stringify({
    environment: { os: platform(), release: release(), arch: process.arch, runtime: process.version },
    heldOutFacts: benchmarkFacts.length,
    proposals: benchmarkFacts.length * roundsPerFact * attempts,
    rounds: benchmarkFacts.length * roundsPerFact,
    baseline,
    adapted,
    rotation: { rounds: rounds.length, adjacentTopics, recentFacts },
  }, null, 2));
  assert.ok(adapted.counts.structured > 0.99 * benchmarkFacts.length * roundsPerFact * attempts);
  assert.ok(adapted.counts.accepted > baseline.counts.accepted);
  assert.ok(adapted.counts.playableRounds >= 0.99 * benchmarkFacts.length * roundsPerFact);
  assert.equal(adjacentTopics + recentFacts, 0);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
