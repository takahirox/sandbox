import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { chromium } from 'playwright';
import { createWorker, migrate } from './helpers.js';

async function fixture({ migrated = true, configured = true } = {}) {
  let apiUrl;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/sandbox/projects/persistent-counter/api-config.json') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ apiUrl: configured ? apiUrl : '' }));
      return;
    }
    const files = {
      '/sandbox/': 'index.html',
      '/sandbox/projects/persistent-counter/': 'projects/persistent-counter/index.html',
      '/sandbox/projects/persistent-counter/counter.js': 'projects/persistent-counter/counter.js',
      '/sandbox/projects/persistent-counter/style.css': 'projects/persistent-counter/style.css'
    };
    if (!files[path]) { response.writeHead(404).end(); return; }
    try {
      const body = await readFile(new URL(`../../../_site/${files[path]}`, import.meta.url));
      response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
      response.end(body);
    } catch {
      response.writeHead(500).end('Build the static site before running browser tests.');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const worker = createWorker({ host: '127.0.0.1', bindings: { ALLOWED_ORIGIN: origin } });
  let browser;
  try {
    if (migrated) await migrate(worker);
    apiUrl = (await worker.ready).origin;
    browser = await chromium.launch();
    return { browser, worker, origin, apiUrl, async close() {
      await browser.close();
      await worker.dispose();
      await new Promise(resolve => server.close(resolve));
    } };
  } catch (error) {
    await browser?.close();
    await worker.dispose();
    await new Promise(resolve => server.close(resolve));
    throw error;
  }
}

const button = page => page.getByRole('button', { name: 'Increment counter by one' });
const valueIs = (page, value) => page.waitForFunction(expected =>
  document.querySelector('#counter').textContent === new Intl.NumberFormat('en-US').format(expected), value);
const connected = page => page.waitForFunction(() =>
  document.querySelector('#connection').textContent === 'LIVE');

async function observeFeedback(page) {
  await page.addInitScript(() => {
    window.feedback = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      window.feedback.push(this.id);
      return animate.apply(this, args);
    };
  });
}

test('two independent browsers receive push, concurrent increments, reload and reconnect state without polling or write retries', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const firstContext = await f.browser.newContext();
    const secondContext = await f.browser.newContext();
    const page = await firstContext.newPage();
    const other = await secondContext.newPage();
    await Promise.all([observeFeedback(page), observeFeedback(other)]);
    const requests = [];
    const errors = [];
    for (const p of [page, other]) {
      p.on('pageerror', error => errors.push(error.message));
      p.on('request', request => {
        if (request.url().startsWith(f.apiUrl)) requests.push({ url: request.url(), method: request.method() });
      });
    }
    let reconnectRoute;
    let reconnectServer;
    let heldSnapshot;
    let holdSnapshot = false;
    await other.routeWebSocket(`${f.apiUrl.replace('http:', 'ws:')}/api/counter/ws`, ws => {
      reconnectRoute = ws;
      reconnectServer = ws.connectToServer();
      if (holdSnapshot) {
        reconnectServer.onMessage(message => { heldSnapshot = message; });
      }
    });
    await page.goto(`${f.origin}/sandbox/`);
    await page.getByRole('link', { name: 'persistent-counter', exact: true }).click();
    await other.goto(page.url());
    await Promise.all([valueIs(page, 0), valueIs(other, 0), connected(page), connected(other)]);
    assert.deepEqual(await page.evaluate(() => window.feedback), [], 'Initial snapshot should not animate');
    assert.equal((await page.locator('body').innerText()).trim(), 'Persistent Counter\n\nLIVE\n\n0\nPUSH\n\ncounted together');
    await button(page).click();
    await Promise.all([valueIs(page, 1), valueIs(other, 1)]);
    assert.deepEqual(await page.evaluate(() => window.feedback), ['increment', 'counter', 'ripple']);
    assert.deepEqual(await other.evaluate(() => window.feedback), ['counter', 'ripple'], 'Remote update should pulse without a local press');
    await button(other).click();
    await Promise.all([valueIs(page, 2), valueIs(other, 2)]);
    await Promise.all([button(page).click(), button(other).click()]);
    await Promise.all([valueIs(page, 4), valueIs(other, 4)]);
    await page.reload();
    await valueIs(page, 4);
    await connected(page);

    // Disconnect B and hold its next initial snapshot. Opening the WebSocket
    // alone must not enable writes or claim that stale state is synchronized.
    holdSnapshot = true;
    await reconnectRoute.close({ code: 1012, reason: 'Simulated connection loss' });
    await other.waitForFunction(() => document.querySelector('#connection').textContent.startsWith('Reconnecting'));
    assert.equal(await button(other).isDisabled(), true);
    await button(page).click();
    await valueIs(page, 5);
    const deadline = Date.now() + 5000;
    while (!heldSnapshot && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(heldSnapshot, 'Reconnection should receive an authoritative snapshot');
    assert.deepEqual(JSON.parse(heldSnapshot), { value: 5 });
    assert.equal(await other.locator('#counter').textContent(), '4');
    assert.equal(await button(other).isDisabled(), true);
    assert.ok((await other.locator('#connection').textContent()).startsWith('Reconnecting'));
    reconnectRoute.send(heldSnapshot);
    reconnectServer.onMessage(message => reconnectRoute.send(message));
    await valueIs(other, 5);
    await connected(other);

    // A's committed POST loses its response. Both browsers must see the saved
    // value and the reconnect must not repeat that increment.
    let attempts = 0;
    await page.route(`${f.apiUrl}/api/counter/increment`, async route => {
      attempts++;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.abort();
    });
    await button(page).click();
    await page.waitForFunction(() => !document.querySelector('#notice').hidden);
    assert.equal(await page.locator('#debug').isVisible(), false);
    await Promise.all([valueIs(page, 6), valueIs(other, 6), connected(page)]);
    await page.unrouteAll();

    // A delayed POST response must not overwrite a newer pushed value.
    let releaseResponse;
    let responseReady;
    const ready = new Promise(resolve => { responseReady = resolve; });
    await page.route(`${f.apiUrl}/api/counter/increment`, async route => {
      const response = await route.fetch();
      responseReady();
      await new Promise(resolve => { releaseResponse = resolve; });
      await route.fulfill({ response });
    });
    await button(page).click();
    await ready;
    const pendingRequestCount = requests.length;
    assert.equal(await button(page).evaluate(element => document.activeElement === element), true,
      'A pending write must retain keyboard focus');
    await page.keyboard.press('Enter');
    assert.equal(requests.length, pendingRequestCount, 'Keyboard input during a pending write must not submit again');
    await valueIs(other, 7);
    await button(other).click();
    await Promise.all([valueIs(page, 8), valueIs(other, 8)]);
    releaseResponse();
    await page.waitForFunction(() => document.querySelector('#increment').getAttribute('aria-disabled') === 'false');
    await page.unrouteAll();
    const requestCount = requests.length;
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(requests.length, requestCount, 'Idle clients must not poll');
    assert.equal(attempts, 1, 'An uncertain mutation must not be replayed');
    assert.ok(requests.every(request => request.method === 'POST' && request.url.endsWith('/api/counter/increment')),
      'The frontend must use WebSocket snapshots, never GET counter requests');
    assert.equal(requests.length, 8, 'Exactly one POST per user click');
    assert.equal(await page.locator('#counter').textContent(), '8');
    const db = await f.worker.getD1Database('DB');
    assert.deepEqual(await db.prepare('SELECT value FROM counter WHERE id = 1').first(), { value: 8 });
    assert.deepEqual(errors, []);
  } finally {
    await f.close();
  }
});

