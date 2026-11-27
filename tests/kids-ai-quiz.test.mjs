import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relations } from '../projects/kids-ai-quiz/content.mjs';
import { createSession, historyKey, historyLimit, makeRound, puzzles } from '../projects/kids-ai-quiz/quiz.mjs';
import { memoryStorage, seeded } from '../scripts/kids-ai-quiz/evaluate.mjs';

const hiragana = /^[ぁ-ゖー0-9 、。！？]+$/u;
const byKey = new Map(puzzles.map(puzzle => [puzzle.key, puzzle]));
const topics = new Set(puzzles.map(puzzle => puzzle.topic));
const rubric = {
  'call:dog': ['わんわん なくのは？', 'いぬ'],
  'coat:owl': ['ふくろうの せなかを おおうのは？', 'はね'],
  'move:whale': ['くじらは どうやって すすむ？', 'ひれで およぐ'],
  'home:mole': ['もぐらが くらす ところは？', 'つちの なか'],
  'use:broom': ['ゆかの ごみを はくとき つかうのは？', 'ほうき'],
  'wear:gloves': ['てに つけるのは？', 'てぶくろ'],
  'next:thirsty': ['のどが かわいたよ。なにを する？', 'みずを のむ'],
  'place:library': ['おうちで よむ ほんを かりるのは どこ？', 'としょかん'],
  'kind:pear': ['なしは どの なかま？', 'くだもの'],
  'ingredient:corn': ['ぽっぷこーんを つくる もとに なるのは？', 'とうもろこし'],
  'travel:bullet': ['しんかんせんは どこを すすむ？', 'せんろ'],
  'job:ambulance': ['けがを した ひとを びょういんへ はこぶのは どれ？', 'きゅうきゅうしゃ'],
  'shape:triangle': ['おなじ かたちは どれ？', 'さんかく'],
  'corners:circle': ['かどは いくつ？', '0'],
  'corners:rectangle': ['かどは いくつ？', '4'],
  'color:purple': ['おなじ いろは どれ？', 'むらさき'],
};

test('every semantic plan has three distinct child-readable choices and one defensible answer', () => {
  assert.equal(byKey.size, puzzles.length);
  assert.equal(topics.size, 10);
  const contrastSets = new Map(relations.map(([, family, , , groups]) => [family, groups]));
  assert.equal(new Set(Object.keys(rubric).map(key => key.split(':')[0])).size, contrastSets.size);

  for (const puzzle of puzzles) {
    for (const random of [() => 0, () => 0.99999, seeded(68)]) {
      const item = makeRound(puzzle, random);
      const labels = item.choices.map(choice => choice.label);
      const correct = labels[item.correct];
      assert.equal(labels.length, 3, item.key);
      assert.equal(new Set(labels).size, 3, item.key);
      assert.ok([item.question, ...labels].every(text => hiragana.test(text) && [...text].length <= 50), item.key);
      const [family, subject] = item.key.split(':');
      if (rubric[item.key]) assert.deepEqual([item.question, correct], rubric[item.key]);
      let expected;
      if (puzzle.rule === 'relation') {
        const groups = contrastSets.get(family);
        const valid = groups.filter(([, members]) => members.some(([id]) => id === subject));
        assert.equal(valid.length, 1, item.key);
        expected = valid[0][0][1];
        if (family === 'shape' || family === 'color') {
          assert.equal(item.clue.icon, item.choices[item.correct].icon);
          assert.ok(item.choices.filter(choice => choice.icon === item.clue.icon).length === 1);
        }
      } else if (puzzle.rule === 'compare') {
        const options = item.choices.map(choice => choice.count).sort((a, b) => a - b);
        assert.deepEqual(options, item.key.split(':').slice(1).map(Number));
        assert.ok(item.choices.every(choice => choice.icon === item.clue.icon && choice.label.includes(String(choice.count))));
        expected = item.choices.find(choice => choice.count === (item.question.includes('おおい') ? options[2] : options[0])).label;
      } else {
        const { count, crossed, split, spoken } = item.clue;
        const [a, b] = item.key.split(':').slice(1).map(Number);
        assert.equal(spoken.split('、').length, count, item.key);
        if (family === 'add') {
          assert.ok(a <= b, item.key);
          assert.equal(split, a, item.key);
          assert.equal(count - split, b, item.key);
        } else {
          assert.equal(count, a, item.key);
          assert.equal(crossed, b ?? 0, item.key);
          assert.equal(spoken.match(/ばつの/g)?.length ?? 0, crossed, item.key);
        }
        expected = String(count - crossed);
      }
      assert.equal(correct, expected, item.key);
      assert.equal(labels.filter(label => label === expected).length, 1, item.key);
    }
  }
});

