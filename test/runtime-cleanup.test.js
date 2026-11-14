import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TaskService } from '../src/task/task-service.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
import { Runtime } from '../src/runtime/runtime.js';
import { WorkspaceManager } from '../src/runtime/workspace-manager.js';
import { createOpenSandboxManager } from '../src/runtime/opensandbox-manager.js';
import { ServicesBridge } from '../src/agent/services-bridge.js';
import { ContextService } from '../src/context/context-service.js';
import { CoreParallelismTracker } from '../src/benchmark/parallelism.js';
import { ensureAgentSession, releaseTerminalExecution, stopCore } from '../src/benchmark/putnam-runner.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, { removeSandbox = async () => new Response('{}'), bind = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-cleanup-'));
  const service = new TaskService();
  const sandboxManager = createOpenSandboxManager({
    lifecycleBaseUrl: 'http://sandbox.test/v1', image: 'image:test',
    fetchImpl: async (url, options) => {
      if (options.method === 'DELETE') return removeSandbox();
      if (url.endsWith('/sandboxes')) return new Response(JSON.stringify({ id: 'sandbox-test' }), { status: 202 });
      if (url.includes('/endpoints/')) return new Response(JSON.stringify({ url: 'http://execd.test' }));
      if (url.endsWith('/command')) return new Response('event: execution_complete\ndata: {"exit_code":0}\n\n');
      return new Response('{}');
    },
  });
  const runtime = new Runtime({ taskService: service, workspaceManager: new WorkspaceManager({ rootDir: root }), agentAdapter: {}, sandboxManager });
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
  core.bridge = new ServicesBridge({ taskService: service, contextService: new ContextService(service.db), runtime, taskId: core.taskId, executionId,
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
