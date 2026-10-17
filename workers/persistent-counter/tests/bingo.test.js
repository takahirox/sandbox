import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCard, drawNumber, hasBingo, randomInt } from '../src/bingo-rules.js';
import { createBingoWorker, bingoControl, subscribeBingo, action, until } from './bingo-helpers.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function start(worker) {
  const a = await subscribeBingo(worker);
  await action(a, 'claim'); await action(a, 'start'); return a;
}
async function draw(a) {
  const length = a.state.called.length;
  await action(a, 'draw', { expected: length });
  assert.equal(a.state.called.length, length + 1);
}

test('75-ball cards have proper ranges, unique columns and a free center; random selection is unbiased', () => {
  const cards = new Set();
  for (let trial = 0; trial < 300; trial++) {
    const card = createCard();
    assert.equal(card.length, 25); assert.equal(card[12], null);
    assert.equal(new Set(card.filter(Boolean)).size, 24);
    for (let i = 0; i < 25; i++) if (i !== 12) {
      assert.ok(card[i] > (i % 5) * 15 && card[i] <= (i % 5 + 1) * 15);
    }
    cards.add(JSON.stringify(card));
  }
  assert.equal(cards.size, 300);
  let samples = [0xffffffff, 0xfffffffe, 7];
  assert.equal(randomInt(75, () => samples.shift()), 7);
  assert.equal(samples.length, 0, 'Reject the biased tail');
  // Every possible pool position is selectable, including both endpoints.
  for (let count = 0; count < 75; count++) {
    const called = Array.from({ length: count }, (_, i) => i + 1);
    const results = Array.from({ length: 75 - count }, (_, i) => drawNumber(called, size => { assert.equal(size, 75 - count); return i; }));
    assert.deepEqual(results, Array.from({ length: 75 - count }, (_, i) => count + i + 1));
  }
  const called = [];
  while (called.length < 75) called.push(drawNumber(called));
  assert.equal(new Set(called).size, 75); assert.equal(drawNumber(called), null);
});

test('every horizontal, vertical and diagonal line is detected; partial lines are not', () => {
  const lines = [...Array.from({ length: 5 }, (_, r) => Array.from({ length: 5 }, (_, c) => r * 5 + c)),
    ...Array.from({ length: 5 }, (_, c) => Array.from({ length: 5 }, (_, r) => r * 5 + c)), [0, 6, 12, 18, 24], [4, 8, 12, 16, 20]];
  for (const line of lines) {
    assert.equal(hasBingo(line.filter(i => i !== 12)), true);
    assert.equal(hasBingo(line.filter(i => i !== 12).slice(1)), false);
  }
  assert.equal(hasBingo([12]), false);
});

test('simultaneous players receive private distinct cards, shared unique draws, late calls, verified Bingo and confirmed resets', { timeout: 30_000 }, async () => {
  const worker = createBingoWorker();
  try {
    const a = await start(worker);
    const [b, c] = await Promise.all([subscribeBingo(worker), subscribeBingo(worker)]);
    assert.notDeepEqual(a.state.you.card, b.state.you.card);
    assert.notDeepEqual(c.state.you.card, b.state.you.card);
    for (let i = 0; i < 75; i++) {
      if (i % 6 === 0) await pause(1550); // Exercise actual production rate control.
      await draw(a);
    }
    await until(() => b.state.called.length === 75 && c.state.called.length === 75);
    assert.deepEqual(a.state.called, b.state.called); assert.deepEqual(b.state.called, c.state.called);
    assert.equal(new Set(a.state.called).size, 75); assert.equal(a.state.phase, 'complete');
    assert.equal((await action(a, 'draw', { expected: 75 })).type, 'error');
    const late = await subscribeBingo(worker);
    assert.deepEqual(late.state.called, a.state.called);
    // A late player can mark prior calls, with server verification on its own card.
    for (let index = 0; index < 5; index++) await action(late, 'mark', { index });
    await until(() => b.state.wins.length === 1);
    assert.equal(late.state.you.bingo, true); assert.equal(b.state.you.bingo, false);
    assert.equal(b.state.wins[0].player, late.state.you.id);
    const publicFrames = JSON.stringify(b.events);
    assert.ok(!publicFrames.includes(a.credential)); assert.ok(!publicFrames.includes(late.credential));
    assert.ok(!publicFrames.includes(JSON.stringify(a.state.you.card)));
    const old = { game: a.state.game, card: b.state.you.card };
    // Reset is allowed only with explicit confirmation, and every connected player gets a fresh card.
    await pause(400);
    await action(a, 'reset', { confirm: true });
    await until(() => b.state.game !== old.game && late.state.game !== old.game);
    assert.equal(b.state.phase, 'waiting'); assert.deepEqual(b.state.called, []);
    assert.deepEqual(b.state.you.marks, [12]); assert.deepEqual(b.state.wins, []);
    assert.notDeepEqual(b.state.you.card, old.card); assert.equal(a.state.you.caller, true);
    assert.equal((await action(b, 'mark', { game: old.game, index: 0 })).type, 'error');
    assert.equal((await action(a, 'draw', { expected: 0 })).type, 'error');
  } finally { await worker.dispose(); }
});

