import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createPongWorker, pongControl } from './pong-helpers.js';

const prefix = '/sandbox/projects/p2p-pong/';
async function fixture(configured = true) {
  let apiUrl;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === prefix + 'api-config.json') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ apiUrl: configured ? apiUrl : '' })); return;
    }
    const files = ['index.html', 'game.mjs', 'peer.mjs', 'rules.mjs', 'style.css'];
    const file = path === prefix ? 'index.html' : path.slice(prefix.length);
    const gallery = { '/sandbox/': 'index.html', '/sandbox/gallery.js': 'gallery.js', '/sandbox/gallery.css': 'gallery.css' };
    const relative = gallery[path] ?? (path.startsWith(prefix) && files.includes(file) ? `projects/p2p-pong/${file}` : null);
    if (!relative) { response.writeHead(404).end(); return; }
    try {
      const data = await readFile(new URL(`../../../_site/${relative}`, import.meta.url));
      response.setHeader('Content-Type', /\.m?js$/.test(relative) ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : 'text/html');
      response.end(data);
    } catch { response.writeHead(500).end('Build site before browser tests'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const worker = createPongWorker({ host: '127.0.0.1', bindings: { ALLOWED_ORIGIN: origin } });
  let browser;
  try {
    apiUrl = (await worker.ready).origin; browser = await chromium.launch();
    return { browser, worker, origin, apiUrl, async close() {
      await browser.close(); await worker.dispose(); await new Promise(resolve => server.close(resolve));
    } };
  } catch (error) { await browser?.close(); await worker.dispose(); await new Promise(resolve => server.close(resolve)); throw error; }
}
const textIs = (page, id, value, timeout = 10_000) => page.waitForFunction(({ id, value }) => document.getElementById(id).textContent.includes(value), { id, value }, { timeout });
async function open(f, options = {}) {
  const context = await f.browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'reduce', ...options });
  const page = await context.newPage(); page.setDefaultTimeout(10_000);
  await page.addInitScript(() => {
    window.pongPCs = []; window.pongData = []; window.pongSignals = []; window.pongSockets = [];
    const NativePC = RTCPeerConnection, NativeSocket = WebSocket, send = RTCDataChannel.prototype.send;
    window.RTCPeerConnection = class extends NativePC { constructor(...args) { super(...args); window.pongPCs.push(this); } };
    window.WebSocket = class extends NativeSocket {
      constructor(...args) { super(...args); window.pongSockets.push(this); }
      send(raw) { window.pongSignals.push(JSON.parse(raw).type); super.send(raw); }
    };
    RTCDataChannel.prototype.send = function(raw) {
      const m = JSON.parse(raw); window.pongData.push({ label: this.label, ...m });
      // Retain a bounded sample, never print SDP/candidates or invitation tokens.
      if (window.pongData.length > 1000) window.pongData.shift();
      return send.call(this, raw);
    };
  });
  return page;
}
async function pair(f, a, b) {
  await a.goto(f.origin + prefix + '?debug=1');
  await a.locator('#create').click(); await textIs(a, 'status', 'Waiting');
  const invite = await a.locator('#invite').inputValue();
  await b.goto(invite); await b.locator('#join').click();
  await Promise.all([a, b].map(p => textIs(p, 'status', 'Connected')));
  await a.waitForFunction(() => window.pongSockets[0]?.readyState === WebSocket.CLOSED);
  await b.waitForFunction(() => window.pongSockets[0]?.readyState === WebSocket.CLOSED);
  return invite;
}