test('seeded fresh sessions vary, and reloads avoid recently seen IDs even with the same seed', () => {
  const opener = seed => createSession({ random: seeded(seed) }).next();
  assert.deepEqual(opener(68), opener(68));
  assert.ok(new Set(Array.from({ length: 24 }, (_, i) => opener(68 + i).key)).size >= 8);

  const storage = memoryStorage();
  const keys = [];
  for (let i = 0; i < 24; i++) {
    const { next } = createSession({ random: seeded(68), storage });
    const item = next();
    assert.ok(!keys.slice(-12).includes(item.key));
    if (i) assert.notEqual(item.topic, byKey.get(keys.at(-1)).topic);
    keys.push(item.key);
  }
  assert.ok(new Set(keys).size >= 20);
  assert.deepEqual(JSON.parse(storage.getItem(historyKey)), [...new Set(keys.toReversed())].reverse());
});

test('topic cycles exhaust IDs before recycling and persist only a bounded list of IDs', () => {
  const storage = memoryStorage();
  const { next } = createSession({ random: seeded(68), storage });
  const seen = new Set();
  const expectedPerTopic = new Map([...topics].map(topic => [topic, puzzles.filter(puzzle => puzzle.topic === topic).length]));
  const servedByTopic = new Map();
  let recent = [], lastTopic;
  for (let i = 0; i < 900; i++) {
    const item = next();
    assert.notEqual(item.topic, lastTopic);
    assert.ok(!recent.includes(item.key), item.key);
    const served = (servedByTopic.get(item.topic) ?? 0) + 1;
    servedByTopic.set(item.topic, served);
    if (served <= expectedPerTopic.get(item.topic)) assert.ok(!seen.has(item.key), item.key);
    seen.add(item.key);
    recent = [...recent.slice(-11), item.key];
    lastTopic = item.topic;
  }
  assert.equal(seen.size, puzzles.length);
  const saved = JSON.parse(storage.getItem(historyKey));
  assert.ok(saved.length <= historyLimit);
  assert.equal(new Set(saved).size, saved.length);
  assert.ok(saved.every(key => byKey.has(key)));
  assert.ok(storage.getItem(historyKey).length < 4096);
});

test('solver errors, invalid proposals and inaccessible or damaged storage still give varied playable rounds', () => {
  const broken = {
    getItem() { throw new Error(); },
    setItem() { throw new Error(); },
  };
  for (const getItem of [broken.getItem, () => '{', () => '[{}]', () => 'nope'.repeat(9999)]) {
    const storage = { ...broken, getItem };
    const { next } = createSession({ random: seeded(68), storage, solve() { throw new Error('offline'); } });
    const items = Array.from({ length: 20 }, next);
    assert.deepEqual(new Set(items.map(item => item.topic)), topics);
    assert.equal(new Set(items.map(item => item.key)).size, 20);
    assert.ok(items.every(item => item.choices.length === 3 && item.choices[item.correct]));
    assert.equal(new Set(items.map(item => item.correct)).size, 3);
  }
  const session = createSession({ random: seeded(69), solve: () => ({ key: 'fabricated' }) });
  assert.ok(byKey.has(session.next().key));
});
