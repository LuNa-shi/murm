import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { ServiceRegistry } from '../src/core/services.js';
import { transport } from './fixtures/core-input-backend.js';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './sandbox/opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) {
    return { url: new URL('./fixtures/core-input-backend.js', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { createRuntime, fenceRuntimeAdmissions } = await import('@luna-shi/murm');
hooks.deregister();

test('invalid session settings reject before allocating an Agent', async t => {
  transport.reset();
  const outputDir = await mkdtemp(join(tmpdir(), 'core-session-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  await assert.rejects(createRuntime({ sandbox: {}, profiles: { worker: {
    model: 'default', image: 'test', writable: true, services: {}, session: { retry: { maxRetries: -1 } },
  } }, services: new ServiceRegistry(), maxAgents: 2, outputDir }), { code: 'INVALID_CONTRACT' });
  assert.equal(transport.listeners.size, 0);
});

async function setup(t, session = {}) {
  transport.reset();
  const outputDir = await mkdtemp(join(tmpdir(), 'core-session-'));
  const runtime = await createRuntime({ sandbox: {}, profiles: { worker: {
    model: 'default', image: 'test', writable: true, services: {}, session,
  } }, services: new ServiceRegistry(), maxAgents: 3, outputDir });
  t.after(async () => { await runtime.close(); await rm(outputDir, { recursive: true, force: true }); });
  const agent = await runtime.spawn({ profile: 'worker', requestId: 'initial', session: { retry: { enabled: false } } });
  return { runtime, agent };
}

test('Profile session settings merge per Agent and mutable settings reach the executor exactly once', async t => {
  const { runtime, agent } = await setup(t, { retry: { enabled: true, maxRetries: 4 }, tools: ['read'] });
  assert.deepEqual(transport.spawned[0].options.session, { retry: { enabled: false, maxRetries: 4 }, tools: ['read'] });
  const other = await runtime.spawn({ profile: 'worker', requestId: 'other' });
  assert.equal(transport.spawned[1].options.session.retry.enabled, true);
  const first = await runtime.session.configure(agent.id, { thinkingLevel: 'low' }, { requestId: 'settings' });
  assert.deepEqual(await runtime.session.configure(agent.id, { thinkingLevel: 'low' }, { requestId: 'settings' }), first);
  assert.equal(transport.sessionCalls.length, 1);
  assert.equal(transport.sessionCalls[0].command, 'core_session_configure');
  assert.equal(transport.sessionCalls[0].agentId, agent.id);
  await assert.rejects(runtime.session.configure(agent.id, { thinkingLevel: 'high' }, { requestId: 'settings' }), { code: 'CONFLICT' });
  assert.equal((await runtime.get(other.id)).status, 'idle');
});

test('context append preserves structure without claiming a model execution and retries reconcile unknown receipt', async t => {
  const { runtime, agent } = await setup(t);
  transport.sessionReply = ({ query }) => query ? { status: 'accepted', disposition: 'appended' } : { status: 'unknown' };
  const context = { type: 'context', customType: 'reference', content: 'keep this', details: { revision: 1 } };
  const first = await runtime.send(agent.id, context, { requestId: 'context', delivery: 'append' });
  assert.equal(first.status, 'unknown');
  const confirmed = await runtime.send(agent.id, context, { requestId: 'context', delivery: 'append' });
  assert.equal(confirmed.inputId, first.inputId);
  assert.equal(confirmed.disposition, 'appended');
  assert.equal(transport.sessionCalls[1].query, true);
  assert.deepEqual(transport.sessionCalls[0].payload.input, { ...context, display: false });
  assert.equal((await runtime.get(agent.id)).status, 'idle');
  await assert.rejects(runtime.send(agent.id, { ...context, content: 'changed' }, { requestId: 'context', delivery: 'append' }), { code: 'CONFLICT' });
});