test('caller authorization, duplicate ordering, fraudulent marks and private credential takeover', async () => {
  const worker = createBingoWorker();
  try {
    const a = await start(worker), b = await subscribeBingo(worker);
    for (const [type, extra] of [['draw', { expected: 0 }], ['reset', { confirm: true }], ['start', {}], ['release', {}], ['claim', {}], ['mark', { index: 0 }]]) {
      assert.equal((await action(b, type, extra)).type, 'error');
    }
    const msg = a.action('draw', { expected: 0 });
    await until(() => a.state.called.length === 1);
    a.send(msg);
    await until(() => a.events.some(e => e.reason?.startsWith('Duplicate')));
    assert.equal(a.state.called.length, 1);
    assert.equal((await action(a, 'draw', { expected: 0 })).type, 'error');
    const wrong = await subscribeBingo(worker, 'f'.repeat(64));
    assert.notEqual(wrong.credential, 'f'.repeat(64));
    assert.equal(wrong.state.you.caller, false);
    const card = a.state.you.card, token = a.credential;
    let closed;
    a.ws.addEventListener('close', e => { closed = e.code; });
    const reclaimed = await subscribeBingo(worker, token);
    await until(() => closed === 4001);
    assert.equal(reclaimed.state.you.caller, true); assert.deepEqual(reclaimed.state.you.card, card);
    await action(reclaimed, 'release');
    await until(() => b.state.caller === null);
    assert.equal((await action(b, 'claim')).you.caller, true);
    assert.ok(!JSON.stringify(b.events).includes(token));
  } finally { await worker.dispose(); }
});

test('caller disconnect has a durable 30-second reservation; expiry and daily reset push without polling', async () => {
  const worker = createBingoWorker();
  try {
    const now = Date.now(); await bingoControl(worker, { now });
    const a = await start(worker), b = await subscribeBingo(worker);
    const credential = a.credential, card = a.state.you.card;
    a.ws.close();
    await until(() => b.state.caller?.reconnectUntil === now + 30_000);
    assert.equal((await action(b, 'claim')).type, 'error');
    const again = await subscribeBingo(worker, credential);
    assert.deepEqual(again.state.you.card, card); assert.equal(again.state.you.caller, true);
    assert.equal(again.state.caller.reconnectUntil, null);
    again.ws.close(); await until(() => b.state.caller?.reconnectUntil);
    await bingoControl(worker, { now: now + 30_001, alarm: true });
    await until(() => b.state.caller === null);
    await action(b, 'claim');
    await bingoControl(worker, { limit: true });
    assert.equal((await action(b, 'start')).type, 'error');
    // Release remains possible even at the daily cap.
    await action(b, 'release'); assert.equal(b.state.caller, null);
    const data = await bingoControl(worker);
    await bingoControl(worker, { now: Date.parse(new Date(now).toISOString().slice(0, 10)) + 86_400_001, alarm: true });
    await until(() => b.state.playAvailable);
    assert.equal(data.used, 5000); assert.equal((await action(b, 'claim')).you.caller, true);
  } finally { await worker.dispose(); }
});

