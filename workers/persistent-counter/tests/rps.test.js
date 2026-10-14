import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { createWorker } from './helpers.js';
import { createRpsWorker, rpsControl, until, subscribe, join, pair, move } from './rps-helpers.js';

const future = Date.parse('2030-01-01T12:00:00Z');

test('five live lobby rooms; first waits, second starts; simultaneous entrants become spectators', async () => {
  const worker = createRpsWorker();
  try {
    const lobby = await subscribe(worker);
    assert.equal(lobby.state.rooms.length, 5);
    assert.ok(lobby.state.rooms.every(r => r.status === 'Empty'));
    const a = await join(await subscribe(worker));
    await until(() => lobby.state.rooms[0].players === 1);
    assert.equal(a.state.room.match.phase, 'waiting');
    assert.equal(lobby.state.rooms[0].status, 'Waiting for opponent');
    const entrants = await Promise.all(Array.from({ length: 4 }, () => subscribe(worker)));
    await Promise.all(entrants.map(c => join(c)));
    await until(() => a.state.room.spectators === 3);
    assert.equal(entrants.filter(c => c.state.you.role === 'player').length, 1);
    assert.equal(a.state.room.match.phase, 'playing');
    assert.equal(lobby.state.rooms[0].status, 'In progress');
    assert.deepEqual(lobby.state.rooms.slice(1).map(r => r.status), Array(4).fill('Empty'));
    const watcher = await join(await subscribe(worker), 'spectate', 2);
    assert.equal(watcher.state.you.role, 'spectator');
    assert.equal(watcher.state.room.status, 'Empty');
    watcher.send({ type: 'leave' });
    await until(() => watcher.state.room === null);
    assert.equal((await rpsControl(worker)).rooms[1].spectators, 0);
  } finally { await worker.dispose(); }
});

test('private moves/credentials, spectator permissions and immutable submissions', async () => {
  const worker = createWorker();
  try {
    const [a, b] = await pair(worker), watcher = await join(await subscribe(worker));
    assert.match(a.credential, /^[a-f0-9]{64}$/);
    assert.notEqual(a.credential, b.credential);
    move(a, 'rock');
    await until(() => watcher.state.room.match.submitted[0]);
    for (const c of [a, b, watcher]) {
      assert.ok(!JSON.stringify(c.state).includes('rock'));
      assert.ok(!JSON.stringify(c.state).includes('credential'));
      assert.ok(!JSON.stringify(c.state).includes(a.credential));
    }
    assert.ok(!JSON.stringify(b.events).includes(a.credential));
    assert.ok(!JSON.stringify(watcher.events).includes(b.credential));
    move(a, 'paper');
    await until(() => a.events.some(e => e.type === 'error'));
    move(watcher, 'scissors');
    watcher.send({ type: 'rematch', match: watcher.state.room.match.id });
    watcher.send({ type: 'join', room: 1, mode: 'play' });
    await until(() => watcher.events.filter(e => e.type === 'error').length === 3);
    assert.equal(watcher.state.you.role, 'spectator');
    move(b, 'scissors');
    await until(() => watcher.state.room.match.results.length === 1);
    assert.deepEqual(watcher.state.room.match.results[0].hands, ['rock', 'scissors']);
    assert.deepEqual(watcher.state.room.match.score, [1, 0]);
    assert.deepEqual(a.state.room.match, watcher.state.room.match);
    assert.deepEqual(b.state.room.match, watcher.state.room.match);
    move(a, 'paper', { round: 1 });
    await until(() => a.events.filter(e => e.type === 'error').length === 2);
    assert.deepEqual(a.state.room.match.submitted, [false, false]);
  } finally { await worker.dispose(); }
});

