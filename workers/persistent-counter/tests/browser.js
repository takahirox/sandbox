import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { chromium } from 'playwright';
import { createWorker, createControlledWorker, control, migrate } from './helpers.js';

async function fixture({ migrated = true, configured = true, controlled = false } = {}) {
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
  const worker = (controlled ? createControlledWorker : createWorker)({ host: '127.0.0.1', bindings: { ALLOWED_ORIGIN: origin } });
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

const socketPattern = /\/api\/counter\/ws(?:\?.*)?$/;
const future = Date.parse('2030-01-01T12:00:00Z');
async function settled(page) {
  await page.waitForFunction(() => document.querySelector('#increment').getAttribute('aria-busy') === 'false');
}
async function checkpointIs(worker, expected) {
  const db = await worker.getD1Database('DB');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await db.prepare('SELECT value FROM counter WHERE id = 1').first()).value === expected) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`D1 did not converge to ${expected}`);
}

test('two independent browsers receive realtime clicks, reload and reconnect snapshots without HTTP mutations or polling', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const page = await f.browser.newPage();
    const other = await f.browser.newPage();
    await Promise.all([observeFeedback(page), observeFeedback(other)]);
    const requests = [];
    const errors = [];
    const intents = [];
    for (const p of [page, other]) {
      p.on('pageerror', error => errors.push(error.message));
      p.on('request', request => { if (request.url().startsWith(f.apiUrl)) requests.push(request.url()); });
      p.on('websocket', ws => ws.on('framesent', event => intents.push(JSON.parse(event.payload))));
    }
    let reconnectRoute;
    let reconnectServer;
    let heldSnapshot;
    let holdSnapshot = false;
    await other.routeWebSocket(socketPattern, ws => {
      reconnectRoute = ws;
      reconnectServer = ws.connectToServer();
      if (holdSnapshot) reconnectServer.onMessage(message => { heldSnapshot = message; });
    });
    await page.goto(`${f.origin}/sandbox/`);
    await page.getByRole('link', { name: 'persistent-counter', exact: true }).click();
    await other.goto(page.url());
    await Promise.all([valueIs(page, 0), valueIs(other, 0), connected(page), connected(other)]);
    assert.deepEqual(await page.evaluate(() => window.feedback), [], 'Initial snapshot should not animate');
    assert.equal((await page.locator('body').innerText()).trim(), 'Persistent Counter\n\nLIVE\n\n0\nPUSH\n\ncounted together');
    await button(page).click();
    await Promise.all([valueIs(page, 1), valueIs(other, 1), settled(page)]);
    assert.deepEqual(await page.evaluate(() => window.feedback), ['increment', 'counter', 'ripple']);
    assert.deepEqual(await other.evaluate(() => window.feedback), ['counter', 'ripple']);
    await button(other).click();
    await Promise.all([valueIs(page, 2), valueIs(other, 2)]);
    await Promise.all([button(page).click(), button(other).click()]);
    await Promise.all([valueIs(page, 4), valueIs(other, 4), settled(page), settled(other)]);
    await page.reload();
    await Promise.all([valueIs(page, 4), connected(page)]);
    holdSnapshot = true;
    await reconnectRoute.close({ code: 1012, reason: 'Simulated connection loss' });
    await other.waitForFunction(() => document.querySelector('#connection').textContent.startsWith('Reconnecting'));
    assert.equal(await button(other).isDisabled(), true);
    await button(page).click();
    await valueIs(page, 5);
    const deadline = Date.now() + 5000;
    while (!heldSnapshot && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(JSON.parse(heldSnapshot).value, 5);
    assert.equal(await other.locator('#counter').textContent(), '4');
    assert.equal(await button(other).isDisabled(), true);
    reconnectRoute.send(heldSnapshot);
    reconnectServer.onMessage(message => reconnectRoute.send(message));
    await Promise.all([valueIs(other, 5), connected(other)]);
    const requestCount = requests.length;
    const intentCount = intents.length;
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(requests.length, requestCount, 'Idle clients never poll');
    assert.equal(intents.length, intentCount, 'Idle clients never send mutation retries');
    assert.equal(requests.length, 0, 'The frontend sends no HTTP backend reads or mutations');
    await checkpointIs(f.worker, 5);
    assert.deepEqual(errors, []);
  } finally { await f.close(); }
});

