import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPongWorker, pongControl, connectPong, createMatch, joinMatch, until } from './pong-helpers.js';
import { newGame, step, clamp, acceptState } from '../../../projects/p2p-pong/rules.mjs';
const sdp = 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
const future = Date.parse('2030-01-01T12:00:00Z');

test('private one-use capabilities, exact two seats, ordered SDP roles, ICE and signaling-only release', async () => {
  const worker = createPongWorker();
  try {
    const { host, invite } = await createMatch(worker);
    assert.match(invite.session, /^[a-f0-9]{32}$/); assert.match(invite.invite, /^[a-f0-9]{64}$/);
    const intruder = await connectPong(worker);
    intruder.send({ type: 'join', session: invite.session, invite: '0'.repeat(64) });
    await until(() => intruder.ws.readyState >= 2);
    const guest = await joinMatch(worker, invite);
    await until(() => host.events.some(e => e.type === 'peer'));
    const third = await connectPong(worker);
    third.send({ type: 'join', session: invite.session, invite: invite.invite });
    await until(() => third.ws.readyState >= 2);
    assert.ok(!JSON.stringify(guest.events).includes(invite.invite));
    host.send({ type: 'offer', sdp }); await until(() => guest.events.some(e => e.type === 'offer'));
    guest.send({ type: 'answer', sdp }); await until(() => host.events.some(e => e.type === 'answer'));
    const candidate = { type: 'candidate', candidate: 'candidate:example', sdpMid: '0', sdpMLineIndex: 0 };
    host.send(candidate); await until(() => guest.events.some(e => e.type === 'candidate'));
    host.send({ type: 'ready' }); guest.send({ type: 'ready' });
    await until(() => host.events.some(e => e.type === 'released') && guest.events.some(e => e.type === 'released'));
    await until(() => host.ws.readyState >= 2 && guest.ws.readyState >= 2);
    const c = await pongControl(worker); assert.equal(c.sessions, 0); assert.equal(c.alarm, null);
  } finally { await worker.dispose(); }
});

test('origin, preflight, upgrade, method validation; missing/wrong capability and game messages cannot relay', async () => {
  const worker = createPongWorker();
  try {
    for (const [method, headers, expected] of [
      ['GET', { Upgrade: 'websocket' }, 403],
      ['GET', { Origin: 'https://evil.example', Upgrade: 'websocket' }, 403],
      ['GET', { Origin: 'https://takahirox.github.io' }, 426],
      ['POST', { Origin: 'https://takahirox.github.io' }, 405],
      ['OPTIONS', { Origin: 'https://takahirox.github.io', 'Access-Control-Request-Method': 'GET' }, 204]
    ]) assert.equal((await worker.dispatchFetch('https://pong.test/api/pong/ws', { method, headers })).status, expected);
    for (const raw of ['{', 'null', '[]', '{"type":"__proto__"}', 'x'.repeat(20_001), new Uint8Array([1]).buffer,
      JSON.stringify({ type: 'join', session: 'public', invite: 'public' }), JSON.stringify({ type: 'create', score: [5, 0] })]) {
      const c = await connectPong(worker); c.ws.send(raw); await until(() => c.ws.readyState >= 2);
    }
    const { host, invite } = await createMatch(worker), guest = await joinMatch(worker, invite);
    host.send({ type: 'state', ball: [1, 2], scores: [5, 0] });
    await until(() => guest.events.some(e => e.type === 'peer-left'));
    assert.ok(!guest.events.some(e => e.type === 'state'));
    assert.equal((await pongControl(worker)).sessions, 0);
  } finally { await worker.dispose(); }
});

test('abandoned unauthenticated sockets, invitations and negotiations expire via alarms; host loss ends session', async () => {
  const worker = createPongWorker();
  try {
    await pongControl(worker, { now: future });
    const unauth = await connectPong(worker);
    assert.equal((await pongControl(worker)).alarm, future + 10_000);
    const expired = await pongControl(worker, { now: future + 10_001, alarm: true });
    assert.equal(expired.sockets, 0); assert.equal(expired.alarm, null);
    await until(() => unauth.events.some(e => e.type === 'expired'));
    // dispatchFetch exposes a Worker-style socket. Native browser close and
    // real alarm delivery are covered in pong-browser.js.
    unauth.ws.close(1000);
    const a = await createMatch(worker);
    await pongControl(worker, { now: future + 310_002, alarm: true });
    await until(() => a.host.events.some(e => e.type === 'expired'));
    assert.equal((await pongControl(worker)).sessions, 0);
    const b = await createMatch(worker), guest = await joinMatch(worker, b.invite);
    await pongControl(worker, { now: future + 370_003, alarm: true });
    await until(() => guest.events.some(e => e.type === 'expired'));
    const c = await createMatch(worker), g = await joinMatch(worker, c.invite);
    c.host.ws.close(1000); await until(() => g.events.some(e => e.type === 'peer-left'));
    assert.equal((await pongControl(worker)).sessions, 0);
  } finally { await worker.dispose(); }
});

