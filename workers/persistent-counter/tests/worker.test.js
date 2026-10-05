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
