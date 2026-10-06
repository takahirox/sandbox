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
    let pageRoute;
    let dropBroadcast = false;
    await page.routeWebSocket(`${f.apiUrl.replace('http:', 'ws:')}/api/counter/ws`, ws => {
      pageRoute = ws;
      const server = ws.connectToServer();
      server.onMessage(message => { if (!dropBroadcast || !JSON.parse(message).intentId) ws.send(message); });
    });
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
    dropBroadcast = true;
    await page.route(`${f.apiUrl}/api/counter/increment`, async route => {
      attempts++;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.abort();
    });
    await button(page).click();
    await page.waitForFunction(() => !document.querySelector('#notice').hidden);
    await pageRoute.close({ code: 1012, reason: 'Finish intercepted close handshake' });
    assert.equal(await page.locator('#debug').isVisible(), false);
    await Promise.all([valueIs(page, 6), valueIs(other, 6), connected(page)]);
    await page.unrouteAll();
    dropBroadcast = false;

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
    assert.equal(requests.length, pendingRequestCount, 'The next intent waits in the POST queue');
    await valueIs(page, 8);
    await valueIs(other, 7);
    await button(other).click();
    await Promise.all([valueIs(page, 9), valueIs(other, 8)]);
    releaseResponse();
    await Promise.all([valueIs(page, 9), valueIs(other, 9)]);
    await page.waitForFunction(() => document.querySelector('#increment').getAttribute('aria-busy') === 'false');
    await page.unrouteAll();
    const requestCount = requests.length;
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(requests.length, requestCount, 'Idle clients must not poll');
    assert.equal(attempts, 1, 'An uncertain mutation must not be replayed');
    assert.ok(requests.every(request => request.method === 'POST' && request.url.endsWith('/api/counter/increment')),
      'The frontend must use WebSocket snapshots, never GET counter requests');
    assert.equal(requests.length, 9, 'Exactly one POST per user click, including input while saving');
    assert.equal(await page.locator('#counter').textContent(), '9');
    const db = await f.worker.getD1Database('DB');
    assert.deepEqual(await db.prepare('SELECT value FROM counter WHERE id = 1').first(), { value: 9 });
    assert.deepEqual(errors, []);
  } finally {
    await f.close();
  }
});

