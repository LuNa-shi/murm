import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TaskService } from '../src/task/task-service.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
import { TaskController } from '../src/runtime/task-controller.js';
import { Runtime } from '../src/runtime/runtime.js';
import { WorkspaceManager } from '../src/runtime/workspace-manager.js';
import { createOpenSandboxManager } from '../src/runtime/opensandbox-manager.js';
import { ServicesBridge } from '../src/agent/services-bridge.js';
import { ContextService } from '../src/context/context-service.js';
import { createBuiltinServiceRegistry } from '../src/sdk/builtin-registry.js';
import { CoreParallelismTracker } from '../src/benchmark/parallelism.js';
import { ObservationStore } from '../src/observability/observation-store.js';
import { closeProjectStores, ensureAgentSession, releaseTerminalExecution, stopCore, stopBenchmarkRuntime, withinRunDeadline, runBenchmarkProject } from '../src/benchmark/putnam-runner.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, { removeSandbox = async () => new Response('{}'), bind = true, runtimeOptions = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-cleanup-'));
  const service = new TaskService();
  let sandboxDeleted = false;
  const sandboxManager = createOpenSandboxManager({
    lifecycleBaseUrl: 'http://sandbox.test/v1', image: 'image:test',
    fetchImpl: async (url, options) => {
      if (options.method === 'DELETE') {
        const response = await removeSandbox();
        if (response.ok && response.status !== 202 || response.status === 404) sandboxDeleted = true;
        return response;
      }
      if (sandboxDeleted && url.endsWith('/sandboxes/sandbox-test')) return new Response('{}', { status: 404 });
      if (url.endsWith('/sandboxes')) return new Response(JSON.stringify({ id: 'sandbox-test' }), { status: 202 });
      if (url.includes('/endpoints/')) return new Response(JSON.stringify({ url: 'http://execd.test' }));
      if (url.endsWith('/command')) return new Response('event: execution_complete\ndata: {"exit_code":0}\n\n');
      return new Response('{}');
    },
  });
  const runtime = new Runtime({ taskService: service, workspaceManager: new WorkspaceManager({ rootDir: root }), agentAdapter: {}, sandboxManager, ...runtimeOptions });
  t.after(async () => {
    await runtime.shutdown();
    service.close();
    await rm(root, { recursive: true, force: true });
  });
  const envelope = () => makeEnvelope({ actorRef: 'bot:cleanup' });
  service.dispatch('mission.create', { mission_id: 'mission:cleanup', goal: 'Verify safe Core reuse' }, envelope());
  const task = service.dispatch('task.create', { mission_id: 'mission:cleanup', summary: 'Inspect one local result', goal: 'Inspect one local result', expected_output: 'Inspection note', acceptance_conditions: ['Note records the inspection'] }, envelope()).task;
  const take = service.takeTask(task.task_id, { owner_ref: 'bot:cleanup', core_id: 'core-1', take_key: 'take:cleanup', workspace_mode: 'clean' });
  // The model process is the external boundary. Task Service, Runtime,
  // Workspace and the OpenSandbox protocol adapter are real collaborators.
  const session = new EventEmitter();
  session.closed = false;
  session.stop = async () => { session.closed = true; session.emit('close'); };
  if (bind) await runtime.bindAgentExecution(take.execution.execution_id, session, { coreId: 'core-1', sendInitialPrompt: false });
  return { service, runtime, sandboxManager, session, executionId: take.execution.execution_id };
}

function benchmarkCore({ service, runtime, session, executionId }) {
  const core = { index: 1, runtime, session, executionId, taskId: service.getExecution(executionId).task_id, sessionHistory: [session], errors: [], parallelism: new CoreParallelismTracker({ coreCount: 1 }) };
  core.parallelism.transition(1, 'RUNNING', { execution_id: executionId, task_id: core.taskId });
  core.bridge = new ServicesBridge({ taskService: service, contextService: new ContextService(service.db), runtime, actorRef: service.getExecution(executionId).owner_ref, taskId: core.taskId, executionId,
    onRelease: () => { core.taskId = null; core.executionId = null; },
  });
  return core;
}

