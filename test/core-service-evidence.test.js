import assert from 'node:assert/strict';
import test from 'node:test';
import { setup } from './fixtures/core-notes-service.js';

test('revocation before scheduled adapter entry prevents a late write and retains unknown identity', async t => {
  let writes = 0;
  let entrySignal;
  let fixture;
  const rows = [];
  fixture = await setup(t, { invoke({ signal, input, caller }) {
    entrySignal = signal;
    writes++;
    return { ...input, author: caller.botId };
  } }, { bridge: { recordService(row) {
    rows.push(row);
    if (row.state === 'invocation') queueMicrotask(() => fixture.bridge.revokeBot('bot-one'));
  } } });
  const failure = await fixture.call('put', { key: 'one', text: 'fixed' });
  assert.equal(failure.error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(failure.error.details.request_outcome, 'unknown');
  assert.equal(failure.error.details.operation_id, 'fixed-request');
  assert.equal(writes, 0, `Adapter entered after revoke with signal.aborted=${entrySignal?.aborted}`);
  assert.equal(rows.at(-1).outcome, 'unknown');
  assert.equal(rows.some(row => row.outcome === 'succeeded'), false);
});

function identity(row) {
  const { runtimeId, botId, profile, serviceId, operation, operationId } = row;
  return { runtimeId, botId, profile, serviceId, operation, operationId };
}

test('Service evidence indexes actual validation and invocation with trusted identity and no raw body or binding', async t => {
  const records = [];
  const { call } = await setup(t, { invoke({ input, caller }) { return { ...input, author: caller.botId }; } }, { bridge: { recordService: row => records.push(row) } });
  assert.equal((await call('put', { key: 'one', text: 'private-marker' }, { caller: { botId: 'forged' } })).ok, true);
  assert.deepEqual(records.map(row => [row.state, row.outcome]), [['validation', 'pending'], ['validation', 'passed'], ['invocation', 'pending'], ['settled', 'succeeded']]);
  for (const row of records) assert.deepEqual(identity(row), { runtimeId: 'run-one', botId: 'bot-one', profile: 'writer', serviceId: 'notes', operation: 'put', operationId: 'fixed-request' });
  assert.equal(JSON.stringify(records).includes('private-marker'), false);
  assert.equal(JSON.stringify(records).includes('notes-account'), false);
  assert.equal(JSON.stringify(records).includes('forged'), false);
});

test('input rejection and Profile denial produce no invocation row or business effect', async t => {
  const rows = []; let calls = 0;
  const { call, bot } = await setup(t, { invoke() { calls++; return null; } }, { bridge: { recordService: row => rows.push(row) } });
  assert.equal((await call('put', {})).error.code, 'SERVICE_INPUT_INVALID');
  assert.deepEqual(rows.map(row => [row.state, row.outcome]), [['validation', 'pending'], ['validation', 'not_executed']]);
  rows.length = 0; bot.services.notes = ['get'];
  assert.equal((await call('put', { key: 'one', text: 'fixed' })).error.code, 'NOT_ALLOWED');
  assert.equal(rows.length, 1); assert.equal(rows[0].outcome, 'not_executed'); assert.equal(rows[0].error.code, 'NOT_ALLOWED');
  assert.equal(calls, 0);
});

test('write output violation and lost reply retain unknown operation identity and never repeat writes', async t => {
  const rows = []; let writes = 0;
  const { call } = await setup(t, { invoke() { writes++; return { invalid: 'private-secret' }; } }, { bridge: { recordService: row => rows.push(row) } });
  assert.equal((await call('put', { key: 'one', text: 'fixed' })).error.code, 'SERVICE_OUTPUT_INVALID');
  assert.equal(writes, 1);
  assert.deepEqual(rows.at(-1), { runtimeId: 'run-one', botId: 'bot-one', profile: 'writer', serviceId: 'notes', operation: 'put', operationId: 'fixed-request', state: 'settled', outcome: 'unknown', error: { code: 'SERVICE_OUTPUT_INVALID', retryable: false } });
  assert.equal(JSON.stringify(rows).includes('private-secret'), false);
  const lost = [];
  const held = await setup(t, { invoke() { writes++; return new Promise(() => {}); } }, { bridge: { serviceTimeoutMs: 10, recordService: row => lost.push(row) } });
  assert.equal((await held.call('put', { key: 'one', text: 'fixed' })).error.code, 'SERVICE_TIMEOUT');
  assert.equal(lost.at(-1).outcome, 'unknown'); assert.equal(lost.at(-1).operationId, 'fixed-request'); assert.equal(writes, 2);
});

test('lost HTTP receipt preserves the same operation identity even when the write later returns', { timeout: 2000 }, async t => {
  let began, release;
  const started = new Promise(resolve => { began = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const rows = []; let writes = 0;
  let unknownRecorded, settledRecorded;
  const unknown = new Promise(resolve => { unknownRecorded = resolve; });
  const complete = new Promise(resolve => { settledRecorded = resolve; });
  const { bridge, credentials } = await setup(t, { async invoke({ input, caller }) { writes++; began(); await held; return { ...input, author: caller.botId }; } }, { bridge: { recordService: row => { rows.push(row); if (row.state === 'response') unknownRecorded(); if (row.state === 'settled') settledRecorded(); } } });
  const abort = new AbortController();
  const response = fetch(bridge.publicUrl + '/call', { method: 'POST', signal: abort.signal, headers: { authorization: `Bearer ${credentials.secretEnvironment.SWARMENV_BRIDGE_TOKEN}` },
    body: JSON.stringify({ service_id: 'notes', operation: 'put', operation_id: 'lost-receipt', payload: { key: 'one', text: 'fixed' } }) });
  await started; abort.abort(); await assert.rejects(response);
  await unknown;
  release(); await complete;
  assert.equal(writes, 1);
  assert.ok(rows.some(row => row.state === 'response' && row.outcome === 'unknown' && row.operationId === 'lost-receipt'));
  assert.equal(rows.at(-1).outcome, 'succeeded');
});

test('effective HTTP adapter timeout remains inspectable after registry snapshot without exposing its token', async () => {
  const { createHttpJsonAdapter, getAdapterMetadata, ServiceRegistry, snapshotServiceRegistry } = await import('../src/core/services.js');
  const { notesManifest } = await import('./fixtures/core-notes-service.js');
  const registry = new ServiceRegistry();
  const manifest = notesManifest(); manifest.endpoint = { transport: 'http-json', url: 'https://example.invalid' };
  registry.registerService({ manifest, adapter: createHttpJsonAdapter({ token: 'private-token-marker', timeoutMs: 1234 }) });
  const metadata = getAdapterMetadata(snapshotServiceRegistry(registry).get('notes').adapter);
  assert.deepEqual(metadata, { transport: 'http-json', timeoutMs: 1234 });
  assert.equal(JSON.stringify(metadata).includes('private-token-marker'), false);
});
