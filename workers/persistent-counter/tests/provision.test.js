import assert from 'node:assert/strict';
import test from 'node:test';
import { provision } from '../scripts/provision.js';
import { config } from './helpers.js';

const accountId = 'a'.repeat(32);
const token = 'test-only-token';
function mockApi(replies, calls) {
  return async (url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    calls.push({ path: new URL(url).pathname.split(`/accounts/${accountId}/`)[1],
      search: new URL(url).search, method: options.method, body: options.body && JSON.parse(options.body) });
    assert.ok(replies.length, 'Unexpected API call');
    const next = replies.shift();
    return Response.json(next.data ?? { success: true, result: next.result }, { status: next.status ?? 200 });
  };
}

test('existing database and subdomain are reused without writes or leaked credentials', async () => {
  const calls = [];
  const result = await provision({ accountId, token, config, fetchApi: mockApi([
    { result: { subdomain: 'existing' } },
    { result: [{ name: config.name, uuid: 'existing-id' }] }
  ], calls) });
  assert.ok(calls.every(call => call.method === 'GET'));
  assert.equal(result.config.d1_databases[0].database_id, 'existing-id');
  assert.deepEqual(result.config.durable_objects, config.durable_objects);
  assert.deepEqual(result.config.migrations, config.migrations);
  assert.equal(result.apiUrl, `https://${config.name}.existing.workers.dev`);
  assert.ok(!JSON.stringify(result).includes(token));
  assert.ok(!JSON.stringify(result).includes(accountId));
  assert.equal(config.d1_databases[0].database_id, undefined);
});

test('first deployment creates missing infrastructure and a subsequent deployment reuses it', async () => {
  const calls = [];
  const result = await provision({ accountId, token, config, fetchApi: mockApi([
    { status: 404, data: { success: false, errors: [{ code: 10007 }] } },
    { result: { subdomain: 'new-sandbox' } },
    { result: [{ name: `${config.name}-other`, uuid: 'wrong-id' }] },
    { result: { uuid: 'new-id' } }
  ], calls) });
  assert.deepEqual(calls.map(call => [call.path, call.method]), [
    ['workers/subdomain', 'GET'], ['workers/subdomain', 'PUT'],
    ['d1/database', 'GET'], ['d1/database', 'POST']
  ]);
  assert.match(calls[1].body.subdomain, /^sandbox-[a-f0-9]{16}$/);
  assert.deepEqual(calls[3].body, { name: config.name });
  assert.equal(result.config.d1_databases[0].database_id, 'new-id');
  const reuseCalls = [];
  await provision({ accountId, token, config, fetchApi: mockApi([
    { result: { subdomain: 'new-sandbox' } },
    { result: [{ name: config.name, uuid: 'new-id' }] }
  ], reuseCalls) });
  assert.ok(reuseCalls.every(call => call.method === 'GET'));
});

test('discovery searches all pages before creating a database', async () => {
  const calls = [];
  const result = await provision({ accountId, token, config, fetchApi: mockApi([
    { result: { subdomain: 'existing' } },
    { result: Array.from({ length: 100 }, (_, i) => ({ name: `other-${i}` })) },
    { result: [{ name: config.name, uuid: 'page-two-id' }] }
  ], calls) });
  assert.match(calls[2].search, /page=2/);
  assert.equal(result.config.d1_databases[0].database_id, 'page-two-id');
});

test('permission or service failures abort without provisioning or echoing response data', async () => {
  for (const status of [403, 429, 500]) {
    const calls = [];
    await assert.rejects(provision({ accountId, token, config, fetchApi: mockApi([
      { status, data: { success: false, errors: [{ code: 1000, message: token }] } }
    ], calls) }), error => error.message.includes(`HTTP ${status}`) && !error.message.includes(token));
    assert.equal(calls.length, 1);
  }
});
