import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServiceRegistry } from '../src/core/services.js';
import { notesManifest, setup } from './fixtures/core-notes-service.js';

test('authorized Bridge calls store and read a note with only trusted selected Service identity', async t => {
  let note;
  const callers = [];
  const { call } = await setup(t, { invoke(request) { callers.push(request.caller); if (request.capability.operation === 'put') note = { ...request.input, author: request.caller.agentId }; return note ?? null; } });
  assert.deepEqual((await call('put', { key: 'one', text: 'fixed' }, { caller: { agentId: 'forged' }, envelope: { caller: {}, operation_id: 'forged' } })).result, { key: 'one', text: 'fixed', author: 'agent-one' });
  assert.deepEqual((await call('get', { key: 'one' })).result, note);
  assert.deepEqual(callers, Array(2).fill({ runtimeId: 'run-one', agentId: 'agent-one', profile: 'writer', binding: 'notes-account' }));
});

test('schemas reject invalid input before effects and report bad output without repeating a write', async t => {
  let writes = 0;
  const { call } = await setup(t, { invoke() { writes++; return { wrong: true }; } });
  for (const input of [{}, { key: 1, text: 'ok' }, { key: 'one', text: 'ok', author: 'forged' }, { key: 'one', text: 'x'.repeat(33) }]) {
    const result = await call('put', input);
    assert.equal(result.error.code, 'SERVICE_INPUT_INVALID');
    assert.equal(result.error.details.operation_id, 'fixed-request');
  }
  const invalid = await call('put', { key: { private: 'never-echo-this' }, text: 'ok' });
  assert.deepEqual(invalid.error.details.validation, [
    { pointer: '/key', expected: 'string', actual: 'object' },
  ]);
  assert.equal(invalid.error.details.request_outcome, 'not_executed');
  assert.ok(!JSON.stringify(invalid.error).includes('never-echo-this'));
  assert.equal(writes, 0);
  const result = await call('put', { key: 'one', text: 'fixed' });
  assert.equal(result.error.code, 'SERVICE_OUTPUT_INVALID');
  assert.equal(result.error.details.operation_id, 'fixed-request');
  assert.equal(result.error.details.request_outcome, 'unknown');
  assert.equal(writes, 1);
});

test('discovery filters operation permissions and closing, unknown and foreign tokens have no effects', async t => {
  let calls = 0;
  const { agent, bridge, call } = await setup(t, { invoke() { calls++; return null; } });
  agent.services.notes = ['get'];
  const discovered = await call('get_service_metadata', { service: 'notes' }, { service_id: undefined });
  assert.deepEqual(discovered.result.capabilities.map(capability => capability.operation), ['get']);
  assert.equal((await call('put', { key: 'one', text: 'fixed' })).error.code, 'NOT_ALLOWED');
  const foreign = await setup(t, { invoke() { return null; } });
  const response = await fetch(bridge.publicUrl + '/call', { method: 'POST', headers: { authorization: 'Bearer ' + foreign.credentials.secretEnvironment.MURM_BRIDGE_TOKEN }, body: '{}' });
  assert.equal(response.status, 403);
  for (const status of ['starting', 'exited', 'closing', 'closed']) {
    agent.status = status;
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

test('Notes owns same-key business idempotency and conflicts while Registry performs one invocation per explicit call', async t => {
  const { createNotesService } = await import('./fixtures/core-notes-service.js');
  const notes = createNotesService();
  const { call } = await setup(t, notes.adapter);
  const input = { key: 'one', text: 'fixed' };
  assert.deepEqual((await call('put', input)).result, (await call('put', input)).result);
  assert.equal(notes.writes, 1);
  assert.equal(notes.calls.length, 2);
  assert.equal((await call('put', { ...input, text: 'changed' })).error.code, 'CONFLICT');
  assert.equal(notes.writes, 1);
});

test('Service names that match Object prototype keys never create implicit Profile permissions', async t => {
  let calls = 0;
  const { agent, call } = await setup(t, { invoke() { calls++; return null; } }, { manifest: notesManifest('constructor') });
  agent.services = {};
  assert.deepEqual((await call('list_services', {}, { service_id: undefined })).result, { services: [] });
  assert.equal((await call('get', { key: 'one' }, { service_id: 'constructor' })).error.code, 'NOT_ALLOWED');
  assert.equal(calls, 0);
});

test('explicit null is validated as supplied, while an omitted payload defaults to an object', async t => {
  let calls = 0;
  const objectManifest = notesManifest();
  objectManifest.capabilities[1].input_schema = { type: 'object', properties: {}, additionalProperties: false };
  const object = await setup(t, { invoke() { calls++; return null; } }, { manifest: objectManifest });
  assert.equal((await object.call('get', null)).error.code, 'SERVICE_INPUT_INVALID');
  assert.equal(calls, 0);
  const manifest = notesManifest();
  manifest.capabilities[1].input_schema = { type: 'null' };
  const nullable = await setup(t, { invoke({ input }) { assert.equal(input, null); calls++; return null; } }, { manifest });
  assert.equal((await nullable.call('get', null)).ok, true);
  assert.equal((await nullable.call('get', undefined)).error.code, 'SERVICE_INPUT_INVALID');
  assert.equal(calls, 1);
});

test('an authorized Service named constructor receives no inherited binding', async t => {
  let caller;
  const { agent, call } = await setup(t, { invoke(request) { caller = request.caller; return null; } }, { manifest: notesManifest('constructor') });
  agent.services = { constructor: ['get'] };
  agent.bindings = {};
  assert.equal((await call('get', { key: 'one' }, { service_id: 'constructor' })).ok, true);
  assert.deepEqual(caller, { runtimeId: 'run-one', agentId: 'agent-one', profile: 'writer' });
});

test('installed swarm help describes an authorized operation and its executable input forms', async t => {
  let writes = 0;
  const { credentials } = await setup(t, { invoke({ input }) { writes++; return { ...input, author: 'agent-one' }; } });
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execute = promisify(execFile);
  const env = { ...process.env, ...credentials.environment, ...credentials.secretEnvironment };
  const args = ['dist/scripts/swarm.js', 'service', 'invoke', 'notes', 'put'];
  const { stdout } = await execute(process.execPath, [...args, '--help'], { env });
  assert.match(stdout, /--key .*string.*required/);
  assert.match(stdout, /swarm service invoke notes put .*--key=/);
  assert.match(stdout, /swarm service invoke notes put --stdin/);
  await assert.rejects(execute(process.execPath, [...args, '--key=123', '--text=private-value'], { env }), error => {
    assert.equal(error.code, 2);
    const diagnostic = JSON.parse(error.stderr);
    assert.equal(diagnostic.code, 'SERVICE_INPUT_INVALID');
    assert.equal(diagnostic.details.request_outcome, 'not_executed');
    assert.deepEqual(diagnostic.details.validation, [{ pointer: '/key', expected: 'string', actual: 'number' }]);
    assert.ok(!error.stderr.includes('private-value'));
    return true;
  });
  assert.equal(writes, 0);
  const result = await execute(process.execPath, [...args, '--key=key', '--text=text'], { env });
  assert.deepEqual(JSON.parse(result.stdout), { key: 'key', text: 'text', author: 'agent-one' });
  assert.equal(writes, 1);
});
