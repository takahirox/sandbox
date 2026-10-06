import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { config, createWorker, createControlledWorker, control, migrate } from './helpers.js';

const origin = config.vars.ALLOWED_ORIGIN;
const request = (worker, path = '/api/counter', method = 'GET', headers = { Origin: origin }, body) =>
  worker.dispatchFetch(`https://counter.test${path}`, { method, headers, body });
const increment = (worker, clientId = crypto.randomUUID(), ip = '192.0.2.1') =>
  request(worker, `/api/counter/increment?clientId=${clientId}`, 'POST',
    { Origin: origin, 'CF-Connecting-IP': ip }, crypto.randomUUID());
const count = async worker => (await (await request(worker)).json()).value;
const checkpoint = async worker => (await (await worker.getD1Database('DB'))
  .prepare('SELECT value FROM counter WHERE id = 1').first()).value;
const future = Date.parse('2030-01-01T12:00:00Z');

async function subscribe(worker, clientId = crypto.randomUUID(), ip = '192.0.2.1') {
  const response = await request(worker, `/api/counter/ws?clientId=${clientId}`, 'GET',
    { Origin: origin, Upgrade: 'websocket', 'CF-Connecting-IP': ip });
  assert.equal(response.status, 101);
  const socket = response.webSocket;
  const events = [];
  socket.addEventListener('message', event => events.push(JSON.parse(event.data)));
  socket.accept();
  return { socket, events };
}
async function received(subscription, length) {
  const deadline = Date.now() + 5000;
  while (subscription.events.length < length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(subscription.events.length, length);
  return subscription.events;
}

function send(subscription) {
  const intentId = crypto.randomUUID();
  subscription.socket.send(JSON.stringify({ type: 'increment', intentId }));
  return intentId;
}

test('existing D1 data is imported once; acknowledged clicks, budget and pending checkpoint survive recreation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'counter-'));
  const options = { d1Persist: join(directory, 'd1'), durableObjectsPersist: join(directory, 'do') };
  let worker = createControlledWorker(options);
  try {
    await migrate(worker);
    const db = await worker.getD1Database('DB');
    await db.prepare('UPDATE counter SET value = 123 WHERE id = 1').run();
    await control(worker, { now: future });
    const client = crypto.randomUUID();
    const responses = await Promise.all(Array.from({ length: 12 }, () => increment(worker, client)));
    const results = await Promise.all(responses.map(r => r.json()));
    assert.deepEqual(results.map(r => r.value).sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => 124 + i));
    assert.ok(results.every(r => r.outcome === 'accepted'));
    assert.equal(await count(worker), 135);
    assert.equal(await checkpoint(worker), 123, 'D1 is outside the per-click hot path');
    const before = await control(worker);
    assert.equal(before.budget.used, 135);
    assert.equal(before.alarmAt, future + 5000);
    await worker.dispose();
    worker = createControlledWorker(options);
    assert.equal(await count(worker), 135);
    const restored = await control(worker);
    assert.equal(restored.budget.used, 135);
    assert.equal(restored.alarmAt, before.alarmAt);
    assert.equal(restored.rateBuckets, 0, 'Only soft burst allowance restarts; persisted budget is unchanged');
    for (let i = 0; i < 30; i++) assert.equal((await increment(worker, client)).status, 200);
    assert.equal((await increment(worker, client)).status, 429, 'Excessive traffic remains throttled after the fresh restart burst');
    const restartedDb = await worker.getD1Database('DB');
    await restartedDb.prepare('DROP TABLE counter').run();
    assert.equal(await count(worker), 165, 'Existing DO reads do not depend on D1 availability');
    assert.equal((await increment(worker)).status, 200, 'D1 failure cannot prevent a safe DO acknowledgement');
    const failed = await control(worker, { now: future + 5000, alarm: true });
    assert.equal(failed.checkpoint, 123);
    assert.equal(failed.checkpointFailures, 1);
    assert.equal(failed.alarmAt, future + 35_000);
    await migrate(worker);
    const flushed = await control(worker, { now: future + 35_000, alarm: true });
    assert.equal(await checkpoint(worker), 166);
    assert.equal(flushed.checkpointPending, false);
    assert.equal(flushed.alarmAt, null);
    assert.equal(flushed.rateBuckets, 0);
    await control(worker, { alarm: true });
    assert.equal(await checkpoint(worker), 166, 'Repeated alarm is safe');
    await worker.dispose();
    worker = createControlledWorker(options);
    assert.equal(await count(worker), 166);
    assert.equal((await control(worker)).budget.used, 166);
    await control(worker, { seed: { value: 166, used: 20_000, day: '2030-01-01' } });
    await request(worker); // Schedule the pushed midnight reset.
    await worker.dispose();
    worker = createControlledWorker(options);
    assert.equal((await control(worker)).budget.used, 20_000);
    assert.equal((await increment(worker)).status, 429, 'Recreation never resets an exhausted daily budget');
    await control(worker, { now: future + 86_400_000 });
    assert.equal((await increment(worker)).status, 200);
    assert.equal((await control(worker)).budget.used, 1);
  } finally {
    await worker.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('15 presses/sec remain usable, brief bursts are responsive, and excessive client traffic is rejected with retry timing', async () => {
  const worker = createControlledWorker();
  try {
    await migrate(worker);
    await control(worker, { now: future });
    const client = crypto.randomUUID();
    for (let i = 0; i < 75; i++) {
      await control(worker, { now: future + Math.ceil(i * 1000 / 15) });
      assert.equal((await increment(worker, client)).status, 200);
    }
    await control(worker, { now: future + 10_000 });
    const responses = await Promise.all(Array.from({ length: 100 }, () => increment(worker, client)));
    assert.equal(responses.filter(r => r.status === 200).length, 30);
    const rejected = responses.find(r => r.status === 429);
    assert.equal(rejected.headers.get('Retry-After'), '1');
    const result = await rejected.json();
    assert.equal(result.reason, 'client_rate_limit');
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.retryAfterMs, 67);
    await control(worker, { now: future + 10_067 });
    assert.equal((await increment(worker, client)).status, 200);
    assert.equal(await count(worker), 106);
  } finally { await worker.dispose(); }
});

test('IP limits allow ten rapid human clients behind one NAT but throttle continuously rotated IDs; different IPs remain independent', async () => {
  const worker = createControlledWorker();
  try {
    await migrate(worker);
    await control(worker, { now: future });
    const clients = Array.from({ length: 10 }, () => crypto.randomUUID());
    for (let i = 0; i < 45; i++) {
      await control(worker, { now: future + Math.ceil(i * 1000 / 15) });
      const responses = await Promise.all(clients.map(c => increment(worker, c)));
      assert.ok(responses.every(r => r.status === 200), '150/sec shared IP is usable');
    }
    await control(worker, { now: future + 10_000 });
    const responses = await Promise.all(Array.from({ length: 340 }, () => increment(worker)));
    assert.equal(responses.filter(r => r.status === 200).length, 300);
    const rejected = await responses.find(r => r.status === 429).json();
    assert.equal(rejected.reason, 'ip_rate_limit');
    assert.equal(rejected.retryAfterMs, 7);
    assert.equal((await increment(worker, crypto.randomUUID(), '192.0.2.2')).status, 200);
    assert.equal(await count(worker), 751);
  } finally { await worker.dispose(); }
});

test('concurrent HTTP and socket intents stop exactly at 20,000; reads/subscriptions stay live and midnight resets budget with a push', async () => {
  const worker = createControlledWorker();
  const subscriptions = [];
  try {
    await migrate(worker);
    await control(worker, { now: future,
      seed: { value: 50_000, day: '2030-01-01', used: 19_990 } });
    const first = await subscribe(worker);
    const other = await subscribe(worker);
    subscriptions.push(first, other);
    await Promise.all([received(first, 1), received(other, 1)]);
    const ids = Array.from({ length: 20 }, () => send(first));
    const responses = await Promise.all(Array.from({ length: 20 }, () => increment(worker)));
    const httpResults = await Promise.all(responses.map(r => r.json()));
    await received(first, 21 + httpResults.filter(r => r.outcome === 'accepted').length);
    const socketResults = first.events.filter(e => ids.includes(e.intentId));
    assert.equal([...socketResults, ...httpResults].filter(e => e.outcome === 'accepted').length, 10);
    assert.equal([...socketResults, ...httpResults].filter(e => e.outcome === 'rejected').length, 30);
    assert.ok(socketResults.every(e => ids.includes(e.intentId)));
    assert.equal(await count(worker), 50_010);
    const exhausted = await (await request(worker)).json();
    assert.equal(exhausted.budget.used, 20_000);
    const fresh = await subscribe(worker);
    subscriptions.push(fresh);
    await received(fresh, 1);
    assert.equal(fresh.events[0].budget.used, 20_000);
    const rejected = await (await increment(worker)).json();
    assert.equal(rejected.reason, 'daily_limit');
    assert.equal(rejected.retryAfterMs, 43_200_000);
    await control(worker, { now: future + 5000, alarm: true });
    assert.equal((await control(worker)).alarmAt, Date.parse('2030-01-02T00:00:00Z'));
    const next = await control(worker, { now: Date.parse('2030-01-02T00:00:00Z'), alarm: true });
    assert.equal(next.budget.used, 0);
    assert.equal(next.budget.day, '2030-01-02');
    assert.equal(next.alarmAt, null);
    await received(fresh, 3);
    assert.equal(fresh.events.at(-1).budget.used, 0, 'Disabled subscribed pages get a midnight reset without polling');
    assert.equal((await increment(worker)).status, 200);
    assert.equal(await count(worker), 50_011);
  } finally {
    subscriptions.forEach(s => s.socket.close());
    await worker.dispose();
  }
});

for (const trigger of ['read', 'subscription']) {
  test(`${trigger} before the midnight alarm pushes the persisted daily reset to existing subscribers`, async () => {
    const worker = createControlledWorker();
    const subscriptions = [];
    const midnight = Date.parse('2030-01-02T00:00:00Z');
    try {
      await migrate(worker);
      const db = await worker.getD1Database('DB');
      await db.prepare('UPDATE counter SET value = 50000 WHERE id = 1').run();
      await control(worker, { now: future,
        seed: { value: 50_000, day: '2030-01-01', used: 20_000 } });
      const existing = await subscribe(worker);
      subscriptions.push(existing);
      await received(existing, 1);
      assert.equal(existing.events[0].budget.used, 20_000);
      assert.equal((await control(worker)).alarmAt, midnight);

      const before = await control(worker, { now: midnight });
      assert.equal(before.state.used, 20_000, 'Advancing the clock does not run the reset or alarm');
      let snapshot;
      if (trigger === 'read') {
        const response = await request(worker);
        assert.equal(response.status, 200);
        snapshot = await response.json();
      } else {
        const fresh = await subscribe(worker);
        subscriptions.push(fresh);
        await received(fresh, 1);
        snapshot = fresh.events[0];
      }
      assert.equal(snapshot.budget.day, '2030-01-02');
      assert.equal(snapshot.budget.used, 0);
      await received(existing, 2);
      assert.deepEqual(existing.events[1], snapshot, 'Existing pages unlock without polling or an alarm');
      const reset = await control(worker);
      assert.equal(reset.state.day, '2030-01-02');
      assert.equal(reset.state.used, 0);
      assert.equal(reset.alarmAt, null);
      assert.equal(reset.checkpointPending, false);

      await request(worker);
      assert.equal(existing.events.length, 2, 'Same-day reads do not broadcast another reset');
      assert.equal((await increment(worker)).status, 200);
      await received(existing, 3);
      assert.equal(existing.events[2].budget.used, 1);
      assert.equal(existing.events[2].value, 50_001);
    } finally {
      subscriptions.forEach(s => s.socket.close());
      await worker.dispose();
    }
  });
}

test('D1 batches 100 clicks, absolute checkpoints are idempotent, and every acceptance broadcasts immediately', async () => {
  const worker = createControlledWorker();
  const subscriptions = [];
  try {
    await migrate(worker);
    const db = await worker.getD1Database('DB');
    await db.prepare('CREATE TABLE checkpoint_writes (value INTEGER)').run();
    await db.prepare('CREATE TRIGGER track_checkpoint AFTER UPDATE ON counter BEGIN INSERT INTO checkpoint_writes VALUES (NEW.value); END').run();
    await control(worker, { now: future });
    const first = await subscribe(worker);
    const second = await subscribe(worker);
    subscriptions.push(first, second);
    await Promise.all([received(first, 1), received(second, 1)]);
    const writesBefore = (await control(worker)).persistedRowsWritten;
    for (let i = 0; i < 100; i++) assert.equal((await increment(worker)).status, 200);
    assert.equal((await control(worker)).persistedRowsWritten - writesBefore, 100,
      'One authoritative DO row write per acceptance; short-lived rate buckets add no writes');
    await Promise.all([received(first, 101), received(second, 101)]);
    assert.deepEqual(first.events.map(e => e.value), Array.from({ length: 101 }, (_, i) => i));
    assert.deepEqual(first.events, second.events);
    assert.equal(await checkpoint(worker), 0);
    assert.equal((await control(worker)).alarmAt, future, 'Threshold advances the scheduled flush');
    await control(worker, { alarm: true });
    assert.equal(await checkpoint(worker), 100);
    for (let i = 0; i < 10; i++) await increment(worker);
    const pending = await control(worker);
    assert.equal(pending.checkpointPending, true);
    assert.equal(pending.alarmAt, future + 5000);
    await control(worker, { now: future + 5000, alarm: true });
    assert.equal(await checkpoint(worker), 110);
    await control(worker, { alarm: true });
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM checkpoint_writes').first()).count, 2,
      'Two D1 writes for 110 accepted clicks, including a quiet tail');
    // Simulate a crash after D1 success, before the DO records checkpoint completion.
    await control(worker, { seed: { value: 110, day: '2030-01-01', used: 110, checkpoint: 100, flushAt: future } });
    await control(worker, { alarm: true });
    assert.equal(await checkpoint(worker), 110);
    assert.equal((await control(worker)).checkpointPending, false);
  } finally {
    subscriptions.forEach(s => s.socket.close());
    await worker.dispose();
  }
});