test('eight rapid presses render synchronously and reconcile delayed intents plus remote broadcasts without double-counting', { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const page = await f.browser.newPage();
    const other = await f.browser.newPage();
    const intents = [];
    let server;
    await page.routeWebSocket(socketPattern, ws => {
      server = ws.connectToServer();
      ws.onMessage(message => intents.push(message));
    });
    await page.goto(`${f.origin}/sandbox/projects/persistent-counter/?debug=1`);
    await other.goto(`${f.origin}/sandbox/projects/persistent-counter/`);
    await Promise.all([connected(page), connected(other)]);
    await button(page).focus();
    const values = await page.evaluate(() => {
      const values = [];
      for (let i = 0; i < 8; i++) {
        document.querySelector('#increment').click();
        values.push(document.querySelector('#counter').textContent);
      }
      window.displayedValues = [];
      new MutationObserver(() => window.displayedValues.push(document.querySelector('#counter').textContent))
        .observe(document.querySelector('#counter'), { childList: true });
      return values;
    });
    assert.deepEqual(values, ['1', '2', '3', '4', '5', '6', '7', '8']);
    assert.equal(await button(page).isEnabled(), true);
    assert.equal(await button(page).getAttribute('aria-busy'), 'true');
    assert.equal(await button(page).evaluate(element => document.activeElement === element), true);
    assert.equal(await page.locator('#debug-value').textContent(), '0');
    assert.equal(await page.locator('#debug-pending').textContent(), '8');
    assert.equal(await page.locator('#debug-queued').textContent(), '0', 'All eight intents use the existing socket immediately');
    await valueIs(other, 0);
    await button(other).click();
    await Promise.all([valueIs(page, 9), valueIs(other, 1)]);
    assert.equal(intents.length, 8);
    for (const intent of intents) server.send(intent);
    await Promise.all([valueIs(page, 9), valueIs(other, 9), settled(page)]);
    assert.equal(new Set(intents.map(message => JSON.parse(message).intentId)).size, 8);
    assert.equal(await page.locator('#debug-value').textContent(), '9');
    assert.equal(await page.locator('#debug-pending').textContent(), '0');
    assert.equal(await page.locator('#debug-accepted').textContent(), '8');
    assert.ok((await page.evaluate(() => window.displayedValues)).every(value => value === '9'));
    await checkpointIs(f.worker, 9);
  } finally { await f.close(); }
});

test('automated bursts roll back rejected optimism cleanly and show short notices with detailed debug reasons', { timeout: 20_000 }, async () => {
  const f = await fixture({ controlled: true });
  try {
    await control(f.worker, { now: future });
    const page = await f.browser.newPage();
    const other = await f.browser.newPage();
    await page.goto(`${f.origin}/sandbox/projects/persistent-counter/?debug=1`);
    await other.goto(`${f.origin}/sandbox/projects/persistent-counter/`);
    await Promise.all([connected(page), connected(other)]);
    assert.equal(await page.evaluate(() => {
      for (let i = 0; i < 100; i++) document.querySelector('#increment').click();
      return document.querySelector('#counter').textContent;
    }), '100');
    await settled(page);
    await Promise.all([valueIs(page, 30), valueIs(other, 30)]);
    assert.equal(await page.locator('#notice').textContent(), 'Too fast');
    assert.equal(await page.locator('#debug-accepted').textContent(), '30');
    assert.equal(await page.locator('#debug-rejected').textContent(), '70');
    assert.equal(await page.locator('#debug-reason').textContent(), 'client_rate_limit');
    assert.equal(await page.locator('#debug-throttle').textContent(), '67 ms');
    assert.equal(await page.locator('#debug-pending').textContent(), '0');
    assert.equal(await button(page).isEnabled(), true);
    assert.equal(await other.locator('#notice').isVisible(), false, 'Rejections are only sent to the initiating socket');
    await control(f.worker, { now: future + 100 });
    await button(page).click();
    await settled(page);
    await Promise.all([valueIs(page, 31), valueIs(other, 31)]);
    assert.equal(await page.locator('#notice').isVisible(), false);
    await page.goto(`${f.origin}/sandbox/projects/persistent-counter/`);
    await connected(page);
    await page.evaluate(() => {
      for (let i = 0; i < 100; i++) document.querySelector('#increment').click();
    });
    await settled(page);
    assert.equal(await page.locator('#debug').isVisible(), false);
    assert.equal(await page.locator('#notice').textContent(), 'Too fast');
    assert.ok(!(await page.locator('body').innerText()).includes('client_rate_limit'));
  } finally { await f.close(); }
});

