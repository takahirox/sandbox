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
    const files = { '/sandbox/': 'index.html',
      '/sandbox/gallery.css': 'gallery.css', '/sandbox/gallery.js': 'gallery.js',
      [prefix]: 'projects/rock-paper-scissors/index.html',
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
const row = (page, room = 1) => page.getByRole('button', { name: new RegExp(`^Room ${String(room).padStart(2, '0')},`) });
async function play(page, room = 1) {
  await row(page, room).click(); await page.getByRole('button', { name: 'Play', exact: true }).click();
}
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
    assert.equal(await a.locator('.room-row').count(), 5);
    assert.equal(await a.locator('#game').isVisible(), false);
    assert.equal(await a.locator('#connection').evaluate(el => getComputedStyle(el).position), 'absolute');
    await play(a); await textIs(a, 'phase', 'Waiting for an opponent');
    assert.equal(await a.locator('#lobby').isVisible(), false);
    assert.equal(await a.getByRole('link', { name: 'Sandbox' }).isVisible(), false);
    assert.equal(await hand(a, 'Rock').isDisabled(), true);
    await play(b); await textIs(a, 'round', 'Round 1');
    await textIs(viewer, 'rooms', '2 / 2');
    await row(viewer).click(); await textIs(viewer, 'role', 'You are watching');
    assert.equal(await viewer.locator('#hands').isVisible(), false);
    assert.equal(await viewer.locator('#spectator-label').isVisible(), true);
    assert.equal(await viewer.locator('#lobby').isVisible(), false);
    assert.equal(await viewer.locator('[data-hand]:enabled').count(), 0);
    await viewer.evaluate(() => document.querySelector('[data-hand]').click());
    await hand(a, 'Rock').click(); await textIs(a, 'phase', 'Waiting for opponent’s hand');
    assert.equal(await hand(a, 'Paper').isDisabled(), true);
    assert.equal(await viewer.locator('#result > div').count(), 0);
    assert.ok(!frames.some(frame => String(frame).includes('"rock"')));
    const credential = await a.evaluate(() => JSON.parse(localStorage.getItem('sandbox-rps-seat')).credential);
    assert.ok(!frames.some(frame => String(frame).includes(credential)));
    // Reload with a locked choice preserves the seat and does not resend a move.
    await a.reload(); await live(a); await textIs(a, 'role', 'Player 1');
    assert.equal(await hand(a, 'Rock').isDisabled(), true);
    assert.equal(await a.evaluate(() => JSON.parse(localStorage.getItem('sandbox-rps-seat')).credential), credential);
    await hand(b, 'Rock').click(); await textIs(viewer, 'result', 'Tie');
    assert.deepEqual(await viewer.locator('#result small').allTextContents(), ['Player 1 · rock', 'Player 2 · rock']);
    for (const p of pages) await textIs(p, 'round', 'Round 2');
    for (let round = 2; round <= 4; round++) {
      await hand(a, 'Paper').click(); await hand(b, 'Rock').click();
      for (const p of pages) await textIs(p, round === 4 ? 'phase' : 'round', round === 4 ? p === viewer ? 'Player 1 wins' : p === a ? 'You win' : 'Opponent wins' : `Round ${round + 1}`);
    }
    assert.equal(await a.locator('#score strong').allTextContents().then(v => v.join(':')), '3:0');
    assert.deepEqual(await b.locator('#score strong').allTextContents(), ['0', '3']);
    assert.deepEqual(await viewer.locator('#score strong').allTextContents(), ['3', '0']);
    await textIs(b, 'result', 'You lose');
    assert.deepEqual(await b.locator('#result small').allTextContents(), ['You · rock', 'Opponent · paper']);
    assert.equal(await a.locator('#result > p').count(), 1);
    assert.equal(await a.locator('#hands').isVisible(), false);
    assert.equal(await viewer.getByRole('button', { name: 'Play again' }).isVisible(), false);
    await a.getByRole('button', { name: 'Play again' }).click();
    assert.equal(await a.getByRole('button', { name: 'Play again' }).isDisabled(), true);
    await textIs(a, 'consent', 'waiting for opponent');
    await textIs(b, 'consent', 'Opponent wants to play again');
    await b.getByRole('button', { name: 'Play again' }).click();
    for (const p of pages) await textIs(p, 'round', 'Round 1');
    assert.deepEqual(await viewer.locator('#score strong').allTextContents(), ['0', '0']);
    assert.equal(await viewer.locator('#result > div').count(), 0);
    // Quiet connected clients can hibernate: no application timer keeps the DO awake.
    await new Promise(resolve => setTimeout(resolve, 11_000));
    await hand(a, 'Scissors').click(); await hand(b, 'Paper').click();
    await textIs(viewer, 'result', 'Player 1 wins');
    assert.deepEqual(requests, [], 'Backend traffic must use only WebSockets');
    assert.deepEqual(errors, []);
    await viewer.setViewportSize({ width: 320, height: 700 });
    assert.equal(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await a.getByRole('button', { name: 'Room list' }).click();
    await textIs(b, 'phase', 'Waiting for an opponent');
    assert.equal(await a.evaluate(() => localStorage.getItem('sandbox-rps-seat')), null);
    await a.waitForFunction(() => document.querySelector('#game').hidden);
    assert.equal(await a.locator('#lobby').isVisible(), true);
    assert.equal(await row(a).evaluate(el => el === document.activeElement), true);
    await a.goto(`${f.origin}/sandbox/`);
    assert.equal(await a.locator('a[href="./projects/rock-paper-scissors/"]').count(), 1);
    assert.equal(await a.locator('a[href="./projects/persistent-counter/"]').count(), 1);
  } finally { await f.close(); }
});

