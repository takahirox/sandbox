import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createBingoWorker, bingoControl } from './bingo-helpers.js';

async function fixture(configured = true) {
  let apiUrl;
  const prefix = '/sandbox/projects/bingo/';
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === `${prefix}api-config.json`) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ apiUrl: configured === 'production' ? 'https://production.example.invalid' : configured ? apiUrl : '' })); return;
    }
    const files = { '/sandbox/': 'index.html', '/sandbox/gallery.js': 'gallery.js', '/sandbox/gallery.css': 'gallery.css',
      [prefix]: 'projects/bingo/index.html', [`${prefix}game.js`]: 'projects/bingo/game.js', [`${prefix}style.css`]: 'projects/bingo/style.css' };
    if (!files[path]) { response.writeHead(404).end(); return; }
    try {
      const data = await readFile(new URL(`../../../_site/${files[path]}`, import.meta.url));
      response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
      response.end(data);
    } catch { response.writeHead(500).end('Build site before browser tests'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const worker = createBingoWorker({ host: '127.0.0.1', bindings: { ALLOWED_ORIGIN: origin } });
  let browser;
  try {
    apiUrl = (await worker.ready).origin;
    browser = await chromium.launch();
    return { worker, browser, origin, apiUrl, async close() {
      await browser.close(); await worker.dispose(); await new Promise(resolve => server.close(resolve));
    } };
  } catch (error) {
    await browser?.close(); await worker.dispose(); await new Promise(resolve => server.close(resolve)); throw error;
  }
}
const live = page => page.waitForFunction(() => document.querySelector('#connection').textContent === 'Live');
const textIs = (page, id, value) => page.waitForFunction(({ id, value }) => document.getElementById(id).textContent.includes(value), { id, value });
const card = page => page.locator('#card button').allTextContents();
async function open(f) {
  const context = await f.browser.newContext();
  const page = await context.newPage(); page.setDefaultTimeout(7000);
  await page.addInitScript(() => {
    window.bingoSockets = [];
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) { super(...args); window.bingoSockets.push(this); }
    };
  });
  await page.goto(`${f.origin}/sandbox/projects/bingo/`); await live(page); return page;
}

test('independent browsers synchronize calls and private cards, retain marks/caller on reload, verify Bingo and confirm new games', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const errors = [], http = [], otherFrames = [];
    const a = await open(f), b = await open(f);
    for (const p of [a, b]) {
      p.on('pageerror', e => errors.push(e.message));
      p.on('request', r => { if (r.url().startsWith(f.apiUrl)) http.push(r.url()); });
    }
    b.on('websocket', ws => ws.on('framereceived', e => otherFrames.push(String(e.payload))));
    await b.reload(); await live(b);
    assert.equal(await a.locator('#card button').count(), 25);
    assert.notDeepEqual(await card(a), await card(b));
    assert.equal(await a.locator('#card button:enabled').count(), 0);
    await a.getByRole('button', { name: 'Become the caller' }).click();
    await a.getByRole('button', { name: 'Start game', exact: true }).click();
    assert.equal(await b.locator('#caller-controls').isVisible(), false);
    const savedCard = await card(a), savedToken = await a.evaluate(() => localStorage.getItem('sandbox-bingo-credential'));
    await a.reload(); await live(a);
    assert.deepEqual(await card(a), savedCard);
    assert.equal(await a.locator('#caller-controls').isVisible(), true);
    assert.equal(await a.evaluate(() => localStorage.getItem('sandbox-bingo-credential')), savedToken);
    const now = Date.now();
    for (let i = 0; i < 75; i++) {
      await bingoControl(f.worker, { now: now + i * 400 });
      await a.getByRole('button', { name: 'Draw next number' }).click();
      await textIs(b, 'count', `${i + 1} / 75`);
      await textIs(a, 'count', `${i + 1} / 75`);
    }
    assert.equal(await a.locator('#latest').textContent(), await b.locator('#latest').textContent());
    assert.equal(await a.locator('#draw').isDisabled(), true);
    const historyA = await a.locator('#history li').allTextContents();
    assert.equal(new Set(historyA).size, 75);
    assert.deepEqual(historyA, await b.locator('#history li').allTextContents());
    const late = await open(f); await textIs(late, 'count', '75 / 75');
    assert.equal(await late.locator('#card button:enabled').count(), 24);
    const first = b.locator('#card button').nth(0);
    await first.focus(); await b.keyboard.press('Enter');
    await b.waitForFunction(() => document.querySelector('#card button').getAttribute('aria-pressed') === 'true');
    assert.equal(await first.evaluate(el => el === document.activeElement), true);
    await b.reload(); await live(b);
    assert.equal(await b.locator('#card button').nth(0).getAttribute('aria-pressed'), 'true');
    for (let i = 1; i < 5; i++) await b.locator('#card button').nth(i).click();
    await b.locator('#celebration').waitFor({ state: 'visible' });
    assert.equal(await b.locator('#celebration').isVisible(), true);
    await textIs(a, 'wins', '1 verified Bingo'); await textIs(late, 'wins', '1 verified Bingo');
    assert.ok(!otherFrames.some(frame => frame.includes(savedToken)));
    await a.getByRole('button', { name: 'New game…' }).click();
    assert.equal(await a.getByRole('dialog').isVisible(), true);
    await a.keyboard.press('Escape');
    assert.equal(await a.locator('#count').textContent(), '75 / 75');
    await a.getByRole('button', { name: 'New game…' }).click();
    await a.getByRole('button', { name: 'Yes, new game' }).click();
    await textIs(a, 'count', '0 / 75'); await textIs(b, 'count', '0 / 75'); await textIs(late, 'count', '0 / 75');
    assert.notDeepEqual(await card(a), savedCard);
    assert.equal(await b.locator('#celebration').isVisible(), false);
    assert.equal(await b.locator('#card button.marked').count(), 1);
    await a.getByRole('button', { name: 'Release caller role' }).click();
    await b.getByRole('button', { name: 'Become the caller' }).click();
    await b.locator('#caller-controls').waitFor({ state: 'visible' });
    assert.deepEqual(http, [], 'Game traffic uses WebSockets, never HTTP polling'); assert.deepEqual(errors, []);
    await a.goto(`${f.origin}/sandbox/`);
    assert.equal(await a.locator('a[href="./projects/bingo/"]').count(), 1);
  } finally { await f.close(); }
});