test('real alarm eventually checkpoints with no readers or connected clients', { timeout: 15_000 }, async () => {
  const worker = createWorker();
  try {
    await migrate(worker);
    assert.equal((await increment(worker)).status, 200);
    assert.equal(await checkpoint(worker), 0);
    const deadline = Date.now() + 10_000;
    while (await checkpoint(worker) !== 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await checkpoint(worker), 1);
  } finally { await worker.dispose(); }
});

test('valid socket intents use connection identity; rejections are private; invalid messages never write', async () => {
  const worker = createControlledWorker();
  const subscriptions = [];
  try {
    await migrate(worker);
    await control(worker, { now: future });
    const client = crypto.randomUUID();
    const first = await subscribe(worker, client);
    const listener = await subscribe(worker);
    subscriptions.push(first, listener);
    await Promise.all([received(first, 1), received(listener, 1)]);
    const ids = Array.from({ length: 31 }, () => send(first));
    await received(first, 32);
    await received(listener, 31);
    assert.equal(first.events.at(-1).outcome, 'rejected');
    assert.equal(first.events.at(-1).intentId, ids[30]);
    assert.equal(first.events.at(-1).reason, 'client_rate_limit');
    assert.equal(await count(worker), 30);
    // A second connection with the same client identity shares its primary bucket.
    const same = await subscribe(worker, client, '192.0.2.2');
    subscriptions.push(same);
    await received(same, 1);
    send(same);
    await received(same, 2);
    assert.equal(same.events.at(-1).reason, 'client_rate_limit');
    const closed = new Promise(resolve => first.socket.addEventListener('close', resolve, { once: true }));
    first.socket.send(JSON.stringify({ type: 'increment', intentId: 'invalid', clientId: crypto.randomUUID() }));
    assert.equal((await closed).code, 1008);
    assert.equal(await count(worker), 30);
    await increment(worker);
    await received(listener, 32);
    assert.equal(listener.events.at(-1).value, 31, 'Closed listeners do not block other broadcasts');
    for (const body of ['not-an-intent', '{}', 'a'.repeat(100)]) {
      assert.equal((await request(worker, '/api/counter/increment', 'POST', { Origin: origin }, body)).status, 400);
    }
    assert.equal((await request(worker, '/api/counter/ws?clientId=invalid', 'GET', { Origin: origin, Upgrade: 'websocket' })).status, 400);
    assert.equal(await count(worker), 31);
  } finally {
    subscriptions.forEach(s => { if (s.socket.readyState === 1) s.socket.close(); });
    await worker.dispose();
  }
});

