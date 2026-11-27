import { distractorPool, facts, starter, topics } from './content.mjs';

export const limits = [6, 8, 8, 3];
export const childForms = 3;

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
  return {
    topic: topic.id,
    question: topic.forms[form].replace('{clue}', fact.clue),
    choices,
    correct: position,
  };
}

export function hasOneAnswer(fact, item) {
  if (!item || new Set(item.choices.map(choice => choice.id)).size !== 3) return false;
  if (item.topic === 'counting') {
    const matching = item.choices.filter(choice => Number(choice.label) === Number(fact.label));
    return matching.length === 1 && matching[0] === item.choices[item.correct];
  }
  return item.choices.filter(choice => choice === fact).length === 1 && item.choices[item.correct] === fact;
}

export function validate(fact, tokens) {
  const item = decode(fact, tokens);
  if (!item || tokens[0] >= childForms || !hasOneAnswer(fact, item)) return null;
  if (item.choices.some(choice => choice.topic !== fact.topic)) return null;
  const clue = {
    colors: () => ({ icon: fact.icon, spoken: fact.label }),
    shapes: () => ({ icon: fact.icon, spoken: fact.label }),
    counting: () => ({ icon: '🍎', count: Number(fact.label), spoken: Array(Number(fact.label)).fill('りんご').join('、') }),
  }[item.topic];
  return {
    ...item,
    clue: clue ? clue() : { icon: topics[fact.topic].picture },
    key: fact.id,
  };
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
