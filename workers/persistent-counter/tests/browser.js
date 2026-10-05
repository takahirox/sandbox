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
      '/sandbox/projects/persistent-counter/counter.js': 'projects/persistent-counter/counter.js'
    };
    if (!files[path]) { response.writeHead(404).end(); return; }
    try {
      const body = await readFile(new URL(`../../../_site/${files[path]}`, import.meta.url));
      response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/html');
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
  document.querySelector('#counter').textContent === String(expected), value);
const connected = page => page.waitForFunction(() =>
  document.querySelector('#connection').textContent.startsWith('Connected'));

test('two independent browsers receive push, concurrent increments, reload and reconnect state without polling or write retries', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const firstContext = await f.browser.newContext();
    const secondContext = await f.browser.newContext();
    const page = await firstContext.newPage();
    const other = await secondContext.newPage();
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
    await button(page).click();
    await Promise.all([valueIs(page, 1), valueIs(other, 1)]);
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
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Could not confirm'));
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
    await valueIs(other, 7);
    await button(other).click();
    await Promise.all([valueIs(page, 8), valueIs(other, 8)]);
    releaseResponse();
    await page.waitForFunction(() => !document.querySelector('#increment').disabled);
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

test('unconfigured static preview explains unavailability and never contacts a backend', async () => {
  const f = await fixture({ configured: false });
  try {
    const page = await f.browser.newPage();
    let connections = 0;
    page.on('websocket', () => connections++);
    await page.goto(`${f.origin}/sandbox/projects/persistent-counter/`);
    await page.waitForFunction(() => document.querySelector('#connection').textContent.includes('not configured'));
    assert.equal(await button(page).isDisabled(), true);
    assert.equal(connections, 0);
  } finally {
    await f.close();
  }
});
