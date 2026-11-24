import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TaskService } from '../src/task/task-service.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
import { Runtime } from '../src/runtime/runtime.js';
import { MissionWorkspace } from '../src/runtime/mission-workspace.js';
import { WorkspaceManager } from '../src/runtime/workspace-manager.js';
import { createOpenSandboxManager } from '../src/runtime/opensandbox-manager.js';
import { ServicesBridge } from '../src/agent/services-bridge.js';
import { ContextService } from '../src/context/context-service.js';
import { createBuiltinServiceRegistry } from '../src/sdk/builtin-registry.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, { removeSandbox = async () => new Response('{}'), bind = true, start = true, runtimeOptions = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-cleanup-'));
  const service = new TaskService();
  let sandboxDeleted = false;
  const sandboxManager = createOpenSandboxManager({
    lifecycleBaseUrl: 'http://sandbox.test/v1', image: 'image:test', waitForExecdReady: false,
    fetchImpl: async (url, options) => {
      if (options.method === 'DELETE') {
        const response = await removeSandbox();
        if (response.ok && response.status !== 202 || response.status === 404) sandboxDeleted = true;
        return response;
      }
      if (sandboxDeleted && url.endsWith('/sandboxes/sandbox-test')) return new Response('{}', { status: 404 });
      if (url.endsWith('/sandboxes')) return new Response(JSON.stringify({ id: 'sandbox-test' }), { status: 202 });
      if (url.includes('/endpoints/')) return new Response(JSON.stringify({ url: 'http://execd.test' }));
      if (url.endsWith('/stop')) return new Response(JSON.stringify({ result: { stopped: true } }));
      if (url.endsWith('/start')) return new Response(JSON.stringify({ result: { contract: { version: 'swarmenv-core-v1', resources: [] }, project_files: { version: 0, writable: false } } }));
      if (url.includes('/project/')) {
        const input = JSON.parse(options.body);
        return new Response(JSON.stringify({ result: { state: url.endsWith('/prepare') ? 'PREPARED' : 'ACTIVE', execution_id: input.execution_id, binding_version: input.binding_version } }));
      }
      if (url.endsWith('/command')) return new Response('event: execution_complete\ndata: {"exit_code":0}\n\n');
      return new Response('{}');
    },
  });
  const missionWorkspace = new MissionWorkspace({ rootDir: join(root, 'public') });
  await missionWorkspace.create({ missionId: 'mission:cleanup', workspaceId: 'workspace-cleanup', initialFiles: { 'input.txt': 'public input' } });
  const runtime = new Runtime({ taskService: service, missionWorkspace, missionWorkspaceId: 'workspace-cleanup', workspaceManager: new WorkspaceManager({ rootDir: root }), sandboxManager, ...runtimeOptions });
  t.after(async () => {
    await runtime.shutdown();
    service.close();
    await rm(root, { recursive: true, force: true });
  });
  const envelope = () => makeEnvelope({ actorRef: 'operator:cleanup' });
  service.dispatch('mission_create', { mission_id: 'mission:cleanup', goal: 'Verify safe Core reuse' }, envelope());
  const task = service.dispatch('task_create', { mission_id: 'mission:cleanup', summary: 'Inspect one local result', goal: 'Inspect one local result', expected_output: 'Inspection note', acceptance_conditions: ['Note records the inspection'] }, envelope()).task;
  // The model process is the external boundary. Task Service, Runtime,
  // Workspace and the OpenSandbox protocol adapter are real collaborators.
  const session = new EventEmitter();
  session.closed = false;
  session.waitForReady = async () => {};
  session.stop = async () => { session.closed = true; session.emit('close'); };
  const startSession = async ({ bot, onSandboxCreated, beforeAgentStart }) => {
    await sandboxManager.ensureExecution({ executionId: bot.resource_key, botId: bot.bot_id, onCreated: onSandboxCreated });
    await sandboxManager.startAgent({ executionId: bot.resource_key, command: 'pi', resources: [], args: [], beforeAgentStart });
    return session;
  };
  if (!start) return { service, runtime, sandboxManager, session, startSession };
  const { bot } = await runtime.startBot({ missionId: 'mission:cleanup', coreId: 'core-1', startSession });
  const take = service.takeTask(task.task_id, { owner_ref: bot.bot_id, core_id: bot.core_id, take_key: 'take:cleanup' });
  if (bind) await runtime.bindAgentExecution(take.execution.execution_id, session, { coreId: 'core-1' });
  return { service, runtime, sandboxManager, session, executionId: take.execution.execution_id };
}

