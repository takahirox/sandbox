import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createRpsWorker, rpsControl } from './rps-helpers.js';

async function fixture(configured = true) {
  let apiUrl;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const prefix = '/sandbox/projects/rock-paper-scissors/';
    if (path === `${prefix}api-config.json`) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ apiUrl: configured ? apiUrl : '' })); return;
    }
    const files = { '/sandbox/': 'index.html', [prefix]: 'projects/rock-paper-scissors/index.html',
      [`${prefix}game.js`]: 'projects/rock-paper-scissors/game.js',
      [`${prefix}style.css`]: 'projects/rock-paper-scissors/style.css' };
    if (!files[path]) { response.writeHead(404).end(); return; }
    try {
      const data = await readFile(new URL(`../../../_site/${files[path]}`, import.meta.url));
      response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
      response.end(data);
    } catch { response.writeHead(500).end('Build site before browser tests'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const worker = createRpsWorker({ host: '127.0.0.1', bindings: { ALLOWED_ORIGIN: origin } });
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
const play = page => page.getByRole('button', { name: 'Join room 1', exact: true });
const hand = (page, name) => page.getByRole('button', { name, exact: true });

test('two browsers plus spectator synchronize private choices, ties, victory, consent and reload with no polling', { timeout: 40_000 }, async () => {
  const f = await fixture();
  try {
    const pages = await Promise.all(Array.from({ length: 3 }, () => f.browser.newPage()));
    const [a, b, viewer] = pages, errors = [], requests = [], frames = [];
    for (const p of pages) {
      p.setDefaultTimeout(5000);
      p.on('pageerror', e => errors.push(e.message));
      p.on('request', r => { if (r.url().startsWith(f.apiUrl)) requests.push(r.url()); });
      if (p !== a) p.on('websocket', ws => ws.on('framereceived', e => frames.push(e.payload)));
      await p.goto(`${f.origin}/sandbox/projects/rock-paper-scissors/`); await live(p);
    }
    assert.equal(await a.locator('.room-card').count(), 5);
    await play(a).click(); await textIs(a, 'phase', 'Waiting for an opponent');
    assert.equal(await hand(a, 'Rock').isDisabled(), true);
    await play(b).click(); await textIs(a, 'phase', 'Round 1');
    await play(viewer).click(); await textIs(viewer, 'role', 'You are watching');
    assert.equal(await viewer.locator('#hands').isVisible(), false);
    await hand(a, 'Rock').click(); await textIs(b, 'pending', 'Player 1: choice locked');
    assert.equal(await hand(a, 'Paper').isDisabled(), true);
    assert.equal(await viewer.locator('#results li').count(), 0);
    assert.ok(!frames.some(frame => String(frame).includes('"rock"')));
    const credential = await a.evaluate(() => JSON.parse(localStorage.getItem('sandbox-rps-seat')).credential);
    assert.ok(!frames.some(frame => String(frame).includes(credential)));
    // Reload with a locked choice preserves the seat and does not resend a move.
    await a.reload(); await live(a); await textIs(a, 'role', 'Player 1');
    assert.equal(await hand(a, 'Rock').isDisabled(), true);
    assert.equal(await a.evaluate(() => JSON.parse(localStorage.getItem('sandbox-rps-seat')).credential), credential);
    await hand(b, 'Rock').click(); await textIs(viewer, 'results', 'Tie');
    for (const p of pages) await textIs(p, 'phase', 'Round 2');
    for (let round = 2; round <= 4; round++) {
      await hand(a, 'Paper').click(); await hand(b, 'Rock').click();
      for (const p of pages) await textIs(p, 'phase', round === 4 ? 'Player 1 wins' : `Round ${round + 1}`);
    }
    assert.equal(await a.locator('#score strong').allTextContents().then(v => v.join(':')), '3:0');
    assert.deepEqual(await b.locator('#score strong').allTextContents(), ['3', '0']);
    assert.deepEqual(await viewer.locator('#score strong').allTextContents(), ['3', '0']);
    await a.getByRole('button', { name: 'Play again' }).click();
    await textIs(b, 'consent', 'Waiting for Player 2');
    await b.getByRole('button', { name: 'Play again' }).click();
    for (const p of pages) await textIs(p, 'phase', 'Round 1');
    assert.deepEqual(await viewer.locator('#score strong').allTextContents(), ['0', '0']);
    // Quiet connected clients can hibernate: no application timer keeps the DO awake.
    await new Promise(resolve => setTimeout(resolve, 11_000));
    await hand(a, 'Scissors').click(); await hand(b, 'Paper').click();
    await textIs(viewer, 'results', 'Player 1 wins');
    assert.deepEqual(requests, [], 'Backend traffic must use only WebSockets');
    assert.deepEqual(errors, []);
    await viewer.setViewportSize({ width: 320, height: 700 });
    assert.equal(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await a.getByRole('button', { name: 'Leave room' }).click();
    await textIs(b, 'phase', 'Waiting for an opponent');
    assert.equal(await a.evaluate(() => localStorage.getItem('sandbox-rps-seat')), null);
    await a.waitForFunction(() => document.querySelector('#game').hidden);
    await a.goto(`${f.origin}/sandbox/`);
    assert.equal(await a.getByRole('link', { name: 'rock-paper-scissors', exact: true }).count(), 1);
    assert.equal(await a.getByRole('link', { name: 'persistent-counter', exact: true }).count(), 1);
  } finally { await f.close(); }
});

test('network reconnect restores seat and secret move; timeout frees seat with pushed lobby updates', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const a = await f.browser.newPage(), b = await f.browser.newPage(), lobby = await f.browser.newPage();
    for (const p of [a, b, lobby]) {
      p.setDefaultTimeout(5000); await p.goto(`${f.origin}/sandbox/projects/rock-paper-scissors/`); await live(p);
    }
    await play(a).click(); await play(b).click(); await textIs(a, 'phase', 'Round 1');
    const token = await a.evaluate(() => JSON.parse(localStorage.getItem('sandbox-rps-seat')).credential);
    await hand(a, 'Scissors').click(); await textIs(b, 'pending', 'Player 1: choice locked');
    await a.context().setOffline(true);
    // Explicitly close the socket via a reload so this test does not depend on TCP's failure detector.
    await a.goto('about:blank'); await textIs(b, 'phase', 'Match paused');
    await a.context().setOffline(false);
    await a.goto(`${f.origin}/sandbox/projects/rock-paper-scissors/`); await live(a); await textIs(a, 'role', 'Player 1');
    assert.equal(await a.evaluate(() => JSON.parse(localStorage.getItem('sandbox-rps-seat')).credential), token);
    assert.equal(await hand(a, 'Paper').isDisabled(), true);
    await hand(b, 'Paper').click(); await textIs(a, 'results', 'Player 1 wins');
    const now = Date.parse('2030-01-01T12:00:00Z');
    await rpsControl(f.worker, { now });
    await a.goto('about:blank'); await textIs(b, 'phase', 'Match paused');
    await rpsControl(f.worker, { now: now + 60_000, alarm: true });
    await textIs(b, 'phase', 'Waiting for an opponent');
    await lobby.waitForFunction(() => document.querySelector('.room-state').textContent === 'Waiting for opponent');
    await a.goto(`${f.origin}/sandbox/projects/rock-paper-scissors/`); await live(a);
    await textIs(a, 'role', 'You are watching');
    await textIs(a, 'notice', 'previous seat expired');
    await a.getByRole('button', { name: 'Leave room' }).click();
    await play(a).click(); await textIs(b, 'phase', 'Round 1');
  } finally { await f.close(); }
});

test('unconfigured preview shows five disabled rooms, no backend traffic, and storage failure still allows play', async () => {
  let f = await fixture(false);
  try {
    const p = await f.browser.newPage(); let sockets = 0;
    p.on('websocket', () => sockets++);
    await p.goto(`${f.origin}/sandbox/projects/rock-paper-scissors/`);
    await textIs(p, 'connection', 'Unavailable');
    assert.equal(await p.locator('.room-card').count(), 5);
    assert.equal(await play(p).isDisabled(), true);
    assert.equal(sockets, 0);
  } finally { await f.close(); }
  f = await fixture();
  try {
    const p = await f.browser.newPage();
    await p.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('Unavailable'); } }); });
    await p.goto(`${f.origin}/sandbox/projects/rock-paper-scissors/`); await live(p);
    await play(p).click(); await textIs(p, 'role', 'Player 1');
    await textIs(p, 'notice', 'Device storage is unavailable');
  } finally { await f.close(); }
});
