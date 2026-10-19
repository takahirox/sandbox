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
  assert.equal(await a.locator('#copy').isVisible(), true);
  assert.equal(await a.locator('#create').isVisible(), false);
  assert.equal(await a.locator('#invite').isVisible(), false, 'Link details stay collapsed');
  const invite = await a.locator('#invite').inputValue();
  await b.goto(invite); await b.locator('#join').click();
  await Promise.all([a, b].map(p => textIs(p, 'status', 'Connected')));
  for (const p of [a, b]) {
    assert.equal(await p.locator('#privacy').isVisible(), false);
    assert.equal(await p.locator('#invitation').isVisible(), false);
    assert.equal(await p.locator('#invite').inputValue(), '', 'Private link is removed during play');
    assert.equal(await p.locator('#create').isVisible(), false);
    assert.equal(await p.locator('#join').isVisible(), false);
    assert.equal(await p.locator('#play-controls').isVisible(), true);
    assert.equal(await p.locator('#court').evaluate(el => el === document.activeElement), true);
    assert.equal(await p.locator('#status').textContent(), 'Connected');
    for (const id of ['up', 'down']) {
      const control = await p.locator('#' + id).boundingBox();
      assert.ok(control.width >= 44 && control.height >= 44, 'Touch controls remain large enough');
    }
  }
  await a.waitForFunction(() => window.pongSockets[0]?.readyState === WebSocket.CLOSED);
  await b.waitForFunction(() => window.pongSockets[0]?.readyState === WebSocket.CLOSED);
  await b.setViewportSize({ width: 320, height: 640 });
  const left = await b.locator('#left-score').boundingBox(), right = await b.locator('#right-score').boundingBox();
  assert.ok(Math.abs(left.y - right.y) < 1, 'Scores align even when a narrow-screen player label wraps');
  assert.equal(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
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
      const diagnostics = await p.locator('#diagnostics').textContent();
      console.info('Same-host handshake milliseconds:', /(?:^| · )connected (\d+)/.exec(diagnostics)?.[1] ?? 'pending');
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
    await textIs(a, 'status', 'wins', 40_000); await textIs(b, 'status', 'wins');
    assert.equal(await a.locator('#status').textContent(), await b.locator('#status').textContent());
    for (const p of [a, b]) {
      assert.equal(await p.locator('#create').textContent(), 'Play again');
      assert.equal(await p.locator('#create').evaluate(el => el === document.activeElement), true);
      assert.equal(await p.locator('#play-controls').isVisible(), false);
      assert.equal(await p.locator('#leave').isVisible(), false);
    }
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
    await a.locator('#create').click(); await textIs(a, 'status', 'Waiting');
    assert.ok(await a.locator('#invite').inputValue() !== invite, 'Play again creates a fresh invitation');
    assert.deepEqual(await a.locator('.score strong').allTextContents(), ['0', '0']);
    assert.equal(await a.locator('#play-controls').isVisible(), false);
    await a.locator('#leave').click();
    await a.goto(f.origin + '/sandbox/'); assert.equal(await a.locator('a[href="./projects/p2p-pong/"]').count(), 1);
  } finally { await f.close(); }
});