test('Runtime retains Core occupancy until provider deletion is confirmed', async (t) => {
  const removing = deferred();
  const removed = deferred();
  const { runtime, executionId } = await fixture(t, { removeSandbox: async () => { removing.resolve(); await removed.promise; return new Response('{}'); } });
  const release = runtime.releaseExecution(executionId);
  try {
    await removing.promise;
    assert.equal(runtime.getCoreStatus('core-1').state, 'CLOSING');
    assert.equal(runtime.getCoreStatus('core-1').execution_id, executionId);
    assert.equal(runtime.getCapacityStatus().idle_core_count, 0);
    assert.equal(runtime.hasActiveExecution(executionId), true);
  } finally {
    removed.resolve();
    await release;
  }
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
  assert.equal(runtime.hasActiveExecution(executionId), false);
});

test('failed provider deletion retains cleanup ownership and a later retry releases the Core', async (t) => {
  let fail = true;
  const { runtime, sandboxManager, executionId } = await fixture(t, { removeSandbox: async () => new Response('{}', { status: fail ? 503 : 200 }) });
  try {
    await assert.rejects(runtime.releaseExecution(executionId), (error) => error.code === 'SERVICE_UNAVAILABLE');
    assert.equal(runtime.getCoreStatus('core-1').state, 'CLOSING');
    assert.equal(runtime.hasActiveExecution(executionId), true);
    assert.equal(sandboxManager.snapshot().executions.length, 1);
  } finally { fail = false; }
  await runtime.releaseExecution(executionId);
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
  assert.equal(sandboxManager.snapshot().executions.length, 0);
  await runtime.releaseExecution(executionId);
});

