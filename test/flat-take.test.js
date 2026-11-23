import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFlatTaskStores } from './fixtures/flat-task-stores.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
import { createLifecycleProvider } from './fixtures/core-lifecycle-provider.js';
import { decodeFileSeed } from '../scripts/core-file-seed.mjs';
import { createFlatTaskService, flatResearcherProfile } from '../src/environments/flat/task-service.js';
import { createFlatBotCoordinator } from '../src/environments/flat/bot-coordinator.js';

async function fixture(t, hooks = {}, config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'flat-take-'));
  const { tasks, context, workspace, manager, task, material, missionId, workspaceId } = await createFlatTaskStores(root);
  let runtime, service, provider;
  t.after(async () => { await service?.close(); provider?.allowDeletion(); await runtime?.close({ timeoutMs: 1000 }); context.close(); tasks.close(); await rm(root, { recursive: true, force: true }); });
  provider = await createLifecycleProvider(t, { fileOperation(action, input) { return { body: { result: action === 'prepare' ? { version: input.version, digest: decodeFileSeed(input.files).digest } : { ...input, writable: true } } }; }, ...hooks, allowHostGit: true }); provider.allowDeletion();
  const { createRuntime } = await import('@swarmenv/core');
  const { createPiOpenSandboxBackend } = await import('@swarmenv/core/backends/pi-opensandbox');
  const { ServiceRegistry } = await import('@swarmenv/core/services');
  const { collect, ...serviceConfig } = config;
  service = createFlatTaskService({ runtime: () => runtime, taskService: tasks, missionId, missionWorkspace: workspace,
    workspaceId, workspaceManager: manager, contextService: context,
    missionDeadline: () => Date.now() + 60_000, executionTimeoutMs: 60_000, ...serviceConfig });
  const services = new ServiceRegistry(); services.registerService(service);
  runtime = await createRuntime({ backend: createPiOpenSandboxBackend({ sandbox: { lifecycleBaseUrl: provider.url },
    bridge: { host: '127.0.0.1', publicUrl: 'http://192.0.2.1:{port}' }, modelGateway: { host: '127.0.0.1', advertiseHost: '192.0.2.1' },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } },
    isolation: { network: 'local-docker', disk: { bytes: 32 * 1024 ** 2, inodes: 2048 } } }),
    profiles: { researcher: flatResearcherProfile({ prompt: 'Fixed discovery', model: 'default', image: 'fixture', ...(config.collect ? { collect: config.collect } : {}) }) }, services, maxBots: 2, outputDir: join(root, 'output') });
  const coordinator = createFlatBotCoordinator({ runtime, taskService: tasks, missionId });
  const spawn = id => coordinator.spawn({ legacySlotId: `slot:${id}`, requestId: id, profile: 'researcher', writable: false,
    selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
  const call = (bot, operation, input = {}, requestId = operation) => service.adapter.invoke({ capability: { operation }, input,
    caller: { runtimeId: runtime.id, botId: bot.id, profile: 'researcher' }, envelope: { operation_id: requestId }, signal: new AbortController().signal });
  return { root, tasks, context, workspace, manager, task, material, provider, runtime, service, spawn, call };
}

test('public flat take joins one handoff and preserves pinned Workspace/Material bytes and independent resource version', async t => {
  let seed;
  const f = await fixture(t, { fileOperation(action, input) {
    if (action === 'prepare') { seed = input.files; return { body: { result: { version: input.version, digest: decodeFileSeed(input.files).digest } } }; }
    return { body: { result: { ...input, writable: true } } };
  } });
  const bot = await f.spawn('first');
  const listing = await f.call(bot, 'task_list'); assert.ok(listing.tasks.some(task => task.task_id === f.task.task_id));
  const [taken, replay] = await Promise.all([f.call(bot, 'task_take', { task_id: f.task.task_id }, 'take'), f.call(bot, 'task_take', { task_id: f.task.task_id }, 'take')]);
  assert.deepEqual(replay, taken);
  assert.equal(taken.execution.state, 'RUNNING');
  assert.equal(taken.handoff.executionFence, taken.execution.fencing_version);
  assert.equal(taken.handoff.prepared.botId, bot.id);
  assert.equal(Buffer.from(seed['input.txt'].data, 'base64').toString(), 'fixed λ\n');
  assert.deepEqual(taken.materials[0].content, { text: 'fixed material bytes' });
  assert.equal(taken.execution.workspace_input.revision, '0.1');
  assert.equal((await readFile(join(f.tasks.getExecution(taken.execution.execution_id).workspace_ref, 'input.txt'), 'utf8')), 'fixed λ\n');
  await assert.rejects(f.call(bot, 'task_take', { task_id: 'other' }, 'take'), { code: 'CONFLICT' });
});

test('two Core Bots compete for one Task and ordinary conflict leaves the losing discovery Bot live', async t => {
  const f = await fixture(t);
  const a = await f.spawn('a'), b = await f.spawn('b');
  const results = await Promise.allSettled([f.call(a, 'task_take', { task_id: f.task.task_id }, 'take-a'), f.call(b, 'task_take', { task_id: f.task.task_id }, 'take-b')]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  const loser = results[0].status === 'rejected' ? a : b;
  assert.equal(results.find(row => row.status === 'rejected').reason.code, 'CONFLICT');
  assert.equal(f.tasks.getBot(loser.id).state, 'UNBOUND');
  assert.equal((await f.runtime.get(loser.id)).status, 'idle');
  assert.equal(f.tasks.listExecutions(f.task.task_id).length, 1);
  await assert.rejects(f.call(loser, 'task_take', { task_id: f.task.task_id, owner_ref: a.id }, 'forged'), { code: 'INVALID_CONTRACT' });
  await assert.rejects(f.service.adapter.invoke({ capability: { operation: 'task_view' }, input: { task_id: f.task.task_id },
    caller: { runtimeId: 'foreign-runtime', botId: loser.id, profile: 'researcher' }, envelope: { operation_id: 'foreign' } }), { code: 'NOT_ALLOWED' });
});

test('unknown grant stops through Core and retains Task ownership until execution stop is confirmed', async t => {
  let stopConfirmed = false;
  const f = await fixture(t, { onStop: () => ({ stopped: stopConfirmed }), fileOperation(action, input) {
    if (action === 'prepare') return { body: { result: { version: input.version, digest: decodeFileSeed(input.files).digest } } };
    return { body: { code: 'OPERATION_UNKNOWN', error: 'Fixed lost grant reply' }, status: 400 };
  } });
  const bot = await f.spawn('unknown'), peer = await f.spawn('peer');
  try {
    await assert.rejects(f.call(bot, 'task_take', { task_id: f.task.task_id }, 'take'), { code: 'OPERATION_UNKNOWN' });
    const row = f.service.inspect(bot.id, 'take');
    assert.equal(row.error.code, 'OPERATION_UNKNOWN');
    assert.equal(row.stopped.execution, 'unknown');
    assert.equal(row.stopped.cleanup, 'pending');
    assert.equal(f.tasks.getBot(bot.id).state, 'CLOSING');
    assert.equal(f.tasks.getExecution(row.executionId).state, 'RUNNING');
    await assert.rejects(f.call(peer, 'task_take', { task_id: f.task.task_id }, 'peer'), { code: 'CONFLICT' });
    stopConfirmed = true;
    const retry = await f.service.reconcile(bot.id, 'take');
    assert.equal(retry.error.code, 'OPERATION_UNKNOWN');
    assert.equal(retry.stopped.execution, 'stopped');
    assert.equal(f.tasks.getExecution(row.executionId).state, 'FAILED');
    assert.equal(f.tasks.getBot(bot.id).state, 'CLOSED');
  } finally { stopConfirmed = true; }
});

test('required artifact failure retains Core Slot while stopped execution permits domain compensation', async t => {
  const f = await fixture(t, { onCollect: () => ({ error: { code: 'INVALID_CONTRACT', error: 'Fixed required archive failure' } }), fileOperation(action, input) {
    if (action === 'prepare') return { body: { result: { version: input.version, digest: decodeFileSeed(input.files).digest } } };
    return { body: { code: 'OPERATION_UNKNOWN', error: 'Fixed uncertain grant' }, status: 400 };
  } }, { collect: { paths: ['.'], includeGit: false, maxBytes: 100, required: true } });
  const bot = await f.spawn('required');
  await assert.rejects(f.call(bot, 'task_take', { task_id: f.task.task_id }, 'take'), { code: 'OPERATION_UNKNOWN' });
  const row = f.service.inspect(bot.id, 'take');
  assert.equal(row.stopped.execution, 'stopped');
  assert.equal(row.stopped.cleanup, 'pending');
  assert.equal(f.tasks.getExecution(row.executionId).state, 'FAILED');
  assert.equal(f.tasks.getBot(bot.id).state, 'CLOSING');
  assert.equal((await f.runtime.get(bot.id)).status, 'closing');
});

test('preparation heartbeat retains timer failure even if Mission appears open again before prepare returns', async t => {
  const reached = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture(t, { async fileOperation(action, input) {
    if (action === 'prepare') { reached.resolve(); await release.promise; return { body: { result: { version: input.version, digest: decodeFileSeed(input.files).digest } } }; }
    throw new Error('Grant must not run after heartbeat failure');
  } }, { heartbeatMs: 5 });
  const bot = await f.spawn('heartbeat');
  const pending = assert.rejects(f.call(bot, 'task_take', { task_id: f.task.task_id }, 'take'), { code: 'NOT_ALLOWED' });
  await reached.promise;
  let stopped = true;
  f.tasks.setMissionStopReader(() => stopped);
  await new Promise(resolve => setTimeout(resolve, 20));
  stopped = false; release.resolve();
  await pending;
  const row = f.service.inspect(bot.id, 'take');
  assert.equal(row.stopped.execution, 'stopped');
  assert.equal(f.tasks.getExecution(row.executionId).state, 'FAILED');
});

test('a Core close racing grant never returns successful take and compensation uses the completed stop receipt', async t => {
  const reached = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture(t, { async fileOperation(action, input) {
    if (action === 'prepare') return { body: { result: { version: input.version, digest: decodeFileSeed(input.files).digest } } };
    reached.resolve(); await release.promise;
    return { body: { result: { ...input, writable: true } } };
  } });
  const bot = await f.spawn('closing');
  const pending = assert.rejects(f.call(bot, 'task_take', { task_id: f.task.task_id }, 'take'), { code: 'OPERATION_UNKNOWN' });
  await reached.promise;
  const closed = await f.runtime.close();
  assert.equal(closed.cleanup, 'complete');
  release.resolve();
  await pending;
  const row = f.service.inspect(bot.id, 'take');
  assert.equal(row.stopped.execution, 'stopped');
  assert.equal(f.tasks.getExecution(row.executionId).state, 'FAILED');
});

test('a stale Execution fence after grant cannot produce successful handoff', async t => {
  let f, bot;
  f = await fixture(t, { fileOperation(action, input) {
    if (action === 'prepare') return { body: { result: { version: input.version, digest: decodeFileSeed(input.files).digest } } };
    const execution = f.tasks.getExecution(f.tasks.getBot(bot.id).execution_id);
    f.tasks.dispatch('fence_execution', { reason: 'fixed concurrent fencing' }, makeEnvelope({ actorRef: 'host', taskId: execution.task_id,
      executionId: execution.execution_id, specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version }));
    return { body: { result: { ...input, writable: true } } };
  } });
  bot = await f.spawn('stale');
  await assert.rejects(f.call(bot, 'task_take', { task_id: f.task.task_id }, 'take'), { code: 'NOT_ALLOWED' });
  const row = f.service.inspect(bot.id, 'take');
  assert.equal(row.stage, 'failed');
  assert.equal(row.stopped.execution, 'stopped');
  assert.equal(f.tasks.getExecution(row.executionId).state, 'FENCED');
  assert.equal(f.tasks.getBot(bot.id).state, 'CLOSED');
});

test('finite preparation timeout owns the late Core result and never grants or reports take success', async t => {
  const reached = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture(t, { async fileOperation(action, input) {
    if (action === 'prepare') { reached.resolve(); await release.promise; return { body: { result: { version: input.version, digest: decodeFileSeed(input.files).digest } } }; }
    throw new Error('Late prepare cannot grant');
  } }, { preparationTimeoutMs: 4000 });
  const bot = await f.spawn('timeout');
  const pending = assert.rejects(f.call(bot, 'task_take', { task_id: f.task.task_id }, 'take'), { code: 'NOT_ALLOWED' });
  await reached.promise;
  await pending;
  const row = f.service.inspect(bot.id, 'take');
  assert.equal(row.stage, 'failed');
  assert.equal(row.inputWorkPending, true);
  assert.equal(row.stopped.execution, 'stopped');
  release.resolve();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.service.inspect(bot.id, 'take').inputWorkPending, false);
});
