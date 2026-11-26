import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { ServiceRegistry } from '../src/core/services.js';
import { transport } from './fixtures/core-input-backend.js';
import { createCoreParticipationEvidence } from './fixtures/core-participation-evidence.js';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return { url: new URL('./fixtures/core-input-backend.js', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
const { createRuntime } = await import('../src/core/index.js'); hooks.deregister();
async function fixture(t, count) {
  const root = await mkdtemp(join(tmpdir(), 'core-participation-'));
  transport.reset();
  const runtime = await createRuntime({ backend: {}, profiles: { peer: { prompt: 'Fixed', model: 'default', image: 'fixture', writable: false, services: {} } }, services: new ServiceRegistry(), maxAgents: count, outputDir: root });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const agents = await Promise.all(Array.from({ length: count }, (_, i) => runtime.spawn({ profile: 'peer', requestId: `spawn-${i}` })));
  return { runtime, agents, complete() {
    transport.next = id => { const row = transport.submissions.get(id); transport.confirm(id, 'started'); transport.listeners.get(row.agentId)({ type: 'settled', outcome: 'completed', output: 'PRIVATE OUTPUT' }); };
  } };
}
test('four actual Core Agents produce bounded host-observed participation receipts', async t => {
  const f = await fixture(t, 4); let now = 10;
  const recorder = createCoreParticipationEvidence({ runtime: f.runtime, agentIds: f.agents.map(agent => agent.id), clockId: 'test-clock', now: () => now, maxInputs: 8 });
  for (const [i, agent] of f.agents.entries()) { f.complete(); now = 20 + i; await recorder.run(agent.id, 'PRIVATE INPUT', { requestId: `turn-${i}`, timeoutMs: 1000 }); }
  const rows = recorder.snapshot().completed;
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(row => row.atMs), [20, 21, 22, 23]);
  assert.deepEqual(new Set(rows.map(row => row.agentId)), new Set(f.agents.map(agent => agent.id)));
  assert.ok(rows.every(row => row.runtimeId === f.runtime.id && row.seq > 0 && row.inputId && row.clockId === 'test-clock'));
  assert.doesNotMatch(JSON.stringify(recorder.snapshot()), /PRIVATE|accepted.*true|business|hour|ttl/i);
});

test('unsettled inputs remain absent from completion evidence and retain bounded failure identity', async t => {
  const f = await fixture(t, 1);
  const recorder = createCoreParticipationEvidence({ runtime: f.runtime, agentIds: [f.agents[0].id], clockId: 'test-clock', maxInputs: 2 });
  transport.next = id => transport.confirm(id, 'started');
  await assert.rejects(recorder.run(f.agents[0].id, 'PRIVATE', { requestId: 'unsettled', timeoutMs: 20 }), { code: 'input_timeout' });
  const snapshot = recorder.snapshot();
  assert.deepEqual(snapshot.completed, []);
  assert.equal(snapshot.failures[0].requestId, 'unsettled');
  assert.equal(snapshot.failures[0].code, 'input_timeout');
  await assert.rejects(recorder.run(f.agents[0].id, 'PRIVATE', { requestId: 'later', timeoutMs: 20 }), { code: 'previous_submission_unresolved' });
  assert.equal(transport.submissions.size, 1);
});

test('eight actual Core Agents retain distinct input and event identities across parallel rounds', async t => {
  const f = await fixture(t, 8); let now = 1;
  const recorder = createCoreParticipationEvidence({ runtime: f.runtime, agentIds: f.agents.map(agent => agent.id), clockId: 'synthetic-test-clock', now: () => now++, maxInputs: 16 });
  const complete = id => { transport.next = complete; const row = transport.submissions.get(id); transport.confirm(id, 'started'); transport.listeners.get(row.agentId)({ type: 'settled', outcome: 'completed', output: 'PRIVATE' }); };
  transport.next = complete;
  for (let round = 0; round < 2; round++) await Promise.all(f.agents.map(agent => recorder.run(agent.id, 'PRIVATE', { requestId: `${agent.id}:${round}`, timeoutMs: 1000 })));
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.completed.length, 16);
  assert.equal(new Set(snapshot.completed.map(row => row.inputId)).size, 16);
  assert.equal(new Set(snapshot.completed.map(row => `${row.agentId}:${row.seq}`)).size, 16);
  for (const agent of f.agents) assert.equal(snapshot.completed.filter(row => row.agentId === agent.id).length, 2);
  assert.deepEqual(snapshot.failures, []);
  await assert.rejects(recorder.run(f.agents[0].id, 'extra', { requestId: 'extra', timeoutMs: 1000 }), { code: 'PARTICIPATION_INPUT_LIMIT' });
  assert.equal(transport.submissions.size, 16);
});