test('switching rooms clears the previous hands and outcome for spectators and players', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const a = await f.browser.newPage(), b = await f.browser.newPage();
    for (const p of [a, b]) {
      p.setDefaultTimeout(5000); await p.goto(`${f.origin}/sandbox/projects/rock-paper-scissors/`); await live(p);
    }
    await play(a); await play(b); await textIs(a, 'phase', 'Choose your hand');
    await hand(a, 'Rock').click(); await hand(b, 'Scissors').click();
    await textIs(a, 'result', 'You win');
    assert.deepEqual(await a.locator('#result small').allTextContents(), ['You · rock', 'Opponent · scissors']);
    await a.getByRole('button', { name: 'Room list' }).click();
    await a.waitForFunction(() => !document.querySelector('#lobby').hidden);
    assert.equal(await a.locator('#result').textContent(), '');
    await row(a, 2).click(); await a.getByRole('button', { name: 'Watch', exact: true }).click();
    await textIs(a, 'room-title', 'Room 02'); await textIs(a, 'phase', 'Waiting for players');
    assert.equal(await a.locator('#result').textContent(), '');
    assert.deepEqual(await a.locator('#score strong').allTextContents(), ['0', '0']);
    assert.equal(await a.locator('#hands').isVisible(), false);
    await a.getByRole('button', { name: 'Room list' }).click();
    await a.waitForFunction(() => !document.querySelector('#lobby').hidden);
    await play(a, 3); await textIs(a, 'phase', 'Waiting for an opponent');
    assert.equal(await a.locator('#result').textContent(), '');
  } finally { await f.close(); }
});

test('network reconnect restores seat and secret move; timeout frees seat with pushed lobby updates', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const a = await f.browser.newPage(), b = await f.browser.newPage(), lobby = await f.browser.newPage();
    for (const p of [a, b, lobby]) {
      p.setDefaultTimeout(5000); await p.goto(`${f.origin}/sandbox/projects/rock-paper-scissors/`); await live(p);
    }
    await play(a); await play(b); await textIs(a, 'round', 'Round 1');
    const token = await a.evaluate(() => JSON.parse(localStorage.getItem('sandbox-rps-seat')).credential);
    await hand(a, 'Scissors').click(); await textIs(a, 'phase', 'Waiting for opponent’s hand');
    await a.context().setOffline(true);
    // Explicitly close the socket via a reload so this test does not depend on TCP's failure detector.
    await a.goto('about:blank'); await textIs(b, 'phase', 'Match paused');
    await a.context().setOffline(false);
    await a.goto(`${f.origin}/sandbox/projects/rock-paper-scissors/`); await live(a); await textIs(a, 'role', 'Player 1');
    assert.equal(await a.evaluate(() => JSON.parse(localStorage.getItem('sandbox-rps-seat')).credential), token);
    assert.equal(await hand(a, 'Paper').isDisabled(), true);
    await hand(b, 'Paper').click(); await textIs(a, 'result', 'You win');
    const now = Date.parse('2030-01-01T12:00:00Z');
    await rpsControl(f.worker, { now });
    await a.goto('about:blank'); await textIs(b, 'phase', 'Match paused');
    await rpsControl(f.worker, { now: now + 60_000, alarm: true });
    await textIs(b, 'phase', 'Waiting for an opponent');
    await lobby.waitForFunction(() => document.querySelector('.room-state').textContent === 'Waiting for opponent');
    await a.goto(`${f.origin}/sandbox/projects/rock-paper-scissors/`); await live(a);
    await textIs(a, 'role', 'You are watching');
    await textIs(a, 'notice', 'previous seat expired');
    await a.getByRole('button', { name: 'Room list' }).click();
    await play(a); await textIs(b, 'round', 'Round 1');
  } finally { await f.close(); }
});