test('eight rapid presses render synchronously and reconcile remote and matching broadcasts without double-counting', { timeout: 20_000 }, async () => {
  const f = await fixture();
  let release;
  try {
    const page = await f.browser.newPage();
    const other = await f.browser.newPage();
    const intents = [];
    const held = new Promise(resolve => { release = resolve; });
    await page.route(`${f.apiUrl}/api/counter/increment`, async route => {
      intents.push(route.request().postData());
      if (intents.length === 1) await held;
      await route.continue();
    });
    await page.goto(`${f.origin}/sandbox/projects/persistent-counter/?debug=1`);
    await other.goto(`${f.origin}/sandbox/projects/persistent-counter/`);
    await Promise.all([connected(page), connected(other)]);
    const immediateValues = await page.evaluate(() => {
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
    assert.deepEqual(immediateValues, ['1', '2', '3', '4', '5', '6', '7', '8']);
    assert.equal(await button(page).isEnabled(), true);
    assert.equal(await button(page).getAttribute('aria-disabled'), 'false');
    assert.equal(await button(page).getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('#debug-value').textContent(), '0');
    assert.equal(await page.locator('#debug-pending').textContent(), '8');
    assert.equal(await page.locator('#debug-queued').textContent(), '7');
    await valueIs(other, 0);
    await button(other).click();
    await Promise.all([valueIs(page, 9), valueIs(other, 1)]);
    release();
    await Promise.all([valueIs(page, 9), valueIs(other, 9)]);
    await page.waitForFunction(() => document.querySelector('#increment').getAttribute('aria-busy') === 'false');
    assert.equal(intents.length, 8);
    assert.equal(new Set(intents).size, 8, 'Each press has its own increment intent');
    assert.equal(await page.locator('#debug-value').textContent(), '9');
    assert.equal(await page.locator('#debug-pending').textContent(), '0');
    assert.equal(await page.locator('#debug-queued').textContent(), '0');
    assert.ok((await page.evaluate(() => window.displayedValues)).every(value => value === '9'),
      'Acknowledging local optimism must neither double-count nor flicker down');
    const db = await f.worker.getD1Database('DB');
    assert.deepEqual(await db.prepare('SELECT value FROM counter WHERE id = 1').first(), { value: 9 });
  } finally {
    release?.();
    await f.close();
  }
});

test('HTTP acceptance before its broadcast retains optimism until the ordered stream catches up', { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const page = await f.browser.newPage();
    let socketRoute;
    const broadcasts = [];
    await page.route(`${f.apiUrl}/api/counter/increment`, async route => {
      const response = await route.fetch();
      await route.fulfill({ response });
    });
    await page.routeWebSocket(`${f.apiUrl.replace('http:', 'ws:')}/api/counter/ws`, ws => {
      socketRoute = ws;
      const server = ws.connectToServer();
      server.onMessage(message => {
        if (JSON.parse(message).value === 0) ws.send(message);
        else broadcasts.push(message);
      });
    });
    await page.goto(`${f.origin}/sandbox/projects/persistent-counter/?debug=1`);
    await connected(page);
    const acknowledgement = page.waitForResponse(response => response.url() === `${f.apiUrl}/api/counter/increment`);
    await button(page).click();
    await (await acknowledgement).finished();
    await page.waitForFunction(() => document.querySelector('#debug-write').textContent === 'Idle');
    assert.equal(await page.locator('#debug-value').textContent(), '0');
    assert.equal(await page.locator('#debug-pending').textContent(), '1');
    await valueIs(page, 1);
    assert.equal(broadcasts.length, 1);
    socketRoute.send(broadcasts[0]);
    await page.waitForFunction(() => document.querySelector('#debug-pending').textContent === '0');
    await valueIs(page, 1);
    assert.equal(await page.locator('#debug-value').textContent(), '1');
  } finally {
    await f.close();
  }
});

for (const committed of [false, true]) {
  test(`an uncertain ${committed ? 'committed' : 'uncommitted'} press is never retried and seven unsent presses survive reconnection`, { timeout: 20_000 }, async () => {
    const f = await fixture();
    let release;
    try {
      const page = await f.browser.newPage();
      const other = await f.browser.newPage();
      const intents = [];
      const held = new Promise(resolve => { release = resolve; });
      let socketRoute;
      await page.routeWebSocket(`${f.apiUrl.replace('http:', 'ws:')}/api/counter/ws`, ws => {
        socketRoute = ws;
        const server = ws.connectToServer();
        server.onMessage(message => {
          const { intentId } = JSON.parse(message);
          if (!intentId || intentId !== intents[0]) ws.send(message);
        });
      });
      await page.route(`${f.apiUrl}/api/counter/increment`, async route => {
        intents.push(route.request().postData());
        if (intents.length === 1) {
          await held;
          if (committed) assert.equal((await route.fetch()).status(), 200);
          await route.abort();
        } else await route.continue();
      });
      await page.goto(`${f.origin}/sandbox/projects/persistent-counter/?debug=1`);
      await other.goto(`${f.origin}/sandbox/projects/persistent-counter/`);
      await Promise.all([connected(page), connected(other)]);
      await page.evaluate(() => {
        for (let i = 0; i < 8; i++) document.querySelector('#increment').click();
      });
      await valueIs(page, 8);
      release();
      await page.waitForFunction(() => !document.querySelector('#notice').hidden);
      await socketRoute.close({ code: 1012, reason: 'Finish intercepted close handshake' });
      const expected = committed ? 8 : 7;
      await Promise.all([valueIs(page, expected), valueIs(other, expected), connected(page)]);
      await page.waitForFunction(() => document.querySelector('#increment').getAttribute('aria-busy') === 'false');
      assert.equal(intents.length, 8);
      assert.equal(new Set(intents).size, 8, 'Reconnecting must never resend a sent intent');
      assert.equal(await page.locator('#debug-pending').textContent(), '0');
      assert.equal(await page.locator('#debug-queued').textContent(), '0');
      assert.match(await page.locator('#status').textContent(), /no mutation retry/);
      const db = await f.worker.getD1Database('DB');
      assert.deepEqual(await db.prepare('SELECT value FROM counter WHERE id = 1').first(), { value: expected });
    } finally {
      release?.();
      await f.close();
    }
  });
}

test('a committed broadcast confirms a press even when its HTTP response is lost', { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const page = await f.browser.newPage();
    let attempts = 0;
    let subscriptions = 0;
    page.on('websocket', () => subscriptions++);
    await page.route(`${f.apiUrl}/api/counter/increment`, async route => {
      attempts++;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      const { value } = await response.json();
      await page.waitForFunction(expected => Number(document.querySelector('#debug-value').textContent) >= expected, value);
      await route.abort();
    });
    await page.goto(`${f.origin}/sandbox/projects/persistent-counter/?debug=1`);
    await connected(page);
    await page.evaluate(() => {
      for (let i = 0; i < 8; i++) document.querySelector('#increment').click();
    });
    // Hold each HTTP response until its matching broadcast has reconciled the
    // current intent (remaining queued optimism is still present).
    await valueIs(page, 8);
    await page.waitForFunction(() => document.querySelector('#increment').getAttribute('aria-busy') === 'false');
    assert.equal(attempts, 8);
    assert.equal(subscriptions, 1);
    assert.equal(await page.locator('#notice').isVisible(), false);
    const db = await f.worker.getD1Database('DB');
    assert.deepEqual(await db.prepare('SELECT value FROM counter WHERE id = 1').first(), { value: 8 });
  } finally {
    await f.close();
  }
});