test('persisted cards, marks, draw history and caller recover after runtime reinitialization', async () => {
  const path = await mkdtemp(join(tmpdir(), 'bingo-state-'));
  let worker = createBingoWorker({ durableObjectsPersist: path });
  try {
    const a = await start(worker);
    const now = Date.now();
    let eligible = -1;
    for (let i = 0; eligible < 0; i++) {
      await bingoControl(worker, { now: now + i * 400 }); await draw(a);
      eligible = a.state.you.card.findIndex(n => a.state.called.includes(n));
    }
    await action(a, 'mark', { index: eligible });
    assert.equal(a.state.you.marks.length, 2);
    assert.equal((await action(a, 'mark', { index: eligible })).type, 'error');
    const saved = a.state, credential = a.credential;
    await worker.dispose();
    worker = createBingoWorker({ durableObjectsPersist: path });
    const restored = await subscribeBingo(worker, credential);
    assert.equal(restored.credential, credential);
    assert.equal(restored.state.game, saved.game);
    assert.deepEqual(restored.state.called, saved.called);
    assert.deepEqual(restored.state.you.card, saved.you.card);
    assert.deepEqual(restored.state.you.marks, saved.you.marks);
    assert.equal(restored.state.you.caller, true);
    await draw(restored);
  } finally { await worker.dispose(); await rm(path, { recursive: true, force: true }); }
});

test('invalid schemas, forged wins, binary/oversized frames and excessive messages close the socket', async () => {
  const worker = createBingoWorker();
  try {
    const cases = ['{', 'null', '[]', JSON.stringify({ type: 'bingo', win: true }),
      JSON.stringify({ type: 'claim', caller: true }), 'x'.repeat(513), new Uint8Array([1, 2]),
      JSON.stringify({ type: 'reset', game: 'game', seq: 1, confirm: false }),
      JSON.stringify({ type: 'mark', game: 'game', seq: 1, index: 25 }),
      JSON.stringify({ type: 'join', credential: [] })];
    for (const [i, raw] of cases.entries()) {
      const c = await subscribeBingo(worker, undefined, `192.0.2.${i + 2}`);
      let code; c.ws.addEventListener('close', e => { code = e.code; }); c.ws.send(raw);
      await until(() => code); assert.equal(code, 1008);
    }
    const c = await subscribeBingo(worker, undefined, '198.51.100.1');
    let code; c.ws.addEventListener('close', e => { code = e.code; });
    for (let i = 0; i < 16; i++) c.action('mark', { index: 0 });
    await until(() => code); assert.equal(code, 1008);
  } finally { await worker.dispose(); }
});

test('Worker enforces origin/method/upgrade and connection limits; hibernation heartbeat has no game effects', async () => {
  const worker = createBingoWorker();
  try {
    for (const [options, status] of [
      [{}, 403], [{ headers: { Origin: 'https://evil.test', Upgrade: 'websocket' } }, 403],
      [{ method: 'POST', headers: { Origin: 'https://takahirox.github.io' } }, 405],
      [{ headers: { Origin: 'https://takahirox.github.io' } }, 426]
    ]) assert.equal((await worker.dispatchFetch('https://game.test/api/bingo/ws', options)).status, status);
    const a = await subscribeBingo(worker);
    const before = await bingoControl(worker);
    let pong = false; a.ws.addEventListener('message', e => { if (e.data === 'pong') pong = true; });
    a.ws.send('ping'); await until(() => pong);
    assert.equal((await bingoControl(worker)).used, before.used);
    for (let i = 0; i < 15; i++) {
      const response = await worker.dispatchFetch('https://game.test/api/bingo/ws', {
        headers: { Origin: 'https://takahirox.github.io', Upgrade: 'websocket', 'CF-Connecting-IP': '203.0.113.1' }
      });
      if (response.status === 429) return;
      response.webSocket.accept();
    }
    assert.fail('Expected handshake limit');
  } finally { await worker.dispose(); }
});

