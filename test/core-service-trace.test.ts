import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServiceTrace } from '../src/core/service-trace.js';
import { setup } from './fixtures/core-notes-service.js';

test('Bridge traces full Service requests and results with trusted identity and private timestamped storage', async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'core-service-trace-'));
  const trace = createServiceTrace(outputDir, value => JSON.parse(JSON.stringify(value).replaceAll('sensitive-token', '[redacted]')));
  await trace.initialize();
  const { call } = await setup(t, { invoke({ input, caller }) { return { ...input, author: caller.agentId }; } }, { bridge: { traceService: row => trace.record(row) } });
  assert.equal((await call('put', { key: 'one', text: 'sensitive-token' }, { caller: { agentId: 'forged' } })).ok, true);
  assert.equal((await call('put', {})).error.code, 'SERVICE_INPUT_INVALID');
  await trace.flush();
  const text = await readFile(join(outputDir, 'service-calls.jsonl'), 'utf8');
  const rows = text.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.seq), [1, 2, 3, 4]);
  assert.equal(rows[0].caller.agentId, 'agent-one');
  assert.equal(rows[0].input.text, '[redacted]');
  assert.equal(rows[1].output.author, 'agent-one');
  assert.equal(rows[3].error.code, 'SERVICE_INPUT_INVALID');
  assert.ok(rows.every(row => Number.isFinite(Date.parse(row.startedAt))));
  assert.ok(rows.filter(row => row.phase === 'settled').every(row => Number.isFinite(Date.parse(row.endedAt))));
  assert.equal(text.includes('sensitive-token'), false);
  assert.equal(text.includes('forged'), false);
  assert.equal((await stat(join(outputDir, 'service-calls.jsonl'))).mode & 0o777, 0o600);
});

test('optional Service state hooks survive public adapter registration and expose bounded export failures', async () => {
  const { createInProcessAdapter, ServiceRegistry, snapshotServiceRegistry } = await import('../src/core/services.js');
  const { exportServiceStates } = await import('../src/core/service-trace.js');
  const { notesManifest } = await import('./fixtures/core-notes-service.js');
  const outputDir = await mkdtemp(join(tmpdir(), 'core-service-state-'));
  const services = new ServiceRegistry();
  services.registerService({ manifest: notesManifest(), adapter: createInProcessAdapter({ invoke() { return null; },
    exportState() { return { messages: [{ text: 'stored' }] }; } }) });
  services.registerService({ manifest: notesManifest('waiting'), adapter: { invoke() { return null; },
    exportState({ signal }) { signal.addEventListener('abort', () => {}); return new Promise(() => {}); } } });
  const results = await exportServiceStates(snapshotServiceRegistry(services), outputDir, value => value, 10);
  assert.deepEqual(JSON.parse(await readFile(results[0].path, 'utf8')).state, { messages: [{ text: 'stored' }] });
  assert.equal(results[1].error.code, 'SERVICE_TIMEOUT');
});

test('HTTP adapter host credentials remain available for trace redaction through frozen registry snapshots', async () => {
  const { createHttpJsonAdapter, ServiceRegistry, snapshotServiceRegistry, registerServicePrivateValues } = await import('../src/core/services.js');
  const { notesManifest } = await import('./fixtures/core-notes-service.js');
  const registry = new ServiceRegistry();
  const manifest = notesManifest(); manifest.endpoint = { transport: 'http-json', url: 'https://example.invalid' };
  registry.registerService({ manifest, adapter: createHttpJsonAdapter({ token: 'host-authentication-marker' }) });
  const values = [];
  registerServicePrivateValues(snapshotServiceRegistry(registry), entries => values.push(...entries));
  assert.deepEqual(values, ['host-authentication-marker']);
});