test('keyboard and touch work on responsive layouts, large counts fit, and reduced motion skips feedback animations', { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const db = await f.worker.getD1Database('DB');
    await db.prepare('UPDATE counter SET value = ? WHERE id = 1').bind(128453).run();
    const context = await f.browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await observeFeedback(page);
    await page.goto(`${f.origin}/sandbox/projects/persistent-counter/`);
    await connected(page);
    await valueIs(page, 128453);
    await page.keyboard.press('Tab');
    assert.equal(await button(page).evaluate(element => element.matches(':focus-visible')), true);
    assert.equal(await button(page).evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
    await page.keyboard.press('Enter');
    await valueIs(page, 128454);
    await page.waitForFunction(() => document.querySelector('#increment').getAttribute('aria-disabled') === 'false');
    await page.keyboard.press('Space');
    await valueIs(page, 128455);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => { window.feedback = []; });
    await button(page).click();
    await valueIs(page, 128456);
    assert.deepEqual(await page.evaluate(() => window.feedback), []);
    assert.equal(await button(page).evaluate(element => getComputedStyle(element).transitionDuration), '0s');

    const mobileContext = await f.browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
    const mobile = await mobileContext.newPage();
    await observeFeedback(mobile);
    await mobile.goto(page.url());
    await connected(mobile);
    await button(mobile).tap();
    await Promise.all([valueIs(page, 128457), valueIs(mobile, 128457)]);
    assert.deepEqual(await page.evaluate(() => window.feedback), [], 'Reduced motion must also suppress remote feedback');
    assert.deepEqual(await mobile.evaluate(() => window.feedback), ['increment', 'counter', 'ripple']);
    await mobile.evaluate(() => {
      window.motionChanged = false;
      matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => {
        window.motionChanged = true;
      }, { once: true });
    });
    await mobile.emulateMedia({ reducedMotion: 'reduce' });
    await mobile.waitForFunction(() => window.motionChanged);
    assert.equal(await mobile.evaluate(() => document.getAnimations().length), 0, 'Enabling reduced motion cancels running effects');
    for (const viewport of [{ width: 320, height: 568 }, { width: 667, height: 375 }]) {
      await mobile.setViewportSize(viewport);
      const rect = await button(mobile).boundingBox();
      assert.ok(rect.width >= 44 && rect.height >= 44);
      assert.ok(rect.x >= 0 && rect.x + rect.width <= viewport.width);
      assert.ok(rect.y >= 0 && rect.y + rect.height <= viewport.height);
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await db.prepare('UPDATE counter SET value = ? WHERE id = 1').bind(Number.MAX_SAFE_INTEGER).run();
    await mobile.setViewportSize({ width: 320, height: 568 });
    await mobile.reload();
    await connected(mobile);
    await valueIs(mobile, Number.MAX_SAFE_INTEGER);
    assert.equal(await mobile.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('#counter'));
      const rect = range.getBoundingClientRect();
      return rect.x >= 0 && rect.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
    }), true, 'Largest supported count should fit a narrow screen');
  } finally {
    await f.close();
  }
});