test('manual compact refuses pending input and admission fencing rejects new work while old receipts remain readable', async t => {
  const { runtime, agent } = await setup(t);
  const applied = await runtime.session.configure(agent.id, { thinkingLevel: 'low' }, { requestId: 'known' });
  await runtime.send(agent.id, 'working', { requestId: 'work' });
  assert.equal((await runtime.session.compact(agent.id, { requestId: 'compact' })).status, 'busy');
  assert.equal(transport.sessionCalls.filter(call => call.command === 'core_session_compact').length, 0);
  fenceRuntimeAdmissions(runtime);
  await assert.rejects(runtime.send(agent.id, 'late', { requestId: 'late' }), { code: 'NOT_ALLOWED' });
  await assert.rejects(runtime.spawn({ profile: 'worker', requestId: 'late-spawn' }), { code: 'NOT_ALLOWED' });
  await assert.rejects(runtime.session.clearQueue(agent.id, { requestId: 'late-clear' }), { code: 'SESSION_UNAVAILABLE' });
  assert.deepEqual(await runtime.session.configure(agent.id, { thinkingLevel: 'low' }, { requestId: 'known' }), applied);
});

test('public Harness control reconciles the original native receipt after the Agent has stopped', async t => {
  const { createHarnessSession, observeProjectRuntime } = await import('@luna-shi/murm');
  const project = await mkdtemp(join(tmpdir(), 'harness-reconcile-'));
  const outputRoot = await mkdtemp(join(tmpdir(), 'harness-reconcile-output-'));
  t.after(async () => { await rm(project, { recursive: true, force: true }); await rm(outputRoot, { recursive: true, force: true }); });
  const { runtime, agent } = await setup(t);
  let observation;
  const ready = Promise.withResolvers<void>();
  const session = createHarnessSession({ id: 'native-receipt', apiVersion: 1, async run(context) {
    observation = observeProjectRuntime(runtime, context, undefined, {
      capabilities: { configure: { supported: true } },
    });
    context.markRunning(); ready.resolve();
    await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
    observation.close();
    return { outcome: 'cancelled', reason: 'stopped', artifacts: [], cleanup: { status: 'complete' } };
  } }, { outputRoot });
  await session.start({ cwd: project, prompt: 'work' }, { requestId: 'start' });
  await ready.promise;
  transport.sessionReply = ({ query }) => query ? { status: 'applied' } : { status: 'unknown' };
  const first = await session.agents.configure(agent.id, { thinkingLevel: 'low' }, { requestId: 'setting' });
  assert.equal(first.status, 'unknown');
  await runtime.stop(agent.id);
  const confirmed = await session.agents.configure(agent.id, { thinkingLevel: 'low' }, { requestId: 'setting' });
  assert.equal(confirmed.status, 'applied');
  assert.equal(confirmed.operationId, first.operationId);
  assert.deepEqual(transport.sessionCalls.map(call => call.query), [false, true]);
  assert.deepEqual(await session.agents.configure(agent.id, { thinkingLevel: 'low' }, { requestId: 'setting' }), confirmed);
  assert.equal(transport.sessionCalls.length, 2);
  await session.stop({ requestId: 'stop' }); await session.completion;
});

test('text and structured context share one public send request identity in both directions', async t => {
  const { runtime, agent } = await setup(t);
  const context = { type: 'context', customType: 'reference', content: 'context' };
  const first = await runtime.send(agent.id, context, { requestId: 'context-first', delivery: 'append' });
  await assert.rejects(runtime.send(agent.id, 'changed to text', { requestId: 'context-first' }), { code: 'CONFLICT' });
  assert.equal(transport.submissions.size, 0);
  await runtime.send(agent.id, 'text', { requestId: 'text-first' });
  const before = transport.sessionCalls.length;
  await assert.rejects(runtime.send(agent.id, context, { requestId: 'text-first', delivery: 'append' }), { code: 'CONFLICT' });
  assert.equal(transport.sessionCalls.length, before);
  assert.deepEqual(await runtime.send(agent.id, context, { requestId: 'context-first', delivery: 'append' }), first);
});