test('unconfigured preview shows five disabled rooms, no backend traffic, and storage failure still allows play', async () => {
  let f = await fixture(false);
  try {
    const p = await f.browser.newPage(); let sockets = 0;
    p.on('websocket', () => sockets++);
    await p.goto(`${f.origin}/sandbox/projects/rock-paper-scissors/`);
    await textIs(p, 'connection', 'Unavailable');
    assert.equal(await p.locator('.room-row').count(), 5);
    assert.equal(await row(p).isDisabled(), true);
    assert.equal(sockets, 0);
  } finally { await f.close(); }
  f = await fixture();
  try {
    const p = await f.browser.newPage();
    await p.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('Unavailable'); } }); });
    await p.goto(`${f.origin}/sandbox/projects/rock-paper-scissors/`); await live(p);
    await play(p); await textIs(p, 'role', 'Player 1');
    await textIs(p, 'notice', 'Device storage is unavailable');
  } finally { await f.close(); }
});

test('room rows and role choice work by keyboard and touch on mobile, with live occupancy and reduced motion', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const a = await f.browser.newPage({ viewport: { width: 320, height: 700 }, isMobile: true, hasTouch: true });
    const b = await f.browser.newPage();
    for (const p of [a, b]) {
      p.setDefaultTimeout(5000); await p.goto(`${f.origin}/sandbox/projects/rock-paper-scissors/`); await live(p);
    }
    await a.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await a.locator('.room-row').count(), 5);
    assert.equal(await a.locator('#lobby button').count(), 5);
    for (const button of await a.locator('.room-row').all()) {
      const box = await button.boundingBox(); assert.ok(box.height >= 48 && box.width >= 280);
    }
    await row(a, 3).focus(); await a.keyboard.press('Enter');
    assert.equal(await a.locator('#room-choice').isVisible(), true);
    assert.equal(await a.getByRole('button', { name: 'Play', exact: true }).evaluate(el => el === document.activeElement), true);
    await a.keyboard.press('Tab');
    assert.equal(await a.getByRole('button', { name: 'Watch', exact: true }).evaluate(el => el === document.activeElement), true);
    await a.keyboard.press('Tab');
    assert.equal(await a.getByRole('button', { name: 'Cancel', exact: true }).evaluate(el => el === document.activeElement), true);
    await row(a, 3).evaluate(el => el.focus());
    assert.equal(await a.getByRole('button', { name: 'Cancel', exact: true }).evaluate(el => el === document.activeElement), true);
    await a.keyboard.press('Shift+Tab'); await a.keyboard.press('Shift+Tab');
    assert.equal(await a.getByRole('button', { name: 'Play', exact: true }).evaluate(el => el === document.activeElement), true);
    await a.keyboard.press('Escape');
    assert.equal(await a.locator('#room-choice').isVisible(), false);
    assert.equal(await row(a, 3).evaluate(el => el === document.activeElement), true);
    assert.equal(await a.locator('#game').isVisible(), false);
    // Watching an empty room is a deliberate choice and never claims a seat.
    await row(a, 3).tap(); await a.getByRole('button', { name: 'Watch', exact: true }).tap();
    await textIs(a, 'phase', 'Waiting for players');
    assert.equal(await a.locator('#hands').isVisible(), false);
    assert.equal(await a.locator('#leave').evaluate(el => el === document.activeElement), true);
    assert.equal((await rpsControl(f.worker)).rooms[2].players.filter(Boolean).length, 0);
    await a.getByRole('button', { name: 'Room list' }).tap();
    await a.waitForFunction(() => !document.querySelector('#lobby').hidden);
    // The selected room's choice stays current while another visitor joins.
    await row(a, 3).tap(); await play(b, 3);
    await textIs(a, 'choice-state', 'An opponent is waiting');
    await a.getByRole('button', { name: 'Play', exact: true }).tap();
    await textIs(a, 'phase', 'Choose your hand');
    assert.deepEqual(await a.locator('#score span').allTextContents(), ['You', 'Opponent']);
    for (const button of await a.locator('[data-hand]').all()) {
      const box = await button.boundingBox(); assert.ok(box.width >= 80 && box.height >= 48);
    }
    assert.equal(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await a.locator('#leave').focus(); await a.keyboard.press('Tab'); await a.keyboard.press('Tab');
    assert.equal(await hand(a, 'Scissors').evaluate(el => el === document.activeElement), true);
    assert.notEqual(await hand(a, 'Scissors').evaluate(el => getComputedStyle(el).outlineStyle), 'none');
    await a.keyboard.press('Enter'); await textIs(a, 'phase', 'Waiting for opponent’s hand');
    assert.equal(await hand(a, 'Paper').isDisabled(), true);
    assert.equal(await a.locator('#result').textContent(), '');
    await hand(b, 'Paper').click(); await textIs(a, 'result', 'You win');
    assert.deepEqual(await a.locator('#score strong').allTextContents(), ['1', '0']);
    assert.equal(await a.locator('#result').evaluate(el => getComputedStyle(el).animationName), 'none');
    assert.equal(await hand(a, 'Paper').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    assert.equal(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await f.close(); }
});