test('debug mode reports transport, snapshots, reconnects and errors without changing synchronization', { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const page = await f.browser.newPage();
    page.setDefaultTimeout(4000);
    let socketRoute;
    await page.routeWebSocket(`${f.apiUrl.replace('http:', 'ws:')}/api/counter/ws`, ws => {
      socketRoute = ws;
      ws.connectToServer();
    });
    await page.goto(`${f.origin}/sandbox/projects/persistent-counter/?debug=1`);
    await connected(page);
    assert.equal(await page.locator('#debug').isVisible(), true);
    assert.equal(await page.locator('#debug-socket').textContent(), 'Open');
    assert.equal(await page.locator('#debug-sync').textContent(), 'Synchronized');
    assert.equal(await page.locator('#debug-api').textContent(), f.apiUrl);
    assert.equal(await page.locator('#debug-value').textContent(), '0');
    assert.match(await page.locator('#debug-update').textContent(), /^\d{4}-\d{2}-\d{2}T/);
    assert.match(await page.locator('#debug-backend').textContent(), /D1/);

    socketRoute.send(JSON.stringify({ value: -1 }));
    await page.waitForFunction(() => document.querySelector('#debug-sync').textContent === 'Waiting for snapshot');
    assert.equal(await button(page).isDisabled(), true);
    assert.match(await page.locator('#status').textContent(), /Invalid WebSocket update/);
    // Complete the intercepted close handshake, then inspect the backoff state.
    await socketRoute.close({ code: 1012, reason: 'Simulated connection loss' });
    await page.waitForFunction(() => document.querySelector('#debug-retry').textContent.endsWith('ms'));
    await connected(page);
    assert.ok(Number(await page.locator('#debug-retries').textContent()) >= 1);
    assert.notEqual(await page.locator('#debug-close').textContent(), 'None');
    assert.equal(await page.locator('#debug-retry').textContent(), 'None');

    let attempts = 0;
    await page.route(`${f.apiUrl}/api/counter/increment`, route => {
      attempts++;
      return route.fulfill({ status: 503, headers: { 'Access-Control-Allow-Origin': f.origin }, body: 'Unavailable' });
    });
    await button(page).click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('HTTP 503'));
    await socketRoute.close({ code: 1012, reason: 'Finish intercepted close handshake' });
    await connected(page);
    assert.equal(attempts, 1);
    await valueIs(page, 0);
    assert.match(await page.locator('#status').textContent(), /no mutation retry/);
    await page.goto(`${f.origin}/sandbox/projects/persistent-counter/?debug=0`);
    await connected(page);
    assert.equal(await page.locator('#debug').isVisible(), false, 'Debug must require the explicit value 1');
  } finally {
    await f.close();
  }
});

test('unavailable backend reconnects and synchronizes after D1 recovery', { timeout: 15_000 }, async () => {
  const f = await fixture({ migrated: false });
  try {
    const page = await f.browser.newPage();
    await page.goto(`${f.origin}/sandbox/projects/persistent-counter/`);
    await page.waitForFunction(() => document.querySelector('#connection').textContent.startsWith('Reconnecting'));
    assert.equal(await button(page).isDisabled(), true);
    assert.equal(await page.locator('#counter').textContent(), '—');
    await migrate(f.worker);
    await valueIs(page, 0);
    await connected(page);
    assert.equal(await button(page).isEnabled(), true);
  } finally {
    await f.close();
  }
});

test('unconfigured preview stays concise, exposes configuration error only in debug, and never contacts a backend', async () => {
  const f = await fixture({ configured: false });
  try {
    const page = await f.browser.newPage();
    let connections = 0;
    page.on('websocket', () => connections++);
    await page.goto(`${f.origin}/sandbox/projects/persistent-counter/`);
    await page.waitForFunction(() => document.querySelector('#connection').textContent === 'Unavailable');
    assert.equal(await page.locator('#debug').isVisible(), false);
    assert.ok(!(await page.locator('body').innerText()).includes('API'));
    await page.goto(`${page.url()}?debug=1`);
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('not configured'));
    assert.equal(await page.locator('#debug').isVisible(), true);
    assert.equal(await button(page).isDisabled(), true);
    assert.equal(connections, 0);
  } finally {
    await f.close();
  }
});