test('real storage alarm releases a disconnected caller without any incoming traffic', { timeout: 36_000 }, async () => {
  const worker = createBingoWorker();
  try {
    const a = await start(worker), b = await subscribeBingo(worker);
    a.ws.close(); await until(() => b.state.caller?.reconnectUntil);
    const deadline = Date.now() + 33_000;
    while (b.state.caller && Date.now() < deadline) await pause(100);
    assert.equal(b.state.caller, null);
    assert.equal((await action(b, 'claim')).you.caller, true);
  } finally { await worker.dispose(); }
});

test('competing claims serialize, disconnected cards persist until reset, and stale socket messages cannot control a reclaimed card', async () => {
  const worker = createBingoWorker();
  try {
    const [a, b] = await Promise.all([subscribeBingo(worker), subscribeBingo(worker)]);
    a.action('claim'); b.action('claim');
    await until(() => a.state.caller && b.state.caller);
    const caller = a.state.you.caller ? a : b, other = caller === a ? b : a;
    assert.equal(Number(a.state.you.caller) + Number(b.state.you.caller), 1);
    const token = other.credential;
    other.ws.close();
    await until(() => caller.state.connected === 1);
    assert.equal((await bingoControl(worker)).players.length, 2);
    await action(caller, 'reset', { confirm: true });
    assert.equal((await bingoControl(worker)).players.length, 1);
    const returned = await subscribeBingo(worker, token);
    assert.notEqual(returned.credential, token);
    assert.equal(returned.state.game, caller.state.game);
    assert.deepEqual(returned.state.you.marks, [12]);
    const reclaimed = await subscribeBingo(worker, caller.credential);
    assert.equal(reclaimed.state.you.caller, true);
    await action(reclaimed, 'start');
    await draw(reclaimed);
    assert.equal(reclaimed.state.called.length, 1);
    assert.equal(returned.state.you.caller, false);
  } finally { await worker.dispose(); }
});

test('128-card/socket bounds reject excess joins but allow authenticated reconnect and reset cleanup', { timeout: 30_000 }, async () => {
  const worker = createBingoWorker();
  try {
    const a = await start(worker), clients = [a];
    for (let i = 1; i < 128; i++) clients.push(await subscribeBingo(worker, undefined, `198.51.100.${i}`));
    assert.equal(new Set(clients.map(c => JSON.stringify(c.state.you.card))).size, 128);
    const request = () => worker.dispatchFetch('https://game.test/api/bingo/ws', {
      headers: { Origin: 'https://takahirox.github.io', Upgrade: 'websocket', 'CF-Connecting-IP': '203.0.113.100' }
    });
    assert.equal((await request()).status, 429);
    clients[1].ws.close(); await until(() => a.state.connected === 127);
    const over = await subscribeBingo(worker, undefined, '203.0.113.101');
    assert.ok(over.events.some(e => e.reason?.includes('128 cards')));
    over.ws.close();
    const restored = await subscribeBingo(worker, clients[1].credential, '203.0.113.102');
    assert.deepEqual(restored.state.you.card, clients[1].state.you.card);
    restored.ws.close(); await until(() => a.state.connected === 127);
    await action(a, 'reset', { confirm: true });
    const fresh = await subscribeBingo(worker, undefined, '203.0.113.103');
    assert.ok(fresh.state.you); assert.deepEqual(fresh.state.called, []);
    const data = await bingoControl(worker);
    assert.equal(data.players.length, 128);
    assert.ok(JSON.stringify(data).length < 128 * 1024, 'Bounded authoritative value fits storage limits');
  } finally { await worker.dispose(); }
});