test('daily limit reconciles concurrent optimistic presses, keeps subscriptions live, and unlocks on the pushed UTC reset', { timeout: 20_000 }, async () => {
  const f = await fixture({ controlled: true });
  try {
    await control(f.worker, { now: future, seed: { value: 19_998, used: 19_998, day: '2030-01-01' } });
    const page = await f.browser.newPage();
    const other = await f.browser.newPage();
    await page.goto(`${f.origin}/sandbox/projects/persistent-counter/?debug=1`);
    await other.goto(`${f.origin}/sandbox/projects/persistent-counter/`);
    await Promise.all([connected(page), connected(other)]);
    await page.evaluate(() => {
      for (let i = 0; i < 5; i++) document.querySelector('#increment').click();
    });
    await settled(page);
    await Promise.all([valueIs(page, 20_000), valueIs(other, 20_000)]);
    assert.equal(await page.locator('#debug-accepted').textContent(), '2');
    assert.equal(await page.locator('#debug-rejected').textContent(), '3');
    assert.equal(await page.locator('#debug-reason').textContent(), 'daily_limit');
    assert.match(await page.locator('#debug-budget').textContent(), /20000 \/ 20000/);
    for (const p of [page, other]) {
      assert.equal(await button(p).isDisabled(), true);
      assert.equal(await p.locator('#notice').textContent(), 'Daily limit reached');
      await connected(p);
    }
    await other.reload();
    await connected(other);
    assert.equal(await button(other).isDisabled(), true);
    await control(f.worker, { now: Date.parse('2030-01-02T00:00:00Z'), alarm: true });
    await page.waitForFunction(() => !document.querySelector('#increment').disabled);
    await other.waitForFunction(() => !document.querySelector('#increment').disabled);
    assert.equal(await page.locator('#notice').isVisible(), false);
    await button(page).click();
    await Promise.all([valueIs(page, 20_001), valueIs(other, 20_001), settled(page)]);
    assert.match(await page.locator('#debug-budget').textContent(), /1 \/ 20000/);
  } finally { await f.close(); }
});

for (const committed of [false, true]) {
  test(`lost acknowledgements for ${committed ? 'committed' : 'uncommitted'} socket presses reconcile on reconnect without replay`, { timeout: 20_000 }, async () => {
    const f = await fixture();
    try {
      const page = await f.browser.newPage();
      const other = await f.browser.newPage();
      const intents = [];
      let socketRoute;
      let subscriptions = 0;
      await page.routeWebSocket(socketPattern, ws => {
        socketRoute = ws;
        subscriptions++;
        const first = subscriptions === 1;
        const server = ws.connectToServer();
        ws.onMessage(message => {
          intents.push(JSON.parse(message).intentId);
          if (!first || committed) server.send(message);
        });
        server.onMessage(message => {
          if (!first || !JSON.parse(message).intentId) ws.send(message);
        });
      });
      await page.goto(`${f.origin}/sandbox/projects/persistent-counter/?debug=1`);
      await other.goto(`${f.origin}/sandbox/projects/persistent-counter/`);
      await Promise.all([connected(page), connected(other)]);
      await page.evaluate(() => {
        for (let i = 0; i < 8; i++) document.querySelector('#increment').click();
      });
      await valueIs(page, 8);
      const deadline = Date.now() + 5000;
      while (intents.length < 8 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(intents.length, 8);
      await valueIs(other, committed ? 8 : 0);
      await socketRoute.close({ code: 1012, reason: 'Disconnect with lost acknowledgements' });
      await page.waitForFunction(() => document.querySelector('#debug-retries').textContent === '1');
      await connected(page);
      await settled(page);
      await valueIs(page, committed ? 8 : 0);
      assert.equal(await page.locator('#notice').isVisible(), true);
      assert.match(await page.locator('#status').textContent(), /no mutation retry/);
      assert.equal(intents.length, 8);
      assert.equal(new Set(intents).size, 8);
      assert.equal(subscriptions, 2);
      await button(page).click();
      await settled(page);
      const expected = committed ? 9 : 1;
      await Promise.all([valueIs(page, expected), valueIs(other, expected)]);
      assert.equal(intents.length, 9);
      await checkpointIs(f.worker, expected);
    } finally { await f.close(); }
  });
}

test('keyboard and touch work on responsive layouts, large counts fit, and reduced motion skips feedback animations', { timeout: 20_000 }, async () => {
  const f = await fixture({ controlled: true });
  try {
    await control(f.worker, { now: future, seed: { value: 128453, used: 0, day: '2030-01-01' } });
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
    // D1 is a checkpoint after initialization, so use an authoritative test
    // snapshot for the frontend's extreme-value formatting check.
    await mobile.routeWebSocket(socketPattern, ws => {
      const server = ws.connectToServer();
      server.onMessage(message => ws.send(JSON.stringify({ ...JSON.parse(message), value: Number.MAX_SAFE_INTEGER })));
    });
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
    await page.routeWebSocket(socketPattern, ws => {
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
    assert.match(await page.locator('#debug-backend').textContent(), /Durable Object/);

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

    assert.equal(await page.locator('#debug-client').textContent(),
      await page.evaluate(() => localStorage.getItem('persistent-counter-client')));
    assert.match(await page.locator('#debug-budget').textContent(), /0 \/ 20000/);
    assert.match(await page.locator('#debug-checkpoint').textContent(), /current/);
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
