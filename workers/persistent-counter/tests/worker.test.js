import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { config, createWorker, migrate } from './helpers.js';

const origin = config.vars.ALLOWED_ORIGIN;
const request = (worker, path = '/api/counter', method = 'GET', headers = { Origin: origin }) =>
  worker.dispatchFetch(`https://counter.test${path}`, { method, headers });

test('migration, atomic increments, reload, and restart preserve one shared counter', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'counter-'));
  let worker = createWorker({ d1Persist: directory });
  try {
    await migrate(worker);
    const initial = await request(worker);
    assert.equal(initial.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await initial.json(), { value: 0 });
    const responses = await Promise.all(Array.from({ length: 12 }, () =>
      request(worker, '/api/counter/increment', 'POST')));
    const values = await Promise.all(responses.map(response => response.json()));
    assert.deepEqual(values.map(result => result.value).sort((a, b) => a - b),
      Array.from({ length: 12 }, (_, i) => i + 1));
    assert.deepEqual(await (await request(worker)).json(), { value: 12 });
    await worker.dispose();
    worker = createWorker({ d1Persist: directory });
    assert.deepEqual(await (await request(worker)).json(), { value: 12 });
  } finally {
    await worker.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('CORS permits only the published origin and endpoint methods; blocked writes do not change D1', async () => {
  const worker = createWorker();
  try {
    await migrate(worker);
    const read = await request(worker);
    assert.equal(read.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(read.headers.get('Vary'), 'Origin');
    assert.equal(read.headers.get('Access-Control-Allow-Credentials'), null);
    const preflight = await request(worker, '/api/counter/increment', 'OPTIONS', {
      Origin: origin, 'Access-Control-Request-Method': 'POST'
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'POST');
    for (const headers of [{ Origin: 'https://example.com' }, { Origin: 'null' }, {}]) {
      const response = await request(worker, '/api/counter/increment', 'POST', headers);
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    }
    const blockedPreflight = await request(worker, '/api/counter/increment', 'OPTIONS', {
      Origin: origin, 'Access-Control-Request-Method': 'DELETE'
    });
    assert.equal(blockedPreflight.status, 403);
    const blockedHeaders = await request(worker, '/api/counter/increment', 'OPTIONS', {
      Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-custom'
    });
    assert.equal(blockedHeaders.status, 403);
    assert.equal((await request(worker, '/api/counter/increment', 'GET')).status, 405);
    assert.equal((await request(worker, '/api/counter', 'POST')).status, 405);
    assert.equal((await request(worker, '/missing')).status, 404);
    assert.deepEqual(await (await request(worker)).json(), { value: 0 });
  } finally {
    await worker.dispose();
  }
});

test('missing schema returns a useful error without exposing database details', async () => {
  const worker = createWorker();
  try {
    const response = await request(worker);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Counter unavailable' });
  } finally {
    await worker.dispose();
  }
});

async function subscribe(worker) {
  const response = await request(worker, '/api/counter/ws', 'GET', { Origin: origin, Upgrade: 'websocket' });
  assert.equal(response.status, 101);
  const socket = response.webSocket;
  const messages = [];
  socket.addEventListener('message', event => messages.push(JSON.parse(event.data).value));
  socket.accept();
  return { socket, messages };
}

async function received(subscription, length) {
  const deadline = Date.now() + 5000;
  while (subscription.messages.length < length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(subscription.messages.length, length);
  return subscription.messages;
}

test('Hibernation API subscriptions receive ordered committed values, reconnect snapshots, and persisted state after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'counter-realtime-'));
  let worker = createWorker({ d1Persist: directory });
  const subscriptions = [];
  try {
    await migrate(worker);
    const first = await subscribe(worker);
    const second = await subscribe(worker);
    subscriptions.push(first, second);
    assert.deepEqual(await received(first, 1), [0]);
    assert.deepEqual(await received(second, 1), [0]);
    const responses = await Promise.all(Array.from({ length: 20 }, () =>
      request(worker, '/api/counter/increment', 'POST')));
    assert.ok(responses.every(response => response.status === 200));
    const expected = Array.from({ length: 21 }, (_, i) => i);
    assert.deepEqual(await received(first, 21), expected);
    assert.deepEqual(await received(second, 21), expected);
    first.socket.close();
    await request(worker, '/api/counter/increment', 'POST');
    assert.equal((await received(second, 22)).at(-1), 21);
    const reconnected = await subscribe(worker);
    subscriptions.push(reconnected);
    assert.deepEqual(await received(reconnected, 1), [21]);
    const db = await worker.getD1Database('DB');
    assert.deepEqual(await db.prepare('SELECT value FROM counter WHERE id = 1').first(), { value: 21 });
    for (const { socket } of subscriptions) {
      if (socket.readyState === 1) socket.close();
    }
    await worker.dispose();
    // Reinitializes the Worker and object with only the existing D1 directory:
    // no cached value or Durable Object storage is needed to recover the state.
    worker = createWorker({ d1Persist: directory });
    const restored = await subscribe(worker);
    subscriptions.push(restored);
    assert.deepEqual(await received(restored, 1), [21]);
    await request(worker, '/api/counter/increment', 'POST');
    assert.deepEqual(await received(restored, 2), [21, 22]);
  } finally {
    for (const { socket } of subscriptions) {
      if (socket.readyState === 1) socket.close();
    }
    await worker.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('WebSocket upgrade and origin checks reject invalid subscriptions; missing D1 cannot report healthy state', async () => {
  const worker = createWorker();
  try {
    assert.equal((await request(worker, '/api/counter/ws')).status, 426);
    assert.equal((await request(worker, '/api/counter/ws', 'POST')).status, 405);
    for (const headers of [{ Upgrade: 'websocket' }, { Upgrade: 'websocket', Origin: 'https://example.com' }]) {
      assert.equal((await request(worker, '/api/counter/ws', 'GET', headers)).status, 403);
    }
    const response = await request(worker, '/api/counter/ws', 'GET', { Upgrade: 'websocket', Origin: origin });
    assert.equal(response.status, 503);
    assert.equal(response.webSocket, null);
    assert.deepEqual(await response.json(), { error: 'Counter unavailable' });
  } finally {
    await worker.dispose();
  }
});

test('socket messages cannot mutate the counter and a closed listener does not block broadcasts', async () => {
  const worker = createWorker();
  try {
    await migrate(worker);
    const invalid = await subscribe(worker);
    const listener = await subscribe(worker);
    await received(invalid, 1);
    await received(listener, 1);
    const closed = new Promise(resolve => invalid.socket.addEventListener('close', resolve, { once: true }));
    invalid.socket.send(JSON.stringify({ type: 'increment' }));
    assert.equal((await closed).code, 1008);
    assert.deepEqual(await (await request(worker)).json(), { value: 0 });
    await request(worker, '/api/counter/increment', 'POST');
    assert.deepEqual(await received(listener, 2), [0, 1]);
    listener.socket.close();
  } finally {
    await worker.dispose();
  }
});