for (const lateSuccess of [false, true]) {
  test(`a late HTTP ${lateSuccess ? 'success' : 'failure'} after reconnect cannot replay a press or close the new subscription`, { timeout: 15_000 }, async () => {
    const f = await fixture();
    let release;
    try {
      const page = await f.browser.newPage();
      const other = await f.browser.newPage();
      const held = new Promise(resolve => { release = resolve; });
      const intents = [];
      let socketRoute;
      let subscriptions = 0;
      await page.routeWebSocket(`${f.apiUrl.replace('http:', 'ws:')}/api/counter/ws`, ws => {
        socketRoute = ws;
        subscriptions++;
        ws.connectToServer();
      });
      await page.route(`${f.apiUrl}/api/counter/increment`, async route => {
        intents.push(route.request().postData());
        if (intents.length === 1) {
          await held;
          if (!lateSuccess) { await route.abort(); return; }
        }
        await route.continue();
      });
      await page.goto(`${f.origin}/sandbox/projects/persistent-counter/?debug=1`);
      await other.goto(`${f.origin}/sandbox/projects/persistent-counter/`);
      await Promise.all([connected(page), connected(other)]);
      await page.evaluate(() => {
        for (let i = 0; i < 8; i++) document.querySelector('#increment').click();
      });
      await valueIs(page, 8);
      await socketRoute.close({ code: 1012, reason: 'Disconnect during an in-flight POST' });
      await page.waitForFunction(() => document.querySelector('#debug-retries').textContent === '1');
      await connected(page);
      await valueIs(page, 7);
      assert.equal(await page.locator('#debug-queued').textContent(), '7');
      assert.equal(await page.locator('#notice').isVisible(), true);
      release();
      const expected = lateSuccess ? 8 : 7;
      await Promise.all([valueIs(page, expected), valueIs(other, expected)]);
      await page.waitForFunction(() => document.querySelector('#increment').getAttribute('aria-busy') === 'false');
      assert.equal(intents.length, 8);
      assert.equal(new Set(intents).size, 8);
      assert.equal(subscriptions, 2, 'An old response must not reconnect the healthy subscription');
      await connected(page);
    } finally {
      release?.();
      await f.close();
    }
  });
}

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