test('legacy HTTP intents use the same protection and cannot bypass limits by rotating intent UUIDs', async () => {
  const worker = createControlledWorker();
  try {
    await migrate(worker);
    await control(worker, { now: future });
    for (let i = 0; i < 30; i++) {
      const result = await request(worker, '/api/counter/increment', 'POST', { Origin: origin },
        i % 2 ? crypto.randomUUID() : undefined);
      assert.equal(result.status, 200);
    }
    assert.equal((await request(worker, '/api/counter/increment', 'POST')).status, 429);
    assert.equal(await count(worker), 30);
  } finally { await worker.dispose(); }
});

test('CORS, methods and WebSocket upgrades remain narrow; rejected requests cannot mutate', async () => {
  const worker = createWorker();
  try {
    await migrate(worker);
    const read = await request(worker);
    assert.equal(read.headers.get('Cache-Control'), 'no-store');
    assert.equal(read.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(read.headers.get('Vary'), 'Origin');
    assert.equal(read.headers.get('Access-Control-Allow-Credentials'), null);
    assert.equal((await request(worker, '/api/counter', 'GET', {})).status, 200);
    const preflight = await request(worker, '/api/counter/increment', 'OPTIONS', {
      Origin: origin, 'Access-Control-Request-Method': 'POST'
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'POST');
    for (const headers of [{ Origin: 'https://example.com' }, { Origin: 'null' }, {}]) {
      assert.equal((await request(worker, '/api/counter/increment', 'POST', headers)).status, 403);
      assert.equal((await request(worker, '/api/counter/ws', 'GET', { ...headers, Upgrade: 'websocket' })).status, 403);
    }
    for (const headers of [
      { Origin: origin, 'Access-Control-Request-Method': 'DELETE' },
      { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-custom' }
    ]) assert.equal((await request(worker, '/api/counter/increment', 'OPTIONS', headers)).status, 403);
    assert.equal((await request(worker, '/api/counter/increment', 'GET')).status, 405);
    assert.equal((await request(worker, '/api/counter', 'POST')).status, 405);
    assert.equal((await request(worker, '/api/counter/ws', 'POST')).status, 405);
    assert.equal((await request(worker, '/api/counter/ws')).status, 426);
    assert.equal((await request(worker, '/missing')).status, 404);
    assert.equal(await count(worker), 0);
  } finally { await worker.dispose(); }
});

test('missing initial schema returns a useful error without exposing database details', async () => {
  const worker = createWorker();
  try {
    assert.deepEqual(await (await request(worker)).json(), { error: 'Counter unavailable' });
    const response = await request(worker, '/api/counter/ws', 'GET', { Origin: origin, Upgrade: 'websocket' });
    assert.equal(response.status, 503);
    assert.equal(response.webSocket, null);
    await migrate(worker);
    assert.equal(await count(worker), 0);
  } finally { await worker.dispose(); }
});
