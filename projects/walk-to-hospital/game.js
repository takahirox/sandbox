const character = document.getElementById('character');
const facing = document.getElementById('facing');
const movement = document.getElementById('movement');
const left = document.getElementById('left');
const right = document.getElementById('right');
const replay = document.getElementById('replay');
const arrival = document.getElementById('arrival');
const celebration = document.getElementById('celebration');
const description = document.getElementById('scene-description');
const start = 208;
const destination = 686;
const pointers = new Map();
const keys = new Set();
let position = start;
let arrived = false;
let frame = null;
let previousTime = null;
let replayPressed = false;

function direction() {
  const inputs = [...pointers.values(), ...keys];
  const backward = inputs.includes(-1);
  const forward = inputs.includes(1);
  return Number(forward) - Number(backward);
}

function clearInputs() {
  pointers.clear();
  keys.clear();
  updateMotion();
}

function move(distance) {
  if (arrived) return;
  position = Math.max(start, Math.min(destination, position + distance));
  character.setAttribute('transform', `translate(${position} 333)`);
  if (distance) facing.setAttribute('transform', `scale(${distance < 0 ? -1 : 1} 1)`);
  if (position < destination) return;

  arrived = true;
  const focusReplay = movement.contains(document.activeElement);
  clearInputs();
  movement.hidden = true;
  replay.hidden = false;
  celebration.removeAttribute('hidden');
  arrival.textContent = 'ついた！';
  description.textContent = '子どもがびょういんに着きました。';
  if (focusReplay) replay.focus({ preventScroll: true });
}

function updateMotion() {
  const heading = direction();
  const walking = !arrived && heading !== 0 && !(heading < 0 && position === start);
  character.classList.toggle('is-walking', walking);
  left.classList.toggle('is-held', !arrived && heading < 0);
  right.classList.toggle('is-held', !arrived && heading > 0);
  if (walking && frame === null) frame = requestAnimationFrame(tick);
  if (!walking) {
    cancelAnimationFrame(frame);
    frame = null;
    previousTime = null;
  }
}

function tick(time) {
  frame = null;
  // Cap long frames so a suspended tab cannot jump straight to the hospital.
  const seconds = previousTime === null ? 0 : Math.min((time - previousTime) / 1000, .05);
  previousTime = time;
  move(direction() * 120 * seconds);
  updateMotion();
}

for (const [button, heading] of [[left, -1], [right, 1]]) {
  button.addEventListener('pointerdown', event => {
    if (arrived || event.button !== 0) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, heading);
    // A quick tap is a small step; holding continues the walk.
    move(direction() * 14);
    updateMotion();
  });
  const release = event => {
    pointers.delete(event.pointerId);
    updateMotion();
  };
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
  button.addEventListener('contextmenu', event => event.preventDefault());
  // Native keyboard activation and assistive-technology clicks take a step too.
  button.addEventListener('click', event => {
    if (event.detail === 0) move(heading * 40);
  });
}

window.addEventListener('keydown', event => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  if (event.repeat || arrived) return;
  keys.add(event.key === 'ArrowLeft' ? -1 : 1);
  move(direction() * 14);
  updateMotion();
});
window.addEventListener('keyup', event => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  keys.delete(event.key === 'ArrowLeft' ? -1 : 1);
  updateMotion();
});
window.addEventListener('blur', clearInputs);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearInputs();
});

replay.addEventListener('pointerdown', () => { replayPressed = true; });
replay.addEventListener('click', event => {
  // A touch released after arrival can synthesize a click on the new button.
  // Require a fresh press there, or native keyboard/assistive activation.
  if (event.detail !== 0 && !replayPressed) return;
  replayPressed = false;
  clearInputs();
  arrived = false;
  position = start;
  character.setAttribute('transform', `translate(${start} 333)`);
  facing.removeAttribute('transform');
  celebration.setAttribute('hidden', '');
  arrival.textContent = '';
  description.textContent = '左におうち、右にびょういん。おうちのそばに子どもがいます。';
  replay.hidden = true;
  movement.hidden = false;
  right.focus({ preventScroll: true });
});
