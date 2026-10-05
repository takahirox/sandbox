import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { chromium } from 'playwright';
import { createWorker, migrate } from './helpers.js';

test('published frontend loads, increments, reloads, and shares D1 across browsers', async () => {
  let apiUrl;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/sandbox/projects/persistent-counter/api-config.json') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ apiUrl }));
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
    await migrate(worker);
    apiUrl = (await worker.ready).origin;
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/sandbox/`);
    await page.getByRole('link', { name: 'persistent-counter', exact: true }).click();
    const value = page.locator('#counter');
    const button = page.getByRole('button', { name: 'Increment counter by one' });
    await page.waitForFunction(() => document.querySelector('#counter').textContent === '0');
    await button.click();
    await page.waitForFunction(() => document.querySelector('#counter').textContent === '1');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#counter').textContent === '1');
    const other = await browser.newPage();
    await other.goto(page.url());
    await other.waitForFunction(() => document.querySelector('#counter').textContent === '1');
    await other.getByRole('button', { name: 'Increment counter by one' }).click();
    await other.waitForFunction(() => document.querySelector('#counter').textContent === '2');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#counter').textContent === '2');
    assert.equal(await value.textContent(), '2');
    assert.deepEqual(errors, []);

    // An uncertain POST must show a recovery message and must never auto-retry.
    let attempts = 0;
    await page.route(`${apiUrl}/api/counter/increment`, async route => {
      attempts++;
      await route.abort();
    });
    await button.click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Could not confirm'));
    assert.equal(attempts, 1);
    assert.equal(await button.isEnabled(), true);
    await page.unrouteAll();
    await page.route(`${apiUrl}/api/counter`, route => route.fulfill({ status: 503, body: '{}' }));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Could not load'));
    assert.equal(await button.isDisabled(), true);
  } finally {
    await browser?.close();
    await worker.dispose();
    await new Promise(resolve => server.close(resolve));
  }
});