test('a model process that fails to stop keeps its Core occupied for cleanup retry', async (t) => {
  const { runtime, session, executionId } = await fixture(t);
  const stop = session.stop;
  session.stop = async () => { throw new Error('process still alive'); };
  try {
    await assert.rejects(runtime.releaseExecution(executionId), /process still alive/);
    assert.equal(runtime.getCoreStatus('core-1').state, 'CLOSING');
    assert.equal(runtime.hasActiveExecution(executionId), true);
  } finally { session.stop = stop; }
  await runtime.releaseExecution(executionId);
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('operator stop retains the Core when sandbox cleanup fails and can be retried', async (t) => {
  let fail = true;
  const { runtime, executionId } = await fixture(t, { removeSandbox: async () => new Response('{}', { status: fail ? 503 : 200 }) });
  try {
    await assert.rejects(runtime.stopExecution(executionId), (error) => error.code === 'SERVICE_UNAVAILABLE');
    assert.equal(runtime.getCoreStatus('core-1').state, 'CLOSING');
    assert.equal(runtime.hasActiveExecution(executionId), true);
    assert.equal(runtime.taskService.getExecution(executionId).state, 'RUNNING', 'Task owner must survive unconfirmed isolation');
  } finally { fail = false; }
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
  await runtime.releaseExecution(executionId);
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

test('benchmark terminal release preserves its Bridge binding on cleanup failure and retries it', async (t) => {
  let fail = true;
  const setup = await fixture(t, { removeSandbox: async () => new Response('{}', { status: fail ? 503 : 200 }) });
  const core = benchmarkCore(setup);
  const execution = setup.service.getExecution(setup.executionId);
  setup.service.dispatch('stop_execution', { terminal_state: 'FAILED', terminal_reason: 'test' }, makeEnvelope({ actorRef: execution.owner_ref, taskId: execution.task_id, executionId: execution.execution_id, specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version }));
  try {
    assert.equal((await releaseTerminalExecution(core)).cleanup_pending, true);
    assert.equal(core.executionId, setup.executionId);
    assert.equal(core.bridge.executionId, setup.executionId);
  } finally { fail = false; }
  await releaseTerminalExecution(core);
  assert.equal(core.executionId, null);
  assert.equal(core.bridge.executionId, null);
});

test('benchmark shutdown reports unconfirmed cleanup without declaring capacity idle', async (t) => {
  let fail = true;
  const setup = await fixture(t, { removeSandbox: async () => new Response('{}', { status: fail ? 503 : 200 }) });
  const core = benchmarkCore(setup);
  const state = { cleanupErrors: [], taskService: setup.service };
  try {
    await stopCore(state, core);
    assert.equal(state.cleanupErrors.some(error => error.code === 'RUNTIME_CLEANUP_PENDING'), true);
    assert.equal(setup.runtime.getCoreStatus('core-1').state, 'CLOSING');
    assert.equal(core.executionId, setup.executionId);
  } finally { fail = false; }
  await stopCore(state, core);
  assert.equal(setup.runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('unexpected process exit retains cleanup ownership when provider deletion fails', async (t) => {
  let fail = true;
  const { runtime, session, executionId } = await fixture(t, { removeSandbox: async () => new Response('{}', { status: fail ? 503 : 200 }) });
  try {
    session.closed = true;
    session.emit('close');
    await runtime.waitForSettled();
    assert.equal(runtime.hasActiveExecution(executionId), true);
    assert.equal(runtime.getCoreStatus('core-1').state, 'CLOSING');
  } finally { fail = false; }
  await runtime.stopExecution(executionId, 'FAILED');
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('failed initial prompt retains its startup binding if rollback cannot delete the sandbox', async (t) => {
  let fail = true;
  const { runtime, session, executionId } = await fixture(t, { bind: false, removeSandbox: async () => new Response('{}', { status: fail ? 503 : 200 }) });
  session.prompt = async () => { throw new Error('provider prompt failed'); };
  try {
    await assert.rejects(runtime.bindAgentExecution(executionId, session, { coreId: 'core-1' }));
    assert.equal(runtime.hasActiveExecution(executionId), true);
    assert.equal(runtime.getCoreStatus('core-1').state, 'CLOSING');
  } finally { fail = false; }
  await runtime.stopExecution(executionId, 'FAILED');
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
    await assert.rejects(runtime.releaseExecution(executionId));
    assert.equal(runtime.getCoreStatus('core-1').state, 'CLOSING');
  } finally {
    await rm(revisions);
    await rename(backup, revisions);
  }
  await runtime.releaseExecution(executionId);
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
  assert.equal(service.getExecution(executionId).state, 'EXPIRED');
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('an accepted asynchronous provider deletion is not yet a free Core', async (t) => {
  let pending = true;
  const { runtime, executionId } = await fixture(t, { removeSandbox: async () => new Response('{}', { status: pending ? 202 : 200 }) });
  try {
    await assert.rejects(runtime.releaseExecution(executionId), (error) => error.code === 'SERVICE_UNAVAILABLE');
    assert.equal(runtime.getCoreStatus('core-1').state, 'CLOSING');
  } finally { pending = false; }
  await runtime.releaseExecution(executionId);
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('explicit restart stops even a compatibility reusable Session before starting its replacement', async (t) => {
  const { runtime, session, executionId } = await fixture(t);
  runtime.freshBotPerExecution = false;
  session.identitySession = true;
  const replacement = new EventEmitter();
  replacement.closed = false;
  replacement.stop = async () => { replacement.closed = true; };
  runtime.agentAdapter = { start: async () => replacement };
  await runtime.restartSession(executionId);
  assert.equal(session.closed, true);
  assert.equal(replacement.closed, false);
});

test('closing lease expiry rejects Runtime heartbeat and does not enter watchdog recovery', async (t) => {
  const removing = deferred();
  const removed = deferred();
  const { runtime, service, executionId } = await fixture(t, { removeSandbox: async () => { removing.resolve(); await removed.promise; return new Response('{}'); } });
  const expires = new Date(Date.parse(service.getExecution(executionId).lease_expires_at) + 1);
  const closing = runtime.sweepExpired(expires);
  try {
    await removing.promise;
    assert.throws(() => runtime.heartbeat(executionId), (error) => error.code === 'NOT_ALLOWED');
    assert.equal(runtime.getSessionHealth(executionId).phase, 'closing');
    assert.deepEqual(await runtime.sweepWatchdog(new Date(expires.getTime() + 600_000)), []);
  } finally { removed.resolve(); }
  await closing;
  assert.equal(service.getExecution(executionId).state, 'EXPIRED');
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('benchmark does not discard a closed unbound Session whose sandbox still needs cleanup', async () => {
  let fail = true;
  const session = { closed: true, stop: async () => { if (fail) throw new Error('delete pending'); } };
  const core = { session, errors: [], stopping: true };
  assert.equal(await ensureAgentSession(core), false);
  assert.equal(core.session, session);
  fail = false;
  assert.equal(await ensureAgentSession(core), false);
  assert.equal(core.session, null);
});

test('manifest persistence failure after process launch still stops the newly created process', async (t) => {
  const { runtime, session, executionId } = await fixture(t, { bind: false });
  runtime.agentAdapter = { start: async ({ cwd }) => {
    await rm(join(cwd, 'runtime-manifest.json'), { force: true });
    await mkdir(join(cwd, 'runtime-manifest.json'));
    return session;
  } };
  await assert.rejects(runtime.startExecution(executionId));
  assert.equal(session.closed, true);
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('Runtime shutdown joins a process launch that has not yet registered its Session', async (t) => {
  const { runtime, session, service, executionId } = await fixture(t, { bind: false });
  const entered = deferred();
  const finishStart = deferred();
  runtime.agentAdapter = { start: async () => { entered.resolve(); await finishStart.promise; return session; } };
  const starting = runtime.startExecution(executionId);
  const rejected = assert.rejects(starting, /stopped/);
  await entered.promise;
  let shutdownFinished = false;
  const shuttingDown = runtime.shutdown().then(result => { shutdownFinished = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(shutdownFinished, false);
  finishStart.resolve();
  const [, result] = await Promise.all([rejected, shuttingDown]);
  assert.equal(session.closed, true);
  assert.equal(result.active_process_count, 0);
  assert.equal(service.getExecution(executionId).state, 'FAILED');
});

test('benchmark startup join shares cleanup grace and reports a still-pending launch', async (t) => {
  const setup = await fixture(t);
  const core = benchmarkCore(setup);
  const startup = deferred();
  core.sessionStartPromise = startup.promise;
  const state = { taskService: setup.service, cleanupErrors: [] };
  try {
    await stopCore(state, core, { cleanupGraceMs: 5 });
    assert.equal(state.cleanupErrors.some(error => error.code === 'STARTUP_CLEANUP_TIMEOUT'), true);
    assert.equal(core.sessionStartPromise, startup.promise);
  } finally { startup.resolve(); }
});

test('accepted incomplete finish keeps the Task occupied through failed cleanup and closes exactly once after retry', async (t) => {
  let fail = true;
  const { service, runtime, executionId } = await fixture(t, { removeSandbox: async () => new Response('{}', { status: fail ? 503 : 200 }) });
  const execution = service.getExecution(executionId);
  const envelope = makeEnvelope({ operationId: 'finish:cleanup', actorRef: execution.owner_ref, taskId: execution.task_id,
    executionId, specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version });
  service.dispatch('task_finish', { outcome: 'incomplete', reason: 'Continue this responsibility in a fresh Bot' }, envelope);
  try {
    await assert.rejects(runtime.releaseExecution(executionId), (error) => error.code === 'SERVICE_UNAVAILABLE');
    assert.equal(service.getExecution(executionId).state, 'CLOSING');
    assert.equal(service.getTask(execution.task_id).state, 'RUNNING');
    assert.equal(service.listEligibleTasks().length, 0);
  } finally {
    fail = false;
    await runtime.releaseExecution(executionId);
  }
  assert.equal(service.getExecution(executionId).state, 'HANDED_OFF');
  assert.equal(service.getTask(execution.task_id).state, 'OPEN');
  const successor = service.takeTask(execution.task_id, { owner_ref: 'bot:next', core_id: 'core-1', take_key: 'next' });
  await runtime.releaseExecution(executionId);
  assert.equal(service.getActiveExecutionForCore('core-1').execution_id, successor.execution.execution_id);
  assert.equal(service.getTask(execution.task_id).state, 'RUNNING');
});

test('Runtime completes an accepted finish without a live CLI caller', { timeout: 3000 }, async (t) => {
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

test('benchmark retries an accepted finish that remained closing after provider failure', async (t) => {
  let fail = true;
  const env = await fixture(t, { removeSandbox: async () => new Response('{}', { status: fail ? 503 : 200 }) });
  const { service, runtime, executionId } = env;
  const core = benchmarkCore(env);
  const current = service.getExecution(executionId);
  service.dispatch('task_finish', { outcome: 'incomplete' }, makeEnvelope({ actorRef: current.owner_ref, taskId: current.task_id,
    executionId, specVersion: current.spec_version, stateVersion: current.state_version, fencingVersion: current.fencing_version }));
  try { await assert.rejects(runtime.releaseExecution(executionId)); } finally { fail = false; }
  await releaseTerminalExecution(core);
  assert.equal(service.getExecution(executionId).state, 'HANDED_OFF');
  assert.equal(core.executionId, null);
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

for (const trigger of ['restart', 'process_exit', 'fence']) {
  test(`finish wins safely while ${trigger} awaits physical isolation`, async (t) => {
    const removing = deferred();
    const removed = deferred();
    const { service, runtime, session, executionId } = await fixture(t, { removeSandbox: async () => { removing.resolve(); await removed.promise; return new Response('{}'); } });
    let pending;
    if (trigger === 'restart') pending = runtime.restartSession(executionId);
    else if (trigger === 'fence') pending = runtime.fenceExecution(executionId);
    else { session.closed = true; session.emit('close'); }
    // Capture asynchronous rejection before the controlled stop resolves.
    const completed = pending?.then((value) => ({ value }), (error) => ({ error }));
    await removing.promise;
    const execution = service.getExecution(executionId);
    service.dispatch('task_finish', { outcome: 'incomplete' }, makeEnvelope({ actorRef: execution.owner_ref, taskId: execution.task_id,
      executionId, specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version }));
    removed.resolve();
    const result = await completed;
    await runtime.releaseExecution(executionId);
    assert.equal(result?.error, undefined);
    assert.equal(service.getExecution(executionId).state, 'HANDED_OFF');
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


test('concurrent Bridge and benchmark cleanup release only their original binding', async (t) => {
  const removing = deferred();
  const removed = deferred();
  const env = await fixture(t, { removeSandbox: async () => { removing.resolve(); await removed.promise; return new Response('{}'); } });
  const core = benchmarkCore(env);
  const finish = core.bridge.call({ operation: 'task_finish', service_id: 'task', payload: { outcome: 'incomplete' } });
  await removing.promise;
  const sweep = releaseTerminalExecution(core);
  removed.resolve();
  await Promise.all([finish, sweep]);
  assert.equal(core.executionId, null);
  assert.equal(core.bridge.executionId, null);
  assert.equal(env.service.getExecution(env.executionId).state, 'HANDED_OFF');
});


test('Runtime retries a transient finish cleanup failure without CLI or benchmark assistance', { timeout: 3000 }, async (t) => {
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
  await runtime.waitForExecutionRelease(executionId, { timeoutMs: 1000 });
  assert.equal(attempts, 2);
  assert.equal(service.getExecution(executionId).state, 'HANDED_OFF');
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('automatic finish cleanup has a retry bound and retains ownership when exhausted', { timeout: 3000 }, async (t) => {
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

test('maintenance retries retained Workspace cleanup after finish is already terminal', { timeout: 3000 }, async (t) => {
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

test('one cleanup deadline bounds held orchestration and Bridge drains while every Core stops', async () => {
  const held = deferred();
  const events = [];
  const state = { cleanupErrors: [], identityLoopAbortController: new AbortController(),
    identityLoops: [{ stop: () => events.push('loop-stopped') }], identityLoopRuns: [held.promise],
    controller: { stop: async () => { events.push('controller-stopped'); await held.promise; } },
    backgroundStopPromises: [held.promise], cores: [1, 2, 3, 4].map(index => ({ index, sessionHistory: [],
      bridge: { stop: async () => { events.push(`bridge-${index}`); if (index === 1) await held.promise; } },
      runtime: { shutdown: async () => { events.push(`runtime-${index}`); return { active_process_count: 0 }; }, waitForSettled: async () => {} },
    })) };
  const runStarted = Date.now();
  await assert.rejects(withinRunDeadline(state, () => held.promise, runStarted + 20), { code: 'BENCHMARK_TIMEBOX_EXPIRED' });
  assert.equal(state.pendingRunOperations.size, 1);
  const cleanupStarted = Date.now();
  try {
    await stopBenchmarkRuntime(state, { cleanupGraceMs: 50 });
    assert.ok(Date.now() - cleanupStarted < 750, 'independent waits must share one grace period');
    assert.equal(state.identityLoopAbortController.signal.aborted, true);
    for (let index = 1; index <= 4; index += 1) assert.ok(events.includes(`runtime-${index}`));
    for (const code of ['CONTROLLER_STOP_TIMEOUT', 'IDENTITY_LOOP_STOP_TIMEOUT', 'BACKGROUND_STOP_TIMEOUT', 'BRIDGE_CLEANUP_TIMEOUT']) {
      assert.ok(state.cleanupErrors.some(error => error.code === code), code);
    }
  } finally { held.resolve(); await state.cleanupPromise; }
  assert.equal(state.pendingRunOperations.size, 0);
  let startedLate = false;
  await assert.rejects(withinRunDeadline(state, () => { startedLate = true; }, Date.now() - 1), { code: 'BENCHMARK_TIMEBOX_EXPIRED' });
  assert.equal(startedLate, false);
});

test('Controller stop prevents a held public-token read from waking another Bot later', async () => {
  const entered = deferred(), held = deferred();
  let wakeups = 0;
  const controller = new TaskController({ listEligibleTasks: () => [], listBlockedTasks: () => [], sweepIntervalMs: 0,
    listIdentityLoops: () => [{ core_id: 'core-1', state: 'IDLE', healthy: true }],
    readPublicChangeToken: async () => { entered.resolve(); await held.promise; return 'new-public-work'; },
    signalIdleIdentity: () => { wakeups += 1; } });
  const reconciling = controller.reconcile();
  await entered.promise;
  const stopping = controller.stop();
  held.resolve();
  await Promise.all([reconciling, stopping]);
  assert.equal(wakeups, 0);
});

test('bounded benchmark cleanup reports pending and retains stores through late observation writes', async () => {
  const observer = new ObservationStore();
  const held = deferred();
  const state = { cores: [], cleanupErrors: [], controller: { async stop() {
    await held.promise;
    observer.append({ experimentId: 'delayed', source: 'runtime', kind: 'cleanup_confirmed' });
  } } };
  observer.registerExperiment({ experimentId: 'delayed' });
  let pending, projectClosed = false, observerClosed = false;
  try {
    await stopBenchmarkRuntime(state, { cleanupGraceMs: 20 });
    assert.equal(state.cleanupErrors[0]?.code, 'CONTROLLER_STOP_TIMEOUT');
    closeProjectStores(state, () => { projectClosed = true; }, {
      onCleanupPending(promise) { pending = promise; },
    });
    assert.ok(pending instanceof Promise);
    assert.equal(projectClosed, false);
    held.resolve();
    await pending;
    assert.equal(projectClosed, true);
    assert.equal(observer.listEvents({ experimentId: 'delayed' }).events[0]?.kind, 'cleanup_confirmed');
    observer.close();
    observerClosed = true;
  } finally {
    held.resolve();
    await state.cleanupPromise;
    if (!observerClosed) observer.close();
  }
});

for (const failure of ['initialization', 'orchestration', 'report-write']) test(`benchmark closes authority after ${failure} failure without allocating a Bot`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'benchmark-failure-'));
  const requests = [];
  const server = createServer((request, response) => { requests.push(request.method); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ items: [] })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  let service;
  const problem = { id: 'controlled_cleanup', problem_file: 'input.lean', source: 'theorem fixture : True := by trivial', source_hash: 'a'.repeat(64) };
  const config = { lean_project_root: root, putnam_bench_root: root, putnambench_commit: 'b'.repeat(40), lean_toolchain: 'controlled', mathlib_version: 'controlled', checker_ref: 'controlled', checker_version: '1', environment_ref: 'controlled' };
  await assert.rejects(runBenchmarkProject(problem, config, { experimentDir: root, reportDir: join(root, 'reports'), timeboxMs: 0, botMaxMs: 60_000,
    sandbox: { enabled: true, provider: 'opensandbox', lifecycleBaseUrl: `http://127.0.0.1:${server.address().port}`, image: 'controlled:test' },
    prepareProject: async ({ taskService }) => {
      service = taskService;
      if (failure === 'initialization') throw new Error('controlled initialization failure');
      if (failure === 'orchestration') service.listMissionTasks = () => { throw new Error('controlled orchestration failure'); };
      else await mkdir(join(root, 'reports', problem.id, 'report.json'));
    },
  }), failure === 'report-write' ? { code: 'EISDIR' } : new RegExp(`controlled ${failure} failure`));
  assert.ok(service);
  assert.throws(() => service.db.prepare('SELECT 1'), /closed|not open/i);
  assert.ok(requests.length > 0);
  assert.ok(requests.every(method => method === 'GET'), 'controlled preflight reads only; no provider allocation or model calls');
});
