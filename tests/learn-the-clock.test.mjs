import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from '../workers/persistent-counter/node_modules/playwright/index.mjs';
import { previewServer } from '../scripts/capture_screenshots.mjs';

const project = '/sandbox/projects/learn-the-clock/';
let browser, preview;
before(async () => {
  preview = await previewServer(resolve(import.meta.dirname, '..'));
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await preview?.close();
});

async function openGame(t, options, setup) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const unexpected = [];
  page.on('pageerror', error => unexpected.push(error.message));
  await context.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === preview.origin && url.pathname.startsWith(project) && request.method() === 'GET') return route.continue();
    unexpected.push('Nonlocal or non-GET request');
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
  if (setup) await page.addInitScript(setup);
  await page.goto(preview.origin + project);
  return page;
}

const button = (page, name) => page.getByRole('button', { name, exact: true });
const answer = (page, name) => page.getByRole('group', { name: 'じかんを えらぶ' }).getByRole('button', { name, exact: true });
const next = page => button(page, 'つぎへ');
const feedback = page => page.getByRole('status');
const angles = page => page.locator('#clock').evaluate(clock => ['hour-hand', 'minute-hand'].map(id => clock.querySelector('#' + id).transform.baseVal.getItem(0).angle));

async function unlockHalfHours(page) {
  await answer(page, '3じ').click();
  await button(page, 'あわせる').click();
  const short = button(page, 'みじかい はりを すすめる');
  await short.click();
  await short.click();
  assert.match(await feedback(page).textContent(), /せいかい/);
  await button(page, '○じはんの れんしゅう').click();
}

async function clockPoint(page, degrees, radius) {
  const box = await page.locator('#clock').boundingBox();
  const angle = degrees * Math.PI / 180;
  return { x: box.x + box.width * (.5 + Math.sin(angle) * radius / 360), y: box.y + box.height * (.5 - Math.cos(angle) * radius / 360) };
}

async function assertFits(page) {
  const view = page.viewportSize();
  for (const element of await page.locator('h1, #clock, #prompt, button:visible').all()) {
    const box = await element.boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= view.width && box.y + box.height <= view.height,
      `Visible control or clock outside ${view.width}×${view.height}: ${await element.textContent()}`);
    if (await element.evaluate(node => node.tagName) === 'BUTTON') assert.ok(box.width >= 44 && box.height >= 44);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), view.width);
}

test('whole-hour reading and keyboard setting give feedback, unlock half hours by choice, and allow revisiting whole hours', async t => {
  const page = await openGame(t, { viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' }, () => {
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: undefined });
  });
  assert.equal(await button(page, 'もんだいを きく').count(), 0);
  assert.equal(await button(page, '○じはんの れんしゅう').count(), 0);
  assert.deepEqual(await angles(page), [90, 0]);
  assert.equal(await page.getByRole('img', { name: /みじかい はりは 3、ながい はりは 12/ }).count(), 1);
  assert.equal(await page.locator('#clock').evaluate(clock => getComputedStyle(clock).touchAction), 'auto');
  await assertFits(page);

  await page.keyboard.press('Tab');
  assert.equal(await answer(page, '2じ').evaluate(node => node === document.activeElement && getComputedStyle(node).outlineStyle === 'solid'), true);
  await page.keyboard.press('Enter');
  assert.match(await feedback(page).textContent(), /みじかい はり/);
  await answer(page, '3じ').press('Space');
  assert.match(await feedback(page).textContent(), /せいかい/);
  assert.equal(await next(page).evaluate(node => node === document.activeElement), true);
  assert.equal(await page.locator('.bird').evaluate(bird => getComputedStyle(bird).animationName), 'none');
  await page.keyboard.press('Enter');
  await answer(page, '7じ').press('Enter');
  await page.keyboard.press('Enter');
  assert.deepEqual(await angles(page), [0, 0]);
  assert.equal(await button(page, '○じはんの れんしゅう').count(), 0);

  await button(page, 'あわせる').press('Enter');
  assert.match(await page.locator('#prompt').textContent(), /おきるのは 7じ/);
  const short = button(page, 'みじかい はりを すすめる');
  await short.press('ArrowLeft');
  assert.deepEqual(await angles(page), [120, 0]);
  await short.press('ArrowRight');
  await short.press('Enter');
  await short.press('Enter');
  assert.match(await feedback(page).textContent(), /せいかい.*はんの れんしゅう/);
  assert.equal(await button(page, '○じの れんしゅう').getAttribute('aria-pressed'), 'true');

  await button(page, '○じはんの れんしゅう').press('Enter');
  await button(page, 'よむ').press('Enter');
  assert.deepEqual(await angles(page), [105, 180]);
  await answer(page, '3じ').press('Enter');
  assert.match(await feedback(page).textContent(), /ながい はり/);
  await answer(page, '3じはん').press('Enter');
  await page.keyboard.press('Enter');
  assert.deepEqual(await angles(page), [345, 180]);
  assert.equal(await page.getByRole('img', { name: /11と12の あいだ、ながい はりは 6/ }).count(), 1);
  await answer(page, '11じはん').press('Enter');
  await page.keyboard.press('Enter');
  assert.deepEqual(await angles(page), [15, 180]);
  await button(page, '○じの れんしゅう').press('Enter');
  await answer(page, '12じ').press('Enter');
  assert.match(await feedback(page).textContent(), /せいかい/);
});

