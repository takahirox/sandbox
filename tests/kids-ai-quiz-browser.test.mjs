import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from '../workers/persistent-counter/node_modules/playwright/index.mjs';
import { previewServer } from '../scripts/capture_screenshots.mjs';
import { createSession } from '../projects/kids-ai-quiz/quiz.mjs';
import { seeded } from '../scripts/kids-ai-quiz/dataset.mjs';
import { modelHistoryKey } from '../projects/kids-ai-quiz/session.mjs';

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

async function open(t, { seed = 68, options, init, handleModel, wait = true } = {}) {
  const context = await browser.newContext({ reducedMotion: 'reduce', ...options });
  const page = await context.newPage();
  const paths = [], unexpected = [];
  page.on('pageerror', error => unexpected.push(error.message));
  await context.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === preview.origin && url.pathname.startsWith(project) && request.method() === 'GET') {
      paths.push(url.pathname);
      if (handleModel && url.pathname.endsWith('/quiz-gru-v1.bin')) return handleModel(route);
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
  if (wait) await choices(page).first().waitFor();
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
  assert.ok(!paths.some(path => /wasm|worker|\.bin$/.test(path)));
});

test('real workers generate the opener on fresh visits and avoid repeats on seeded reloads', async t => {
  const openers = new Set();
  for (const seed of [68, 73, 79, 82, 88]) {
    const { page, paths } = await open(t, { seed });
    for (let load = 0; load < 3; load++) {
      assert.equal(await page.locator('main').getAttribute('data-source'), 'model');
      const keys = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).map(row => row[0]), modelHistoryKey);
      assert.equal(new Set(keys).size, load + 1);
      assert.equal(await choices(page).count(), 3);
      await assertFits(page);
      if (load === 0) openers.add(keys[0]);
      if (load < 2) await page.reload();
      await choices(page).first().waitFor();
    }
    assert.ok(paths.some(path => path.endsWith('/model-worker.mjs')));
    assert.ok(paths.some(path => path.endsWith('/quiz-gru-v1.bin')));
  }
  assert.ok(openers.size >= 4);
});