test('all nine outcomes, ties, first-to-three, stale match rejection, bilateral rematch', async () => {
  const worker = createRpsWorker();
  try {
    await rpsControl(worker, { now: future });
    const [a, b] = await pair(worker);
    const cases = [['rock', 'rock', null], ['paper', 'paper', null], ['scissors', 'scissors', null],
      ['rock', 'paper', 1], ['paper', 'scissors', 1], ['scissors', 'paper', 0],
      ['paper', 'rock', 0], ['rock', 'scissors', 0]];
    for (const [i, [one, two, winner]] of cases.entries()) {
      await rpsControl(worker, { now: future + (i + 1) * 1000 });
      move(a, one); move(b, two);
      await until(() => a.state.room.match.results.length === i + 1);
      assert.equal(a.state.room.match.results.at(-1).winner, winner);
    }
    assert.deepEqual(a.state.room.match.score, [3, 2]);
    assert.equal(a.state.room.match.phase, 'complete');
    assert.equal(a.state.room.match.winner, 0);
    const old = a.state.room.match.id;
    move(a, 'rock');
    await until(() => a.events.some(e => e.type === 'error'));
    a.send({ type: 'rematch', match: old });
    await until(() => b.state.room.match.rematch[0]);
    assert.equal(b.state.room.match.phase, 'complete');
    b.send({ type: 'rematch', match: old });
    await until(() => a.state.room.match.id !== old);
    assert.deepEqual(a.state.room.match.score, [0, 0]);
    assert.equal(a.state.room.match.phase, 'playing');
    move(a, 'rock', { match: old });
    await until(() => a.events.filter(e => e.type === 'error').length === 2);
    await rpsControl(worker, { now: future + 10_000 });
    move(a, 'scissors'); move(b, 'rock');
    await until(() => a.state.room.match.results.length === 1);
    assert.equal(a.state.room.match.results[0].winner, 1);
  } finally { await worker.dispose(); }
});

test('60 second reservation, private credential reclaim, deadline expiry and empty cleanup', async () => {
  const worker = createRpsWorker();
  try {
    await rpsControl(worker, { now: future });
    const [a, b] = await pair(worker), token = a.credential, match = a.state.room.match.id;
    move(a, 'paper'); await until(() => b.state.room.match.submitted[0]);
    a.ws.close(1000);
    await until(() => !b.state.room.players[0].connected);
    assert.equal((await rpsControl(worker)).alarm, future + 60_000);
    const intruder = await join(await subscribe(worker));
    assert.equal(intruder.state.you.role, 'spectator');
    await rpsControl(worker, { now: future + 59_999 });
    const rejoined = await join(await subscribe(worker), 'play', 1, token);
    assert.equal(rejoined.state.you.seat, 0);
    assert.equal(rejoined.credential, token);
    assert.equal(rejoined.state.room.match.id, match);
    assert.equal(rejoined.state.room.match.submitted[0], true);
    assert.equal((await rpsControl(worker)).alarm, null);
    rejoined.ws.close(1000);
    await until(() => !b.state.room.players[0].connected);
    await rpsControl(worker, { now: future + 119_998, alarm: true });
    assert.equal(b.state.room.status, 'In progress');
    await rpsControl(worker, { now: future + 119_999, alarm: true });
    await until(() => b.state.room.status === 'Waiting for opponent');
    assert.equal(b.state.room.match.phase, 'waiting');
    assert.deepEqual(b.state.room.match.score, [0, 0]);
    assert.deepEqual(b.state.room.match.submitted, [false, false]);
    const late = await subscribe(worker);
    late.send({ type: 'join', room: 1, mode: 'play', credential: token });
    await until(() => late.events.some(e => e.type === 'error'));
    assert.equal(late.state.room, null);
    b.send({ type: 'leave' }); await until(() => intruder.state.room.status === 'Empty');
    assert.equal((await rpsControl(worker)).alarm, null);
  } finally { await worker.dispose(); }
});