test('a selected room becoming full offers only watching; capped play and connection failures remain actionable', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const playerContext = await f.browser.newContext();
    const a = await playerContext.newPage();
    const [b, visitor] = await Promise.all(Array.from({ length: 2 }, () => f.browser.newPage()));
    for (const p of [a, b, visitor]) {
      p.setDefaultTimeout(5000); await p.goto(`${f.origin}/sandbox/projects/rock-paper-scissors/`); await live(p);
    }
    await play(a); await row(visitor).click();
    await visitor.getByRole('button', { name: 'Play', exact: true }).focus();
    await play(b); await textIs(visitor, 'choice-state', 'Room full');
    assert.equal(await visitor.getByRole('button', { name: 'Play', exact: true }).isVisible(), false);
    assert.equal(await visitor.getByRole('button', { name: 'Watch', exact: true }).evaluate(el => el === document.activeElement), true);
    await visitor.keyboard.press('Enter'); await textIs(visitor, 'role', 'You are watching');
    await visitor.getByRole('button', { name: 'Room list' }).click();
    await visitor.waitForFunction(() => !document.querySelector('#lobby').hidden);
    // Taking over a saved seat stops the old tab and leaves a visible recovery action.
    const otherTab = await a.context().newPage();
    await otherTab.goto(`${f.origin}/sandbox/projects/rock-paper-scissors/`); await live(otherTab);
    await textIs(otherTab, 'role', 'Player 1');
    await textIs(a, 'connection', 'Continue there, or reload');
    assert.equal(await a.locator('#connection').evaluate(el => getComputedStyle(el).position), 'static');
    assert.equal(await hand(a, 'Rock').isDisabled(), true);
    await rpsControl(f.worker, { limit: true });
    await visitor.reload(); await live(visitor);
    await textIs(visitor, 'availability', 'Play limit reached');
    await row(visitor, 2).click(); await textIs(visitor, 'choice-state', 'Play unavailable');
    assert.equal(await visitor.getByRole('button', { name: 'Play', exact: true }).isVisible(), false);
    await visitor.getByRole('button', { name: 'Watch', exact: true }).click();
    await textIs(visitor, 'phase', 'Waiting for players');
  } finally { await f.close(); }
});
