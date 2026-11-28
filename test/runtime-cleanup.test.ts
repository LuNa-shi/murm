import { sdkFixtureFetch } from '../test-support/opensandbox-sdk-fixture.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TaskService } from '../examples/taskpool/services/task/task-service.js';
import { makeEnvelope } from '../examples/taskpool/persistence/envelope.js';
import { Runtime } from '../test-support/taskpool-legacy/runtime.js';
import { MissionWorkspace } from '../examples/taskpool/services/workspace/mission-workspace.js';
import { WorkspaceManager } from '../examples/taskpool/services/workspace/workspace-manager.js';
import { createOpenSandboxManager as createSdkManager } from '../src/core/sandbox/opensandbox-manager.js';

import { ServicesBridge } from '../test-support/taskpool-legacy/services-bridge.js';
import { ContextService } from '../examples/taskpool/services/material/context-service.js';
import { createBuiltinServiceRegistry } from '../examples/taskpool/services/builtin-registry.js';


function createOpenSandboxManager(options) {
  return createSdkManager({ ...options, fetchImpl: sdkFixtureFetch(options.fetchImpl), waitForExecdReady: options.waitForExecdReady ?? false });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, { removeSandbox = async () => new Response('{}'), runtimeOptions = {} } = {}) {
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
      if (url.endsWith('/start')) return new Response(JSON.stringify({ result: { contract: { version: 'murm-core-v2', resources: [] }, project_files: { version: 0, writable: false } } }));
      if (url.includes('/project/')) {
        const input = JSON.parse(options.body);
        return new Response(JSON.stringify({ result: { state: url.endsWith('/prepare') ? 'PREPARED' : 'ACTIVE', execution_id: input.execution_id, binding_version: input.binding_version } }));
      }
      if (url.endsWith('/command')) return new Response('event: execution_complete\ndata: {"type":"execution_complete","exit_code":0}\n\n');
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
  const startSession = async ({ agent, onSandboxCreated, beforeAgentStart }) => {
    await sandboxManager.ensureExecution({ executionId: agent.resource_key, agentId: agent.agent_id, onCreated: onSandboxCreated });
    await sandboxManager.startAgent({ executionId: agent.resource_key, command: 'pi', resources: [], args: [], beforeAgentStart });
    return session;
  };
  const { agent } = await runtime.startAgent({ missionId: 'mission:cleanup', coreId: 'core-1', startSession });
  const take = service.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'take:cleanup' });
  await runtime.bindAgentExecution(take.execution.execution_id, session, { coreId: 'core-1' });
  return { service, runtime, sandboxManager, session, executionId: take.execution.execution_id };
}

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

test('Runtime retries a transient finish cleanup failure without an operator retry', { timeout: 30000 }, async (t) => {
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
  await runtime.waitForSettled();
  assert.equal(attempts, 2);
  assert.equal(service.getExecution(executionId).state, 'HANDED_OFF');
  assert.equal(runtime.hasActiveExecution(executionId), false);
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
