// The decoder owns all six fields. Check the rendered meaning before using any
// of them. Real-world questions use explicit contrasts; puzzle facts can be
// invented by the model because the clue supplies the information needed.
import { modelRelations } from './content.mjs';

const counters = new Map([
  ['りんご', '🍎'], ['いちご', '🍓'], ['ほし', '⭐'], ['さかな', '🐟'], ['ぼーる', '⚽'],
  ['みかん', '🍊'], ['くるま', '🚗'], ['きのこ', '🍄'], ['ばなな', '🍌'], ['はな', '🌷'],
  ['かさ', '☂️'], ['くつ', '👟'], ['えんぴつ', '✏️'], ['はっぱ', '🍃'],
  ['ほん', '📕'], ['ぼうし', '🧢'], ['さくらんぼ', '🍒'], ['ぶどう', '🍇'], ['ふね', '⛵'],
]);

// Parse the relation and then look up its subject independently.
function factPattern(family, wording) {
  if (family === 'shape') return /^(?:おなじ かたちは どれ|この かたちと おなじなのは(?: どれ)?)？$/u;
  if (family === 'color') return /^(?:おなじ いろは どれ|この いろと おなじなのは(?: どれ)?)？$/u;
  if (family === 'corners') return /^かどは (?:いくつ|なんこ)(?: ある)?？$/u;
  const body = wording.replace('{subject}', '(.+)')
    .replace(/のは(?: どれ)?？$/, 'のは(?: どれ)?？')
    .replace(/(?:なにを する|どうする)？$/, '(?:なにを する|どうする)？');
  return new RegExp('^' + body + '$', 'u');
}

const contrasts = modelRelations.map(([topic, family, wording, icon, groups]) => {
  const pattern = factPattern(family, wording);
  const options = new Map(groups.map(([[, label, symbol, kind]]) => [label, { label, icon: symbol, kind }]));
  const subjects = new Map();
  for (const [[answerId, answer], members] of groups) {
    for (const [id, name, symbol] of members) {
      if (subjects.has(name)) throw new Error('Ambiguous quiz contrast: ' + family + ':' + name);
      subjects.set(name, {
        key: family + ':' + id, group: family + ':' + (members.length > 1 ? answerId : 'any'), answer,
        clue: icon ? { icon } : { icon: symbol, spoken: name, kind: topic === 'colors' ? 'swatch' : 'shape' },
      });
    }
  }
  return { pattern, icon, subjects, options };
});

function factual(picture, question, labels) {
  let result = null;
  for (const { pattern, icon, subjects, options } of contrasts) {
    if (Boolean(icon) !== (picture === '-')) continue;
    const match = pattern.exec(question);
    const fact = match && subjects.get(icon ? match[1] : picture);
    if (!fact) continue;
    if (result) return null;
    result = { ...fact, choices: labels.map(label => options.get(label)) };
  }
  return result;
}

const number = value => /^[0-9]$/.test(value);
const numberChoice = label => ({ label, kind: 'number' });
const totalQuestion = /^(?:([ぁ-ゖー]+) は |(あわせて|ぜんぶで) )?(?:いくつ|なんこ)(?: ある)?？$/u;
const takeQuestion = /^ばつの ものを (?:とる|へらす)と、(?:いくつ のこる|のこりは なんこ)？$/u;
const compareQuestion = /^(どれが )?いちばん (すくない|おおい)(のは)?？$/u;
const positionQuestions = [
  /^(?:ひだりの はしは どれ|いちばん ひだりに あるのは(?: どれ)?)？$/u,
  /^まんなか(?:は どれ|に あるのは(?: どれ)?)？$/u,
  /^(?:みぎの はしは どれ|いちばん みぎに あるのは(?: どれ)?)？$/u,
];
const sequenceQuestion = /^おなじ ぶんずつ (へる|ふえる)よ。つぎの かずは(?: なに)?？$/u;