test('real model rounds stay playable on repeated mobile advances', async t => {
  const { page, context } = await open(t, {
    seed: 74, options: { viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true },
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  for (let i = 0; i < 12; i++) {
    assert.equal(await page.locator('main').getAttribute('data-source'), 'model');
    assert.equal(await choices(page).count(), 3);
    assert.equal(new Set(await labels(page).allTextContents()).size, 3);
    await assertFits(page);
    if (i === 0) {
      // Exactly one displayed choice is marked correct, while wrong answers
      // remain retryable and the winning choice moves focus to Next.
      let successes = 0;
      for (const button of await choices(page).all()) {
        await button.tap();
        if (await status(page).textContent() === 'せいかい！') {
          successes++;
          break;
        }
        assert.equal(await status(page).textContent(), 'もういちど えらんでね。');
      }
      assert.equal(successes, 1);
      assert.equal(await page.locator('#answers button:disabled').count(), 3);
      assert.equal(await next(page).evaluate(node => node === document.activeElement), true);
    }
    if (i === 5) await page.setViewportSize({ width: 740, height: 360 });
    await next(page).tap();
    await page.locator('#answers button:enabled').first().waitFor();
    assert.equal(await heading(page).evaluate(node => node === document.activeElement), true);
  }
});

test('the real model asks which objects to count in a held-out mixed picture', async t => {
  // Five pencils and two other objects were held out regardless of object names.
  const { page, paths } = await open(t, {
    seed: 551, options: { viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true },
  });
  assert.equal(await page.locator('main').getAttribute('data-source'), 'model');
  assert.ok(paths.some(path => path.endsWith('/quiz-gru-v1.bin')));
  assert.equal(await heading(page).textContent(), 'えんぴつ は いくつ ある？');
  const groups = page.locator('#illustration .counters');
  assert.deepEqual(await groups.evaluateAll(rows => rows.map(row =>
    [...row.children].map(child => child.dataset.icon))), [Array(5).fill('✏️'), Array(2).fill('⭐')]);
  assert.ok(!(await page.locator('#illustration').textContent()).includes('＋'));
  assert.deepEqual(await labels(page).allTextContents(), ['9', '0', '5']);
  await assertFits(page);
  await choices(page).nth(0).tap();
  assert.equal(await status(page).textContent(), 'もういちど えらんでね。');
  await choices(page).nth(1).tap();
  assert.equal(await status(page).textContent(), 'もういちど えらんでね。');
  await choices(page).nth(2).tap();
  assert.equal(await status(page).textContent(), 'せいかい！');
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
  assert.ok(!paths.some(path => /wasm|worker|\.bin$/.test(path)));
});

test('unreadable model weights fall back and the next visit can recover', async t => {
  let corrupt = true;
  const { page } = await open(t, {
    handleModel: route => corrupt ? route.fulfill({ body: 'truncated weights' }) : route.continue(),
  });
  assert.equal(await page.locator('main').getAttribute('data-source'), 'fallback');
  const first = await heading(page).textContent();
  await next(page).click();
  await page.locator('#answers button:enabled').first().waitFor();
  assert.equal(await page.locator('main').getAttribute('data-source'), 'fallback');
  assert.notEqual(await heading(page).textContent(), first);
  corrupt = false;
  await page.reload();
  await page.locator('#answers button:enabled').first().waitFor();
  assert.equal(await page.locator('main').getAttribute('data-source'), 'model');
});

for (const recovers of [true, false]) {
  test(recovers ? 'a weight-load 503 serves fallback while one retry recovers'
    : 'a second weight-load 503 keeps fallback playable', { timeout: 10_000 }, async t => {
    let requests = 0, notify;
    const retryStarted = new Promise(resolve => { notify = resolve; });
    const { page } = await open(t, {
      init: () => {
        const RealWorker = Worker;
        window.finishedAttempts = 0;
        window.Worker = class extends RealWorker {
          constructor(...args) {
            super(...args);
            this.addEventListener('message', ({ data }) => {
              if (data.failed || data.item) window.finishedAttempts++;
            });
          }
        };
      },
      handleModel: route => {
        if (++requests === 2) notify(route);
        else return route.fulfill({ status: 503 });
      },
    });
    assert.equal(await page.locator('main').getAttribute('data-source'), 'fallback');
    const first = await heading(page).textContent();
    const retry = await retryStarted;
    await next(page).click();
    await page.locator('#answers button:enabled').first().waitFor();
    assert.equal(await page.locator('main').getAttribute('data-source'), 'fallback');
    assert.notEqual(await heading(page).textContent(), first);
    assert.equal(await choices(page).count(), 3);
    if (recovers) await retry.continue();
    else await retry.fulfill({ status: 503 });
    await page.waitForFunction(() => window.finishedAttempts >= 2);
    for (let i = 0; i < 2; i++) {
      await next(page).click();
      await page.locator('#answers button:enabled').first().waitFor();
      assert.equal(await page.locator('main').getAttribute('data-source'), recovers ? 'model' : 'fallback');
      assert.equal(await choices(page).count(), 3);
    }
    assert.equal(requests, 2);
  });
}

test('a stalled startup falls back and a later round adopts a successful retry', { timeout: 10_000 }, async t => {
  const held = [];
  let notify;
  const retryStarted = new Promise(resolve => { notify = resolve; });
  const { page } = await open(t, {
    init: () => {
      const RealWorker = Worker;
      window.Worker = class extends RealWorker {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', ({ data }) => { if (data.item) window.generatedRound = true; });
        }
      };
    },
    handleModel: route => {
      held.push(route);
      if (held.length === 2) notify();
      if (held.length > 2) return route.continue();
    },
  });
  assert.equal(await page.locator('main').getAttribute('data-source'), 'fallback');
  const first = await heading(page).textContent();
  await retryStarted;
  await held[0].abort().catch(() => {});
  await next(page).click();
  await page.locator('#answers button:enabled').first().waitFor();
  assert.equal(await page.locator('main').getAttribute('data-source'), 'fallback');
  assert.notEqual(await heading(page).textContent(), first);
  await held[1].continue();
  await page.waitForFunction(() => window.generatedRound);
  await next(page).click();
  await page.locator('#answers button:enabled').first().waitFor();
  assert.equal(await page.locator('main').getAttribute('data-source'), 'model');
  assert.equal(held.length, 2);
});

test('a second startup timeout keeps later fallback rounds playable', { timeout: 10_000 }, async t => {
  const held = [];
  const { page } = await open(t, {
    init: () => {
      const RealWorker = Worker;
      window.terminated = 0;
      window.Worker = class extends RealWorker {
        terminate() { window.terminated++; super.terminate(); }
      };
    },
    handleModel: route => { held.push(route); },
  });
  await page.waitForFunction(() => window.terminated === 2);
  for (const route of held) await route.abort().catch(() => {});
  for (let i = 0; i < 2; i++) {
    await next(page).click();
    await page.locator('#answers button:enabled').first().waitFor();
    assert.equal(await page.locator('main').getAttribute('data-source'), 'fallback');
  }
  assert.equal(held.length, 2);
});

test('pagehide cancels an in-flight opener and page restore starts a fresh worker', async t => {
  let held, notify;
  const started = new Promise(resolve => { notify = resolve; });
  const { page } = await open(t, {
    wait: false,
    init: () => {
      const RealWorker = Worker;
      window.terminated = 0;
      window.Worker = class extends RealWorker {
        terminate() { window.terminated++; super.terminate(); }
      };
    },
    handleModel: route => {
      if (held) return route.continue();
      held = route;
      notify();
    },
  });
  await started;
  assert.equal(await choices(page).count(), 0);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await held.abort().catch(() => {});
  await page.locator('#answers button:enabled').first().waitFor();
  assert.equal(await page.evaluate(() => window.terminated), 1);
  assert.equal(await page.locator('main').getAttribute('data-source'), 'model');
  assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).length, modelHistoryKey), 1);
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
  const visibleRound = async () => ({
    question: await heading(page).textContent(),
    clue: await page.locator('#clue').textContent(),
    choices: await labels(page).allTextContents(),
  });
  const first = await visibleRound();
  await speak.click();
  await next(page).click();
  await page.locator('#answers button:enabled').first().waitFor();
  const second = await visibleRound();
  assert.equal(await page.evaluate(() => window.cancelled), 1);
  await speak.click();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  assert.equal(await page.evaluate(() => window.cancelled), 2);
  assert.deepEqual(await page.evaluate(() => window.spoken), [first, second].map(round => ({
    text: [round.question, round.clue && round.clue + '。', round.choices.join('、')]
      .filter(Boolean).join(' '),
    lang: 'ja-JP',
    local: true,
  })));
});
