// The decoder owns all six fields. Check the rendered meaning before using any
// of them. Real-world questions use explicit contrasts; puzzle facts can be
// invented by the model because the clue supplies the information needed.
import { modelRelations } from './content.mjs';

export const counters = new Map([
  ['りんご', '🍎'], ['いちご', '🍓'], ['ほし', '⭐'], ['さかな', '🐟'], ['ぼーる', '⚽'],
  ['みかん', '🍊'], ['くるま', '🚗'], ['きのこ', '🍄'], ['ばなな', '🍌'], ['はな', '🌷'],
  ['かさ', '☂️'], ['くつ', '👟'], ['えんぴつ', '✏️'], ['どんぐり', '🌰'], ['はっぱ', '🍃'],
  ['ほん', '📕'], ['ぼうし', '🧢'], ['さくらんぼ', '🍒'], ['ぶどう', '🍇'], ['ふね', '⛵'],
]);

export const countPrompts = {
  count: ['いくつ ある？', 'ぜんぶで なんこ？'],
  add: ['あわせて なんこ？', 'ぜんぶで いくつ？'],
  take: ['ばつの ものを とると、いくつ のこる？', 'ばつの ものを へらすと、のこりは なんこ？'],
};
export const positionPrompts = [
  ['ひだりの はしは どれ？', 'いちばん ひだりに あるのは？'],
  ['まんなかは どれ？', 'まんなかに あるのは？'],
  ['みぎの はしは どれ？', 'いちばん みぎに あるのは？'],
];
export const sequencePrompts = [
  'おなじ ぶんずつ へるよ。つぎの かずは？',
  'おなじ ぶんずつ ふえるよ。つぎの かずは？',
];
export const comparePrompts = [['いちばん すくないのは？', 'どれが いちばん すくない？'],
  ['いちばん おおいのは？', 'どれが いちばん おおい？']];

export function factPrompts(family, wording, name) {
  const question = wording.replace('{subject}', name);
  if (question.endsWith('のは？')) return [question, question.replace(/のは？$/, 'のは どれ？')];
  if (question.endsWith('のは どれ？')) return [question, question.replace(/のは どれ？$/, 'のは？')];
  if (family === 'shape') return [question, 'この かたちと おなじなのは？'];
  if (family === 'color') return [question, 'この いろと おなじなのは？'];
  if (family === 'corners') return [question, 'かどは なんこ ある？'];
  return [question];
}

const facts = new Map();
for (const [topic, family, wording, icon, groups] of modelRelations) {
  const options = new Map(groups.map(([[, label, symbol, kind]]) => [label, { label, icon: symbol, kind }]));
  for (const [[answerId, answer], subjects] of groups) {
    for (const [id, name, symbol] of subjects) {
      for (const question of factPrompts(family, wording, name)) {
        const clue = icon ? '-' : name;
        const key = family + ':' + id;
        const group = family + ':' + (subjects.length > 1 ? answerId : 'any');
        const lookup = [clue, question].join('\n');
        if (facts.has(lookup)) throw new Error('Ambiguous quiz contrast: ' + lookup);
        facts.set(lookup, {
          key, group, answer, options,
          clue: icon ? { icon } : { icon: symbol, spoken: name, kind: topic === 'colors' ? 'swatch' : 'shape' },
        });
      }
    }
  }
}

const number = value => /^[0-9]$/.test(value);
const numberChoice = label => ({ label, kind: 'number' });

function counting(picture, question, labels) {
  const [name, a, operator, b, extra] = picture.split(' ');
  const icon = counters.get(name);
  if (!icon || !/^[1-9]$/.test(a) || !labels.every(number) || extra !== undefined) return null;
  if (b !== undefined && !/^[1-9]$/.test(b)) return null;
  const first = Number(a), second = Number(b);
  const rule = operator === undefined ? 'count' : operator === '+' ? 'add' : operator === '-' ? 'take' : null;
  if (!rule || !countPrompts[rule].includes(question)) return null;
  const count = rule === 'add' ? first + second : first;
  const crossed = rule === 'take' ? second : 0;
  if (!Number.isInteger(count - crossed) || count > 9 || crossed > first || (operator && b === undefined)) return null;
  const split = rule === 'add' ? first : undefined;
  const spoken = Array.from({ length: count }, (_, index) =>
    (index === split ? 'それから ' : index >= count - crossed ? 'ばつの ' : '') + name).join('、');
  const pair = rule === 'add' ? [first, second].sort((x, y) => x - y) : [first, second];
  const key = rule + ':' + (rule === 'count' ? first : pair.join(':'));
  return {
    key, group: rule === 'count' ? 'count' : rule + ':' + (count - crossed),
    clue: { icon, count, crossed, split, spoken }, answer: String(count - crossed),
    choices: labels.map(numberChoice),
  };
}

