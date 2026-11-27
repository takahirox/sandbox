import { createGenerator } from './model.mjs';
import { createSession, fallback, firstQuestion, validate } from './quiz.mjs';

const [question, clue, illustration, answers, speak, next, retry, feedback] =
  ['question', 'clue', 'illustration', 'answers', 'speak', 'next', 'retry', 'feedback'].map(id => document.getElementById(id));
const game = document.querySelector('main');
const session = createSession();
const generator = createGenerator();

let item = firstQuestion;
let solved = false;
let pending = false;
let modelState = 'ready';

function art(icon, topic, number) {
  const node = document.createElement('span');
  node.className = 'art';
  node.dataset.icon = icon;
  node.setAttribute('aria-hidden', 'true');
  if (topic === 'colors') node.classList.add('swatch');
  else if (topic === 'shapes') {
    node.classList.add('shape');
    if (icon !== 'oval') node.textContent = icon;
  } else if (number) {
    node.dataset.number = '';
    node.textContent = number;
  } else if (icon !== '▰') node.textContent = icon;
  return node;
}

function render() {
  solved = false;
  game.removeAttribute('data-solved');
  game.dataset.topic = item.topic;
  question.textContent = item.question;
  clue.textContent = item.clue.spoken ?? '';
  const pictures = Array.from({ length: item.clue.count ?? 1 }, () => art(item.clue.icon, item.topic));
  illustration.replaceChildren(...pictures);
  answers.replaceChildren(...item.choices.map((choice, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'answer';
    const number = item.topic === 'counting' ? choice.label : '';
    const caption = document.createElement('span');
    caption.textContent = choice.label;
    if (number) caption.className = 'sr-only';
    button.append(art(choice.icon, item.topic, number), caption);
    button.addEventListener('click', () => answer(index, button));
    return button;
  }));
  next.textContent = 'つぎへ';
  speak.disabled = false;
  retry.hidden = modelState !== 'error';
}

function answer(index, button) {
  if (pending || solved) return;
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

async function advance() {
  pending = true;
  retry.hidden = true;
  stopTalking();
  const fact = session.next();
  let generated;

  if (modelState === 'ready') {
    for (const choice of answers.children) choice.disabled = true;
    speak.disabled = true;
    feedback.textContent = 'もんだいを つくってるよ…';
    next.textContent = 'すぐ あそぶ';
    const result = await generator.generate(fact.topic);
    if (result.kind === 'ok') {
      for (const candidate of result.candidates) {
        generated = validate(fact, candidate);
        if (generated) break;
      }
    } else if (result.kind === 'unsupported') modelState = 'unsupported';
    else if (result.kind !== 'stopped') modelState = 'error';
  }

  item = generated ?? fallback(fact);
  pending = false;
  feedback.textContent = { error: 'つくれなかったよ。', unsupported: 'このまま あそべるよ。' }[modelState] ?? '';
  render();
  question.focus({ preventScroll: true });
}

next.addEventListener('click', () => {
  if (pending) generator.stop();
  else void advance();
});

retry.addEventListener('click', () => {
  if (pending) return;
  modelState = 'ready';
  next.focus({ preventScroll: true });
  void advance();
});

// Use on-device Japanese voices when the browser offers one.
const speech = window.speechSynthesis;
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
    if (!voice || pending) return;
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

window.addEventListener('pagehide', () => {
  stopTalking();
  generator.stop();
});

render();