test('active reload takes over seat; stale socket close cannot release the new connection', async () => {
  const worker = createWorker();
  try {
    const [a, b] = await pair(worker);
    const next = await join(await subscribe(worker), 'play', 1, a.credential);
    await until(() => a.ws.readyState >= 2);
    assert.equal(next.state.you.seat, 0);
    move(next, 'rock'); move(b, 'scissors');
    await until(() => next.state.room.match.score[0] === 1);
    assert.equal(next.state.room.players[0].connected, true);
  } finally { await worker.dispose(); }
});

test('durable restart retains unrevealed moves, score, credentials and disconnect deadlines', async () => {
  const directory = await mkdtemp(pathJoin(tmpdir(), 'rps-'));
  const options = { durableObjectsPersist: directory };
  let worker = createRpsWorker(options);
  try {
    await rpsControl(worker, { now: future });
    const [a, b] = await pair(worker);
    move(a, 'rock'); move(b, 'scissors');
    await until(() => a.state.room.match.score[0] === 1);
    move(a, 'paper'); await until(() => b.state.room.match.submitted[0]);
    const [ta, tb] = [a.credential, b.credential], match = a.state.room.match.id;
    a.ws.close(1000); b.ws.close(1000);
    await until(() => a.ws.readyState === 3 && b.ws.readyState === 3);
    const before = await rpsControl(worker);
    assert.equal(before.alarm, future + 60_000);
    await worker.dispose(); worker = createRpsWorker(options);
    await rpsControl(worker, { now: future + 30_000 });
    assert.equal((await rpsControl(worker)).alarm, before.alarm);
    const nextA = await join(await subscribe(worker), 'play', 1, ta);
    const nextB = await join(await subscribe(worker), 'play', 1, tb);
    assert.equal(nextA.state.room.match.id, match);
    assert.deepEqual(nextB.state.room.match.score, [1, 0]);
    assert.deepEqual(nextB.state.room.match.submitted, [true, false]);
    assert.ok(!JSON.stringify(nextB.state.room.match).includes('paper'));
    move(nextB, 'rock'); await until(() => nextA.state.room.match.score[0] === 2);
    assert.deepEqual(nextA.state.room.match.results.at(-1).hands, ['paper', 'rock']);
  } finally { await worker.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('origin/method/upgrade validation and malformed, binary, oversized messages', async () => {
  const worker = createWorker();
  try {
    for (const [headers, method, expected] of [
      [{ Upgrade: 'websocket' }, 'GET', 403],
      [{ Origin: 'https://evil.example', Upgrade: 'websocket' }, 'GET', 403],
      [{ Origin: 'https://takahirox.github.io' }, 'GET', 426],
      [{ Origin: 'https://takahirox.github.io' }, 'POST', 405]
    ]) assert.equal((await worker.dispatchFetch('https://game.test/api/rps/ws', { headers, method })).status, expected);
    for (const raw of ['{', 'null', '[]', '{"type":"__proto__"}', '{"type":"constructor"}',
      'x'.repeat(513), new Uint8Array([1, 2]).buffer,
      JSON.stringify({ type: 'join', room: 6, mode: 'play' }),
      JSON.stringify({ type: 'join', room: 1, mode: 'play', credential: 'public-room-1' }),
      JSON.stringify({ type: 'leave', score: [3, 0] })]) {
      const c = await subscribe(worker);
      let code; c.ws.addEventListener('close', e => { code = e.code; });
      c.ws.send(raw); await until(() => code); assert.equal(code, 1008);
    }
  } finally { await worker.dispose(); }
});

test('abrupt runtime recreation reserves lost active sockets and recovers a locked choice', async () => {
  const directory = await mkdtemp(pathJoin(tmpdir(), 'rps-active-'));
  const options = { durableObjectsPersist: directory };
  let worker = createWorker(options);
  try {
    const [a, b] = await pair(worker);
    move(a, 'scissors'); await until(() => b.state.room.match.submitted[0]);
    const tokens = [a.credential, b.credential], match = a.state.room.match.id;
    // Do not deliver orderly close frames before recreating workerd.
    await worker.dispose(); worker = createWorker(options);
    const viewer = await join(await subscribe(worker), 'spectate');
    assert.ok(viewer.state.room.players.every(p => !p.connected && p.reconnectUntil > Date.now()));
    const nextA = await join(await subscribe(worker), 'play', 1, tokens[0]);
    const nextB = await join(await subscribe(worker), 'play', 1, tokens[1]);
    assert.equal(nextA.state.room.match.id, match);
    move(nextB, 'paper'); await until(() => viewer.state.room.match.score[0] === 1);
  } finally { await worker.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('a real storage alarm releases an abandoned seat after 60 seconds without incoming traffic', { timeout: 75_000 }, async () => {
  const worker = createWorker();
  try {
    const lobby = await subscribe(worker), player = await join(await subscribe(worker));
    await until(() => lobby.state.rooms[0].players === 1);
    const released = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Cleanup alarm did not push vacancy')), 70_000);
      lobby.ws.addEventListener('message', e => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'snapshot' && msg.rooms[0].status === 'Empty') {
          clearTimeout(timer); resolve();
        }
      });
    });
    player.ws.close(1000);
    await released;
    assert.equal(lobby.state.rooms[0].players, 0);
    assert.equal(lobby.state.rooms[0].status, 'Empty');
  } finally { await worker.dispose(); }
});

test('message and IP limits, heartbeat auto-response, durable daily cap with pushed reset', async () => {
  const worker = createRpsWorker();
  try {
    await rpsControl(worker, { now: future });
    const [a, b] = await pair(worker);
    let pong = false; a.ws.addEventListener('message', e => { if (e.data === 'pong') pong = true; });
    a.ws.send('ping'); await until(() => pong);
    for (let i = 0; i < 20; i++) a.send({ type: 'rematch', match: a.state.room.match.id });
    await until(() => a.events.some(e => e.reason?.startsWith('Too fast')));
    await rpsControl(worker, { limit: true });
    move(b, 'rock'); await until(() => b.events.some(e => e.reason?.startsWith('Daily play limit')));
    const viewer = await join(await subscribe(worker), 'spectate');
    assert.equal(viewer.state.playAvailable, false);
    await rpsControl(worker, { now: Date.parse('2030-01-02T00:00:00Z'), alarm: true });
    await until(() => viewer.state.playAvailable);
    move(b, 'rock'); await until(() => a.state.room.match.submitted[1]);
    // Per-IP quota is a connection control, not a fixed room spectator limit.
    for (let i = 0; i < 20; i++) await subscribe(worker, '192.0.2.99');
    const handshakeLimited = await worker.dispatchFetch('https://game.test/api/rps/ws', {
      headers: { Origin: 'https://takahirox.github.io', Upgrade: 'websocket', 'CF-Connecting-IP': '192.0.2.99' }
    });
    assert.equal(handshakeLimited.status, 429);
    await rpsControl(worker, { now: Date.parse('2030-01-02T00:00:10Z') });
    for (let i = 0; i < 12; i++) await subscribe(worker, '192.0.2.99');
    const denied = await worker.dispatchFetch('https://game.test/api/rps/ws', {
      headers: { Origin: 'https://takahirox.github.io', Upgrade: 'websocket', 'CF-Connecting-IP': '192.0.2.99' }
    });
    assert.equal(denied.status, 429);
  } finally { await worker.dispose(); }
});

test('shared-IP message bursts are limited across sockets without blocking a different IP', async () => {
  const worker = createRpsWorker();
  try {
    await rpsControl(worker, { now: future });
    const clients = await Promise.all(Array.from({ length: 8 }, () => subscribe(worker)));
    for (const c of clients) for (let i = 0; i < 10; i++) c.send({ type: 'rematch', match: 'not-a-match' });
    await until(() => clients.some(c => c.events.some(e => e.reason?.startsWith('Too fast'))));
    const other = await subscribe(worker, '192.0.2.8');
    await join(other);
    assert.equal(other.state.you.role, 'player');
  } finally { await worker.dispose(); }
});
