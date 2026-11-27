import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from '../workers/persistent-counter/node_modules/playwright/index.mjs';
import { previewServer } from '../scripts/capture_screenshots.mjs';
import { createSession, historyKey } from '../projects/kids-ai-quiz/quiz.mjs';
import { memoryStorage, seeded } from '../scripts/kids-ai-quiz/evaluate.mjs';

const project = '/sandbox/projects/kids-ai-quiz/';
const choices = page => page.locator('#answers button');
const labels = page => page.locator('#answers button > span:last-child');
const next = page => page.locator('#next');
const heading = page => page.locator('#question');
const status = page => page.getByRole('status');
let browser, preview;

before(async () => {
  preview = await previewServer(resolve(import.meta.dirname, '..'));
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await preview?.close();
});

async function open(t, { seed = 68, options, init, handleQuiz } = {}) {
  const context = await browser.newContext({ reducedMotion: 'reduce', ...options });
  const page = await context.newPage();
  const paths = [], unexpected = [];
  page.on('pageerror', error => unexpected.push(error.message));
  await context.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === preview.origin && url.pathname.startsWith(project) && request.method() === 'GET') {
      paths.push(url.pathname);
      if (handleQuiz && url.pathname.endsWith('/quiz.mjs')) return handleQuiz(route);
      return route.continue();
    }
    unexpected.push(request.method() + ' ' + url.origin);
    return route.abort();
  });
  await context.routeWebSocket('**/*', socket => {
    unexpected.push('WebSocket');
    socket.close();
  });
  t.after(async () => {
    await context.close();
    assert.deepEqual(unexpected, []);
  });
  await page.addInitScript(initialSeed => {
    let seed = initialSeed;
    Math.random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  }, seed);
  if (init) await page.addInitScript(init);
  await page.goto(preview.origin + project);
  await choices(page).first().waitFor();
  return { context, page, paths };
}

async function assertFits(page) {
  const view = page.viewportSize();
  for (const element of await page.locator('h1, .illustration, button:visible').all()) {
    const box = await element.boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= view.width
      && box.y + box.height <= view.height, JSON.stringify({ box, view }));
    if (await element.evaluate(node => node.tagName === 'BUTTON')) assert.ok(box.width >= 44 && box.height >= 44);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), view.width);
  assert.equal(await choices(page).count(), 3);
}

async function assertRound(page, expected) {
  assert.equal(await heading(page).textContent(), expected.question);
  assert.deepEqual(await labels(page).allTextContents(), expected.choices.map(choice => choice.label));
  assert.equal(await page.locator('#clue').textContent(), expected.clue.spoken ?? '');
}

test('gallery keeps a stable inert view with no storage, speech or round-generation side effects', async t => {
  const { page, paths } = await open(t, {
    options: { viewport: { width: 1280, height: 720 } },
    init: () => {
      globalThis.__sandboxCapture = true;
      window.calls = [];
      Math.random = () => { window.calls.push('random'); return 0; };
      for (const key of ['localStorage', 'speechSynthesis', 'Worker']) {
        Object.defineProperty(window, key, { get() { window.calls.push(key); } });
      }
    },
  });
  for (let i = 0; i < 2; i++) {
    await assertFits(page);
    assert.equal(await heading(page).textContent(), 'わんわん なくのは？');
    assert.deepEqual(await labels(page).allTextContents(), ['ねこ', 'いぬ', 'ぶた']);
    assert.equal(await page.locator('main').evaluate(node => node.inert), true);
    await page.evaluate(() => {
      document.querySelectorAll('#answers button')[1].click();
      document.querySelector('#next').click();
    });
    assert.equal(await page.locator('#feedback').textContent(), '');
    assert.deepEqual(await page.evaluate(() => window.calls), []);
    if (!i) await page.reload();
  }
  assert.ok(!paths.some(path => /wasm|worker/.test(path)));
});

test('fresh visits and repeated reloads start with varied, enabled rounds', async t => {
  const openers = new Set();
  for (const seed of [68, 73, 79, 82, 88]) {
    const { page } = await open(t, { seed });
    const storage = memoryStorage();
    for (let load = 0; load < 3; load++) {
      const expected = createSession({ random: seeded(seed), storage }).next();
      await assertRound(page, expected);
      const keys = JSON.parse(await page.evaluate(key => localStorage.getItem(key), historyKey));
      assert.deepEqual(keys, JSON.parse(storage.getItem()));
      assert.equal(new Set(keys).size, load + 1);
      assert.equal(await page.locator('#answers button:enabled').count(), 3);
      if (load === 0) openers.add(expected.key);
      if (load < 2) await page.reload();
    }
  }
  assert.ok(openers.size >= 4);
});

