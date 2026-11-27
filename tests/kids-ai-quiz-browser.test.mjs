import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from '../workers/persistent-counter/node_modules/playwright/index.mjs';
import { previewServer } from '../scripts/capture_screenshots.mjs';
import { createSession, fallback, validate } from '../projects/kids-ai-quiz/quiz.mjs';
import { seeded } from '../scripts/kids-ai-quiz/dataset.mjs';

const project = '/sandbox/projects/kids-ai-quiz/';
const button = (page, name) => page.getByRole('button', { name, exact: true });
const choices = page => page.locator('#answers button');
const labels = page => page.locator('#answers button > span:last-child');
const next = page => button(page, 'つぎへ');
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

async function open(t, { options, init, handleModel } = {}) {
  const context = await browser.newContext({ reducedMotion: 'reduce', ...options });
  const page = await context.newPage();
  const paths = [], unexpected = [];
  page.on('pageerror', error => unexpected.push(error.message));
  await context.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === preview.origin && url.pathname.startsWith(project) && request.method() === 'GET') {
      paths.push(url.pathname);
      if (handleModel && url.pathname.endsWith('.wasm')) return handleModel(route);
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
  if (init) await page.addInitScript(init);
  await page.goto(preview.origin + project);
  await choices(page).first().waitFor();
  return { context, page, paths };
}

async function assertFits(page) {
  const view = page.viewportSize();
  for (const element of await page.locator('h1, .illustration, button:visible').all()) {
    const box = await element.boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= view.width && box.y + box.height <= view.height);
    if (await element.evaluate(node => node.tagName === 'BUTTON')) assert.ok(box.width >= 44 && box.height >= 44);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), view.width);
  assert.equal(await choices(page).count(), 3);
}

test('gallery-sized first paint is inert, then the browser uses real WASM worker proposals in the game', async t => {
  const { context, page, paths } = await open(t, {
    options: { viewport: { width: 1280, height: 720 }, hasTouch: true },
    init: () => {
      let seed = 64;
      Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
      window.replies = [];
      window.workerStarts = 0;
      const BrowserWorker = window.Worker;
      window.Worker = class extends BrowserWorker {
        constructor(...args) {
          super(...args);
          window.workerStarts++;
          this.addEventListener('message', ({ data }) => {
            window.replies.push({ candidates: data.candidates, elapsed: performance.now() - this.started });
          });
        }
        postMessage(message) {
          this.started = performance.now();
          return super.postMessage(message);
        }
      };
    },
  });
  await assertFits(page);
  assert.equal(await page.getByRole('heading').textContent(), 'わんわん なくのは？');
  assert.deepEqual(await labels(page).allTextContents(), ['ねこ', 'いぬ', 'ぶた']);
  // The capture tool settles for 750 ms before taking its gallery image.
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => window.workerStarts), 0);
  assert.ok(!paths.some(path => /\.wasm$|model-worker/.test(path)));

  await page.setViewportSize({ width: 390, height: 740 });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const random = seeded(64);
  const session = createSession(random);
  let fromModel = 0;
  for (let i = 0; i < 4; i++) {
    const fact = session.next();
    await next(page).tap();
    await page.waitForFunction(count => window.replies.length === count && document.activeElement?.id === 'question', i + 1);
    const { candidates, elapsed } = await page.evaluate(index => window.replies[index], i);
    const proposal = candidates.map(tokens => validate(fact, tokens)).find(Boolean);
    fromModel += Number(Boolean(proposal));
    const expected = proposal ?? fallback(fact, random);
    assert.equal(await page.getByRole('heading').textContent(), expected.question);
    assert.deepEqual(await labels(page).allTextContents(), expected.choices.map(choice => choice.label));
    await choices(page).nth(expected.correct).tap();
    assert.equal(await status(page).textContent(), 'せいかい！');
    t.diagnostic(`${i === 0 ? 'Cold' : 'Warm'} worker round with 4× Chromium CPU throttling: ${elapsed.toFixed(1)} ms`);
  }
  assert.ok(fromModel > 0);
  await assertFits(page);
  assert.equal(paths.filter(path => path.endsWith('.wasm')).length, 1);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
});