test('mouse can tap a number and drag the short hand to a snapped hour', async t => {
  const page = await openGame(t);
  await button(page, 'あわせる').click();
  const twelve = await clockPoint(page, 0, 112);
  await page.mouse.click(twelve.x, twelve.y);
  assert.deepEqual(await angles(page), [0, 0]);
  assert.match(await feedback(page).textContent(), /いまは 12じ/);
  const start = await clockPoint(page, 0, 60);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const angle of [-45, -90, -145]) {
    const point = await clockPoint(page, angle, 60);
    await page.mouse.move(point.x, point.y);
  }
  await page.mouse.up();
  assert.deepEqual(await angles(page), [210, 0]);
  assert.match(await feedback(page).textContent(), /せいかい/);
});

test('touch moves both hands continuously across 12, snaps on release, and fits portrait and landscape', async t => {
  const page = await openGame(t, { viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
  await assertFits(page);
  await unlockHalfHours(page);
  assert.deepEqual(await angles(page), [330, 0]);
  await assertFits(page);
  assert.equal(await page.locator('#clock').evaluate(clock => getComputedStyle(clock).touchAction), 'none');
  const session = await page.context().newCDPSession(page);
  const touch = async (type, angle) => {
    const touchPoints = angle === undefined ? [] : [await clockPoint(page, angle, 90)];
    await session.send('Input.dispatchTouchEvent', { type, touchPoints });
    // Chromium can coalesce touch moves until the next animation frame.
    if (type === 'touchMove') await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  };
  await touch('touchStart', 0);
  await touch('touchMove', 60);
  await touch('touchMove', 120);
  const between = await angles(page);
  assert.ok(Math.abs(between[0] - 340) < 1 && Math.abs(between[1] - 120) < 2,
    `Moving minutes also moves the hour hand before the snap, got ${between}`);
  assert.equal(await page.evaluate(() => scrollY), 0);
  await touch('touchCancel');
  assert.deepEqual(await angles(page), [330, 0]);
  await touch('touchStart', 0);
  await touch('touchMove', 180);
  await touch('touchEnd');
  assert.deepEqual(await angles(page), [345, 180]);
  assert.match(await feedback(page).textContent(), /せいかい/);

  await next(page).tap();
  await page.setViewportSize({ width: 568, height: 320 });
  await assertFits(page);
  await touch('touchStart', 0);
  for (const angle of [80, 160, 240, 320, 365]) await touch('touchMove', angle);
  await touch('touchEnd');
  assert.deepEqual(await angles(page), [0, 0]);
  const long = button(page, 'ながい はりを すすめる');
  await long.press('ArrowLeft');
  assert.deepEqual(await angles(page), [345, 180]);
  await long.press('ArrowRight');
  assert.deepEqual(await angles(page), [0, 0]);
  await long.tap();
  assert.deepEqual(await angles(page), [15, 180]);
  assert.match(await feedback(page).textContent(), /せいかい/);
  await assertFits(page);
});

test('spoken prompts require activation and use only an available local Japanese voice', async t => {
  const page = await openGame(t, {}, () => {
    window.prompts = [];
    window.voices = [{ lang: 'ja-JP', localService: false }, { lang: 'en-US', localService: true }];
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => window.voices,
      cancel() {},
      speak: utterance => window.prompts.push([utterance.text, utterance.lang, utterance.voice.localService]),
    } });
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  });
  const spoken = () => page.evaluate(() => window.prompts);
  const speak = button(page, 'もんだいを きく');
  assert.deepEqual(await spoken(), []);
  await speak.click();
  assert.deepEqual(await spoken(), []);
  await page.evaluate(() => window.voices.push({ lang: 'ja-JP', localService: true }));
  await speak.click();
  await button(page, 'あわせる').click();
  await speak.click();
  assert.deepEqual(await spoken(), [['いま、なんじ？', 'ja-JP', true], ['おきるのは しちじにしてね。', 'ja-JP', true]]);
});
