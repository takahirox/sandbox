import { relations } from './content.mjs';

export const historyKey = 'kids-ai-quiz:questions:v1';
export const historyLimit = 256;
export const nearWindow = 12;
const counters = [['🍎', 'りんご'], ['🍓', 'いちご'], ['⭐', 'ほし'], ['🐟', 'さかな']];
const numbers = Array.from({ length: 10 }, (_, value) => ({ label: String(value), value, kind: 'number' }));

function relationPuzzles() {
  return relations.flatMap(([topic, family, wording, picture, groups]) => {
    const choices = groups.map(([[id, label, icon, kind]]) => ({ id, label, icon, kind }));
    return groups.flatMap(([[answer], subjects]) => subjects.map(([id, name, icon]) => ({
      topic, key: family + ':' + id, group: family + ':' + (subjects.length > 1 ? answer : 'any'),
      rule: 'relation', choices, answer, wording, picture, name, icon,
    })));
  });
}

function* numberPuzzles() {
  for (let count = 1; count <= 9; count++) {
    yield { topic: 'counting', key: 'count:' + count, group: 'count', rule: 'count', count };
  }
  // Addition is commutative, so each unordered pair appears only once.
  for (let first = 1; first <= 8; first++) {
    for (let second = 1; second <= 9 - first; second++) {
      if (second < first) continue;
      yield { topic: 'counting', key: 'add:' + first + ':' + second, group: 'add:' + (first + second),
        rule: 'add', first, second };
    }
  }
  // The objects taken away are counted in the first group, including when
  // taking everything leaves zero. Both groups stay within single digits.
  for (let first = 2; first <= 9; first++) {
    for (let second = 1; second <= first; second++) {
      yield { topic: 'counting', key: 'take:' + first + ':' + second, group: 'take:' + (first - second),
        rule: 'take', first, second };
    }
  }
  for (let low = 1; low <= 5; low++) {
    for (let middle = low + 1; middle <= 6; middle++) {
      for (let high = middle + 1; high <= 7; high++) {
        yield { topic: 'comparing', key: 'compare:' + low + ':' + middle + ':' + high, group: 'compare:' + middle,
          rule: 'compare', values: [low, middle, high] };
      }
    }
  }
}

export const puzzles = [...relationPuzzles(), ...numberPuzzles()];
const byKey = new Map(puzzles.map(puzzle => [puzzle.key, puzzle]));
const byTopic = new Map();
for (const puzzle of puzzles) {
  if (!byTopic.has(puzzle.topic)) byTopic.set(puzzle.topic, []);
  byTopic.get(puzzle.topic).push(puzzle);
}

function sample(items, random) {
  return items[Math.floor(random() * items.length)];
}

