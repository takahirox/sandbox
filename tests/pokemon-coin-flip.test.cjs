const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../projects/pokemon-coin-flip/coin.js'), 'utf8');

function setup({ reduced = false, bytes = [0] } = {}) {
  let click;
  let draws = 0;
  let failRandom = false;
  const timers = [];
  const announcements = [];
  const classes = new Set();
  const properties = {};
  const attributes = { 'aria-disabled': 'false' };
  const motion = { matches: reduced };
  const button = {
    addEventListener(event, handler) { assert.equal(event, 'click'); click = handler; },
    setAttribute(name, value) { attributes[name] = value; },
  };
  const coin = {
    dataset: { side: 'heads' },
    style: { setProperty(name, value) { properties[name] = value; } },
    classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); } },
  };
  const result = {
    set textContent(value) { announcements.push(value); },
    get textContent() { return announcements.at(-1); },
  };
  vm.runInNewContext(source, {
    Uint8Array,
    document: { getElementById(id) { return { flip: button, coin, result }[id]; } },
    window: {
      matchMedia(query) { assert.equal(query, '(prefers-reduced-motion: reduce)'); return motion; },
      crypto: {
        getRandomValues(array) {
          assert.ok(array instanceof Uint8Array);
          assert.equal(array.length, 1);
          if (failRandom) throw new Error('Random source unavailable');
          array[0] = bytes[draws++ % bytes.length];
          return array;
        },
      },
      setTimeout(callback, delay) { timers.push({ callback, delay }); },
    },
  });
  return {
    click: () => click(), coin, result, announcements, timers, classes, attributes, properties, motion,
    get draws() { return draws; },
    set failRandom(value) { failRandom = value; },
    settle() { assert.equal(timers.length, 1); timers.shift().callback(); },
  };
}

test('all 256 possible random bytes split equally, and each face matches its announced result', () => {
  const app = setup({ bytes: Array.from({ length: 256 }, (_, index) => index) });
  const counts = { 表: 0, 裏: 0 };
  for (let i = 0; i < 256; i++) {
    app.click();
    assert.equal(app.result.textContent, 'トス中…');
    app.settle();
    const expected = i % 2 === 0 ? '表' : '裏';
    assert.equal(app.result.textContent, expected);
    assert.equal(app.coin.dataset.side, expected === '表' ? 'heads' : 'tails');
    counts[expected]++;
  }
  assert.deepEqual(counts, { 表: 128, 裏: 128 });
  assert.equal(app.draws, 256);
});

test('rapid clicks draw only once and the control unlocks after the toss', () => {
  const app = setup({ bytes: [1, 0] });
  app.click();
  for (let i = 0; i < 20; i++) app.click();
  assert.equal(app.draws, 1);
  assert.equal(app.timers.length, 1);
  assert.equal(app.attributes['aria-disabled'], 'true');
  assert.ok(app.classes.has('is-flipping'));
  assert.equal(app.timers[0].delay, 680);
  app.settle();
  assert.equal(app.attributes['aria-disabled'], 'false');
  assert.equal(app.classes.size, 0);
  assert.equal(app.result.textContent, '裏');
  app.click();
  assert.equal(app.properties['--start-angle'], '180deg');
  assert.equal(app.properties['--end-angle'], '1080deg');
  app.settle();
  assert.equal(app.result.textContent, '表');
  assert.equal(app.draws, 2);
});

test('successive identical outcomes use new draws and separate live announcements', () => {
  const app = setup({ bytes: [1, 3, 255] });
  for (let i = 0; i < 3; i++) { app.click(); app.settle(); }
  assert.equal(app.draws, 3);
  assert.deepEqual(app.announcements, ['トス中…', '裏', 'トス中…', '裏', 'トス中…', '裏']);
});

test('reduced motion uses a short pause and honors preference changes on subsequent tosses', () => {
  const app = setup({ reduced: true });
  app.click();
  assert.equal(app.timers[0].delay, 120);
  app.settle();
  assert.equal(app.result.textContent, '表');
  assert.equal(app.attributes['aria-disabled'], 'false');
  app.motion.matches = false;
  app.click();
  assert.equal(app.timers[0].delay, 680);
  app.settle();
});

test('a random-source failure reports an error without inventing a result or locking retries', () => {
  const app = setup();
  app.failRandom = true;
  app.click();
  assert.match(app.result.textContent, /もう一度/);
  assert.equal(app.coin.dataset.side, 'heads');
  assert.equal(app.timers.length, 0);
  assert.equal(app.attributes['aria-disabled'], 'false');
  app.failRandom = false;
  app.click();
  app.settle();
  assert.equal(app.result.textContent, '表');
});
