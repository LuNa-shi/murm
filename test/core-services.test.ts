import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServiceRegistry, createInProcessAdapter, snapshotServiceRegistry } from '../src/core/services.js';

function registration() {
  return {
    manifest: {
      id: 'notes', title: 'Notes', purpose: 'Share durable notes',
      provider_version: '1.0.0', contract_version: '2', endpoint: { transport: 'in-process' },
      capabilities: [{
        name: 'get', operation: 'get', description: 'Read a note',
        side_effect: 'read', idempotent: true, help: { when: 'Read a published note' },
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        output_schema: { type: 'string' }, errors: [],
      }],
    },
    adapter: createInProcessAdapter({ invoke: () => 'published note' }),
  };
}

test('Environment can register a v2 custom Service and rejects duplicate identity', () => {
  const services = new ServiceRegistry();
  services.registerService(registration());
  assert.throws(() => services.registerService(registration()), { code: 'CONFLICT' });
});

test('reserved Agent Service identity and incomplete manifests fail before registration', () => {
  const services = new ServiceRegistry();
  const entry = registration();
  entry.manifest.id = 'agent';
  assert.throws(() => services.registerService(entry), { code: 'INVALID_CONTRACT' });
  entry.manifest.id = 'notes';
  entry.manifest.contract_version = '1';
  assert.throws(() => services.registerService(entry), { code: 'INVALID_CONTRACT' });
});

test('in-process adapter retains its implementation context and result', async () => {
  const adapter = createInProcessAdapter({ note: 'published note', invoke() { return this.note; } });
  assert.equal(await adapter.invoke({}), 'published note');
});


test('Runtime registry snapshot freezes adapter entrypoints while retaining Service business state', async () => {
  const services = new ServiceRegistry();
  const entry = registration();
  const state = { note: 'initial' };
  entry.adapter = { state, invoke() { return this.state.note; } };
  services.registerService(entry);
  const snapshot = snapshotServiceRegistry(services);
  entry.manifest.capabilities[0].operation = 'mutated';
  entry.adapter.invoke = () => 'replacement-must-not-run';
  state.note = 'published';
  assert.equal(snapshot.get('notes').manifest.capabilities[0].operation, 'get');
  assert.equal(await snapshot.get('notes').adapter.invoke({}), 'published');
  const late = registration();
  late.manifest.id = 'late';
  services.registerService(late);
  assert.equal(snapshot.has('late'), false);
});