function shuffle(items, random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// A rule supplies both its legal options and the predicate that identifies
// the answer. Sample only from the nonmatching options, then check the round.
function makeChoices(options, matches, random) {
  const right = options.filter(matches);
  const wrong = shuffle(options.filter(choice => !matches(choice)), random).slice(0, 2);
  const choices = shuffle([...right, ...wrong], random);
  const correct = choices.findIndex(matches);
  if (right.length !== 1 || choices.length !== 3 || new Set(choices.map(choice => choice.label)).size !== 3) return null;
  return { choices, correct };
}

export function makeRound(puzzle, random = Math.random) {
  const { topic, key, group, rule } = puzzle;
  let question, clue, answers;
  if (rule === 'relation') {
    question = puzzle.wording.replace('{subject}', puzzle.name);
    const visual = !puzzle.picture;
    clue = {
      icon: puzzle.icon || puzzle.picture,
      kind: topic === 'shapes' ? 'shape' : topic === 'colors' ? 'swatch' : undefined,
      spoken: visual ? puzzle.name : undefined,
    };
    answers = makeChoices(puzzle.choices, choice => choice.id === puzzle.answer, random);
  } else {
    const [icon, label] = sample(counters, random);
    if (rule === 'compare') {
      const more = random() < 0.5;
      const target = (more ? Math.max : Math.min)(...puzzle.values);
      question = more ? 'いちばん おおいのは？' : 'いちばん すくないのは？';
      clue = { icon };
      answers = makeChoices(puzzle.values.map(value => ({
        label: label + 'が ' + value + 'こ', icon, count: value, value,
      })), choice => choice.value === target, random);
    } else {
      const { count, first, second } = puzzle;
      const total = count ?? (rule === 'add' ? first + second : first - second);
      const pictured = count ?? (rule === 'add' ? total : first);
      clue = {
        icon, count: pictured, split: rule === 'add' ? first : undefined,
        crossed: rule === 'take' ? second : 0,
        spoken: Array.from({ length: pictured }, (_, i) => {
          if (rule === 'add' && i === first) return 'それから ' + label;
          if (rule === 'take' && i >= first - second) return 'ばつの ' + label;
          return label;
        }).join('、'),
      };
      question = { count: label + 'は なんこ？', add: 'あわせて なんこ？', take: 'ばつの ' + label + 'を とると、いくつ のこる？' }[rule];
      // Near numbers are useful distractors. At the ends, keep within 0–9.
      const start = Math.max(0, Math.min(total - 2, 5));
      answers = makeChoices(numbers.slice(start, start + 5), choice => choice.value === total, random);
    }
  }
  return answers && { key, group, topic, question, clue, ...answers };
}

function choosePuzzle(candidates, recentGroups, random) {
  const unfamiliar = candidates.filter(puzzle => !recentGroups.has(puzzle.group));
  return sample(unfamiliar.length ? unfamiliar : candidates, random);
}

function readHistory(storage) {
  try {
    const raw = storage?.getItem(historyKey);
    if (!raw || raw.length > historyLimit * 40) return [];
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved)) return [];
    // Keep the most recent occurrence if the stored list contains duplicates.
    const latest = new Set(saved.reverse().filter(key => byKey.has(key)));
    return [...latest].slice(0, historyLimit).reverse();
  } catch {
    // A blocked or corrupt store does not prevent a round.
  }
  return [];
}

export function createSession({ random = Math.random, storage, solve = choosePuzzle } = {}) {
  const history = readHistory(storage);
  let order = [];
  return {
    next() {
      const recentTopics = new Set(history.slice(-4).map(key => byKey.get(key).topic));
      if (!order.length) order = shuffle([...byTopic.keys()], random);
      const freshTopic = order.findIndex(topic => !recentTopics.has(topic));
      const [topic] = order.splice(Math.max(0, freshTopic), 1);
      const lastUsed = new Map(history.map((key, index) => [key, index]));
      const pool = byTopic.get(topic);
      const fresh = pool.filter(puzzle => !lastUsed.has(puzzle.key));
      // Once a topic has used every available ID, recycle its oldest one.
      const candidates = fresh.length ? fresh : [pool.reduce((oldest, puzzle) =>
        lastUsed.get(puzzle.key) < lastUsed.get(oldest.key) ? puzzle : oldest)];
      const recentGroups = new Set(history.slice(-nearWindow).map(key => byKey.get(key).group));
      let proposal;
      try {
        proposal = solve(candidates, recentGroups, random);
      } catch {
        // Use the deterministic constructive path if the solver fails.
      }
      const generated = candidates.includes(proposal) ? makeRound(proposal, random) : null;
      const item = generated ?? makeRound(candidates[0], random);
      const previous = lastUsed.get(item.key);
      if (previous !== undefined) history.splice(previous, 1);
      history.push(item.key);
      if (history.length > historyLimit) history.shift();
      try {
        storage?.setItem(historyKey, JSON.stringify(history));
      } catch {
        // Continue with the tab's bounded in-memory history.
      }
      return item;
    },
  };
}
