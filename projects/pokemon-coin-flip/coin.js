'use strict';

const flipButton = document.getElementById('flip');
const coin = document.getElementById('coin');
const result = document.getElementById('result');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let flipping = false;

flipButton.addEventListener('click', () => {
  if (flipping) return;

  let heads;
  try {
    // A uniform byte has exactly 128 even and 128 odd values: no modulo bias.
    const random = new Uint8Array(1);
    window.crypto.getRandomValues(random);
    heads = (random[0] & 1) === 0;
  } catch {
    result.textContent = 'コインを投げられませんでした。もう一度お試しください。';
    return;
  }

  flipping = true;
  // aria-disabled keeps keyboard focus on the button for the next toss.
  flipButton.setAttribute('aria-disabled', 'true');
  result.textContent = 'トス中…';

  const startAngle = coin.dataset.side === 'heads' ? 0 : 180;
  const endAngle = heads ? 0 : 180;
  coin.style.setProperty('--start-angle', `${startAngle}deg`);
  coin.style.setProperty('--end-angle', `${1080 + endAngle}deg`);
  coin.classList.add('is-flipping');

  // Use a timer so a canceled/disabled CSS animation cannot lock the control.
  // A short no-motion pause also separates announcements for identical results.
  window.setTimeout(() => {
    coin.dataset.side = heads ? 'heads' : 'tails';
    coin.classList.remove('is-flipping');
    result.textContent = heads ? '表' : '裏';
    flipButton.setAttribute('aria-disabled', 'false');
    flipping = false;
  }, reducedMotion.matches ? 120 : 680);
});