test('a Runtime without the registered resource binding cannot stop or release another owner', async t => {
  const { runtime, service, sandboxManager, session, executionId } = await fixture(t);
  const observer = new Runtime({ taskService: service, workspaceManager: {}, sandboxManager });
  try {
    const before = service.getExecution(executionId);
    await assert.rejects(observer.stopExecution(executionId), { code: 'SERVICE_UNAVAILABLE' });
    await assert.rejects(observer.releaseExecution(executionId), { code: 'SERVICE_UNAVAILABLE' });
    assert.deepEqual(service.getExecution(executionId), before);
    assert.equal(session.closed, false);
    assert.equal(sandboxManager.snapshot().executions.length, 1);
    assert.equal(runtime.getCoreStatus('core-1').state, 'RUNNING');
  } finally { await observer.shutdown(); }
  await runtime.stopExecution(executionId);
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('shutdown reports retained cleanup instead of forgetting a terminal Execution after a failed stop', async (t) => {
  let fail = true;
  const { runtime, executionId } = await fixture(t, { removeSandbox: async () => new Response('{}', { status: fail ? 503 : 200 }) });
  try {
    const first = await runtime.shutdown();
    assert.equal(first.active_process_count, 1);
    assert.deepEqual(first.cleanup_pending_execution_ids, [executionId]);
    const second = await runtime.shutdown();
    assert.deepEqual(second.cleanup_pending_execution_ids, [executionId]);
    assert.equal(runtime.getCoreStatus('core-1').state, 'CLOSING');
  } finally { fail = false; }
  const last = await runtime.shutdown();
  assert.deepEqual(last.cleanup_pending_execution_ids, []);
  assert.equal(last.active_process_count, 0);
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('lease expiry retains a closing Core on deletion failure until cleanup retry', async (t) => {
  let fail = true;
  const { service, runtime, executionId } = await fixture(t, { removeSandbox: async () => new Response('{}', { status: fail ? 503 : 200 }) });
  const expires = new Date(Date.parse(service.getExecution(executionId).lease_expires_at) + 1);
  try {
    await assert.rejects(runtime.sweepExpired(expires), (error) => error.code === 'SERVICE_UNAVAILABLE');
    assert.equal(runtime.getCoreStatus('core-1').state, 'CLOSING');
    assert.equal(runtime.hasActiveExecution(executionId), true);
  } finally { fail = false; }
  await runtime.sweepExpired(expires);
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('fencing retains the original process and Core when its sandbox cannot be removed', async (t) => {
  let fail = true;
  const { runtime, executionId } = await fixture(t, { removeSandbox: async () => new Response('{}', { status: fail ? 503 : 200 }) });
  try {
    await assert.rejects(runtime.fenceExecution(executionId), (error) => error.code === 'SERVICE_UNAVAILABLE');
    assert.equal(runtime.getCoreStatus('core-1').state, 'CLOSING');
    assert.equal(runtime.hasActiveExecution(executionId), true);
  } finally { fail = false; }
  await runtime.fenceExecution(executionId);
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('cleanup reconciles a durable fence whose Workspace update has not happened', async (t) => {
  const { runtime, service, executionId } = await fixture(t);
  const execution = service.getExecution(executionId);
  service.dispatch('fence_execution', { runtime_generation: 1, terminal_reason: 'operator_fence' }, makeEnvelope({ actorRef: execution.owner_ref, taskId: execution.task_id, executionId, specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version }));
  await runtime.releaseExecution(executionId);
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
  await runtime.releaseExecution(executionId);
});

test('Workspace release retries after primary metadata succeeded but revision metadata failed', async (t) => {
  const { runtime, service, executionId } = await fixture(t);
  const execution = service.getExecution(executionId);
  const revisions = join(execution.workspace_ref, '.swarm', 'revisions');
  const backup = `${revisions}-held`;
  // Inject a filesystem failure at the revision-write boundary; the public
  // release operation must recover without granting another writer.
  await rename(revisions, backup);
  await writeFile(revisions, 'temporarily unavailable');
  try {
    await assert.rejects(runtime.stopExecution(executionId));
    assert.equal(runtime.getCoreStatus('core-1').state, 'CLOSING');
  } finally {
    await rm(revisions);
    await rename(backup, revisions);
  }
  await runtime.stopExecution(executionId);
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('timebox expiry holds Task ownership until both worker and sandbox are isolated', async (t) => {
  let fail = true;
  const { runtime, service, executionId } = await fixture(t, { removeSandbox: async () => new Response('{}', { status: fail ? 503 : 200 }) });
  const deadline = new Date(Date.parse(service.getExecution(executionId).execution_deadline) + 1);
  try {
    await assert.rejects(runtime.sweepExecutionTimeouts(deadline));
    assert.equal(service.getExecution(executionId).state, 'RUNNING');
    assert.equal(runtime.getCoreStatus('core-1').state, 'CLOSING');
  } finally { fail = false; }
  await runtime.sweepExecutionTimeouts(deadline);
  assert.equal(service.getExecution(executionId).state, 'FAILED');
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('an accepted asynchronous provider deletion is not yet a free Core', async (t) => {
  let pending = true;
  const { runtime, executionId } = await fixture(t, { removeSandbox: async () => new Response('{}', { status: pending ? 202 : 200 }) });
  try {
    await assert.rejects(runtime.stopExecution(executionId), (error) => error.code === 'SERVICE_UNAVAILABLE');
    assert.equal(runtime.getCoreStatus('core-1').state, 'CLOSING');
  } finally { pending = false; }
  await runtime.stopExecution(executionId);
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('closing lease expiry rejects Runtime heartbeat while physical deletion remains outstanding', async (t) => {
  const removing = deferred();
  const removed = deferred();
  const { runtime, service, executionId } = await fixture(t, { removeSandbox: async () => { removing.resolve(); await removed.promise; return new Response('{}'); } });
  const expires = new Date(Date.parse(service.getExecution(executionId).lease_expires_at) + 1);
  const closing = runtime.sweepExpired(expires);
  try {
    await removing.promise;
    assert.throws(() => runtime.heartbeat(executionId), (error) => error.code === 'NOT_ALLOWED');
    assert.equal(runtime.getCoreStatus('core-1').state, 'CLOSING');
    assert.equal(runtime.hasActiveExecution(executionId), true);
  } finally { removed.resolve(); }
  await closing;
  assert.equal(service.getExecution(executionId).state, 'EXPIRED');
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('Runtime shutdown retains a late registered Session and cleans it when startup settles', async (t) => {
  const { runtime, session, service, startSession } = await fixture(t, { start: false });
  const entered = deferred();
  const finishStart = deferred();
  let botId;
  const starting = runtime.startBot({ missionId: 'mission:cleanup', coreId: 'core-1', startSession: async options => {
    botId = options.bot.bot_id;
    const started = await startSession(options);
    entered.resolve();
    await finishStart.promise;
    return started;
  } });
  const rejected = assert.rejects(starting, /stopp/i);
  await entered.promise;
  try {
    await runtime.shutdown();
    assert.equal(service.getBot(botId).state, 'CLOSING');
    assert.equal(runtime.getCoreStatus('core-1').state, 'CLOSING');
  } finally { finishStart.resolve(); }
  await rejected;
  await new Promise(resolve => setImmediate(resolve));
  await runtime.shutdown();
  assert.equal(session.closed, true);
  assert.equal(service.getBot(botId).state, 'CLOSED');
  assert.equal(service.listActiveExecutions().length, 0);
});

test('Runtime completes an accepted finish without a live CLI caller', { timeout: 30000 }, async (t) => {
  const { service, runtime, session, executionId } = await fixture(t);
  const closed = deferred();
  service.subscribeTaskEvents((event) => { if (event.kind === 'task_finish_closed') closed.resolve(); });
  const execution = service.getExecution(executionId);
  service.dispatch('task_finish', { outcome: 'done' }, makeEnvelope({ actorRef: execution.owner_ref, taskId: execution.task_id,
    executionId, specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version }));
  await closed.promise;
  // Join the already initiated release, including its Workspace cleanup.
  await runtime.releaseExecution(executionId);
  assert.equal(session.closed, true);
  assert.equal(service.getTask(execution.task_id).state, 'DONE');
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('finish accepted during an existing release is finalized before its Core is reused', async (t) => {
  const removing = deferred();
  const removed = deferred();
  const { service, runtime, executionId } = await fixture(t, { removeSandbox: async () => { removing.resolve(); await removed.promise; return new Response('{}'); } });
  const release = runtime.releaseExecution(executionId);
  await removing.promise;
  const execution = service.getExecution(executionId);
  service.dispatch('task_finish', { outcome: 'incomplete' }, makeEnvelope({ actorRef: execution.owner_ref, taskId: execution.task_id,
    executionId, specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version }));
  removed.resolve();
  await release;
  assert.equal(service.getExecution(executionId).state, 'HANDED_OFF');
  assert.equal(service.getTask(execution.task_id).state, 'OPEN');
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

for (const trigger of ['process_exit', 'fence']) {
  test(`a registered ${trigger} stop rejects late finish while retaining physical cleanup`, async (t) => {
    const removing = deferred();
    const removed = deferred();
    const { service, runtime, session, executionId } = await fixture(t, { removeSandbox: async () => { removing.resolve(); await removed.promise; return new Response('{}'); } });
    const pending = trigger === 'fence' ? runtime.fenceExecution(executionId) : null;
    if (!pending) { session.closed = true; session.emit('close'); }
    const completed = pending?.then(value => ({ value }), error => ({ error }));
    try {
      await removing.promise;
      const execution = service.getExecution(executionId);
      assert.equal(runtime.getCoreStatus('core-1').state, 'CLOSING');
      assert.throws(() => service.dispatch('task_finish', { outcome: 'incomplete' }, makeEnvelope({ actorRef: execution.owner_ref, taskId: execution.task_id,
        executionId, specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version })), error => error.code === 'NOT_ALLOWED');
    } finally { removed.resolve(); }
    assert.equal((await completed)?.error, undefined);
    await runtime.waitForSettled();
    await runtime.releaseExecution(executionId);
    assert.equal(service.getExecution(executionId).state, trigger === 'fence' ? 'FENCED' : 'FAILED');
    assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
  });
}

for (const registered of [false, true]) {
  test(`Bridge preserves an accepted finish when cleanup fails (registry=${registered})`, async (t) => {
    let fail = true;
    const { service, runtime, executionId } = await fixture(t, { removeSandbox: async () => new Response('{}', { status: fail ? 503 : 200 }) });
    const current = service.getExecution(executionId);
    const context = new ContextService(service.db, { taskService: service });
    const registry = registered ? createBuiltinServiceRegistry({ taskService: service, contextService: context }) : null;
    const bridge = new ServicesBridge({ taskService: service, contextService: context, runtime, registry,
      actorRef: current.owner_ref, taskId: current.task_id, executionId });
    try {
      const receipt = await bridge.call({ operation: 'task_finish', service_id: 'task', payload: { outcome: 'incomplete' }, operation_id: 'finish:bridge' });
      assert.equal(receipt.execution.state, 'CLOSING');
      assert.equal(receipt.disposition, 'closing');
      assert.equal(receipt.cleanup_pending, true);
      assert.equal(bridge.executionId, executionId);
      assert.equal(service.getTask(current.task_id).state, 'RUNNING');
    } finally {
      fail = false;
      await runtime.releaseExecution(executionId);
    }
  });
}

test('Runtime retries a transient finish cleanup failure without CLI or benchmark assistance', { timeout: 30000 }, async (t) => {
  let attempts = 0;
  const { service, runtime, executionId } = await fixture(t, {
    removeSandbox: async () => new Response('{}', { status: ++attempts === 1 ? 503 : 200 }),
    runtimeOptions: { finishCleanupRetryMs: 10 },
  });
  const closed = deferred();
  service.subscribeTaskEvents((event) => { if (event.kind === 'task_finish_closed') closed.resolve(); });
  const execution = service.getExecution(executionId);
  service.dispatch('task_finish', { outcome: 'incomplete' }, makeEnvelope({ actorRef: execution.owner_ref, taskId: execution.task_id,
    executionId, specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version }));
  await closed.promise;
  await runtime.waitForExecutionRelease(executionId, { timeoutMs: 10000 });
  assert.equal(attempts, 2);
  assert.equal(service.getExecution(executionId).state, 'HANDED_OFF');
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('automatic finish cleanup has a retry bound and retains ownership when exhausted', { timeout: 30000 }, async (t) => {
  let attempts = 0;
  let fail = true;
  const retried = deferred();
  const { service, runtime, executionId } = await fixture(t, {
    removeSandbox: async () => { if (++attempts === 2) retried.resolve(); return new Response('{}', { status: fail ? 503 : 200 }); },
    runtimeOptions: { finishCleanupRetryMs: 10, maxFinishCleanupRetries: 1 },
  });
  const execution = service.getExecution(executionId);
  service.dispatch('task_finish', { outcome: 'incomplete' }, makeEnvelope({ actorRef: execution.owner_ref, taskId: execution.task_id,
    executionId, specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version }));
  try {
    await retried.promise;
    await runtime.waitForSettled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(attempts, 2);
    assert.equal(service.getExecution(executionId).state, 'CLOSING');
    assert.equal(service.getTask(execution.task_id).state, 'RUNNING');
    assert.equal(runtime.getCoreStatus('core-1').state, 'CLOSING');
  } finally {
    fail = false;
    await runtime.sweepExpired();
  }
  assert.equal(service.getExecution(executionId).state, 'HANDED_OFF');
});

test('maintenance retries retained Workspace cleanup after finish is already terminal', { timeout: 30000 }, async (t) => {
  const exhausted = deferred();
  const { service, runtime, executionId } = await fixture(t, { runtimeOptions: {
    finishCleanupRetryMs: 10, maxFinishCleanupRetries: 1,
    logger: { append(event) { if (event.event === 'runtime.finish_cleanup_pending' && event.retries_exhausted) exhausted.resolve(); } },
  } });
  const execution = service.getExecution(executionId);
  const originalPath = execution.workspace_ref;
  const temporarilyUnavailable = `${originalPath}-offline`;
  await rename(originalPath, temporarilyUnavailable);
  try {
    service.dispatch('task_finish', { outcome: 'incomplete' }, makeEnvelope({ actorRef: execution.owner_ref, taskId: execution.task_id,
      executionId, specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version }));
    await exhausted.promise;
    await runtime.waitForSettled();
    assert.equal(service.getExecution(executionId).state, 'HANDED_OFF');
    assert.equal(runtime.getCoreStatus('core-1').state, 'CLOSING');
  } finally { await rename(temporarilyUnavailable, originalPath); }
  await runtime.sweepExpired();
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});
