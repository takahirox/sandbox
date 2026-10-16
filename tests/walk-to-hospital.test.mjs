import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { resolve } from 'node:path';
import { chromium } from '../workers/persistent-counter/node_modules/playwright/index.mjs';
import { previewServer } from '../scripts/capture_screenshots.mjs';

let browser, preview;
before(async () => {
  preview = await previewServer(resolve(import.meta.dirname, '..'));
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await preview?.close();
});

async function openGame(t, options = {}) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, preview.origin, 'All assets stay local');
    assert.ok(url.pathname.startsWith('/sandbox/projects/walk-to-hospital/'));
    return route.continue();
  });
  t.after(async () => {
    await context.close();
    assert.deepEqual(errors, [], 'No runtime errors');
  });
  await page.clock.install();
  await page.goto(preview.origin + '/sandbox/projects/walk-to-hospital/');
  return page;
}

const position = page => page.locator('#character').evaluate(node => node.transform.baseVal.getItem(0).matrix.e);
const walking = page => page.locator('#character').evaluate(node => node.classList.contains('is-walking'));
async function holdKey(page, key, duration) {
  await page.keyboard.down(key);
  await page.clock.runFor(duration);
  await page.keyboard.up(key);
}

test('waits for interaction, walks both ways, stops on release, and keeps the child on the path', async t => {
  const page = await openGame(t);
  const start = await position(page);
  await page.clock.runFor(10000);
  assert.equal(await position(page), start, 'No automatic progress');
  assert.equal(await page.locator('#replay').isVisible(), false);
  await holdKey(page, 'ArrowLeft', 1000);
  assert.equal(await position(page), start, 'Cannot walk past home');
  await holdKey(page, 'ArrowRight', 1000);
  const forward = await position(page);
  assert.ok(forward > start + 100 && forward < start + 160);
  assert.equal(await walking(page), false);
  await page.clock.runFor(500);
  assert.equal(await position(page), forward, 'Release stops movement');
  await holdKey(page, 'ArrowLeft', 500);
  assert.ok(await position(page) < forward - 50);
  await holdKey(page, 'ArrowLeft', 2000);
  assert.equal(await position(page), start);
  await page.keyboard.down('ArrowRight');
  await page.keyboard.down('ArrowLeft');
  const opposed = await position(page);
  await page.clock.runFor(500);
  assert.equal(await position(page), opposed, 'Opposing arrows pause');
  await page.keyboard.up('ArrowLeft');
  await page.clock.runFor(500);
  assert.ok(await position(page) > opposed);
  await page.keyboard.up('ArrowRight');
});

test('arrival celebrates once, announces success, and replay starts a fresh walk', async t => {
  const page = await openGame(t);
  const start = await position(page);
  await page.locator('#right').focus();
  await holdKey(page, 'ArrowRight', 5000);
  const destination = await position(page);
  assert.ok(destination > start + 400);
  assert.equal(await walking(page), false);
  assert.equal(await page.locator('#arrival').textContent(), 'ついた！');
  assert.equal(await page.locator('#celebration').isVisible(), true);
  assert.equal(await page.locator('#movement').isVisible(), false);
  assert.equal(await page.locator('#replay').evaluate(node => node === document.activeElement), true);
  await holdKey(page, 'ArrowLeft', 1000);
  assert.equal(await position(page), destination);
  await page.keyboard.press('Enter');
  assert.equal(await position(page), start);
  assert.equal(await page.locator('#celebration').isVisible(), false);
  assert.equal(await page.locator('#arrival').textContent(), '');
  assert.equal(await page.locator('#right').evaluate(node => node === document.activeElement), true);
  await page.clock.runFor(5000);
  assert.equal(await position(page), start, 'Replay does not walk automatically');
  // Native button activation also works without holding an arrow key.
  await page.keyboard.press('Space');
  assert.ok(await position(page) > start);
  await holdKey(page, 'ArrowRight', 5000);
  assert.equal(await page.locator('#replay').isVisible(), true);
});

test('mouse capture, release outside the button, lost capture, and window blur stop walking', async t => {
  const page = await openGame(t);
  const button = await page.locator('#right').boundingBox();
  const press = async () => {
    await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2);
    await page.mouse.down();
    await page.clock.runFor(400);
  };
  await press();
  assert.equal(await walking(page), true);
  await page.mouse.move(2, 2);
  await page.mouse.up();
  const released = await position(page);
  await page.clock.runFor(1000);
  assert.equal(await position(page), released);
  await press();
  await page.locator('#right').evaluate(node => node.releasePointerCapture(1));
  await page.mouse.move(2, 2);
  await page.clock.runFor(50);
  assert.equal(await walking(page), false);
  await page.mouse.up();
  await page.keyboard.down('ArrowRight');
  await page.clock.runFor(400);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  const blurred = await position(page);
  await page.clock.runFor(1000);
  assert.equal(await position(page), blurred);
  await page.keyboard.up('ArrowRight');
});

test('real touch taps, holds, cancellations, and replay work in a mobile browser', async t => {
  const page = await openGame(t, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const start = await position(page);
  await page.locator('#right').tap();
  assert.ok(await position(page) > start, 'Quick tap takes a step');
  assert.equal(await walking(page), false);
  const session = await page.context().newCDPSession(page);
  const box = await page.locator('#right').boundingBox();
  const touchPoints = [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }];
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints });
  const pressed = await position(page);
  await page.clock.runFor(600);
  assert.ok(await position(page) > pressed + 50);
  await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  const cancelled = await position(page);
  await page.clock.runFor(1000);
  assert.equal(await position(page), cancelled);
  assert.equal(await walking(page), false);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints });
  await page.clock.runFor(5000);
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal(await page.locator('#replay').isVisible(), true);
  await page.locator('#replay').tap();
  assert.equal(await position(page), start);
});

test('phone, tablet, and landscape layouts fit, controls have labels, focus is visible, and motion is reduced', async t => {
  const page = await openGame(t);
  for (const [width, height] of [[320, 568], [390, 844], [844, 390], [768, 1024], [1024, 768]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true, `${width}×${height} fits`);
    for (const id of ['left', 'right']) {
      const button = page.locator('#' + id);
      const box = await button.boundingBox();
      assert.ok(box.width >= 76 && box.height >= 76 && box.y + box.height <= height);
      assert.ok(await button.getAttribute('aria-label'));
    }
  }
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#left').evaluate(node => getComputedStyle(node).outlineStyle), 'solid');
  await page.keyboard.down('ArrowRight');
  await page.clock.runFor(300);
  assert.equal(await page.locator('.person').evaluate(node => getComputedStyle(node).animationName), 'bounce');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.person').evaluate(node => getComputedStyle(node).animationName), 'none');
  const before = await position(page);
  await page.clock.runFor(300);
  assert.ok(await position(page) > before, 'Essential walking still responds with reduced motion');
  await page.keyboard.up('ArrowRight');
  await holdKey(page, 'ArrowRight', 5000);
  assert.equal(await page.locator('#celebration .heart').evaluate(node => getComputedStyle(node).animationName), 'none');
  assert.equal(await page.locator('#replay').isVisible(), true);
});