function counting(picture, question, labels) {
  const expression = /^([^ ]+) ([1-9])(?: ([-+]) (?:([^ ]+) )?([1-9]))?$/u.exec(picture);
  if (!expression || !labels.every(number)) return null;
  const [, name, a, operator, other, b] = expression;
  const icon = counters.get(name);
  const secondIcon = other ? counters.get(other) : icon;
  if (!icon || !secondIcon) return null;
  const first = Number(a), second = Number(b);
  const total = totalQuestion.exec(question);
  const selected = total?.[1];
  const rule = operator === '-' ? 'take' : operator === '+' ? 'add' : 'count';
  if (rule === 'take') {
    if (!takeQuestion.test(question) || (other && other !== name)) return null;
  } else if (!total || (total[2] === 'あわせて' && rule !== 'add')) return null;
  if (selected && (rule !== 'add' || !other || name === other || (selected !== name && selected !== other))) return null;
  const count = rule === 'add' ? first + second : first;
  const crossed = rule === 'take' ? second : 0;
  if (count > 9 || crossed > first) return null;
  const split = rule === 'add' ? first : undefined;
  const spoken = Array.from({ length: count }, (_, index) =>
    (index === split ? 'それから ' : index >= count - crossed ? 'ばつの ' : '')
      + (other && rule === 'add' && index >= split ? other : name)).join('、');
  const clue = { icon, count, crossed, split, spoken, secondIcon, separate: Boolean(selected) };
  const choices = labels.map(numberChoice);
  if (selected) {
    const [wanted, rest] = selected === name ? [first, second] : [second, first];
    return { key: 'select:' + wanted + ':' + rest, group: 'select', clue, answer: String(wanted), choices };
  }
  const pair = rule === 'add' ? [first, second].sort((x, y) => x - y) : [first, second];
  const key = rule + ':' + (rule === 'count' ? first : pair.join(':'));
  return {
    key, group: rule === 'count' ? 'count' : rule + ':' + (count - crossed),
    clue, answer: String(count - crossed), choices,
  };
}

function comparing(picture, question, labels) {
  const icon = counters.get(picture);
  const match = compareQuestion.exec(question);
  if (!icon || !match || Boolean(match[1]) === Boolean(match[3]) || !labels.every(label => /^[1-7]$/.test(label))) return null;
  const direction = Number(match[2] === 'おおい');
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
  const index = positionQuestions.findIndex(pattern => pattern.test(question));
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
  const match = sequenceQuestion.exec(question);
  const values = picture.split(' ');
  if (!match || values.length !== 3 || !values.every(number) || !labels.every(number)) return null;
  const [a, b, c] = values.map(Number);
  const step = b - a;
  const next = c + step;
  if (step !== c - b || ![1, 2].includes(Math.abs(step)) || next < 0 || next > 9
    || (match[1] === 'ふえる') !== (step > 0)) return null;
  return {
    key: 'sequence:' + a + ':' + step, group: 'sequence:' + step,
    answer: String(next), clue: { values, spoken: values.join('、') }, choices: labels.map(numberChoice),
  };
}

const text = /^[ぁ-ゖー0-9 、。！？]+$/u;

export function verifyRound(fields, random = Math.random) {
  if (!Array.isArray(fields) || fields.length !== 6 || fields.some(field => typeof field !== 'string')) return null;
  const [topic, picture, question, ...labels] = fields;
  if (!/^[a-z]{1,24}$/.test(topic) || picture.length > 64 || question.length > 46 || !text.test(question)
    || labels.some(label => label.length > 16 || (!text.test(label) && !/^@[123]$/.test(label)))
    || new Set(labels).size !== 3) return null;
  // Judge the question and clue independently of the model's topic label.
  const result = counting(picture, question, labels) ?? comparing(picture, question, labels)
    ?? positions(picture, question, labels) ?? sequence(picture, question, labels) ?? factual(picture, question, labels);
  if (!result || result.answer !== labels[0]) return null;
  const choices = result.choices;
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