test('responsive touch targets, keyboard focus, reduced motion, reconnect, takeover and storage failure', { timeout: 35_000 }, async () => {
  const f = await fixture();
  try {
    const a = await open(f);
    for (const width of [320, 375, 768, 1280]) {
      await a.setViewportSize({ width, height: 900 });
      assert.equal(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const box = await a.locator('#card button').first().boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44);
    }
    await a.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await a.locator('#latest').evaluate(el => getComputedStyle(el).animationName), 'none');
    await a.getByRole('button', { name: 'Become the caller' }).focus(); await a.keyboard.press('Enter');
    await a.getByRole('button', { name: 'Start game', exact: true }).click();
    const savedCard = await card(a);
    await a.evaluate(() => window.bingoSockets.at(-1).close());
    await a.waitForFunction(() => window.bingoSockets.length >= 2); await live(a);
    await new Promise(resolve => setTimeout(resolve, 11_000));
    await a.getByRole('button', { name: 'Draw next number' }).click();
    await textIs(a, 'count', '1 / 75');
    assert.deepEqual(await card(a), savedCard);
    const tab = await a.context().newPage();
    await tab.goto(`${f.origin}/sandbox/projects/bingo/`); await live(tab);
    await textIs(a, 'connection', 'Card opened in another tab');
    assert.equal(await a.locator('#draw').isDisabled(), true);
    await a.getByRole('button', { name: 'Reconnect', exact: true }).click(); await live(a);
    assert.deepEqual(await card(a), savedCard);
    const blocked = await f.browser.newPage();
    await blocked.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('Blocked'); } }); });
    await blocked.goto(`${f.origin}/sandbox/projects/bingo/`); await live(blocked);
    await textIs(blocked, 'notice', 'Device storage is unavailable');
  } finally { await f.close(); }
});

test('unconfigured previews and localhost pages with production config render safely without backend traffic', async () => {
  for (const config of [false, 'production']) {
    const f = await fixture(config);
    try {
      const page = await f.browser.newPage(), sockets = [], errors = [];
      page.on('websocket', ws => sockets.push(ws.url())); page.on('pageerror', e => errors.push(e.message));
      await page.goto(`${f.origin}/sandbox/projects/bingo/`); await textIs(page, 'connection', 'Unavailable');
      assert.equal(await page.locator('#card button').count(), 25);
      assert.equal(await page.locator('#card button:enabled').count(), 0);
      assert.deepEqual(sockets, []); assert.deepEqual(errors, []);
    } finally { await f.close(); }
  }
});
