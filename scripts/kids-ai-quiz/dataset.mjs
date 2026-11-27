// Original supervision for a small Japanese quiz language model. Only the
// offline teacher constructs gold rows. The browser samples every field.
import { fileURLToPath } from 'node:url';
import { modelRelations } from '../../projects/kids-ai-quiz/content.mjs';
import { counters } from '../../projects/kids-ai-quiz/verify.mjs';

const countPrompts = {
  count: ['いくつ ある？', 'ぜんぶで なんこ？'],
  add: ['あわせて なんこ？', 'ぜんぶで いくつ？'],
  take: ['ばつの ものを とると、いくつ のこる？', 'ばつの ものを へらすと、のこりは なんこ？'],
};
const positionPrompts = [
  ['ひだりの はしは どれ？', 'いちばん ひだりに あるのは？'],
  ['まんなかは どれ？', 'まんなかに あるのは？'],
  ['みぎの はしは どれ？', 'いちばん みぎに あるのは？'],
];
const sequencePrompts = [
  'おなじ ぶんずつ へるよ。つぎの かずは？',
  'おなじ ぶんずつ ふえるよ。つぎの かずは？',
];
const comparePrompts = [['いちばん すくないのは？', 'どれが いちばん すくない？'],
  ['いちばん おおいのは？', 'どれが いちばん おおい？']];

function factPrompts(family, wording, name) {
  const question = wording.replace('{subject}', name);
  if (question.endsWith('のは？')) return [question, question.replace(/のは？$/, 'のは どれ？')];
  if (question.endsWith('のは どれ？')) return [question, question.replace(/のは どれ？$/, 'のは？')];
  if (family === 'shape') return [question, 'この かたちと おなじなのは？'];
  if (family === 'color') return [question, 'この いろと おなじなのは？'];
  if (family === 'corners') return [question, 'かどは なんこ ある？'];
  return [question];
}

export function seeded(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

export function memoryStorage() {
  const data = new Map();
  return { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
}

export function heldOut(key) {
  const [rule, a, b, c, d] = key.split(':');
  if (rule === 'add') return (3 * Number(a) + Number(b)) % 7 === 1;
  if (rule === 'take' || rule === 'select') return (3 * Number(a) + Number(b)) % 7 === 3;
  if (rule === 'compare') return (Number(b) + 3 * Number(c) + Number(d)) % 7 === 0;
  if (rule === 'sequence') return (Number(a) + Number(b) + 2) % 7 === 0;
  if (rule === 'position') return [...counters.keys()].indexOf(b) % 5 === Number(a);
  return false;
}

export function* dataset(seed = 68, examplesPerTopic = 1400) {
  const random = seeded(seed);
  const pick = values => values[Math.floor(random() * values.length)];
  const names = [...counters.keys()];
  const examples = new Map();
  const add = (topic, make) => {
    if (!examples.has(topic)) examples.set(topic, []);
    examples.get(topic).push(make);
  };
  const integers = Array.from({ length: 10 }, (_, i) => String(i));
  const negatives = (correct, options) => {
    const pool = options.filter(value => value !== correct);
    const one = pool.splice(Math.floor(random() * pool.length), 1)[0];
    return [correct, one, pick(pool)];
  };

  for (const [topic, family, wording, illustration, groups] of modelRelations) {
    const options = groups.map(([[, label]]) => label);
    for (const [[, correct], subjects] of groups) {
      for (const [, name] of subjects) {
        add(topic, () => [topic, illustration ? '-' : name, pick(factPrompts(family, wording, name)),
          ...negatives(correct, options)]);
      }
    }
  }

  for (let a = 1; a <= 9; a++) {
    add('counting', () => ['counting', pick(names) + ' ' + a, pick(countPrompts.count),
      ...negatives(String(a), integers)]);
    for (let b = 1; b <= 9; b++) {
      if (a + b <= 9 && !heldOut('add:' + Math.min(a, b) + ':' + Math.max(a, b))) {
        add('counting', () => ['counting', pick(names) + ' ' + a + ' + ' + b, pick(countPrompts.add),
          ...negatives(String(a + b), integers)]);
      }
      if (b <= a && !heldOut('take:' + a + ':' + b)) {
        add('counting', () => ['counting', pick(names) + ' ' + a + ' - ' + b, pick(countPrompts.take),
          ...negatives(String(a - b), integers)]);
      }
    }
  }

  for (let wanted = 1; wanted <= 8; wanted++) {
    for (let other = 1; wanted + other <= 9; other++) {
      if (heldOut('select:' + wanted + ':' + other)) continue;
      add('select', () => {
        const name = pick(names);
        const distractor = pick(names.filter(candidate => candidate !== name));
        const groups = [name + ' ' + wanted, distractor + ' ' + other];
        if (random() < 0.5) groups.reverse();
        const question = name + ' は ' + pick(['なんこ？', 'いくつ ある？']);
        return ['counting', groups.join(' + '), question, ...negatives(String(wanted), integers)];
      });
    }
  }

  for (let a = 1; a <= 5; a++) {
    for (let b = a + 1; b <= 6; b++) {
      for (let c = b + 1; c <= 7; c++) {
        for (let direction = 0; direction < 2; direction++) {
          if (heldOut(['compare', direction, a, b, c].join(':'))) continue;
          const values = [String(a), String(b), String(c)];
          add('comparing', () => ['comparing', pick(names), pick(comparePrompts[direction]),
            ...negatives(values[direction ? 2 : 0], values)]);
        }
      }
    }
  }

  for (let index = 0; index < positionPrompts.length; index++) {
    for (const target of names) {
      if (heldOut('position:' + index + ':' + target)) continue;
      add('positions', () => {
        const labels = negatives(target, names);
        const picture = labels.slice(1);
        picture.splice(index, 0, target);
        return ['positions', picture.join(' '), pick(positionPrompts[index]),
          ...labels.map(label => '@' + (picture.indexOf(label) + 1))];
      });
    }
  }

  for (let a = 0; a <= 9; a++) {
    for (const step of [-2, -1, 1, 2]) {
      const next = a + 3 * step;
      if (next < 0 || next > 9 || heldOut('sequence:' + a + ':' + step)) continue;
      add('sequence', () => ['sequence', [a, a + step, a + 2 * step].join(' '), sequencePrompts[Number(step > 0)],
        ...negatives(String(next), integers)]);
    }
  }

  for (const makers of examples.values()) {
    for (let i = 0; i < examplesPerTopic; i++) yield pick(makers)();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify([...dataset()]));
}