test('real direct WebRTC between isolated browser contexts: touch/keyboard, consistent first-to-five, no gameplay signaling', { timeout: 65_000 }, async () => {
  const f = await fixture();
  try {
    const a = await open(f), b = await open(f), errors = [], backendHttp = [];
    for (const p of [a, b]) {
      p.on('pageerror', e => errors.push(e.message));
      p.on('request', r => { if (r.url().startsWith(f.apiUrl)) backendHttp.push(r.method()); });
    }
    const invite = await pair(f, a, b);
    assert.equal((await pongControl(f.worker)).sessions, 0);
    for (const p of [a, b]) {
      assert.equal(await p.evaluate(() => location.hash), '');
      const servers = await p.evaluate(() => window.pongPCs[0].getConfiguration().iceServers);
      assert.deepEqual(servers.flatMap(s => s.urls), ['stun:stun.cloudflare.com:3478']);
      await p.waitForFunction(() => window.pongData.some(m => m.label === 'events'));
      const channels = await p.evaluate(() => window.pongData.map(m => m.label));
      assert.ok(channels.includes('events'));
      const routes = await p.evaluate(async () => {
        const stats = await window.pongPCs[0].getStats();
        return [...stats.values()].filter(s => s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated)
          .flatMap(s => [stats.get(s.localCandidateId)?.candidateType, stats.get(s.remoteCandidateId)?.candidateType]);
      });
      assert.ok(routes.length >= 2); assert.ok(routes.every(type => type && type !== 'relay'));
      console.info('Same-host WebRTC candidate types:', [...new Set(routes)].join(', '));
    }
    await a.locator('#court').focus(); await a.keyboard.down('ArrowDown'); await a.waitForTimeout(200); await a.keyboard.up('ArrowDown');
    await a.waitForFunction(() => window.pongData.some(m => m.type === 'input' && m.y > 260));
    await b.locator('#up').tap();
    await b.waitForFunction(() => window.pongData.some(m => m.type === 'input' && m.y < 225));
    await b.locator('#court').focus();
    const touch = await b.context().newCDPSession(b), box = await b.locator('#up').boundingBox();
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
    await b.waitForTimeout(450);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.ok(await b.evaluate(() => window.pongData.filter(m => m.type === 'input').at(-1).y <= 50), 'Touch hold keeps moving after court focus');
    await touch.detach();
    // Park both paddles above the ball's path using real touch input. The real
    // authoritative physics runs through nine points to a 5:4 victory.
    for (const p of [a, b]) await p.locator('#court').tap({ position: { x: 80, y: 2 } });
    await textIs(a, 'status', 'Match finished', 40_000); await textIs(b, 'status', 'Match finished');
    assert.equal(await a.locator('#status').textContent(), await b.locator('#status').textContent());
    const scores = await a.locator('.score strong').allTextContents(); assert.ok(scores.includes('5'));
    assert.deepEqual(await b.locator('.score strong').allTextContents(), scores);
    const messages = await a.evaluate(() => window.pongData);
    assert.ok(messages.some(m => m.type === 'state' && m.label === 'motion'));
    assert.ok(messages.some(m => m.type === 'score' && m.label === 'events'));
    assert.ok(messages.some(m => m.type === 'end' && m.label === 'events'));
    const signals = await a.evaluate(() => window.pongSignals);
    assert.ok(signals.every(type => ['create', 'offer', 'candidate', 'ready'].includes(type)));
    assert.deepEqual(backendHttp, []); assert.deepEqual(errors, []);
    await textIs(a, 'diagnostics', 'ms');
    const diagnostics = await a.locator('#diagnostics').textContent();
    assert.ok(!diagnostics.includes(new URLSearchParams(new URL(invite).hash.slice(1)).get('invite')));
    assert.ok(!/candidate:|v=0|192\.168\.|127\.0\.0\./.test(diagnostics));
    assert.equal(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await a.goto(f.origin + '/sandbox/'); assert.equal(await a.locator('a[href="./projects/p2p-pong/"]').count(), 1);
  } finally { await f.close(); }
});

test('host disconnect ends match; a third browser cannot reuse an invitation or replace the opponent', { timeout: 25_000 }, async () => {
  const f = await fixture();
  try {
    const a = await open(f), b = await open(f), third = await open(f);
    const invite = await pair(f, a, b);
    await third.goto(invite); await third.locator('#join').click(); await textIs(third, 'status', 'Connection failed');
    assert.ok(await third.locator('#create').isVisible());
    await textIs(b, 'status', 'Connected');
    await a.goto('about:blank'); await textIs(b, 'status', 'Disconnected');
    assert.ok(await b.locator('#up').isDisabled());
    await b.locator('#create').click(); await textIs(b, 'status', 'Waiting');
  } finally { await f.close(); }
});

test('a real alarm expires an unauthenticated browser socket without incoming traffic', { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const p = await open(f); await p.goto(f.origin + prefix);
    await p.evaluate(apiUrl => { window.rawSocket = new WebSocket(apiUrl.replace('http:', 'ws:') + '/api/pong/ws'); }, f.apiUrl);
    await p.waitForFunction(() => window.rawSocket.readyState === WebSocket.OPEN);
    await p.waitForFunction(() => window.rawSocket.readyState === WebSocket.CLOSED, null, { timeout: 15_000 });
    const cleaned = await pongControl(f.worker);
    assert.equal(cleaned.sockets, 0); assert.equal(cleaned.alarm, null);
  } finally { await f.close(); }
});

test('ICE negotiation timeout provides retry and disposes stale connection; offline preview opens no peers/sockets', { timeout: 25_000 }, async () => {
  let f = await fixture();
  try {
    const a = await open(f), b = await open(f);
    await b.addInitScript(() => { RTCPeerConnection.prototype.setRemoteDescription = () => new Promise(() => {}); });
    await a.clock.install();
    await a.goto(f.origin + prefix); await a.locator('#create').click(); await textIs(a, 'status', 'Waiting');
    const old = await a.locator('#invite').inputValue();
    await b.goto(old); await b.locator('#join').click(); await textIs(a, 'status', 'Connecting directly');
    await a.clock.fastForward(36_000); await textIs(a, 'status', 'Connection failed');
    assert.equal(await a.evaluate(() => window.pongPCs[0].connectionState), 'closed');
    await a.locator('#create').click(); await textIs(a, 'status', 'Waiting');
    assert.notEqual(await a.locator('#invite').inputValue(), old);
  } finally { await f.close(); }
  f = await fixture(false);
  try {
    const p = await open(f); await p.goto(f.origin + prefix); await textIs(p, 'status', 'Offline preview');
    assert.equal(await p.locator('#create').isDisabled(), true);
    assert.deepEqual(await p.evaluate(() => [window.pongPCs.length, window.pongSockets.length]), [0, 0]);
    assert.equal(await p.locator('#debug').isVisible(), false);
  } finally { await f.close(); }
});
