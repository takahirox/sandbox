import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { facts, topics } from '../../projects/kids-ai-quiz/content.mjs';
import { decode, hasOneAnswer, limits, validate } from '../../projects/kids-ai-quiz/quiz.mjs';

export const heldOut = new Set([
  'cat', 'sheep', 'strawberry', 'corn', 'plane', 'fire-engine', 'yellow', 'purple',
  'triangle', 'oval', 'apples-4', 'apples-7', 'umbrella', 'clock',
]);

export function seeded(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function choose(weights, random) {
  let target = random() * weights.reduce((sum, weight) => sum + weight, 0);
  return weights.findIndex(weight => (target -= weight) < 0);
}

const formWeights = [
  [6, 3, 2], [6, 4, 2], [4, 6, 2], [5, 2, 5], [4, 3, 5], [5, 5, 3], [6, 4, 3],
];

function trainingData() {
  const random = seeded(64);
  const baseline = [], adaptation = [];
  const training = facts.filter(fact => !heldOut.has(fact.id));
  assert.equal(new Set(facts.map(fact => fact.id)).size, facts.length);
  for (const topic of topics) {
    assert.equal(topic.forms.length, limits[0]);
    assert.equal(new Set(topic.facts.map(fact => fact.label)).size, topic.facts.length);
    assert.equal(topic.facts.filter(fact => heldOut.has(fact.id)).length, 2);
  }

  for (const fact of training) {
    const topic = fact.topic;
    for (let n = 0; n < 36; n++) {
      // Conventional wording and a mix of easy and nearby same-topic distractors.
      const generalWeights = [5, 5, 4, 4, 4];
      const generalFirst = choose(generalWeights, random);
      generalWeights[generalFirst] = 0;
      const general = [
        choose([2, 2, 2, 4, 4, 3], random),
        generalFirst,
        choose(generalWeights, random),
        n % 3,
      ];
      const generalItem = decode(fact, general);
      assert.ok(hasOneAnswer(fact, generalItem));
      assert.ok(generalItem.choices.every(choice => choice.topic === topic));
      baseline.push({ topic, tokens: general });

      // A near neighbor and a second, distinct answer from the same topic.
      const first = choose([7, 6, 5, 4, 3], random);
      const related = [6, 6, 5, 5, 4];
      related[first] = 0;
      const second = choose(related, random);
      const tokens = [
        choose(formWeights[topic], random),
        first,
        second,
        (n + 1) % 3,
      ];
      const approved = validate(fact, tokens);
      assert.ok(approved && hasOneAnswer(fact, approved));
      assert.match(approved.question, /^[ぁ-ゖー0-9 「」、。！？]+$/u);
      assert.ok([...approved.question].length <= 45);
      const negatives = [[0, 3 + n % 3], [1, 5 + n % 3], [2, first], [2, 5 + (n + 1) % 3]];
      for (const [stage, token] of negatives) {
        const corrupted = [...tokens];
        corrupted[stage] = token;
        assert.equal(validate(fact, corrupted), null);
      }
      adaptation.push({ topic, tokens, negatives });
    }
  }
  return { baseline, adaptation, limits, topicCount: topics.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(trainingData()));
}
