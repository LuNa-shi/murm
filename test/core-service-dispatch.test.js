import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServiceRegistry } from '../src/core/services.js';
import { notesManifest, setup } from './fixtures/core-notes-service.js';

test('authorized Bridge calls store and read a note with only trusted selected Service identity', async t => {
  let note;
  const callers = [];
  const { call } = await setup(t, { invoke(request) { callers.push(request.caller); if (request.capability.operation === 'put') note = { ...request.input, author: request.caller.botId }; return note ?? null; } });
  assert.deepEqual((await call('put', { key: 'one', text: 'fixed' }, { caller: { botId: 'forged' }, envelope: { caller: {}, operation_id: 'forged' } })).result, { key: 'one', text: 'fixed', author: 'bot-one' });
  assert.deepEqual((await call('get', { key: 'one' })).result, note);
  assert.deepEqual(callers, Array(2).fill({ runtimeId: 'run-one', botId: 'bot-one', profile: 'writer', binding: 'notes-account' }));
});

test('schemas reject invalid input before effects and report bad output without repeating a write', async t => {
  let writes = 0;
  const { call } = await setup(t, { invoke() { writes++; return { wrong: true }; } });
  for (const input of [{}, { key: 1, text: 'ok' }, { key: 'one', text: 'ok', author: 'forged' }, { key: 'one', text: 'x'.repeat(33) }]) {
    const result = await call('put', input);
    assert.equal(result.error.code, 'SERVICE_INPUT_INVALID');
    assert.equal(result.error.details.operation_id, 'fixed-request');
  }
  assert.equal(writes, 0);
  const result = await call('put', { key: 'one', text: 'fixed' });
  assert.equal(result.error.code, 'SERVICE_OUTPUT_INVALID');
  assert.equal(result.error.details.operation_id, 'fixed-request');
  assert.equal(result.error.details.request_outcome, 'unknown');
  assert.equal(writes, 1);
});

test('discovery filters operation permissions and closing, unknown and foreign tokens have no effects', async t => {
  let calls = 0;
  const { bot, bridge, call } = await setup(t, { invoke() { calls++; return null; } });
  bot.services.notes = ['get'];
  const discovered = await call('get_service_metadata', { service: 'notes' }, { service_id: undefined });
  assert.deepEqual(discovered.result.capabilities.map(capability => capability.operation), ['get']);
  assert.equal((await call('put', { key: 'one', text: 'fixed' })).error.code, 'NOT_ALLOWED');
  const foreign = await setup(t, { invoke() { return null; } });
  const response = await fetch(bridge.publicUrl + '/call', { method: 'POST', headers: { authorization: 'Bearer ' + foreign.credentials.secretEnvironment.SWARMENV_BRIDGE_TOKEN }, body: '{}' });
  assert.equal(response.status, 403);
  for (const status of ['starting', 'exited', 'closing', 'closed']) {
    bot.status = status;
    assert.equal((await call('get', { key: 'one' })).error.code, 'NOT_ALLOWED');
  }
  assert.equal(calls, 0);
});

test('timeout and unavailable errors preserve operation identity and never automatically repeat', async t => {
  let calls = 0;
  const { call } = await setup(t, { invoke() { calls++; return new Promise(() => {}); } }, { bridge: { serviceTimeoutMs: 20 } });
  const result = await call('put', { key: 'one', text: 'fixed' });
  assert.equal(result.error.code, 'SERVICE_TIMEOUT');
  assert.equal(result.error.details.operation_id, 'fixed-request');
  assert.equal(calls, 1);
  const failed = await setup(t, { invoke() { throw new Error('private upstream error'); } });
  assert.equal((await failed.call('get', { key: 'one' })).error.code, 'SERVICE_UNAVAILABLE');
});

test('v1, malformed identities, unsupported schemas and asynchronous validation reject at registration', () => {
  for (const change of [m => { m.contract_version = '1'; }, m => { delete m.id; }, m => { delete m.capabilities[0].name; }, m => { delete m.capabilities[0].operation; },
    m => { m.capabilities[0].input_schema = { type: 'object', misspelled: true }; },
    m => { m.capabilities[0].input_schema = { $ref: 'https://untrusted.invalid/schema' }; },
    m => { m.capabilities[0].input_schema.$async = true; }]) {
    const manifest = notesManifest(); change(manifest);
    assert.throws(() => new ServiceRegistry().registerService({ manifest, adapter: { invoke() {} } }), { code: 'INVALID_CONTRACT' });
  }
});