test('touch and keyboard are playable at phone sizes without WASM, motion or speech', async t => {
  const { page, paths } = await open(t, {
    options: { viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true },
    init: () => {
      Object.defineProperty(window, 'WebAssembly', { value: undefined });
      Object.defineProperty(window, 'speechSynthesis', { value: undefined });
    },
  });
  assert.equal(await button(page, 'もんだいを きく').isVisible(), false);
  await assertFits(page);
  await page.keyboard.press('Tab');
  assert.equal(await choices(page).first().evaluate(node => node === document.activeElement && getComputedStyle(node).outlineStyle === 'solid'), true);
  await page.keyboard.press('Enter');
  assert.equal(await status(page).textContent(), 'もういちど えらんでね。');
  await button(page, 'いぬ').tap();
  assert.equal(await status(page).textContent(), 'せいかい！');
  assert.equal(await button(page, 'いぬ').locator('.art').evaluate(node => getComputedStyle(node).animationName), 'none');
  assert.equal(await next(page).evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.activeElement?.id === 'question');
  assert.equal(await status(page).textContent(), 'このまま あそべるよ。');
  assert.equal(await button(page, 'もういちど つくる').isVisible(), false);
  assert.ok(!paths.some(path => path.endsWith('.wasm')));
  await page.setViewportSize({ width: 740, height: 360 });
  await assertFits(page);
});

test('a model download failure gives an immediate fallback and retries on request', async t => {
  let fail = true;
  const { page, paths } = await open(t, {
    handleModel: route => fail ? route.fulfill({ status: 503 }) : route.continue(),
  });
  await next(page).click();
  const retry = button(page, 'もういちど つくる');
  await retry.waitFor();
  assert.equal(await status(page).textContent(), 'つくれなかったよ。');
  assert.ok(await choices(page).first().isEnabled());
  await next(page).click();
  assert.equal(paths.filter(path => path.endsWith('.wasm')).length, 1, 'Continues without repeated failing downloads');
  fail = false;
  await retry.click();
  await next(page).waitFor();
  assert.equal(await retry.isVisible(), false);
  assert.equal(paths.filter(path => path.endsWith('.wasm')).length, 2);
});

test('stop cancels an in-flight round, then a new worker can start and invalid proposals fall back', async t => {
  const { page } = await open(t, {
    init: () => {
      window.starts = 0;
      window.stops = 0;
      window.Worker = class {
        constructor() { window.starts++; }
        postMessage({ id }) {
          if (window.starts < 2) return;
          queueMicrotask(() => this.onmessage({ data: {
            id, candidates: [[0, 7, 1, 0], [0, 1, 1, 0], ['なまえは？', 1, 2, 0]],
          } }));
        }
        terminate() { window.stops++; }
      };
    },
  });
  await next(page).click();
  assert.equal(await status(page).textContent(), 'もんだいを つくってるよ…');
  assert.ok(await choices(page).first().isDisabled());
  await button(page, 'すぐ あそぶ').click();
  await next(page).waitFor();
  assert.equal(await page.evaluate(() => window.stops), 1);
  assert.ok(await choices(page).first().isEnabled());
  const afterStop = await page.getByRole('heading').textContent();
  await next(page).click();
  await next(page).waitFor();
  assert.equal(await page.evaluate(() => window.starts), 2);
  assert.notEqual(await page.getByRole('heading').textContent(), afterStop);
  assert.ok(await choices(page).first().isEnabled());
  assert.equal(await choices(page).count(), 3);
});

test('optional speech appears only with a local Japanese voice, reads once on demand and stops on advance', async t => {
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
  const speak = button(page, 'もんだいを きく');
  assert.equal(await speak.isVisible(), false);
  await page.evaluate(() => {
    window.voices.push({ lang: 'ja-JP', localService: true });
    speechSynthesis.dispatchEvent(new Event('voiceschanged'));
  });
  assert.deepEqual(await page.evaluate(() => window.spoken), []);
  await speak.click();
  assert.deepEqual(await page.evaluate(() => window.spoken), [
    { text: 'わんわん なくのは？ ねこ、いぬ、ぶた', lang: 'ja-JP', local: true },
  ]);
  await next(page).click();
  assert.equal(await page.evaluate(() => window.cancelled), 1);
  assert.equal(await page.evaluate(() => window.spoken.length), 1);
});