test('handshake and message rate/size limits; durable daily cap survives runtime recreation and resets next day', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pong-test-'));
  let worker = createPongWorker({ durableObjectsPersist: directory });
  try {
    await pongControl(worker, { now: future });
    const { host, invite } = await createMatch(worker), guest = await joinMatch(worker, invite);
    host.send({ type: 'offer', sdp }); guest.send({ type: 'answer', sdp });
    await until(() => host.events.some(e => e.type === 'answer'));
    for (let i = 0; i < 161; i++) host.send({ type: 'candidate', candidate: '', sdpMid: null, sdpMLineIndex: null });
    await until(() => host.ws.readyState >= 2);
    const headers = { Origin: 'https://takahirox.github.io', Upgrade: 'websocket', 'CF-Connecting-IP': '192.0.2.99' };
    for (let i = 0; i < 20; i++) await connectPong(worker, '192.0.2.99');
    assert.equal((await worker.dispatchFetch('https://pong.test/api/pong/ws', { headers })).status, 429);
    await pongControl(worker, { connections: 3000 });
    await worker.dispose(); worker = createPongWorker({ durableObjectsPersist: directory });
    await pongControl(worker, { now: future });
    assert.equal((await worker.dispatchFetch('https://pong.test/api/pong/ws', { headers })).status, 429);
    await pongControl(worker, { now: future + 86_400_000, alarm: true });
    const c = await connectPong(worker); assert.equal(c.events[0].type, 'hello');
  } finally { await worker.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('pending session and socket capacities stay bounded; alarms release all abandoned resources', async () => {
  const worker = createPongWorker();
  try {
    await pongControl(worker, { now: future });
    for (let i = 0; i < 24; i++) {
      const c = await connectPong(worker, `192.0.2.${i + 1}`); c.send({ type: 'create' });
      await until(() => c.events.some(e => e.type === 'created'));
    }
    const extra = await connectPong(worker, '192.0.2.100'); extra.send({ type: 'create' });
    await until(() => extra.ws.readyState >= 2);
    assert.equal((await pongControl(worker)).sessions, 24);
    for (let i = 0; i < 40; i++) await connectPong(worker, `198.51.100.${i + 1}`);
    assert.equal((await pongControl(worker)).sockets, 64);
    const response = await worker.dispatchFetch('https://pong.test/api/pong/ws', {
      headers: { Origin: 'https://takahirox.github.io', Upgrade: 'websocket', 'CF-Connecting-IP': '203.0.113.1' }
    });
    assert.equal(response.status, 429);
    const cleaned = await pongControl(worker, { now: future + 300_001, alarm: true });
    assert.equal(cleaned.sessions, 0); assert.equal(cleaned.sockets, 0); assert.equal(cleaned.alarm, null);
  } finally { await worker.dispose(); }
});

test('wrong SDP roles, duplicates, early readiness and invalid candidates are rejected before forwarding', async () => {
  const worker = createPongWorker();
  try {
    const cases = [
      ['guest', { type: 'offer', sdp }], ['host', { type: 'answer', sdp }],
      ['host', { type: 'offer', sdp: 'arbitrary game data' }], ['host', { type: 'ready' }],
      ['host', { type: 'candidate', candidate: 'x'.repeat(2049), sdpMid: null, sdpMLineIndex: null }],
      ['host', { type: 'candidate', candidate: '', sdpMid: '0', sdpMLineIndex: -1 }]
    ];
    for (const [seat, message] of cases) {
      const { host, invite } = await createMatch(worker), guest = await joinMatch(worker, invite);
      const sender = seat === 'host' ? host : guest, receiver = seat === 'host' ? guest : host;
      sender.send(message); await until(() => receiver.events.some(e => e.type === 'peer-left'));
      assert.ok(!receiver.events.some(e => e.type === message.type));
    }
    const { host, invite } = await createMatch(worker), guest = await joinMatch(worker, invite);
    host.send({ type: 'offer', sdp }); await until(() => guest.events.some(e => e.type === 'offer'));
    host.send({ type: 'offer', sdp }); await until(() => guest.events.some(e => e.type === 'peer-left'));
    assert.equal(guest.events.filter(e => e.type === 'offer').length, 1);
  } finally { await worker.dispose(); }
});

test('Pong walls, paddles, speed-limited inputs, scoring, first-to-five and immutable victory', () => {
  const s = newGame(); s.pause = 0;
  s.ball = [400, 8, 330, -110]; step(s, [225, 225], 1 / 120); assert.ok(s.ball[3] > 0);
  s.ball = [41, 225, -330, 0]; step(s, [225, 225], 1 / 120); assert.ok(s.ball[2] > 0);
  s.ball = [759, 225, 330, 0]; step(s, [225, 225], 1 / 120); assert.ok(s.ball[2] < 0);
  const old = s.paddles[1]; step(s, [225, 10000], 1 / 120); assert.ok(s.paddles[1] - old <= 3.51);
  assert.equal(clamp(-10), 42); assert.equal(clamp(10000), 408);
  for (let i = 1; i <= 5; i++) {
    s.pause = 0; s.ball = [809, 60, 330, 0];
    assert.equal(step(s, [225, 225], 1 / 120), i === 5 ? 'end' : 'score'); assert.deepEqual(s.scores, [i, 0]);
  }
  assert.equal(s.winner, 0); const before = structuredClone(s);
  assert.equal(step(s, [42, 42], 1 / 120), null); assert.deepEqual(s, before);
  const right = newGame(); right.pause = 0; right.ball = [-9, 60, -330, 0];
  step(right, [225, 225], 1 / 120); assert.deepEqual(right.scores, [0, 1]);
});

test('unreliable stale state cannot revert score/victory or overtake a reliable essential event', () => {
  const current = newGame(); current.tick = 100; current.revision = 1; current.scores = [1, 0];
  assert.equal(acceptState(current, { ...current, tick: 99 }, false), false);
  assert.equal(acceptState(current, { ...current, tick: 101 }, false), true);
  assert.equal(acceptState(current, { ...current, tick: 101, revision: 2 }, false), false);
  assert.equal(acceptState(current, { ...current, tick: 101, revision: 2 }, true), true);
  assert.equal(acceptState(current, { ...current, tick: 101, revision: 0 }, true), false);
  assert.equal(acceptState(current, { ...current, ball: [NaN, 0, 0, 0] }, true), false);
});