test('host disconnect ends match; a third browser cannot reuse an invitation or replace the opponent', { timeout: 25_000 }, async () => {
  const f = await fixture();
  try {
    const a = await open(f), b = await open(f), third = await open(f);
    const invite = await pair(f, a, b);
    await third.goto(invite); await third.locator('#join').click(); await textIs(third, 'status', 'Invitation unavailable');
    assert.ok(await third.locator('#create').isVisible());
    await textIs(b, 'status', 'Connected');
    await a.goto('about:blank'); await textIs(b, 'status', 'Disconnected');
    assert.ok(await b.locator('#up').isDisabled());
    assert.equal(await b.locator('#play-controls').isVisible(), false);
    assert.equal(await b.locator('#create').evaluate(el => el === document.activeElement), true);
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
    await b.goto(old);
    assert.equal(await b.locator('#join').isVisible(), true);
    assert.equal(await b.locator('#create').isVisible(), false);
    assert.equal(await b.locator('#privacy').isVisible(), true);
    await b.locator('#join').click(); await textIs(a, 'status', 'Connecting…');
    assert.equal(await a.locator('#invitation').isVisible(), false);
    assert.equal(await a.locator('#play-controls').isVisible(), false);
    await a.clock.fastForward(41_000); await textIs(a, 'status', 'Retrying');
    await a.clock.fastForward(42_000); await textIs(a, 'status', 'Direct connection failed');
    assert.equal(await a.locator('#privacy').isVisible(), true);
    assert.equal(await a.locator('#create').textContent(), 'Create new match');
    assert.equal(await a.evaluate(() => window.pongPCs[0].connectionState), 'closed');
    await b.waitForFunction(() => window.pongPCs[0]?.connectionState === 'closed');
    for (const p of [a, b]) await p.waitForFunction(() => window.pongSockets[0]?.readyState === WebSocket.CLOSED);
    assert.equal((await pongControl(f.worker)).sessions, 0);
    assert.equal((await pongControl(f.worker)).alarm, null);
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

test('minimal responsive landing, privacy disclosure, invitation copy/fallback, cancel and expiry', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const p = await open(f, { permissions: ['clipboard-read', 'clipboard-write'] });
    await p.goto(f.origin + prefix); await textIs(p, 'status', 'Invite a friend');
    assert.deepEqual(await p.evaluate(() => [window.pongPCs.length, window.pongSockets.length]), [0, 0]);
    assert.equal(await p.locator('button:visible').count(), 1);
    assert.equal(await p.locator('#play-controls').isVisible(), false);
    assert.equal(await p.locator('#privacy').getAttribute('open'), null);
    assert.ok(!/STUN|NAT|WebRTC|DataChannel|TURN/.test(await p.locator('body').innerText()));
    await p.locator('#privacy summary').focus(); await p.keyboard.press('Enter');
    assert.match(await p.locator('#privacy').innerText(), /IP address/);
    assert.match(await p.locator('#privacy').innerText(), /no relay \(TURN\) fallback/);
    await p.keyboard.press('Enter');
    for (const width of [320, 390, 1280]) {
      await p.setViewportSize({ width, height: 720 });
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const court = await p.locator('#court').boundingBox();
      assert.ok(Math.abs(court.width / court.height - 800 / 450) < .03);
      const action = await p.locator('#create').boundingBox();
      assert.ok(action.y + action.height < 720, 'Primary action fits the initial view');
    }
    assert.equal(await p.locator('#create').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    await p.locator('#create').focus();
    assert.equal(await p.locator('#create').evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
    await p.keyboard.press('Enter'); await textIs(p, 'status', 'Waiting');
    assert.equal(await p.locator('#copy').evaluate(el => el === document.activeElement), true);
    await p.locator('#copy').click(); await textIs(p, 'status', 'Link copied');
    assert.ok(await p.evaluate(async () => await navigator.clipboard.readText() === document.getElementById('invite').value));
    await p.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Denied'); }; });
    await p.locator('#copy').click();
    await p.locator('#invite').waitFor({ state: 'visible' });
    assert.equal(await p.locator('#invite').evaluate(el => el === document.activeElement && el.selectionEnd === el.value.length), true);
    assert.equal(await p.locator('#debug').isVisible(), false);
    await p.locator('#leave').click(); await textIs(p, 'status', 'Disconnected');
    assert.equal(await p.locator('#invite').inputValue(), '');
    assert.equal(await p.locator('#create').evaluate(el => el === document.activeElement), true);
    await p.clock.install();
    await p.locator('#create').click(); await textIs(p, 'status', 'Waiting');
    await p.clock.fastForward(301_000); await textIs(p, 'status', 'Invitation expired');
    assert.equal(await p.locator('#copy').isVisible(), false);
    assert.equal(await p.locator('#create').isVisible(), true);
    assert.equal(await p.locator('#invite').inputValue(), '');
  } finally { await f.close(); }
});

test('lost initial ICE recovers with one real ICE restart on the same authorized sockets', { timeout: 25_000 }, async () => {
  const f = await fixture();
  try {
    const a = await open(f), b = await open(f);
    for (const p of [a, b]) await p.addInitScript(() => {
      const send = WebSocket.prototype.send, createOffer = RTCPeerConnection.prototype.createOffer;
      window.restartOffers = []; window.initialCredentials = null; window.freshCredentials = false;
      RTCPeerConnection.prototype.createOffer = async function(options) {
        const result = await createOffer.call(this, options);
        window.restartOffers.push(!!options?.iceRestart);
        const credentials = /^a=ice-ufrag:(\S+)/m.exec(result.sdp)?.[1];
        if (!options?.iceRestart) window.initialCredentials = credentials;
        else window.freshCredentials = !!credentials && credentials !== window.initialCredentials;
        return result;
      };
      WebSocket.prototype.send = function(raw) {
        const m = JSON.parse(raw);
        if (m.generation === 0 && m.type === 'candidate') return; // Simulated lost signaling.
        if (m.generation === 0 && ['offer', 'answer'].includes(m.type)) {
          m.sdp = m.sdp.replace(/^a=(candidate:.*|end-of-candidates)\r?\n/gm, '');
          raw = JSON.stringify(m);
        }
        return send.call(this, raw);
      };
    });
    await a.clock.install();
    await a.goto(f.origin + prefix + '?debug=1'); await a.locator('#create').click(); await textIs(a, 'status', 'Waiting');
    await b.goto(await a.locator('#invite').inputValue()); await b.locator('#join').click();
    await a.waitForFunction(() => window.pongPCs[0]?.remoteDescription?.type === 'answer');
    await a.clock.fastForward(41_000); await textIs(a, 'status', 'Retrying'); await a.clock.resume();
    await Promise.all([a, b].map(p => textIs(p, 'status', 'Connected')));
    assert.deepEqual(await a.evaluate(() => window.restartOffers), [false, true]);
    assert.equal(await a.evaluate(() => window.freshCredentials), true, 'ICE restart changes credentials');
    for (const p of [a, b]) {
      await p.waitForFunction(() => window.pongSockets[0]?.readyState === WebSocket.CLOSED);
      assert.deepEqual(await p.evaluate(() => [window.pongPCs.length, window.pongSockets.length]), [1, 1]);
      await textIs(p, 'diagnostics', 'Retry: 1 / 1');
      await textIs(p, 'diagnostics', 'Selected pair types: host / host');
    }
    assert.equal((await pongControl(f.worker)).sessions, 0);
    assert.equal((await pongControl(f.worker)).alarm, null);
    await a.waitForFunction(() => window.pongData.some(m => m.type === 'state'));
  } finally { await f.close(); }
});

test('delayed/reordered ICE and completion markers remain private and establish a direct route', { timeout: 25_000 }, async () => {
  const f = await fixture();
  try {
    const a = await open(f), b = await open(f), errors = [];
    for (const p of [a, b]) {
      p.on('pageerror', () => errors.push('pageerror'));
      await p.addInitScript(() => {
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function(raw) {
          const m = JSON.parse(raw);
          // Deliver candidates (and completion) before the corresponding SDP,
          // then resend a stale ICE credential. No private values are logged.
          if (['offer', 'answer'].includes(m.type)) {
            setTimeout(() => send.call(this, raw), 250); return;
          }
          if (m.type === 'candidate' && m.candidate) {
            const stale = { ...m, usernameFragment: 'obsolete' };
            send.call(this, JSON.stringify(stale));
            setTimeout(() => send.call(this, raw), 100); return;
          }
          return send.call(this, raw);
        };
      });
    }
    await pair(f, a, b);
    assert.deepEqual(errors, []);
    for (const p of [a, b]) {
      const diagnostics = await p.locator('#diagnostics').textContent();
      assert.match(diagnostics, /Retry: 0 \/ 1/);
      assert.match(diagnostics, /Candidate errors: 0/);
      assert.ok(!/candidate:|v=0|obsolete|(?:\d{1,3}\.){3}\d{1,3}|[a-f0-9]{0,4}:[a-f0-9]{0,4}:/i.test(diagnostics));
    }
  } finally { await f.close(); }
});

test('a transient answer setup error retries with rollback and no replacement peer or socket', { timeout: 25_000 }, async () => {
  const f = await fixture();
  try {
    const a = await open(f), b = await open(f);
    await b.addInitScript(() => {
      const answer = RTCPeerConnection.prototype.createAnswer;
      let attempts = 0;
      RTCPeerConnection.prototype.createAnswer = function(...args) {
        if (++attempts === 1) return Promise.reject(new Error('Simulated setup failure'));
        return answer.apply(this, args);
      };
    });
    try { await pair(f, a, b); } catch (error) {
      for (const p of [a, b]) console.info('Retry setup diagnostics:', await p.locator('#diagnostics').textContent(),
        await p.evaluate(() => window.pongSignals));
      throw error;
    }
    for (const p of [a, b]) {
      await textIs(p, 'diagnostics', 'Retry: 1 / 1');
      assert.deepEqual(await p.evaluate(() => [window.pongPCs.length, window.pongSockets.length]), [1, 1]);
    }
    assert.equal((await pongControl(f.worker)).sessions, 0);
  } finally { await f.close(); }
});
