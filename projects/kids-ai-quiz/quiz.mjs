import { distractorPool, facts, starter, topics } from './content.mjs';

export const limits = [6, 8, 8, 3];
export const childForms = 3;

// List every catalog choice that can satisfy each text clue. The keyed choice
// in the generator is not evidence that another choice fails the clue.
const textAnswers = new Map([
  ['わんわん', ['dog']],
  ['にゃあにゃあ', ['cat']],
  ['ぶうぶう', ['pig']],
  ['もーもー', ['cow']],
  ['があがあ', ['duck']],
  ['めえめえ', ['sheep']],
  ['こけこっこー', ['rooster']],
  ['かわが きいろくて ながい くだもの', ['banana']],
  ['きに なる しゃりしゃりの くだもの', ['apple']],
  ['ごはんを ぎゅっと にぎった たべもの', ['rice-ball']],
  ['ちーずを のせて やく まるい たべもの', ['pizza']],
  ['まんなかに あなが ある おかし', ['doughnut']],
  ['あかくて つぶつぶの くだもの', ['strawberry']],
  ['きいろい つぶが ならんだ やさい', ['corn']],
  ['せんろを はしる', ['train']],
  ['つばさで そらを とぶ', ['plane']],
  ['みずに うかんで すすむ', ['boat']],
  ['ぺだるを こいで すすむ', ['bicycle']],
  ['まちの みちで たくさんの ひとを のせる', ['bus']],
  ['みちを はしって かじの ひを けしに いく', ['fire-engine']],
  ['けがを した ひとを びょういんへ はこぶ', ['ambulance']],
  ['はを みがく どうぐ', ['toothbrush']],
  ['あめの ひに さす もの', ['umbrella']],
  ['すーぷを すくう どうぐ', ['spoon']],
  ['ぬれた からだを ふく もの', ['towel']],
  ['そとへ いくとき あしに はく もの', ['shoes']],
  ['けると ころがる まるい もの', ['ball']],
  ['いまの じかんが わかる もの', ['clock']],
]);

export function hasStructure(tokens) {
  return Array.isArray(tokens) && tokens.length === limits.length
    && limits.every((limit, i) => Number.isInteger(tokens[i]) && tokens[i] >= 0 && tokens[i] < limit);
}

export function decode(fact, tokens) {
  if (!facts.includes(fact) || !hasStructure(tokens)) return null;
  const [form, first, second, position] = tokens;
  const topic = topics[fact.topic];
  const pool = distractorPool(fact);
  const choices = [pool[first], pool[second]];
  choices.splice(position, 0, fact);
  let clue = { icon: topic.picture };
  if (topic.id === 'colors' || topic.id === 'shapes') {
    clue = { icon: fact.icon, spoken: fact.label };
  } else if (topic.id === 'counting') {
    const count = Number(fact.label);
    clue = { icon: '🍎', count, spoken: Array(count).fill('りんご').join('、') };
  }
  return {
    topic: topic.id,
    question: topic.forms[form].replace('{clue}', fact.clue),
    choices,
    correct: position,
    clue,
  };
}

export function hasOneAnswer(fact, item) {
  if (!item || item.choices.length !== 3 || new Set(item.choices.map(choice => choice.label)).size !== 3) return false;
  let matching;
  if (item.topic === 'counting') {
    matching = item.choices.filter(choice => Number(choice.label) === item.clue.count);
  } else if (item.topic === 'colors' || item.topic === 'shapes') {
    matching = item.choices.filter(choice => choice.icon === item.clue.icon);
  } else {
    const answers = textAnswers.get(fact.clue);
    if (!answers || !item.question.includes(fact.clue)) return false;
    matching = item.choices.filter(choice => answers.includes(choice.id));
  }
  return matching.length === 1 && matching[0] === item.choices[item.correct];
}

export function validate(fact, tokens) {
  const item = decode(fact, tokens);
  if (!item || tokens[0] >= childForms || !hasOneAnswer(fact, item)) return null;
  if (item.choices.some(choice => choice.topic !== fact.topic)) return null;
  return { ...item, key: fact.id };
}

function shuffle(items, random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function fallback(fact, random = Math.random) {
  const [first, second] = shuffle([0, 1, 2, 3, 4], random);
  return validate(fact, [Math.floor(random() * childForms), first, second, Math.floor(random() * 3)]);
}

export const firstQuestion = validate(starter, [0, 0, 1, 1]);

export function createSession(random = Math.random) {
  const byTopic = topics.map(topic => ({ remaining: [], recent: [] }));
  byTopic[starter.topic].remaining = shuffle(topics[starter.topic].facts.filter(fact => fact !== starter), random);
  byTopic[starter.topic].recent.push(starter);
  let order = shuffle(topics.map((_, index) => index).filter(index => index !== starter.topic), random);
  let lastTopic = starter.topic;

  return {
    next() {
      if (!order.length) {
        order = shuffle(topics.map((_, index) => index), random);
        if (order[0] === lastTopic) [order[0], order[1]] = [order[1], order[0]];
      }
      lastTopic = order.shift();
      const bucket = byTopic[lastTopic];
      if (!bucket.remaining.length) bucket.remaining = shuffle(topics[lastTopic].facts, random);
      const fresh = bucket.remaining.findIndex(fact => !bucket.recent.includes(fact));
      const [fact] = bucket.remaining.splice(Math.max(0, fresh), 1);
      bucket.recent = [...bucket.recent.slice(-1), fact];
      return fact;
    },
  };
}
