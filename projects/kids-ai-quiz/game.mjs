import { createSession } from './quiz.mjs';
import { modelSession } from './session.mjs';

const [question, clue, illustration, answers, speak, next, feedback] =
  ['question', 'clue', 'illustration', 'answers', 'speak', 'next', 'feedback'].map(id => document.getElementById(id));
const game = document.querySelector('main');
const capture = globalThis.__sandboxCapture === true;
let storage;
if (!capture) {
  try {
    storage = window.localStorage;
  } catch {
    // Play with in-memory history when browser storage is blocked.
  }
}
const model = capture ? null : modelSession({ storage });
let fallback;

// A stable, inert gallery cover. The first normal round comes from the worker.
let item = capture ? {
  topic: 'animals',
  question: 'わんわん なくのは？',
  clue: { icon: '♪' },
  choices: [{ label: 'ねこ', icon: '🐈' }, { label: 'いぬ', icon: '🐕' }, { label: 'ぶた', icon: '🐖' }],
  correct: 1,
} : null;
let solved = false;
let prepared;
let revision = 0;

async function showRound(focus) {
  const current = ++revision;
  next.disabled = true;
  speak.disabled = true;
  for (const choice of answers.children) choice.disabled = true;
  const generated = await (prepared ?? model.generate());
  if (current !== revision) return;
  if (generated) item = generated;
  else {
    fallback ??= createSession({ storage });
    item = { ...fallback.next(), source: 'fallback' };
  }
  model.remember(item);
  feedback.textContent = '';
  render();
  next.disabled = false;
  speak.disabled = false;
  if (focus) question.focus({ preventScroll: true });
  prepared = model.generate();
}

function art({ icon, kind, label }) {
  const node = document.createElement('span');
  node.className = 'art';
  if (icon) node.dataset.icon = icon;
  node.setAttribute('aria-hidden', 'true');
  if (kind === 'swatch') node.classList.add('swatch');
  else if (kind === 'shape') {
    node.classList.add('shape');
    if (icon !== 'oval') node.textContent = icon;
  } else if (kind === 'number') {
    node.dataset.number = '';
    node.textContent = label;
  } else if (icon !== '▰') node.textContent = icon ?? '';
  return node;
}

function counters({ icon, count, crossed = 0 }) {
  const group = document.createElement('span');
  group.className = 'counters';
  group.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < count; i++) {
    const counter = art({ icon });
    if (i >= count - crossed) counter.classList.add('crossed');
    group.append(counter);
  }
  return group;
}

function render() {
  solved = false;
  game.removeAttribute('data-solved');
  game.dataset.topic = item.topic;
  if (item.source) game.dataset.source = item.source;
  question.textContent = item.question;
  clue.textContent = item.clue.spoken ?? '';
  const { icon, icons, values, count, split } = item.clue;
  if (split) {
    const plus = document.createElement('span');
    plus.textContent = '＋';
    illustration.replaceChildren(counters({ icon, count: split }), plus, counters({ icon, count: count - split }));
  } else if (icons) {
    illustration.replaceChildren(...icons.map(icon => art({ icon })));
  } else if (values) {
    illustration.replaceChildren(...values.map(label => art({ label, kind: 'number' })));
  } else {
    illustration.replaceChildren(count ? counters(item.clue) : art(item.clue));
  }

  answers.replaceChildren(...item.choices.map((choice, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'answer';
    const caption = document.createElement('span');
    caption.textContent = choice.label;
    if (choice.kind === 'number' || choice.count) caption.className = 'sr-only';
    if (choice.count) button.append(counters(choice));
    else if (choice.icon || choice.kind) button.append(art(choice));
    else button.classList.add('text-answer');
    button.append(caption);
    button.addEventListener('click', () => answer(index, button));
    return button;
  }));
}

function answer(index, button) {
  if (capture || solved) return;
  for (const choice of answers.children) delete choice.dataset.result;
  if (index !== item.correct) {
    button.dataset.result = 'retry';
    feedback.textContent = 'もういちど えらんでね。';
    return;
  }
  solved = true;
  game.dataset.solved = '';
  button.dataset.result = 'correct';
  feedback.textContent = 'せいかい！';
  next.focus({ preventScroll: true });
  for (const choice of answers.children) choice.disabled = true;
}

if (capture) game.inert = true;
else next.addEventListener('click', () => {
  stopTalking();
  feedback.textContent = '';
  void showRound(true);
});

// Use on-device Japanese voices when the browser offers one.
const speech = capture ? null : window.speechSynthesis;
let voice;
let utterance;
function stopTalking() {
  if (utterance) {
    utterance = null;
    speech.cancel();
  }
}
function updateVoice() {
  voice = speech.getVoices().find(candidate => candidate.localService && /^ja(?:[-_]|$)/i.test(candidate.lang));
  speak.hidden = !voice;
}

if (speech?.getVoices && typeof SpeechSynthesisUtterance === 'function') {
  updateVoice();
  speech.addEventListener('voiceschanged', updateVoice);
  speak.addEventListener('click', () => {
    if (!voice || !item || speak.disabled) return;
    stopTalking();
    const description = item.clue.spoken ? item.clue.spoken + '。' : '';
    const labels = item.choices.map(choice => choice.label).join('、');
    const current = new SpeechSynthesisUtterance(
      [item.question, description, labels].filter(Boolean).join(' '),
    );
    current.lang = 'ja-JP';
    current.voice = voice;
    current.rate = 0.85;
    current.onend = () => { if (utterance === current) utterance = null; };
    current.onerror = () => {
      if (utterance === current) {
        utterance = null;
        if (document.activeElement === speak) question.focus({ preventScroll: true });
        speak.hidden = true;
      }
    };
    utterance = current;
    speech.speak(current);
  });
}

if (capture) render();
else {
  window.addEventListener('pagehide', () => {
    stopTalking();
    revision++;
    prepared = undefined;
    model.stop();
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    if (next.disabled) void showRound(Boolean(item));
    else prepared = model.generate();
  });
  void showRound(false);
}