function comparing(picture, question, labels) {
  const icon = counters.get(picture);
  const direction = comparePrompts.findIndex(prompts => prompts.includes(question));
  if (!icon || direction < 0 || !labels.every(label => /^[1-7]$/.test(label))) return null;
  const values = labels.toSorted().map(Number);
  const answer = String(values[direction ? 2 : 0]);
  return {
    key: 'compare:' + direction + ':' + values.join(':'),
    group: 'compare:' + direction,
    answer, clue: { icon },
    choices: labels.map(label => ({ icon, count: Number(label), label: picture + 'が ' + label + 'こ' })),
  };
}

function positions(picture, question, labels) {
  const names = picture.split(' ');
  const icons = names.map(name => counters.get(name));
  const index = positionPrompts.findIndex(prompts => prompts.includes(question));
  if (names.length !== 3 || index < 0 || icons.some(icon => !icon) || new Set(icons).size !== 3
    || !labels.every(label => /^@[123]$/.test(label))) return null;
  return {
    key: 'position:' + index + ':' + names[index],
    group: 'position:' + index,
    answer: '@' + (index + 1),
    clue: { icons, spoken: 'ひだりから、' + names.join('、') },
    choices: labels.map(label => {
      const position = Number(label[1]) - 1;
      return { label: names[position], icon: icons[position] };
    }),
  };
}

function sequence(picture, question, labels) {
  const values = picture.split(' ');
  if (values.length !== 3 || !values.every(number) || !labels.every(number)) return null;
  const [a, b, c] = values.map(Number);
  const step = b - a;
  const next = c + step;
  if (step !== c - b || ![1, 2].includes(Math.abs(step)) || next < 0 || next > 9
    || question !== sequencePrompts[Number(step > 0)]) return null;
  return {
    key: 'sequence:' + a + ':' + step, group: 'sequence:' + step,
    answer: String(next), clue: { values, spoken: values.join('、') }, choices: labels.map(numberChoice),
  };
}

// Dispatch by the meaning of the prompt and clue. The model's topic label
// is only for variety and does not gate which questions can be checked.
const checks = new Map([
  ...Object.values(countPrompts).flat().map(prompt => [prompt, counting]),
  ...comparePrompts.flat().map(prompt => [prompt, comparing]),
  ...positionPrompts.flat().map(prompt => [prompt, positions]),
  ...sequencePrompts.map(prompt => [prompt, sequence]),
]);
const text = /^[ぁ-ゖー0-9 、。！？]+$/u;

export function verifyRound(fields, random = Math.random) {
  if (fields.length !== 6) return null;
  const [topic, picture, question, ...labels] = fields;
  const check = checks.get(question);
  if (!/^[a-z]{1,24}$/.test(topic) || !question.endsWith('？') || question.length > 46 || !text.test(question)
    || labels.some(label => label.length > 16 || (!text.test(label) && check !== positions))
    || new Set(labels).size !== 3) return null;
  const result = check ? check(picture, question, labels) : facts.get([picture, question].join('\n'));
  if (!result || result.answer !== labels[0]) return null;
  const choices = result.choices ?? labels.map(label => result.options.get(label));
  if (!choices.every(Boolean)) return null;
  // Randomize position without changing any generated answer text.
  const answer = choices[0];
  for (let i = 2; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  return {
    topic, question, choices, correct: choices.indexOf(answer), clue: result.clue,
    key: result.key, group: result.group, source: 'model',
  };
}
