import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, cp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { chromium } from '../workers/persistent-counter/node_modules/playwright/index.mjs';
import { coverName, previewServer } from '../scripts/capture_screenshots.mjs';

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, '..');

test('normal build discovers real covers, isolates network access, and renders an accessible responsive gallery', { timeout: 120000 }, async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'sandbox-gallery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hits = [];
  const trap = createServer((req, res) => { hits.push(req.method); res.end('Unexpected backend request'); });
  trap.on('upgrade', (req, socket) => { hits.push('WebSocket'); socket.destroy(); });
  await new Promise(resolve => trap.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => trap.close(resolve)));
  const backend = `http://127.0.0.1:${trap.address().port}`;
  const ws = backend.replace('http:', 'ws:');
  await cp(resolve(repo, 'projects'), resolve(root, 'projects'), { recursive: true });
  const add = async (name, body) => {
    const path = resolve(root, 'projects', name);
    await mkdir(path, { recursive: true });
    await writeFile(resolve(path, 'index.html'), `<!doctype html><meta charset="utf-8"><style>body { background: #d8ece3; font: 32px system-ui; padding: 60px; }</style>${body}`);
  };
  await add('new-demo', '<h1>A newly discovered experiment</h1>');
  await add('odd & "日本語"', '<h1>Names work without registration</h1>');
  await add('__proto__', '<h1>Any directory name</h1>');
  await add('network-probe', `<h1 id="state">Loading preview</h1><script type="module">
    const config = await fetch('./api-config.json').then(r => r.json());
    if (config.apiUrl) throw new Error('Production configuration reached the preview');
    document.getElementById('state').textContent = 'Offline preview';
    fetch('${backend}/mutate', { method: 'POST', body: 'no' }).catch(() => {});
    fetch('${backend}/mutating-get').catch(() => {});
    fetch('/api/mutate', { method: 'POST', body: 'no' }).catch(() => {});
    navigator.sendBeacon('${backend}/beacon', 'no');
    new WebSocket('${ws}/live');
    new WebSocket('ws://' + location.host + '/api/ws');
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  </script>`);
  const config = JSON.stringify({ apiUrl: backend + '/private-token-do-not-log' });
  for (const name of ['persistent-counter', 'rock-paper-scissors', 'network-probe']) {
    await writeFile(resolve(root, 'projects', name, 'api-config.json'), config);
  }
  await writeFile(resolve(root, 'projects/network-probe/sw.js'), `fetch('${backend}/worker-mutation', { method: 'POST' });`);
  await add('broken-script', '<h1>Broken project</h1><script>throw new Error("private-token-do-not-log")</script>');
  await add('missing-asset', '<h1>Missing visual asset</h1><img src="./missing.png">');
  await add('remote-asset', `<h1>Remote dependency</h1><img src="${backend}/external.png">`);

  const build = () => exec('python3', ['-c', 'from pathlib import Path; import sys; from scripts.build_site import build_site; build_site(Path(sys.argv[1]))', root], { cwd: repo, timeout: 90000 });
  const { stderr } = await build();
  assert.match(stderr, /Screenshot unavailable.*broken-script.*JavaScript error/);
  assert.ok(!stderr.includes('private-token-do-not-log'));
  const output = resolve(root, '_site');
  const report = JSON.parse(await readFile(resolve(output, 'capture-report.json'), 'utf8'));
  const valid = ['happy-cat', 'pokemon-coin-flip', 'persistent-counter', 'rock-paper-scissors', 'walk-to-hospital', 'new-demo', 'odd & "日本語"', '__proto__', 'network-probe'];
  for (const name of valid) {
    assert.equal(report[name].status, 'ok', `${name}: ${JSON.stringify(report[name])}`);
    const image = await readFile(resolve(output, 'covers', coverName(name)));
    assert.equal(image.readUInt16BE(0), 0xffd8, 'Real JPEG output');
    assert.ok(image.length > 1000 && image.length < 300000, 'Optimized cover size');
  }
  assert.ok(report['network-probe'].blockedRequests >= 4);
  assert.equal(report['network-probe'].blockedWebSockets, 2);
  for (const name of ['broken-script', 'missing-asset', 'remote-asset']) {
    assert.equal(report[name].status, 'unavailable');
    assert.ok(!(await readdir(resolve(output, 'covers'))).includes(coverName(name)));
  }
  assert.deepEqual(hits, [], 'No request or WebSocket reaches the backend');
  const originalCat = await readFile(resolve(output, 'covers', coverName('happy-cat')));
  for (const name of ['persistent-counter', 'rock-paper-scissors']) {
    assert.equal(await readFile(resolve(output, 'projects', name, 'api-config.json'), 'utf8'), config, 'Published API config is preserved');
  }

  const preview = await previewServer(output);
  t.after(() => preview.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const loaded = [];
  page.on('request', request => loaded.push(new URL(request.url()).pathname));
  await page.goto(preview.origin + '/sandbox/');
  const cards = page.locator('.card');
  assert.equal(await cards.count(), valid.length + 3);
  assert.equal(await page.locator('.cover img').count(), valid.length);
  const eagerCount = Object.keys(report).slice(0, 2).filter(name => report[name].status === 'ok').length;
  assert.equal(await page.locator('.cover img[loading="lazy"]').count(), valid.length - eagerCount);
  assert.equal(await page.locator('iframe').count(), 0);
  assert.ok(!loaded.some(path => path.includes('/projects/')), 'Homepage never loads apps');
  const first = await cards.nth(0).boundingBox(), second = await cards.nth(1).boundingBox();
  assert.equal(first.y, second.y, 'Two columns on desktop');
  assert.ok(second.x > first.x + first.width);
  for (const image of await page.locator('.cover img').all()) {
    await image.scrollIntoViewIfNeeded();
    await image.evaluate(image => image.decode());
    assert.deepEqual(await image.evaluate(image => [image.naturalWidth, image.naturalHeight]), [1280, 720]);
    assert.match(await image.getAttribute('alt'), /Screenshot of the .+ web experiment/);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileFirst = await cards.nth(0).boundingBox(), mobileSecond = await cards.nth(1).boundingBox();
  assert.equal(mobileFirst.x, mobileSecond.x);
  assert.ok(mobileSecond.y > mobileFirst.y + mobileFirst.height, 'Single column on mobile');
  const cover = await page.locator('.cover').first().boundingBox();
  assert.ok(Math.abs(cover.width / cover.height - 16 / 9) < .02);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await cards.first().evaluate(card => getComputedStyle(card).transitionDuration), '0s');
  await cards.first().focus();
  assert.equal(await cards.first().evaluate(card => getComputedStyle(card).outlineStyle), 'solid');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/projects\//);
  assert.match(await page.locator('h1').innerText(), /Any directory name/);

  // A cached homepage must also handle a cover that disappears after publication.
  await page.route('**/covers/' + coverName('new-demo'), route => route.abort());
  await page.goto(preview.origin + '/sandbox/');
  const newCard = page.locator('.card[href="./projects/new-demo/"]');
  await newCard.scrollIntoViewIfNeeded();
  await newCard.locator('img').waitFor({ state: 'hidden' });
  assert.equal(await newCard.locator('.fallback').getAttribute('aria-hidden'), null);
  assert.match(await newCard.innerText(), /Screenshot unavailable/);

  // A second normal build automatically adds a cover and removes stale output.
  await add('another-demo', '<h1>Another automatic addition</h1>');
  await rm(resolve(root, 'projects/new-demo'), { recursive: true });
  await build();
  const updated = JSON.parse(await readFile(resolve(output, 'capture-report.json'), 'utf8'));
  assert.equal(updated['another-demo'].status, 'ok');
  assert.equal(updated['new-demo'], undefined);
  assert.ok(!(await readdir(resolve(output, 'covers'))).includes(coverName('new-demo')));
  assert.deepEqual(await readFile(resolve(output, 'covers', coverName('happy-cat'))), originalCat, 'Stable projects produce deterministic screenshots');
  assert.deepEqual(hits, []);
});