test('foreign and repeated input identities cannot create extra evidence', async t => {
  const f = await fixture(t, 2);
  const recorder = createCoreParticipationEvidence({ runtime: f.runtime, agentIds: [f.agents[0].id], clockId: 'test-clock', maxInputs: 3 });
  await assert.rejects(recorder.run(f.agents[1].id, 'foreign', { requestId: 'foreign', timeoutMs: 100 }), { code: 'FOREIGN_PARTICIPANT' });
  f.complete();
  const { evidence } = await recorder.run(f.agents[0].id, 'first', { requestId: 'same', timeoutMs: 1000 });
  evidence.agentId = 'tampered';
  await assert.rejects(recorder.run(f.agents[0].id, 'replay', { requestId: 'same', timeoutMs: 1000 }), { code: 'wait_request_id_reused' });
  assert.equal(transport.submissions.size, 1);
  const snapshot = recorder.snapshot(); assert.equal(snapshot.completed.length, 1); assert.equal(snapshot.completed[0].agentId, f.agents[0].id);
  snapshot.completed.length = 0;
  assert.equal(recorder.snapshot().completed.length, 1);
});

for (const disposition of ['queued', 'handled', 'unknown', 'failed']) test(`${disposition} input produces no completed participation`, async t => {
  const f = await fixture(t, 1);
  const recorder = createCoreParticipationEvidence({ runtime: f.runtime, agentIds: [f.agents[0].id], clockId: 'test-clock', maxInputs: 1 });
  transport.next = id => {
    if (disposition !== 'unknown') transport.confirm(id, disposition === 'failed' ? 'started' : disposition);
    if (disposition === 'failed') transport.listeners.get(f.agents[0].id)({ type: 'settled', outcome: 'failed', error: { code: 'PRIVATE' } });
  };
  await assert.rejects(recorder.run(f.agents[0].id, 'PRIVATE', { requestId: disposition, timeoutMs: 1000 }));
  assert.deepEqual(recorder.snapshot().completed, []);
  assert.equal(recorder.snapshot().failures.length, 1);
  assert.doesNotMatch(JSON.stringify(recorder.snapshot()), /PRIVATE/);
});

test('clock rollback at actual completion invalidates that receipt', async t => {
  const f = await fixture(t, 1); let now = 10;
  const recorder = createCoreParticipationEvidence({ runtime: f.runtime, agentIds: [f.agents[0].id], clockId: 'test-clock', now: () => now, maxInputs: 1 });
  transport.next = id => { now = 9; transport.confirm(id, 'started'); transport.listeners.get(f.agents[0].id)({ type: 'settled', outcome: 'completed' }); };
  await assert.rejects(recorder.run(f.agents[0].id, 'fixed', { requestId: 'rollback', timeoutMs: 1000 }), { code: 'INVALID_MONOTONIC_OBSERVATION' });
  assert.deepEqual(recorder.snapshot().completed, []);
});

test('concurrent wait and a foreign Agent event cannot settle the owned input', async t => {
  const f = await fixture(t, 2);
  const recorder = createCoreParticipationEvidence({ runtime: f.runtime, agentIds: f.agents.map(agent => agent.id), clockId: 'test-clock', maxInputs: 2 });
  const entered = Promise.withResolvers();
  transport.next = id => { transport.confirm(id, 'started'); entered.resolve(); };
  const first = recorder.run(f.agents[0].id, 'fixed', { requestId: 'held', timeoutMs: 1000 });
  await entered.promise;
  await assert.rejects(recorder.run(f.agents[0].id, 'second', { requestId: 'second', timeoutMs: 1000 }), { code: 'concurrent_wait_for_agent' });
  transport.listeners.get(f.agents[1].id)({ type: 'settled', outcome: 'completed' });
  assert.deepEqual(recorder.snapshot().completed, []);
  assert.deepEqual(recorder.snapshot().pendingAgentIds, [f.agents[0].id]);
  transport.listeners.get(f.agents[0].id)({ type: 'settled', outcome: 'completed' });
  await first;
  assert.equal(recorder.snapshot().completed.length, 1);
  assert.equal(transport.submissions.size, 1);
});