test('touch and keyboard stay responsive on phone viewports with no workers, WASM, storage or speech', async t => {
  const seed = 70;
  const { context, page, paths } = await open(t, {
    seed,
    options: { viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true },
    init: () => {
      for (const key of ['Worker', 'WebAssembly', 'speechSynthesis']) {
        Object.defineProperty(window, key, { value: undefined });
      }
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } });
    },
  });
  const session = createSession({ random: seeded(seed) });
  const first = session.next();
  assert.equal(await page.locator('#speak').isVisible(), false);
  await assertFits(page);
  await assertRound(page, first);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const firstWrong = first.correct === 0 ? 1 : 0;
  for (let i = 0; i <= firstWrong; i++) await page.keyboard.press('Tab');
  assert.equal(await choices(page).nth(firstWrong).evaluate(node =>
    node === document.activeElement && getComputedStyle(node).outlineStyle === 'solid'), true);
  await page.keyboard.press('Enter');
  assert.equal(await status(page).textContent(), 'もういちど えらんでね。');
  await choices(page).nth(first.correct).tap();
  assert.equal(await status(page).textContent(), 'せいかい！');
  assert.equal(await choices(page).nth(first.correct).locator('.art').first().evaluate(node => getComputedStyle(node).animationName), 'none');
  assert.equal(await next(page).evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Space');
  let expected = session.next();
  await assertRound(page, expected);
  const topics = new Set([first.topic]);
  const picturedTasks = new Set();
  for (let i = 0; i < 13; i++) {
    topics.add(expected.topic);
    assert.equal(await heading(page).evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('#answers button:enabled').count(), 3);
    await assertFits(page);
    if (expected.clue.split) {
      picturedTasks.add('addition');
      assert.deepEqual(await page.locator('#illustration .counters').evaluateAll(groups => groups.map(group => group.childElementCount)),
        [expected.clue.split, expected.clue.count - expected.clue.split]);
    } else if (expected.clue.crossed) {
      picturedTasks.add('subtraction');
      assert.equal(await page.locator('#illustration .crossed').count(), expected.clue.crossed);
    }
    if (expected.topic === 'comparing') {
      picturedTasks.add('comparison');
      assert.deepEqual(await choices(page).evaluateAll(buttons => buttons.map(button => button.querySelectorAll('.art').length)),
        expected.choices.map(choice => choice.count));
    }
    if (i === 5) await page.setViewportSize({ width: 740, height: 360 });
    await next(page).tap();
    expected = session.next();
    await assertRound(page, expected);
  }
  assert.equal(topics.size, 10);
  assert.deepEqual(picturedTasks, new Set(['addition', 'subtraction', 'comparison']));
  assert.equal(await status(page).textContent(), '');
  assert.ok(!paths.some(path => /wasm|worker/.test(path)));
});

test('a rejected solver proposal falls back on the same click, with no pending round to cancel', async t => {
  const { page } = await open(t, {
    handleQuiz: async route => {
      const response = await route.fetch();
      const source = (await response.text()).replace('function choosePuzzle(candidates, recentGroups, random) {',
        'function choosePuzzle(candidates, recentGroups, random) { return null;');
      await route.fulfill({ response, body: source });
    },
  });
  const { next: fallback } = createSession({ random: seeded(68), solve: () => null });
  await assertRound(page, fallback());
  for (let i = 0; i < 4; i++) {
    const enabled = await next(page).evaluate(node => {
      node.click();
      return document.querySelectorAll('#answers button:enabled').length;
    });
    assert.equal(enabled, 3);
    await assertRound(page, fallback());
  }
});

test('read-aloud tracks the current round and cancels immediately on advance and pagehide', async t => {
  const { page } = await open(t, {
    init: () => {
      window.spoken = [];
      window.cancelled = 0;
      window.voices = [{ lang: 'ja-JP', localService: false }, { lang: 'en-US', localService: true }];
      const speech = new EventTarget();
      speech.getVoices = () => window.voices;
      speech.speak = utterance => window.spoken.push({ text: utterance.text, lang: utterance.lang, local: utterance.voice.localService });
      speech.cancel = () => window.cancelled++;
      Object.defineProperty(window, 'speechSynthesis', { value: speech });
      window.SpeechSynthesisUtterance = class {
        constructor(text) { this.text = text; }
      };
    },
  });
  const speak = page.getByRole('button', { name: 'もんだいを きく' });
  assert.equal(await speak.isVisible(), false);
  await page.evaluate(() => {
    window.voices.push({ lang: 'ja-JP', localService: true });
    speechSynthesis.dispatchEvent(new Event('voiceschanged'));
  });
  assert.deepEqual(await page.evaluate(() => window.spoken), []);
  const session = createSession({ random: seeded(68) });
  const rounds = [session.next(), session.next()];
  await speak.click();
  await next(page).click();
  assert.equal(await page.evaluate(() => window.cancelled), 1);
  await speak.click();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  assert.equal(await page.evaluate(() => window.cancelled), 2);
  assert.deepEqual(await page.evaluate(() => window.spoken), rounds.map(round => ({
    text: [round.question, round.clue.spoken && round.clue.spoken + '。', round.choices.map(choice => choice.label).join('、')]
      .filter(Boolean).join(' '),
    lang: 'ja-JP',
    local: true,
  })));
});
