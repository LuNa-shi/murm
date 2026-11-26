import { createWorkspaceMergeService } from '../examples/taskpool/workspace-merge.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskService } from '../src/task/task-service.js';
import { ACTIVE_EXECUTION_STATES } from '../src/task/task-types.js';
import { Runtime } from '../src/runtime/runtime.js';
import { WorkspaceManager } from '../src/runtime/workspace-manager.js';
import { MissionWorkspace } from '../src/runtime/mission-workspace.js';
import { createMissionCoordination } from '../examples/taskpool/mission-coordination.js';
import { createMissionSubmissionAccess } from '../src/runtime/mission-submission-access.js';
import { createOpenSandboxManager } from '../src/runtime/opensandbox-manager.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
import { stableStringify } from '../src/protocol/envelope.js';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listTools } from '../src/sdk/service-catalog.js';
import { ServicesBridge } from '../src/agent/services-bridge.js';
import { ContextService } from '../src/context/context-service.js';
import { createBuiltinServiceRegistry } from '../src/sdk/builtin-registry.js';
import { startIndependentServices } from '../src/sdk/independent-services.js';
import { MurmError, ERROR_CODES } from '../src/errors.js';

async function assertExecutionReleased(runtime, service, executionId, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (runtime.hasActiveExecution(executionId) || ACTIVE_EXECUTION_STATES.includes(service.getExecution(executionId)?.state)) {
    assert.ok(performance.now() < deadline, `Execution ${executionId} did not release within ${timeoutMs} ms`);
    await delay(25);
  }
}

async function fixture(t, runtimeOptions = {}, { persistent = false, acceptanceConditions = {}, mergeRequiredCheck = null, beforeFetch = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-agent-'));
  const service = new TaskService(persistent ? join(root, 'state.sqlite') : ':memory:');
  service.createMission({ mission_id: 'mission:agents', goal: 'Inspect independent questions', acceptance_conditions: acceptanceConditions, merge_required_check: mergeRequiredCheck }, makeEnvelope({ actorRef: 'operator:test' }));
  const calls = [];
  let sandboxNumber = 0;
  const deletedSandboxes = new Set();
  const manager = createOpenSandboxManager({ lifecycleBaseUrl: 'http://provider.test', image: 'test:agent', waitForExecdReady: false,
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      await beforeFetch?.(url, options);
      if (options.method === 'DELETE') { deletedSandboxes.add(url); return new Response('{}'); }
      if (options.method === 'GET' && deletedSandboxes.has(url)) return new Response('{}', { status: 404 });
      if (url.endsWith('/sandboxes')) return new Response(JSON.stringify({ id: `sandbox:${++sandboxNumber}` }), { status: 202 });
      if (url.includes('/endpoints/')) return new Response(JSON.stringify({ url: 'http://execd.test' }));
      if (url.endsWith('/stop')) return new Response(JSON.stringify({ result: { stopped: true } }));
      if (url.endsWith('/start')) return new Response(JSON.stringify({ result: { contract: { version: 'murm-core-v1', resources: [] }, project_files: { version: 0, writable: false } } }));
      if (url.includes('/project/')) {
        const input = JSON.parse(options.body);
        return new Response(JSON.stringify({ result: { state: url.endsWith('/prepare') ? 'PREPARED' : 'ACTIVE', execution_id: input.execution_id, binding_version: input.binding_version } }));
      }
      if (url.endsWith('/command')) return new Response('event: execution_complete\ndata: {"exit_code":0}\n\n');
      return new Response('{}');
    },
  });
  const missionWorkspace = new MissionWorkspace({ rootDir: join(root, 'default-public') });
  await missionWorkspace.create({ missionId: 'mission:agents', workspaceId: 'workspace-default', initialFiles: { 'input.txt': 'public project input' } });
  const runtime = new Runtime({ taskService: service, missionWorkspace, missionWorkspaceId: 'workspace-default', workspaceManager: new WorkspaceManager({ rootDir: root }), sandboxManager: manager, ...runtimeOptions });
  const missionSubmission = { store: null };
  const domains = { workspaceMerge: null };
  t.after(async () => {
    const mergeClosing = domains.workspaceMerge?.close();
    await missionSubmission.store?.stop({ missionId: 'mission:agents' });
    await runtime.shutdown();
    const mergeReceipt = await mergeClosing;
    if (mergeReceipt?.cleanup === 'pending') throw new Error('Workspace merge checker cleanup remains pending');
    service.close();
    await rm(root, { recursive: true, force: true });
  });
  const startSession = async ({ agent, onSandboxCreated, beforeAgentStart }) => {
    const sandbox = await manager.ensureExecution({ executionId: agent.resource_key, agentId: agent.agent_id, onCreated: onSandboxCreated });
    await manager.startAgent({ executionId: agent.resource_key, command: 'pi', resources: [], args: [], beforeAgentStart });
    const session = new EventEmitter();
    session.closed = false;
    session.waitForReady = async () => {};
    session.stop = async () => { session.closed = true; session.emit('close'); };
    return session;
  };
  return { root, service, runtime, manager, startSession, calls, missionSubmission, domains };
}

test('Mission timeout preserves a fresh Agent proposal after earlier Tasks finish and the previous Agent closes', async t => {
  const identity = { checker_ref: 'controlled', checker_version: '1', environment_ref: 'test' };
  const { service, runtime, startSession, missionSubmission } = await fixture(t, { coordinationPermissions: ['mission_submit'] },
    { acceptanceConditions: { required_check: identity } });
  const context = new ContextService(':memory:', { taskService: service });
  t.after(() => context.close());
  const missionId = 'mission:agents';
  const coreId = 'core-1';
  const store = createMissionCoordination({ taskService: service, contextService: context, missionId,
    workspace: runtime.missionWorkspace, workspaceId: runtime.missionWorkspaceId,
    deadline: Date.now() + 60_000,
    checker: { identity, check: () => { throw new MurmError('SERVICE_TIMEOUT', 'controlled final-check timeout'); } },
  });
  missionSubmission.store = store;
  const create = (summary, actorRef) => service.createTask({ gap: 'Resolve the boundary required by this test Mission', priority: 'medium', mission_id: missionId, summary,
    expected_output: 'Reproducible result', acceptance_conditions: ['Evidence is published'] }, makeEnvelope({ actorRef })).task;
  const former = create('Check a completed responsibility', 'operator:test');
  const done = service.takeTask(former.task_id, { owner_ref: 'agent:earlier', core_id: 'core-earlier', take_key: 'earlier' }).execution;
  service.dispatch('task_finish', { outcome: 'done' }, makeEnvelope({ actorRef: done.owner_ref,
    taskId: done.task_id, executionId: done.execution_id, specVersion: done.spec_version,
    stateVersion: done.state_version, fencingVersion: done.fencing_version }));
  service.finalizeExecutionFinish(done.execution_id, { fencingVersion: done.fencing_version });
  assert.equal(service.getTask(former.task_id).state, 'DONE');

  const starter = () => runtime.startAgent({ missionId, coreId, startSession });
  const first = await starter();
  const submission = await store.submit({ missionId, workspaceId: runtime.missionWorkspaceId,
    actorRef: first.agent.agent_id, materialIds: [], requestId: 'final-timeout' });
  await store.waitForIdle();
  assert.equal((await store.get({ missionId, submissionId: submission.submission_id })).state, 'timed_out');
  assert.equal((await runtime.missionWorkspace.get({ workspaceId: runtime.missionWorkspaceId })).frozen_submission_id, null);
  const retry = await store.submit({ missionId, workspaceId: runtime.missionWorkspaceId,
    actorRef: first.agent.agent_id, materialIds: [], requestId: 'same-snapshot' });
  assert.equal(retry.result.code, 'MISSION_RETRY_EXHAUSTED');

  // Mission timeout and exhausted same-snapshot retry do not imply Mission
  // acceptance or prevent an authorized host from starting a fresh Agent.
  service.requestAgentStop(first.agent.agent_id, 'selection-budget');
  await runtime.releaseAgent(first.agent.agent_id);
  assert.equal(first.session.closed, true);
  assert.equal(service.getAgent(first.agent.agent_id).state, 'CLOSED');
  const second = await starter();
  assert.notEqual(second.agent.agent_id, first.agent.agent_id);
  assert.equal(second.agent.core_id, first.agent.core_id);
  const proposed = create('Find a smaller proof that fits the final check budget', second.agent.agent_id);
  assert.ok(proposed);
  assert.equal(service.getTask(former.task_id).state, 'DONE');
  assert.equal(service.listActiveExecutions().length, 0);
});

for (const boundary of ['accepted Mission', 'Runtime stop', 'run deadline'])
for (const checkpoint of ['sandbox dispatch', 'sandbox receipt', 'Pi dispatch', 'ready']) test(
  `${boundary} prevents late Agent ${checkpoint} and releases its resources`, async t => {
    let entered, resume, agentId;
    const reached = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { resume = resolve; });
    const { service, runtime, manager, startSession, calls } = await fixture(t, {}, {
      beforeFetch: async (url, { method }) => {
        if ((checkpoint === 'Pi dispatch' && url.endsWith('/health')) ||
            (checkpoint === 'sandbox receipt' && method === 'POST' && url.endsWith('/sandboxes'))) {
          entered();
          await gate;
        }
      },
    });
    const starting = runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession: async options => {
      agentId = options.agent.agent_id;
      if (checkpoint === 'sandbox dispatch') { entered(); await gate; }
      await manager.ensureExecution({ executionId: agentId, agentId,
        onCreateDispatch: options.onSandboxCreateDispatch, onCreated: options.onSandboxCreated });
      const session = await startSession({ ...options, beforeAgentStart: options.assertStartupAllowed });
      if (checkpoint === 'ready') session.waitForReady = async () => { entered(); await gate; };
      return session;
    } });
    const rejected = assert.rejects(starting, { code: ERROR_CODES.NOT_ALLOWED });
    await reached;
    if (checkpoint === 'sandbox receipt') assert.equal(service.getAgent(agentId).sandbox_create_state, 'UNKNOWN');
    let shutdown;
    if (boundary === 'accepted Mission') service.setMissionStopReader(id => id === 'mission:agents');
    if (boundary === 'Runtime stop') shutdown = runtime.shutdown();
    if (boundary === 'run deadline') runtime.setRunDeadline(Date.now());
    resume();
    await rejected;
    await shutdown;
    await runtime.releaseAgent(agentId);
    assert.equal(service.getAgent(agentId).state, 'CLOSED');
    assert.equal(service.getAgent(agentId).ready_at, null);
    if (checkpoint === 'sandbox receipt') {
      assert.equal(service.getAgent(agentId).sandbox_id, 'sandbox:1');
      assert.ok(calls.some(call => call.method === 'DELETE' && call.url.endsWith('/sandboxes/sandbox%3A1')));
    }
    assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
    assert.equal(manager.snapshot().executions.length, 0);
    assert.equal(calls.filter(call => call.method === 'POST' && call.url.endsWith('/sandboxes')).length, checkpoint === 'sandbox dispatch' ? 0 : 1);
    assert.equal(calls.filter(call => call.method === 'POST' && call.url.endsWith('/start')).length, checkpoint === 'ready' ? 1 : 0);
  },
);

test('expired startup retains the Core until the late Session has been stopped', async (t) => {
  const { service, runtime, startSession } = await fixture(t);
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  let agentId;
  const starting = runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', selectionTimeoutMs: 30,
    startSession: async (options) => { agentId = options.agent.agent_id; await gate; return startSession(options); },
  });
  const rejected = assert.rejects(starting, /stopped/);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(service.getAgent(agentId).state, 'CLOSING');
  await assert.rejects(runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession }), /occupied/);
  await rejected;
  resume();
  await new Promise(resolve => setImmediate(resolve));
  await runtime.releaseAgent(agentId);
  assert.equal(service.getAgent(agentId).state, 'CLOSED');
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('Execution binding rejects unregistered owners before preparing a Workspace', async t => {
  const { service, runtime, manager } = await fixture(t);
  const task = service.createTask({ mission_id: 'mission:agents', summary: 'Check a rejected legacy launch', expected_output: 'No resource allocation', acceptance_conditions: ['Unregistered launch denied'] }, makeEnvelope({ actorRef: 'operator:test' })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: 'agent:unregistered', core_id: 'core-1', take_key: 'legacy-binding' });
  await assert.rejects(runtime.bindAgentExecution(execution.execution_id, { stop() {} }, { coreId: 'core-1' }), { code: 'NOT_ALLOWED' });
  assert.equal(service.getExecution(execution.execution_id).state, 'CREATED');
  assert.equal(service.getExecution(execution.execution_id).workspace_ref, null);
  assert.equal(manager.snapshot().executions.length, 0);
  assert.equal(runtime.getActiveProcessCount(), 0);
});

test('taken Agent keeps its original Sandbox and closes before a successor can use the Core', async (t) => {
  const { service, runtime, manager, startSession, calls } = await fixture(t);
  const { agent, session } = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession });
  const task = service.createTask({ gap: 'Resolve the boundary required by this test Mission', priority: 'medium', mission_id: agent.mission_id, summary: 'Inspect a local question', expected_output: 'Reusable note', acceptance_conditions: ['Question answered'] }, makeEnvelope({ actorRef: agent.agent_id })).task;
  const taken = service.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'take:bound' });
  await assert.rejects(runtime.bindAgentExecution(taken.execution.execution_id, { stop() {} }, { coreId: agent.core_id }), /original Agent Session/);
  assert.equal(service.getExecution(taken.execution.execution_id).state, 'CREATED');
  await runtime.bindAgentExecution(taken.execution.execution_id, session, { coreId: 'core-1' });
  const execution = service.getExecution(taken.execution.execution_id);
  assert.equal(service.getAgent(agent.agent_id).state, 'ACTIVE');
  assert.equal(manager.snapshot().executions.length, 1);
  assert.equal(calls.filter(call => call.method === 'POST' && call.url.endsWith('/sandboxes')).length, 1);
  service.dispatch('task_finish', { outcome: 'incomplete' }, makeEnvelope({ actorRef: agent.agent_id, taskId: task.task_id, executionId: execution.execution_id,
    specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version }));
  await runtime.releaseExecution(execution.execution_id);
  assert.equal(service.getAgent(agent.agent_id).state, 'CLOSED');
  assert.equal(session.closed, true);
  assert.equal(runtime.agentBindings.size, 0);
  const next = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession });
  assert.notEqual(next.agent.agent_id, agent.agent_id);
  assert.notEqual(next.agent.sandbox_id, agent.sandbox_id);
});

for (const cause of ['selection-budget', 'shutdown']) test(`startup ${cause} stops a visible Session even when readiness never settles`, async (t) => {
  const { service, runtime, startSession } = await fixture(t);
  let visible;
  let observed;
  const readyEntered = new Promise(resolve => { observed = resolve; });
  const starting = runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', selectionTimeoutMs: cause === 'shutdown' ? 60_000 : 40,
    startSession: async options => {
      visible = await startSession(options);
      visible.waitForReady = () => { observed(); return new Promise(() => {}); };
      return visible;
    },
  });
  const rejected = assert.rejects(starting, /stopped/);
  await readyEntered;
  if (cause === 'shutdown') await runtime.shutdown();
  else await new Promise(resolve => setTimeout(resolve, 70));
  await rejected;
  assert.equal(visible.closed, true);
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
  assert.equal(service.db.prepare("SELECT state FROM agents").get().state, 'CLOSED');
});

test('pre-alias rollback stops the retained Agent Session and Sandbox', async (t) => {
  const { service, runtime, manager, startSession } = await fixture(t);
  const { agent, session } = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession });
  const task = service.createTask({ gap: 'Resolve the boundary required by this test Mission', priority: 'medium', mission_id: agent.mission_id, summary: 'Inspect one question while preparation is pending', expected_output: 'Note', acceptance_conditions: ['Reviewed'] }, makeEnvelope({ actorRef: agent.agent_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'take:pre-alias' });
  const foreign = { stop: async () => assert.fail('foreign Session must not become cleanup owner') };
  await assert.rejects(runtime.bindAgentExecution(execution.execution_id, foreign, { coreId: 'core-1' }), /original Agent/);
  await runtime.stopExecution(execution.execution_id, 'FAILED', 'prepare-rollback');
  assert.equal(session.closed, true);
  assert.equal(manager.snapshot().executions.length, 0);
  assert.equal(service.getAgent(agent.agent_id).state, 'CLOSED');
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('another owner cannot reserve a Task on the Core occupied by an unbound Agent', async (t) => {
  const { service, runtime, startSession } = await fixture(t);
  const { agent } = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession });
  const task = service.createTask({ gap: 'Resolve the boundary required by this test Mission', priority: 'medium', mission_id: agent.mission_id, summary: 'Inspect independent work on the occupied Core', expected_output: 'Note', acceptance_conditions: ['Reviewed'] }, makeEnvelope({ actorRef: agent.agent_id })).task;
  assert.throws(() => service.takeTask(task.task_id, { owner_ref: 'legacy:intruder', core_id: 'core-1', take_key: 'intruder' }), /another Agent/);
  assert.equal(service.listActiveExecutions().length, 0);
});

test('a Agent that closes during input preparation cannot become ACTIVE', async (t) => {
  const { service, runtime, manager, startSession } = await fixture(t);
  const { agent, session } = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession });
  const task = service.createTask({ gap: 'Resolve the boundary required by this test Mission', priority: 'medium', mission_id: agent.mission_id, summary: 'Inspect a question with delayed preparation', expected_output: 'Note', acceptance_conditions: ['Reviewed'] }, makeEnvelope({ actorRef: agent.agent_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'take:delayed' });
  let resume;
  let entered;
  const gate = new Promise(resolve => { resume = resolve; });
  const copying = new Promise(resolve => { entered = resolve; });
  const sync = manager.syncWorkspace.bind(manager);
  manager.syncWorkspace = async options => { entered(); await gate; return sync(options); };
  const binding = runtime.bindAgentExecution(execution.execution_id, session, { coreId: 'core-1' });
  const rejected = assert.rejects(binding);
  await copying;
  session.closed = true;
  session.emit('close');
  await runtime.stopExecution(execution.execution_id, 'FAILED', 'process-exited');
  const successor = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession });
  resume();
  await rejected;
  assert.notEqual(service.getExecution(execution.execution_id).state, 'RUNNING');
  assert.equal(service.getAgent(agent.agent_id).state, 'CLOSED');
  assert.equal(manager.snapshot().executions.length, 1);
  assert.equal(runtime.getCoreStatus('core-1').agent_id, successor.agent.agent_id);
  assert.equal(runtime.getCoreStatus('core-1').state, 'DISCOVERING');
});

test('provider input-copy rejection fails preparation and cleans the original Agent resource', async (t) => {
  const { service, runtime, manager, startSession } = await fixture(t);
  const { agent, session } = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession });
  const task = service.createTask({ gap: 'Resolve the boundary required by this test Mission', priority: 'medium', mission_id: agent.mission_id, summary: 'Inspect one question with a rejected input copy', expected_output: 'Note', acceptance_conditions: ['Reviewed'] }, makeEnvelope({ actorRef: agent.agent_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'take:copy-failed' });
  const providerFetch = manager.fetch;
  manager.fetch = (url, options) => url.endsWith('/project/prepare')
    ? Promise.resolve(new Response(JSON.stringify({ message: 'project input rejected' }), { status: 400 })) : providerFetch(url, options);
  await assert.rejects(runtime.bindAgentExecution(execution.execution_id, session, { coreId: 'core-1' }), error => error.code === ERROR_CODES.INVALID_CONTRACT && error.details?.status === 400);
  assert.equal(session.closed, true);
  assert.equal(service.getAgent(agent.agent_id).state, 'CLOSED');
  assert.equal(manager.snapshot().executions.length, 0);
  assert.notEqual(service.getExecution(execution.execution_id).state, 'RUNNING');
});

test('preparing process exit retries a transient deletion failure without a bind caller', async (t) => {
  const { service, runtime, manager, startSession } = await fixture(t, { finishCleanupRetryMs: 10, maxFinishCleanupRetries: 2 });
  const { agent, session } = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession });
  const task = service.createTask({ gap: 'Resolve the boundary required by this test Mission', priority: 'medium', mission_id: agent.mission_id, summary: 'Inspect pre-alias process failure cleanup', expected_output: 'Note', acceptance_conditions: ['Reviewed'] }, makeEnvelope({ actorRef: agent.agent_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'take:retry' });
  const providerFetch = manager.fetch;
  let deletes = 0;
  let deleted;
  const removed = new Promise(resolve => { deleted = resolve; });
  manager.fetch = (url, options) => {
    if (options.method === 'DELETE') {
      deletes += 1;
      if (deletes === 1) return Promise.resolve(new Response('{}', { status: 503 }));
      deleted();
    }
    return providerFetch(url, options);
  };
  session.closed = true;
  session.emit('close');
  assert.equal(service.getAgent(agent.agent_id).state, 'CLOSING');
  await removed;
  await runtime.stopExecution(execution.execution_id, 'FAILED', 'process-exited');
  assert.equal(deletes, 2);
  assert.equal(service.getAgent(agent.agent_id).state, 'CLOSED');
  assert.equal(service.getExecution(execution.execution_id).state, 'FAILED');
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('late factory Session is stopped even when it arrives inside a pending provider cleanup', { timeout: 5000 }, async (t) => {
  // The fake Session and provider gates have no I/O handles. Keep this test
  // alive until Runtime's unref'ed selection deadline can initiate cleanup.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const { service, runtime, manager, startSession } = await fixture(t);
  let allowSession;
  const sessionGate = new Promise(resolve => { allowSession = resolve; });
  let resourceReady;
  const resource = new Promise(resolve => { resourceReady = resolve; });
  let lateSession;
  const starting = runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', selectionTimeoutMs: 40,
    startSession: async options => {
      lateSession = await startSession(options);
      resourceReady();
      await sessionGate;
      return lateSession;
    },
  });
  const rejected = assert.rejects(starting, /stopped/);
  await resource;
  const providerFetch = manager.fetch;
  let remove;
  let deleting;
  const deletionGate = new Promise(resolve => { remove = resolve; });
  const deletionStarted = new Promise(resolve => { deleting = resolve; });
  manager.fetch = async (url, options) => {
    if (options.method === 'DELETE') { deleting(); await deletionGate; }
    return providerFetch(url, options);
  };
  await deletionStarted;
  allowSession();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lateSession.closed, false);
  remove();
  await rejected;
  assert.equal(lateSession.closed, true);
  assert.equal(service.db.prepare('SELECT state FROM agents').get().state, 'CLOSED');
  assert.equal(runtime.getCoreStatus('core-1').state, 'IDLE');
});

test('a new Agent finish cannot override a durable Runtime stop while provider deletion is pending', async (t) => {
  const { service, runtime, manager, startSession } = await fixture(t);
  const { agent, session } = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession });
  const task = service.createTask({ gap: 'Resolve the boundary required by this test Mission', priority: 'medium', mission_id: agent.mission_id, summary: 'Inspect competing terminal decisions safely', expected_output: 'Note', acceptance_conditions: ['Reviewed'] }, makeEnvelope({ actorRef: agent.agent_id })).task;
  const taken = service.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'take:finish-race' });
  await runtime.bindAgentExecution(taken.execution.execution_id, session, { coreId: 'core-1' });
  const execution = service.getExecution(taken.execution.execution_id);
  const providerFetch = manager.fetch;
  let remove;
  let deleting;
  const gate = new Promise(resolve => { remove = resolve; });
  const entered = new Promise(resolve => { deleting = resolve; });
  manager.fetch = async (url, options) => { if (options.method === 'DELETE') { deleting(); await gate; } return providerFetch(url, options); };
  const stopping = runtime.stopExecution(execution.execution_id, 'FAILED', 'operator-stop');
  await entered;
  try {
    assert.equal(service.getAgent(agent.agent_id).state, 'CLOSING');
    assert.throws(() => service.dispatch('task_finish', { outcome: 'done' }, makeEnvelope({ actorRef: agent.agent_id, taskId: task.task_id, executionId: execution.execution_id,
      specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version })), /active Agent/);
    assert.equal(service.getExecutionFinish(execution.execution_id), null);
  } finally { remove(); }
  await stopping;
  assert.equal(service.getExecution(execution.execution_id).state, 'FAILED');
  assert.equal(service.getExecution(execution.execution_id).terminal_reason, 'operator-stop');
});

test('prepare rollback joins the original stop and preserves its terminal reason', async (t) => {
  const { service, runtime, manager, startSession } = await fixture(t);
  const { agent, session } = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession });
  const task = service.createTask({ gap: 'Resolve the boundary required by this test Mission', priority: 'medium', mission_id: agent.mission_id, summary: 'Inspect prepare rollback joining an existing stop', expected_output: 'Note', acceptance_conditions: ['Reviewed'] }, makeEnvelope({ actorRef: agent.agent_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'take:stop-race' });
  let copied;
  let resumeCopy;
  const entered = new Promise(resolve => { copied = resolve; });
  const copyGate = new Promise(resolve => { resumeCopy = resolve; });
  const sync = manager.syncWorkspace.bind(manager);
  let finishedCopy;
  const copyFinished = new Promise(resolve => { finishedCopy = resolve; });
  manager.syncWorkspace = async options => { copied(); await copyGate; const result = await sync(options); finishedCopy(); return result; };
  let allowStop;
  let stopEntered;
  let physicalStops = 0;
  const stopGate = new Promise(resolve => { allowStop = resolve; });
  const stoppingStarted = new Promise(resolve => { stopEntered = resolve; });
  session.stop = async () => { if (!session.closed) { physicalStops += 1; stopEntered(); await stopGate; session.closed = true; session.emit('close'); } };
  const binding = runtime.bindAgentExecution(execution.execution_id, session, { coreId: 'core-1' });
  const rejected = assert.rejects(binding, /stopped during Task preparation/);
  await entered;
  const stopping = runtime.stopExecution(execution.execution_id, 'CANCELLED', 'explicit-user-stop');
  await stoppingStarted;
  resumeCopy();
  await copyFinished;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.getAgent(agent.agent_id).state, 'CLOSING');
  allowStop();
  await Promise.all([rejected, stopping]);
  assert.equal(physicalStops, 1);
  assert.equal(service.getExecution(execution.execution_id).state, 'CANCELLED');
  assert.equal(service.getExecution(execution.execution_id).terminal_reason, 'explicit-user-stop');
});

test('Agent lifetime is fixed before take and caps the active Execution deadline', async t => {
  const { service, runtime, startSession } = await fixture(t, { executionTimeoutMs: 60_000, handoffReminderMs: 50_000 });
  const { agent, session } = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', maxLifetimeMs: 5000, startSession });
  const task = service.createTask({ gap: 'Resolve the boundary required by this test Mission', priority: 'medium', mission_id: agent.mission_id, summary: 'Inspect a bounded independent research question', expected_output: 'Note', acceptance_conditions: ['Note written'], timebox_ms: 60_000 }, makeEnvelope({ actorRef: agent.agent_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'bounded-take' });
  await runtime.bindAgentExecution(execution.execution_id, session, { coreId: agent.core_id });
  assert.ok(Date.parse(service.getExecution(execution.execution_id).execution_deadline) <= Date.parse(agent.hard_deadline));
  await new Promise(resolve => setTimeout(resolve, Math.max(1, Date.parse(agent.hard_deadline) - Date.now() + 100)));
  await assertExecutionReleased(runtime, service, execution.execution_id, 1_000);
  assert.equal(service.getAgent(agent.agent_id).state, 'CLOSED');
  assert.equal(session.closed, true);
  assert.equal(service.getExecution(execution.execution_id).terminal_reason, 'agent-lifetime-budget');
});

for (const [budget, selectionFirst] of [['agent-lifetime-budget', false], ['agent-lifetime-budget', true], ['selection-budget', true]]) test(`${budget} stops a taken Agent while Workspace preparation has not returned (${selectionFirst ? 'selection' : 'hard'} callback first)`, async t => {
  const { service, runtime, startSession } = await fixture(t);
  // Git input export can take longer than the budget under load. Advance the
  // real deadline callbacks only after the intended preparation barrier.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const setTimer = globalThis.setTimeout;
  const callbackOrder = [];
  let armedTimers = 0;
  globalThis.setTimeout = (callback, delay, ...args) => {
    const index = armedTimers++;
    const invoke = () => {
      if (index < 2) callbackOrder.push(index === 0 ? 'hard' : 'selection');
      return callback(...args);
    };
    // Model a one-millisecond timer-registration skew between callbacks that
    // target the same persisted deadline; either callback may dispatch first.
    return setTimer(invoke, index === 0 && selectionFirst ? delay + 1 : delay);
  };

  let started;
  try {
    started = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', selectionTimeoutMs: budget === 'selection-budget' ? 1000 : 60_000, maxLifetimeMs: budget === 'agent-lifetime-budget' ? 1000 : 60_000, startSession });
  } finally { globalThis.setTimeout = setTimer; }
  const { agent, session } = started;
  const task = service.createTask({ gap: 'Resolve the boundary required by this test Mission', priority: 'medium', mission_id: agent.mission_id, summary: 'Prepare inputs for an independent research question', expected_output: 'Note', acceptance_conditions: ['Note'] }, makeEnvelope({ actorRef: agent.agent_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'prepare-budget' });
  const create = runtime.workspaceManager.createWorkspace.bind(runtime.workspaceManager);
  let release, enterPreparation, preparationEntered = false;
  const entered = new Promise(resolve => { enterPreparation = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  runtime.workspaceManager.createWorkspace = async options => { preparationEntered = true; enterPreparation(); await gate; return create(options); };
  const binding = runtime.bindAgentExecution(execution.execution_id, session, { coreId: agent.core_id });
  const rejected = assert.rejects(binding);
  try {
    await Promise.race([entered, binding]);
    assert.equal(preparationEntered, true);
    t.mock.timers.tick(1001);
    assert.equal(callbackOrder[0], selectionFirst ? 'selection' : 'hard');
    // The budget callback has fired; cleanup polling uses ordinary timers.
    t.mock.timers.reset();
    await assertExecutionReleased(runtime, service, execution.execution_id, 5_000);
    assert.equal(preparationEntered, true, 'the deadline must interrupt a pending Workspace preparation');
    assert.equal(session.closed, true);
    const stopped = service.getExecution(execution.execution_id);
    assert.equal(stopped.terminal_reason, budget);
    assert.equal(stopped.started_at, null);
    assert.equal(stopped.workspace_ref, null);
  } finally {
    release();
    await rejected;
  }
  assert.equal(service.getAgent(agent.agent_id).state, 'CLOSED');
});

test('elapsed Mission deadline rejects Agent creation before a provider request', async t => {
  const { runtime, startSession, calls } = await fixture(t);
  runtime.setRunDeadline(Date.now() - 1);
  await assert.rejects(runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession }), /deadline already elapsed/);
  assert.equal(calls.length, 0);
  for (const maxLifetimeMs of [0, -1, Infinity, 2_147_483_648]) {
    await assert.rejects(runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', maxLifetimeMs, startSession }), { code: 'INVALID_CONTRACT' });
  }
});

for (const boundary of ['task', 'agent']) test(`registered Agent ${boundary} timeout sweep uses hard stop without synthesizing a checkpoint`, async t => {
  const { service, runtime, startSession } = await fixture(t);
  const { agent, session } = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', maxLifetimeMs: 60_000, startSession });
  const task = service.createTask({ gap: 'Resolve the boundary required by this test Mission', priority: 'medium', mission_id: agent.mission_id, summary: 'Inspect an independent deadline boundary', expected_output: 'Note', acceptance_conditions: ['Note'], timebox_ms: boundary === 'task' ? 30_000 : 120_000 }, makeEnvelope({ actorRef: agent.agent_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: `deadline:${boundary}` });
  await runtime.bindAgentExecution(execution.execution_id, session, { coreId: agent.core_id });
  const deadline = service.getExecution(execution.execution_id).execution_deadline;
  await runtime.sweepExecutionTimeouts(new Date(deadline));
  assert.equal(service.getAgent(agent.agent_id).state, 'CLOSED');
  assert.equal(service.getExecution(execution.execution_id).terminal_reason, boundary === 'task' ? 'execution-timebox' : 'agent-lifetime-budget');
});

test('earlier Task hard deadline automatically stops a registered Agent without an external sweep', async t => {
  const { service, runtime, startSession } = await fixture(t);
  const { agent, session } = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', maxLifetimeMs: 60_000, startSession });
  const task = service.createTask({ gap: 'Resolve the boundary required by this test Mission', priority: 'medium', mission_id: agent.mission_id, summary: 'Inspect a locally bounded question', expected_output: 'Note', acceptance_conditions: ['Note'], timebox_ms: 150 }, makeEnvelope({ actorRef: agent.agent_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'automatic-short-task' });
  await runtime.bindAgentExecution(execution.execution_id, session, { coreId: agent.core_id });
  await assertExecutionReleased(runtime, service, execution.execution_id, 1_000);
  assert.equal(session.closed, true);
  assert.equal(service.getAgent(agent.agent_id).state, 'CLOSED');
  assert.equal(service.getExecution(execution.execution_id).terminal_reason, 'execution-timebox');
});

test('registered take pins the complete public tree even when main advances during preparation', async t => {
  const { root, service, runtime, startSession } = await fixture(t);
  const publicStore = new MissionWorkspace({ rootDir: join(root, 'public-repositories') });
  const files = Object.fromEntries([['README.md', 'Shared project description'], ['problem.lean', 'locked source'], ['config/settings.json', '{"setting":true}'], ['data/bytes.bin', Buffer.from([0, 255, 128])], ['.gitignore', 'scratch/\n'], ['__proto__', 'ordinary project data']]);
  await publicStore.create({ missionId: 'mission:agents', workspaceId: 'workspace-agents', initialFiles: files });
  runtime.missionWorkspace = publicStore;
  runtime.missionWorkspaceId = 'workspace-agents';
  const { agent, session } = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession });
  const task = service.createTask({ gap: 'Resolve the boundary required by this test Mission', priority: 'medium', mission_id: agent.mission_id, summary: 'Inspect the full shared project input', expected_output: 'Note', acceptance_conditions: ['Inputs inspected'] }, makeEnvelope({ actorRef: agent.agent_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'full-tree-input' });
  const create = runtime.workspaceManager.createWorkspace.bind(runtime.workspaceManager);
  runtime.workspaceManager.createWorkspace = async options => {
    const next = await publicStore.save({ workspaceId: 'workspace-agents', files: { ...files, 'later.txt': 'arrived after input resolution' } });
    await publicStore.merge({ workspaceId: 'workspace-agents', fromRevision: next.revision });
    return create(options);
  };
  const prepare = runtime.sandboxManager.prepareAgentProject.bind(runtime.sandboxManager);
  const grant = runtime.sandboxManager.grantAgentProject.bind(runtime.sandboxManager);
  const permissionOrder = [];
  runtime.sandboxManager.prepareAgentProject = async input => {
    assert.equal(service.getAgent(agent.agent_id).state, 'PREPARING');
    assert.equal(service.getExecution(execution.execution_id).state, 'CREATED');
    permissionOrder.push('prepare'); return prepare(input);
  };
  runtime.sandboxManager.grantAgentProject = async input => {
    assert.equal(service.getAgent(agent.agent_id).state, 'ACTIVE');
    assert.equal(service.getExecution(execution.execution_id).state, 'RUNNING');
    permissionOrder.push('grant'); return grant(input);
  };
  const { workspace } = await runtime.bindAgentExecution(execution.execution_id, session, { coreId: agent.core_id });
  const current = service.getExecution(execution.execution_id);
  assert.deepEqual(permissionOrder, ['prepare', 'grant']);
  assert.equal(current.workspace_input.revision, '0.1');
  assert.equal((await publicStore.get({ workspaceId: 'workspace-agents' })).main_revision, '0.3');
  assert.equal(current.workspace_input.git_commit, workspace.public_workspace_input.git_commit);
  assert.deepEqual(Object.keys(current.workspace_input.manifest).sort(), Object.keys(files).sort());
  for (const [path, content] of Object.entries(files)) assert.deepEqual(await readFile(join(workspace.workspace_ref, path)), Buffer.from(content));
  const names = await readdir(workspace.workspace_ref);
  for (const absent of ['later.txt', 'runtime-manifest.json', 'workspace-manifest.json', '.pi']) assert.equal(names.includes(absent), false);
  assert.throws(() => service.dispatch('save_workspace_revision', { workspace_ref: current.workspace_ref, workspace_revision: current.workspace_revision + 1,
    workspace_content_hash: 'next', workspace_input: { ...current.workspace_input, revision: '0.3' } }, makeEnvelope({ actorRef: 'runtime:test', taskId: task.task_id, executionId: current.execution_id,
      specVersion: current.spec_version, stateVersion: current.state_version, fencingVersion: current.fencing_version })), /immutable/);
  assert.equal(service.getExecution(execution.execution_id).workspace_input.revision, '0.1');
});

test('registered take fails closed when no authoritative Mission Workspace is wired', async t => {
  const { service, runtime, startSession } = await fixture(t);
  runtime.missionWorkspace = null;
  const { agent, session } = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession });
  const task = service.createTask({ gap: 'Resolve the boundary required by this test Mission', priority: 'medium', mission_id: agent.mission_id, summary: 'Try taking work without a trusted public input', expected_output: 'Note', acceptance_conditions: ['Note'] }, makeEnvelope({ actorRef: agent.agent_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'without-public-input' });
  await assert.rejects(runtime.bindAgentExecution(execution.execution_id, session, { sendInitialPrompt: false }), { code: 'SERVICE_NOT_READY' });
  assert.equal(service.getExecution(execution.execution_id).workspace_input, null);
  assert.equal(service.getAgent(agent.agent_id).state, 'CLOSED');
});

test('a Task cannot materialize another Mission public Workspace', async t => {
  const { root, service, runtime, startSession } = await fixture(t);
  runtime.missionWorkspace = new MissionWorkspace({ rootDir: join(root, 'public-repositories') });
  runtime.missionWorkspaceId = null;
  await runtime.missionWorkspace.create({ missionId: 'mission:other', workspaceId: 'workspace-other', initialFiles: { 'other.txt': 'private to another Mission' } });
  const { agent, session } = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession });
  const task = service.createTask({ gap: 'Resolve the boundary required by this test Mission', priority: 'medium', mission_id: agent.mission_id, summary: 'Attempt a foreign project input', expected_output: 'Note', acceptance_conditions: ['Note'], workspace: { workspace_id: 'workspace-other' } }, makeEnvelope({ actorRef: agent.agent_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'foreign-input' });
  await assert.rejects(runtime.bindAgentExecution(execution.execution_id, session, { coreId: agent.core_id }), /must belong to the Agent Mission/);
  assert.equal(service.getExecution(execution.execution_id).workspace_input, null);
  assert.equal(service.getAgent(agent.agent_id).state, 'CLOSED');
  assert.equal(session.closed, true);
});

test('a Task explicit public revision is used instead of the current main', async t => {
  const { root, service, runtime, startSession } = await fixture(t);
  runtime.missionWorkspace = new MissionWorkspace({ rootDir: join(root, 'public-repositories') });
  runtime.missionWorkspaceId = 'workspace-selected';
  await runtime.missionWorkspace.create({ missionId: 'mission:agents', workspaceId: 'workspace-selected', initialFiles: { 'input.txt': 'main' } });
  const saved = await runtime.missionWorkspace.save({ workspaceId: 'workspace-selected', files: { 'input.txt': 'selected saved revision' } });
  const { agent, session } = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession });
  const task = service.createTask({ gap: 'Resolve the boundary required by this test Mission', priority: 'medium', mission_id: agent.mission_id, summary: 'Inspect a specific public input revision', expected_output: 'Note', acceptance_conditions: ['Note'],
    workspace: { workspace_id: 'workspace-selected' }, base_revision: saved.revision }, makeEnvelope({ actorRef: agent.agent_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'selected-input' });
  const { workspace } = await runtime.bindAgentExecution(execution.execution_id, session, { coreId: agent.core_id });
  assert.equal(service.getExecution(execution.execution_id).workspace_input.revision, saved.revision);
  assert.equal(await readFile(join(workspace.workspace_ref, 'input.txt'), 'utf8'), 'selected saved revision');
});

test('a delayed project grant cannot return a successful binding after Agent stop', async t => {
  const { root, service, runtime, startSession } = await fixture(t);
  runtime.missionWorkspace = new MissionWorkspace({ rootDir: join(root, 'public-repositories') });
  runtime.missionWorkspaceId = 'workspace-late-grant';
  await runtime.missionWorkspace.create({ missionId: 'mission:agents', workspaceId: 'workspace-late-grant', initialFiles: { 'input.txt': 'input' } });
  const { agent, session } = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession });
  const task = service.createTask({ gap: 'Resolve the boundary required by this test Mission', priority: 'medium', mission_id: agent.mission_id, summary: 'Inspect a late permission transition', expected_output: 'Note', acceptance_conditions: ['Note'] }, makeEnvelope({ actorRef: agent.agent_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'late-grant' });
  let entered; let release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  runtime.sandboxManager.grantAgentProject = async () => { entered(); await gate; return { state: 'ACTIVE' }; };
  const binding = runtime.bindAgentExecution(execution.execution_id, session, { coreId: agent.core_id });
  const rejected = assert.rejects(binding, /stopped during project grant/);
  await started;
  await runtime.stopExecution(execution.execution_id, 'FAILED', 'controlled-hard-stop');
  release(); await rejected;
  assert.equal(service.getAgent(agent.agent_id).state, 'CLOSED');
  assert.equal(service.getExecution(execution.execution_id).terminal_reason, 'controlled-hard-stop');
  assert.equal(runtime.hasActiveExecution(execution.execution_id), false);
});

test('private Pi compaction and retry records preserve the registered Agent and explicit Workspace boundary', async t => {
  const { service, runtime, startSession } = await fixture(t);
  const { agent, session } = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession });
  const task = service.createTask({ mission_id: agent.mission_id, gap: 'Separate private memory from public delivery', priority: 'medium',
    summary: 'Keep private Pi memory independent of domain ownership',
    expected_output: 'An explicitly published result', acceptance_conditions: ['Public input remains fixed'],
  }, makeEnvelope({ actorRef: agent.agent_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'private-memory' });
  await runtime.bindAgentExecution(execution.execution_id, session, { coreId: agent.core_id });
  const before = service.getExecution(execution.execution_id);
  const messages = [];
  session.prompt = async message => { messages.push(message); };
  for (let index = 0; index < 4; index++) {
    session.emit('rpc', { type: 'compaction_start' });
    session.emit('rpc', { type: 'compaction_end', result: { tokensBefore: 1000, estimatedTokensAfter: 900 }, context_window: 1000 });
  }
  session.emit('rpc', { type: 'compaction_end', result: null, aborted: false });
  session.emit('rpc', { type: 'auto_retry_end', success: false, finalError: 'context token length exceeded' });
  session.emit('rpc', { type: 'message_end', message: { errorMessage: 'context length' } });
  const notice = service.enqueueNotification({ deliveryKey: `retained:${execution.execution_id}`, missionId: agent.mission_id,
    recipientTaskId: task.task_id, recipientExecutionId: execution.execution_id, type: 'handoff_warning',
    payload: { execution_id: execution.execution_id, deadline: before.execution_deadline } });
  session.emit('rpc', { type: 'turn_end' });
  session.emit('rpc', { type: 'auto_retry_end', success: true });
  await new Promise(resolve => setImmediate(resolve));
  await runtime.waitForSettled();
  const retainedNotice = service.listUnprocessedNotifications(task.task_id, execution.execution_id)
    .find(row => row.notification_id === notice.notification_id);
  assert.equal(retainedNotice.delivery_attempts, 0, 'Retired Runtime must not compete with the Environment input owner');
  assert.equal(retainedNotice.recipient_delivery, null);
  assert.equal(retainedNotice.handled_at, null);
  assert.equal(service.getAgent(agent.agent_id).state, 'ACTIVE');
  assert.equal(service.getExecution(execution.execution_id).state, 'RUNNING');
  assert.equal(service.getExecution(execution.execution_id).workspace_revision, before.workspace_revision);
  assert.equal(runtime.getCoreStatus(agent.core_id).state, 'RUNNING');
  assert.deepEqual(messages, []);
  assert.equal((await runtime.missionWorkspace.listRevisions({ workspaceId: 'workspace-default' })).length, 1);
});

async function workspaceFixture(t, options = {}) {
  const f = await fixture(t, options.runtimeOptions ?? {}, options);
  let session;
  let env;
  const context = new ContextService(f.service.db, { taskService: f.service });
  f.service.contextService = context;
  if (options.createMissionSubmissionStore) f.missionSubmission.store = options.createMissionSubmissionStore({ ...f, context });
  const workspaceMerge = createWorkspaceMergeService({ taskService: f.service, workspace: f.runtime.missionWorkspace,
    workspaceId: f.runtime.missionWorkspaceId, checker: options.workspaceMergeChecker,
    assertExecutionWorkspace: (identity, guardOptions) => f.runtime.assertExecutionWorkspace(identity, guardOptions) });
  f.domains.workspaceMerge = workspaceMerge;
  const bridge = new ServicesBridge({ taskService: f.service, contextService: context, runtime: f.runtime, coreId: 'core-1', workspaceMerge,
    missionSubmission: createMissionSubmissionAccess({ store: f.missionSubmission.store, workspaceId: f.runtime.missionWorkspaceId,
      isStopped: missionId => f.runtime.stopping || f.runtime.clock() >= (f.runtime.runDeadlineAt ?? Infinity) || f.service.isMissionStopped(missionId) }),
    registry: createBuiltinServiceRegistry({ taskService: f.service, contextService: context, missionWorkspace: f.runtime.missionWorkspace, missionSubmissionStore: f.missionSubmission.store, judgeService: options.createJudgeService?.(f.service, f.runtime) ?? options.judgeService }),
    onTake: result => f.runtime.bindAgentExecution(result.execution.execution_id, session, { coreId: 'core-1' }) });
  await bridge.start();
  t.after(() => bridge.stop());
  const { agent } = await f.runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession: async input => {
    env = bridge.startAgentIdentity(input.agent.agent_id);
    session = await f.startSession(input);
    return session;
  } });
  const task = f.service.createTask({ mission_id: agent.mission_id, summary: 'Produce a reusable project artifact', gap: 'Produce the public artifact needed for the Mission', priority: 'medium', expected_output: 'Public files', acceptance_conditions: ['Artifact saved'], completion_contract: options.completionContract ?? {} }, makeEnvelope({ actorRef: agent.agent_id })).task;
  await bridge.call({ operation: 'task_take', payload: { task_id: task.task_id }, operationId: 'workspace-take' });
  const execution = f.service.getExecution(bridge.executionId);
  const identity = { actorRef: agent.agent_id, taskId: task.task_id, executionId: execution.execution_id, fencingVersion: execution.fencing_version };
  const guest = { files: { 'input.txt': Buffer.from('public project input') }, captures: 0, before: null };
  f.manager.snapshotAgentProject = async ({ executionId }) => {
    const current = f.service.getExecution(executionId);
    if (guest.held) throw new MurmError(ERROR_CODES.WORKSPACE_BUSY, 'controlled install hold');
    guest.captures += 1;
    await guest.before?.();
    const manifest = Object.fromEntries(Object.entries(guest.files).map(([path, bytes]) => [path, { bytes: bytes.length, content_hash: createHash('sha256').update(bytes).digest('hex') }]));
    return { state: 'ACTIVE', execution_id: current.execution_id, binding_version: current.fencing_version, manifest,
      files: Object.fromEntries(Object.entries(guest.files).map(([path, bytes]) => [path, bytes.toString('base64')])), content_hash: createHash('sha256').update(stableStringify(manifest)).digest('hex') };
  };
  guest.receipts = new Map();
  guest.installs = 0;
  guest.installHook = null;
  guest.confirmHook = null;
  f.manager.queryAgentProjectInstall = async input => guest.receipts.get(input.request_id) ?? { execution_id: input.executionId,
    binding_version: f.service.getExecution(input.executionId).fencing_version, request_id: input.request_id, phase: 'not_found' };
  f.manager.installAgentProject = async input => {
    guest.installs += 1;
    await guest.installHook?.(input);
    guest.files = Object.fromEntries(Object.entries(input.files).map(([path, value]) => [path, Buffer.from(value, 'base64')]));
    const receipt = { execution_id: input.executionId, binding_version: f.service.getExecution(input.executionId).fencing_version, request_id: input.request_id,
      phase: 'installed', content_hash: input.content_hash, fingerprint: createHash('sha256').update(stableStringify({ content_hash: input.content_hash, expected_content_hash: input.expected_content_hash })).digest('hex') };
    guest.receipts.set(input.request_id, receipt); guest.held = true;
    return receipt;
  };
  f.manager.confirmAgentProjectInstall = async input => {
    await guest.confirmHook?.(input);
    const receipt = { ...guest.receipts.get(input.request_id), phase: 'committed' };
    guest.receipts.set(input.request_id, receipt); guest.held = false;
    return receipt;
  };
  const command = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, ['dist/scripts/swarm.js', ...args], { env: { PATH: process.env.PATH, ...env }, timeout: 15_000 })).stdout);
  const dispatch = (operation, requestId, input = {}) => f.runtime.dispatchExecutionWorkspace(operation, input, { ...identity, requestId });
  return { ...f, agent, bridge, execution, identity, guest, command, dispatch, context, workspaceMerge };
}

test('legacy Workspace routes reject live apply without a registered capability before guest work', async t => {
  const { command, bridge, dispatch, guest, service } = await workspaceFixture(t);
  assert.equal(listTools(null, { includeInternal: true }).some(tool => tool.operation === 'workspace_public_apply'), false);
  const { stdout: help } = await promisify(execFile)(process.execPath, ['dist/scripts/swarm.js', 'workspace', '--help']);
  assert.doesNotMatch(help, /\bapply\b/);
  await assert.rejects(command('workspace', 'apply', '--from', 'main'), error => JSON.parse(error.stderr).code === 'NOT_ALLOWED');
  const response = await fetch(`http://127.0.0.1:${bridge.address.port}/call`, { method: 'POST',
    headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ operation: 'workspace_public_apply', payload: { from: 'main' }, operation_id: 'retired' }) });
  assert.equal(response.status, 400);
  const rejected = await response.json();
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'NOT_ALLOWED');
  await assert.rejects(dispatch('apply', 'retired', { from: 'main' }), error => error.code === 'INVALID_CONTRACT');
  assert.equal(guest.captures, 0);
  assert.equal(guest.installs, 0);
  assert.equal(service.db.prepare('SELECT count(*) AS count FROM execution_workspace_requests').get().count, 0);
});

test('real CLI saves guest additions/deletions/binary files and chains immutable public revisions', async t => {
  const { runtime, command, dispatch, guest, execution, bridge } = await workspaceFixture(t);
  assert.equal((await command('workspace', 'status')).dirty, false);
  guest.files = { '2': Buffer.from([0, 255, 128]), '10': Buffer.from('ten'), 'nested/note.md': Buffer.from('first') };
  assert.deepEqual((await command('workspace', 'diff')).changed_paths, ['10', '2', 'input.txt', 'nested/note.md']);
  const saved = await command('workspace', 'save', '--request-id', 'save-one');
  assert.equal(saved.revision, '0.2');
  assert.deepEqual(saved.parents, ['0.1']);
  assert.equal((await command('workspace', 'view')).main_revision, '0.1');
  const exported = await runtime.missionWorkspace.exportRevision({ workspaceId: saved.workspace_id, revision: saved.revision });
  assert.deepEqual(exported.files['2'], Buffer.from([0, 255, 128]));
  assert.equal(exported.files['input.txt'], undefined);
  const captures = guest.captures;
  guest.files['nested/note.md'] = Buffer.from('second');
  assert.deepEqual(await command('workspace', 'save', '--request-id', 'save-one'), saved);
  assert.equal(guest.captures, captures);
  assert.equal((await command('workspace', 'status')).dirty, true);
  const next = await command('workspace', 'save', '--request-id', 'save-two');
  assert.deepEqual(next.parents, [saved.revision]);
  const status = await command('workspace', 'status');
  assert.equal(status.initial_revision, '0.1');
  assert.equal(status.last_saved_revision, next.revision);
  assert.equal(status.dirty, false);
  assert.equal((await command('workspace', 'history')).items.length, 1);
  const allHistory = await command('workspace', 'history', '--all');
  assert.equal(allHistory.items.length, 3);
  assert.equal(allHistory.items[0].reachable_from_main, false);
  assert.equal((await command('workspace', 'history', '--all', '--execution', execution.execution_id)).items.length, 2);
  assert.equal((await command('workspace', 'history', '--all', '--path', 'nested')).items.length, 2);
  const page = await command('workspace', 'history', '--all', '--limit', '1');
  assert.equal(page.items[0].revision, next.revision);
  assert.equal((await command('workspace', 'history', '--all', '--limit', '1', '--cursor', page.next_cursor)).items[0].revision, saved.revision);
  assert.equal(saved.source.execution_id, execution.execution_id);
  assert.equal(saved.source.task_id, execution.task_id);
  assert.equal(saved.content_hash, exported.content_hash);
  assert.equal((await command('workspace', 'read', 'nested/note.md', '--at', next.revision)).content, 'second');
  await assert.rejects(dispatch('status', 'save-one'), error => error.code === 'CONFLICT');
  await assert.rejects(bridge.call({ operation: 'workspace_save', payload: { files: { injected: 'bad' } } }), /cannot supply/);
  await assert.rejects(bridge.call({ operation: 'write_workspace_file', payload: { path: 'injected', content: 'bad' } }), { code: 'NOT_ALLOWED' });
  assert.equal(runtime.taskService.getExecution(execution.execution_id).workspace_input.revision, '0.1');
});

test('Git commit lost before SQL acknowledgement reconciles after E closes without recapturing', async t => {
  const { runtime, dispatch, service, agent, guest, execution } = await workspaceFixture(t);
  guest.files = { 'saved.txt': Buffer.from('persisted before close') };
  let faulted = false;
  runtime.missionWorkspace.repository.fault = point => { if (point === 'after_receipt' && !faulted) { faulted = true; throw new Error('controlled process loss after Git receipt'); } };
  await assert.rejects(dispatch('save', 'commit-first'), error => error.code === 'WORKSPACE_RESULT_UNKNOWN');
  assert.equal(service.db.prepare('SELECT phase FROM execution_workspace_requests WHERE request_id = ?').get('commit-first').phase, 'captured');
  runtime.missionWorkspace.repository.fault = null;
  guest.files = { 'different.txt': Buffer.from('must not recapture') };
  service.requestAgentStop(agent.agent_id, 'controlled-close', { terminalState: 'FAILED' });
  await runtime.executionWorkspace.reconcile(execution.execution_id);
  const result = await dispatch('save', 'commit-first');
  assert.equal(result.revision, '0.2');
  assert.equal(guest.captures, 1);
  assert.equal((await runtime.missionWorkspace.read({ workspaceId: 'workspace-default', revision: result.revision, path: 'saved.txt' })).content, 'persisted before close');
  assert.equal(service.db.prepare('SELECT phase FROM execution_workspace_requests WHERE request_id = ?').get('commit-first').phase, 'done');
});

test('Workspace contributions reject foreign identity, stale fence and closed Session before capture', async t => {
  const { runtime, identity, guest, service, agent, dispatch } = await workspaceFixture(t);
  const call = overrides => runtime.dispatchExecutionWorkspace('save', {}, { ...identity, requestId: 'unauthorized', ...overrides });
  await assert.rejects(call({ actorRef: 'agent:foreign' }), error => error.code === 'NOT_ALLOWED');
  await assert.rejects(call({ fencingVersion: identity.fencingVersion + 1 }), error => error.code === 'NOT_ALLOWED');
  const binding = runtime.agentBindings.get(agent.agent_id);
  binding.session.closed = true;
  await assert.rejects(dispatch('save', 'closed-session'), error => error.code === 'NOT_ALLOWED');
  binding.session.closed = false;
  service.db.prepare('UPDATE agents SET hard_deadline = ? WHERE agent_id = ?').run(new Date(Date.now() - 1).toISOString(), agent.agent_id);
  await assert.rejects(dispatch('save', 'expired'), error => error.code === 'NOT_ALLOWED');
  assert.equal(guest.captures, 0);
});

for (const method of ['stopExecution', 'fenceExecution']) test(`${method} retains Task ownership when pending save reconciliation fails`, async t => {
  const { service, runtime, execution, dispatch } = await workspaceFixture(t);
  await dispatch('save', 'before-stop');
  const reconcile = runtime.executionWorkspace.reconcile.bind(runtime.executionWorkspace);
  runtime.executionWorkspace.reconcile = async () => { throw new MurmError(ERROR_CODES.WORKSPACE_RECONCILIATION_REQUIRED, 'controlled unresolved receipt'); };
  await assert.rejects(runtime[method](execution.execution_id), error => error.code === 'WORKSPACE_RECONCILIATION_REQUIRED');
  assert.equal(service.getExecution(execution.execution_id).state, 'RUNNING');
  assert.equal(service.getTask(execution.task_id).state, 'RUNNING');
  runtime.executionWorkspace.reconcile = reconcile;
  await runtime[method](execution.execution_id);
  assert.notEqual(service.getExecution(execution.execution_id).state, 'RUNNING');
});

test('lease expiry keeps its durable intent and Task owner until Workspace receipts reconcile', async t => {
  const { service, runtime, execution, agent } = await workspaceFixture(t);
  service.db.prepare('UPDATE executions SET lease_expires_at = ? WHERE execution_id = ?').run(new Date(Date.now() - 1000).toISOString(), execution.execution_id);
  const reconcile = runtime.executionWorkspace.reconcile.bind(runtime.executionWorkspace);
  runtime.executionWorkspace.reconcile = async () => { throw new MurmError(ERROR_CODES.WORKSPACE_RECONCILIATION_REQUIRED, 'controlled lease receipt failure'); };
  await assert.rejects(runtime.sweepExpired(), error => error.code === 'WORKSPACE_RECONCILIATION_REQUIRED');
  assert.equal(service.getAgent(agent.agent_id).state, 'CLOSING');
  assert.equal(service.getAgent(agent.agent_id).stop_terminal_state, 'EXPIRED');
  assert.equal(service.getTask(execution.task_id).state, 'RUNNING');
  assert.equal(service.listEligibleTasks().length, 0);
  runtime.executionWorkspace.reconcile = reconcile;
  await runtime.sweepExpired();
  assert.equal(service.getExecution(execution.execution_id).state, 'EXPIRED');
  assert.equal(service.getTask(execution.task_id).state, 'OPEN');
});

test('lease renewal before atomic expiry intent keeps the Agent active', async t => {
  const { service, runtime, execution, agent } = await workspaceFixture(t);
  const cutoff = new Date();
  const original = service.listActiveExecutions.bind(service);
  service.db.prepare('UPDATE executions SET lease_expires_at = ? WHERE execution_id = ?').run(new Date(cutoff.getTime() - 1000).toISOString(), execution.execution_id);
  service.listActiveExecutions = () => {
    const rows = original();
    service.db.prepare('UPDATE executions SET lease_expires_at = ? WHERE execution_id = ?').run(new Date(cutoff.getTime() + 60_000).toISOString(), execution.execution_id);
    return rows;
  };
  assert.deepEqual(await runtime.sweepExpired(cutoff), []);
  assert.equal(service.getAgent(agent.agent_id).state, 'ACTIVE');
  assert.equal(service.getExecution(execution.execution_id).state, 'RUNNING');
});

// Represents an already durable pre-retirement request; no public operation can
// create this plan. The captured bytes and request identity must survive upgrade.
async function seedPendingInstall(f, requestId, phase = 'installing') {
  await f.dispatch('status', 'initialize-lineage');
  f.guest.captures = 0;
  const state = f.service.db.prepare('SELECT * FROM execution_workspace_state WHERE execution_id = ?').get(f.execution.execution_id);
  const files = { 'input.txt': Buffer.from('public project input'), peer: Buffer.from('previously captured contribution') };
  const manifest = Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, { bytes: bytes.length, content_hash: createHash('sha256').update(bytes).digest('hex') }]));
  const published = await f.runtime.missionWorkspace.save({ workspaceId: 'workspace-default', baseRevision: '0.1', files });
  const captured = { kind: 'apply', workspace_id: 'workspace-default', base_revision: '0.1', source_revision: published.revision,
    state_version: state.version, expected_content_hash: createHash('sha256').update(stableStringify(JSON.parse(state.manifest_json))).digest('hex'),
    content_hash: createHash('sha256').update(stableStringify(manifest)).digest('hex'), manifest,
    files: Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, bytes.toString('base64')])),
    parents: ['0.1', published.revision], conflicts: [], changed_paths: ['peer'], already_included: false,
    source: { mission_id: f.agent.mission_id, task_id: f.execution.task_id, execution_id: f.execution.execution_id,
      agent_id: f.agent.agent_id, fencing_version: f.execution.fencing_version } };
  f.service.db.prepare(`INSERT INTO execution_workspace_requests
    (execution_id, request_id, fingerprint, phase, captured_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(f.execution.execution_id, requestId, 'original-durable-fingerprint', phase, JSON.stringify(captured), new Date().toISOString(), new Date().toISOString());
  return () => f.service.db.prepare('SELECT * FROM execution_workspace_requests WHERE execution_id = ? AND request_id = ?').get(f.execution.execution_id, requestId);
}

test('persisted install recovery retries only original confirmation and preserves finish interlock', { timeout: 8000 }, async t => {
  const f = await workspaceFixture(t);
  const row = await seedPendingInstall(f, 'lost-ack', 'captured');
  let once = true;
  f.guest.confirmHook = () => { if (once) { once = false; throw new MurmError(ERROR_CODES.SERVICE_TIMEOUT, 'controlled acknowledgement loss'); } };
  f.guest.installHook = () => assert.throws(() => f.service.dispatch('task_finish', { outcome: 'incomplete' }, makeEnvelope({
    actorRef: f.agent.agent_id, taskId: f.execution.task_id, executionId: f.execution.execution_id,
    specVersion: f.execution.spec_version, stateVersion: f.execution.state_version, fencingVersion: f.execution.fencing_version })), error => error.code === 'WORKSPACE_BUSY');
  await assert.rejects(f.runtime.executionWorkspace.reconcile(f.execution.execution_id), error => error.code === 'WORKSPACE_RESULT_UNKNOWN');
  assert.equal(row().phase, 'installed');
  assert.equal(f.guest.held, true);
  const before = row().result_json;
  const until = Date.now() + 4000;
  while (f.guest.held && Date.now() < until) await delay(50);
  assert.equal(row().phase, 'done');
  assert.equal(row().result_json, before);
  assert.equal(row().captured_json, null);
  assert.equal(f.guest.held, false);
  assert.equal(f.guest.installs, 1);
  assert.equal(f.guest.captures, 0);
  assert.equal(f.guest.files.peer.toString(), 'previously captured contribution');
  await assert.rejects(f.dispatch('apply', 'lost-ack', { from: 'main' }), error => error.code === 'INVALID_CONTRACT');
  assert.equal(row().result_json, before);
});

test('persisted committed install retains original receipt through confirmed physical stop', async t => {
  const f = await workspaceFixture(t);
  const row = await seedPendingInstall(f, 'confirmed-before-close');
  const confirm = f.manager.confirmAgentProjectInstall;
  f.manager.confirmAgentProjectInstall = async input => { await confirm(input); throw new MurmError(ERROR_CODES.SERVICE_TIMEOUT, 'controlled response lost after resume'); };
  await assert.rejects(f.runtime.executionWorkspace.reconcile(f.execution.execution_id), error => error.code === 'WORKSPACE_RESULT_UNKNOWN');
  const before = row().result_json;
  assert.equal(row().phase, 'installed');
  assert.equal(f.guest.held, false);
  await f.runtime.stopExecution(f.execution.execution_id, 'FAILED', 'controlled-hard-stop');
  assert.equal(row().phase, 'done');
  assert.equal(row().result_json, before);
  assert.equal(f.guest.installs, 1);
  assert.equal(f.guest.captures, 0);
});

test('persisted install closing intent retains capture until physical close is confirmed', async t => {
  const f = await workspaceFixture(t);
  const row = await seedPendingInstall(f, 'close-query-race');
  f.guest.confirmHook = () => { throw new MurmError(ERROR_CODES.SERVICE_TIMEOUT, 'controlled held acknowledgement'); };
  await assert.rejects(f.runtime.executionWorkspace.reconcile(f.execution.execution_id), error => error.code === 'WORKSPACE_RESULT_UNKNOWN');
  f.service.requestAgentStop(f.agent.agent_id, 'controlled-close', { terminalState: 'FAILED' });
  const query = f.manager.queryAgentProjectInstall;
  f.manager.queryAgentProjectInstall = async () => { throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'physical stop still pending'); };
  await assert.rejects(f.runtime.executionWorkspace.reconcile(f.execution.execution_id), error => error.code === 'WORKSPACE_RESULT_UNKNOWN');
  assert.equal(row().phase, 'installed');
  assert.ok(row().captured_json);
  f.manager.queryAgentProjectInstall = query;
  await f.runtime.stopExecution(f.execution.execution_id);
  assert.equal(row().phase, 'failed');
  assert.equal(JSON.parse(row().error_json).details.worktree_closed, true);
  assert.equal(f.guest.installs, 1);
});

test('save still resolves inherited persisted conflict metadata without an apply route', async t => {
  const f = await workspaceFixture(t);
  await f.dispatch('status', 'initialize-conflicts');
  const conflicts = [{ artifact_root: 'workspace-conflicts-original', paths: ['input.txt'], marker_labels: ['original-base', 'original-source'],
    marker_lines: [{ path: 'input.txt', line: '<<<<<<< original-base', allowed_count: 0 }] }];
  f.service.db.prepare('UPDATE execution_workspace_state SET conflicts_json = ? WHERE execution_id = ?')
    .run(JSON.stringify(conflicts), f.execution.execution_id);
  f.guest.files['workspace-conflicts-original/current/input.txt'] = Buffer.from('old alternative');
  f.guest.files['input.txt'] = Buffer.from('<<<<<<< original-base\nunresolved\n');
  await assert.rejects(f.dispatch('save', 'alternatives-remain', { resolved: true }), error => error.code === 'INVALID_CONTRACT');
  delete f.guest.files['workspace-conflicts-original/current/input.txt'];
  await assert.rejects(f.dispatch('save', 'markers-remain', { resolved: true }), error => error.code === 'INVALID_CONTRACT');
  f.guest.files['input.txt'] = Buffer.from('explicitly chosen resolution');
  const saved = await f.dispatch('save', 'resolved-inherited', { resolved: true });
  assert.deepEqual(saved.conflicts, []);
  const snapshot = await f.runtime.missionWorkspace.exportRevision({ workspaceId: 'workspace-default', revision: saved.revision });
  assert.deepEqual(snapshot.conflicts, []);
  assert.equal(snapshot.files['input.txt'], 'explicitly chosen resolution');
  assert.equal(f.service.getExecution(f.execution.execution_id).workspace_input.revision, '0.1');
});

test('registered Judge CLI checks only a fixed public file and scopes durable results to its Mission', async t => {
  const { JudgeService } = await import('../src/judge/judge-service.js');
  const checked = [];
  let judge;
  const createJudgeService = service => (judge = new JudgeService(service.db, { taskService: service, fixtureManifest: { fixture_id: 'public-source', putnambench_commit: 'a'.repeat(40), problem_file: 'input.txt', problem_file_hash: 'b'.repeat(64), lean_toolchain: 'leanprover/lean4:v4.33.1', mathlib_version: 'test', checker_ref: 'lean', checker_version: 'test', environment_ref: 'test' }, checker: {
    preflight: async () => ({ status: 'healthy', checker_process_status: 'completed', evidence: { input_binding_verified: true, toolchain_version_verified: true, checker_version_verified: true } }),
    check: async input => { checked.push(input); return { verdict: 'PASS', evidence: { checker_started: true, exit_code: 0, private_internal_field: 'private checker stream', diagnostic: 'verified input' } }; },
  } }));
  const { runtime, command, dispatch, guest, bridge, service, agent } = await workspaceFixture(t, { createJudgeService });
  guest.files['proof.lean'] = Buffer.from('theorem local : True := by trivial');
  const saved = await dispatch('save', 'check-source-save');
  guest.files['proof.lean'] = Buffer.from('unsaved private edit');
  runtime.readWorkspaceFile = async () => { throw new Error('legacy host read must not occur'); };
  const current = service.getExecution(bridge.executionId);
  const legacyInput = { request_key: 'legacy-source-check', source: { workspace_id: 'workspace-default', revision: saved.revision, path: 'proof.lean', content: 'theorem local : True := by trivial' } };
  const legacyEnvelope = makeEnvelope({ actorRef: 'runtime:legacy', operationId: 'legacy-source-check', taskId: bridge.taskId, executionId: bridge.executionId, specVersion: current.spec_version, stateVersion: current.state_version });
  const legacy = await judge.checkWorkspaceSource(legacyInput, legacyEnvelope);
  assert.equal((await judge.checkWorkspaceSource(legacyInput, legacyEnvelope)).check_result_id, legacy.check_result_id);
  assert.equal(checked.length, 1);
  const result = await command('judge', 'check', '--at', saved.revision, '--path', 'proof.lean', '--request-id', 'public-source-check');
  assert.equal(result.verdict, 'PASS');
  assert.equal(checked.length, 2);
  assert.equal(checked[1].workspace_source.content, 'theorem local : True := by trivial');
  assert.equal(result.workspace_input.revision, saved.revision);
  assert.equal(result.workspace_input.git_tree, saved.git_tree);
  assert.equal(result.workspace_input.content_hash, createHash('sha256').update(checked[1].workspace_source.content).digest('hex'));
  assert.equal(result.evidence, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private checker stream/);
  service.db.prepare('UPDATE executions SET state_version = state_version + 1 WHERE execution_id = ?').run(bridge.executionId);
  const replay = await command('judge', 'check', '--revision', saved.revision, '--path', 'proof.lean', '--request-id', 'public-source-check');
  assert.deepEqual(replay, result);
  assert.equal(checked.length, 2);
  const read = await command('judge', 'result', '--check-result-id', result.check_result_id);
  assert.equal(read.workspace_input.revision, saved.revision);
  assert.equal(read.diagnostic_excerpt, result.diagnostic_excerpt);
  for (const payload of [{ path: 'proof.lean' }, { revision: saved.revision, path: 'proof.lean', source: { content: 'forged' } }, { revision: 'main', path: 'proof.lean' }]) {
    await assert.rejects(bridge.call({ operation: 'workspace_check', payload }), { code: 'INVALID_CONTRACT' });
  }
  await assert.rejects(bridge.call({ operation: 'workspace_check', payload: { revision: saved.revision, path: 'proof.lean', workspace_id: 'other-mission' } }), { code: 'NOT_ALLOWED' });
  await assert.rejects(bridge.call({ operation: 'workspace_check', operation_id: 'public-source-check', payload: { revision: saved.revision, path: 'input.txt' } }), { code: 'CONFLICT' });
  assert.equal(checked.length, 2);
  guest.files['proof.lean'] = Buffer.from('theorem local : True := by trivial');
  guest.files['other.txt'] = Buffer.from('a changed surrounding tree');
  const later = await dispatch('save', 'check-later-tree');
  const laterResult = await command('judge', 'check', '--revision', later.revision, '--path', 'proof.lean', '--request-id', 'later-public-check');
  assert.equal(checked.length, 3);
  assert.equal(laterResult.workspace_input.revision, later.revision);
  assert.equal(laterResult.workspace_input.git_tree, later.git_tree);
  assert.notEqual(laterResult.check_result_id, result.check_result_id);
  const alias = await command('judge', 'check', '--revision', later.revision, '--path', 'proof.lean', '--request-id', 'public-check-alias');
  assert.equal(alias.check_result_id, laterResult.check_result_id);
  assert.equal(checked.length, 3);
  const aliasQuery = await command('judge', 'result', '--request-key', 'public-check-alias');
  assert.equal(aliasQuery.check_result_id, laterResult.check_result_id);
  await assert.rejects(bridge.call({ operation: 'workspace_check', operation_id: 'public-check-alias', payload: { revision: saved.revision, path: 'proof.lean' } }), { code: 'CONFLICT' });
  assert.equal(checked.length, 3);
  const foreignMission = service.createMission({ mission_id: 'foreign-judge', goal: 'Other research' }, makeEnvelope({ actorRef: 'operator:test' })).mission;
  const foreignTask = service.createTask({ mission_id: foreignMission.mission_id, summary: 'Investigate an unrelated responsibility', expected_output: 'Other result', acceptance_conditions: ['Other evidence'] }, makeEnvelope({ actorRef: 'operator:test' })).task;
  judge.db.prepare('UPDATE check_results SET target_task_id = ? WHERE check_result_id = ?').run(foreignTask.task_id, result.check_result_id);
  await assert.rejects(bridge.call({ operation: 'get_check_result', payload: { check_result_id: result.check_result_id } }), { code: 'NOT_ALLOWED' });
  judge.db.prepare('UPDATE check_results SET target_task_id = ? WHERE check_result_id = ?').run(bridge.taskId, result.check_result_id);
  const reader = service.registerAgent({ missionId: agent.mission_id, coreId: 'core-2', selectionDeadline: new Date(Date.now() + 60000).toISOString() });
  const readerBridge = new ServicesBridge({ taskService: service, contextService: {}, runtime, coreId: 'core-2',
    registry: createBuiltinServiceRegistry({ taskService: service, judgeService: judge }) });
  await readerBridge.start(); t.after(() => readerBridge.stop());
  readerBridge.startAgentIdentity(reader.agent_id);
  service.recordAgentSandbox(reader.agent_id, { provider: 'controlled', sandboxId: 'reader-sandbox' }); service.markAgentReady(reader.agent_id);
  const publicResult = await readerBridge.call({ operation: 'get_check_result', payload: { check_result_id: result.check_result_id } });
  assert.equal(publicResult.workspace_input.revision, saved.revision);
  assert.equal(service.getAgent(reader.agent_id).execution_id, null);
  assert.equal(service.getAgent(agent.agent_id).state, 'ACTIVE');
});

test('registered Judge CLI forwards module mode and fences a late response while preserving its domain receipt', async t => {
  const { JudgeService } = await import('../src/judge/judge-service.js');
  const { LeanChecker } = await import('../src/judge/lean-adapter.js');
  const checkerIdentity = { checker_ref: 'lean', checker_version: 'test', environment_ref: 'test-project' };
  let holdBuild;
  let judge;
  const createJudgeService = (service, runtime) => {
    const checker = new LeanChecker({ projectChecker: async ({ tree, path, checkMode, startProcess }) => {
      return startProcess(async () => {
        await holdBuild?.();
        return { verdict: 'PASS', checked_tree: tree, ...(checkMode === 'lean-module' ? { scope: 'module', requested_path: path } : {}), checked_paths: ['Helper.lean', 'Proof.lean'],
          warnings: ['Helper.lean: provisional proof'] };
      });
    } });
    checker.preflight = async () => ({ status: 'healthy', checker_process_status: 'completed',
      evidence: { input_binding_verified: true, toolchain_version_verified: true, checker_version_verified: true } });
    judge = new JudgeService(service.db, { taskService: service, checker,
      readProjectRevision: reference => runtime.missionWorkspace.exportRevision(reference), fixtureManifest: {
        fixture_id: 'project-source', putnambench_commit: 'a'.repeat(40), problem_file: 'input.txt',
        problem_file_hash: 'b'.repeat(64), lean_toolchain: 'leanprover/lean4:v4.33.1', mathlib_version: 'test', ...checkerIdentity,
      } });
    service.setCheckResultReader(id => judge.getCheckResult(id));
    return judge;
  };
  const { service, command, dispatch, guest, bridge, execution } = await workspaceFixture(t, { createJudgeService,
    runtimeOptions: { workspaceProjectCheck: true },
    completionContract: { workspace_delivery: { paths: ['Proof.lean'], check: checkerIdentity } },
  });
  guest.files['Proof.lean'] = Buffer.from('import Helper\n/- No axiom. /- No admit. -/ -/\ntheorem proof : True := helper -- no sorry');
  guest.files['Helper.lean'] = Buffer.from('theorem helper : True := True.intro');
  const saved = await dispatch('save', 'fixed-project');
  const project = await command('judge', 'check', '--revision', saved.revision, '--request-id', 'project-check');
  const finish = checkId => command('task', 'finish', '--outcome', 'done', '--workspace-revision', saved.revision, '--check-result-id', checkId);
  await assert.rejects(finish(project.check_result_id), /did not pass for this delivery/);
  await assert.rejects(bridge.call({ operation: 'workspace_check', payload: { revision: saved.revision, files: {} } }), { code: 'INVALID_CONTRACT' });
  await assert.rejects(bridge.call({ operation: 'workspace_check', payload: { revision: saved.revision, path: 'input.txt' } }), { code: 'INVALID_CONTRACT' });
  const scoped = await command('judge', 'check', '--revision', saved.revision, '--path', 'Proof.lean', '--request-id', 'delivery-check');
  const module = await command('judge', 'check', '--revision', saved.revision, '--path', 'Proof.lean',
    '--check-mode', 'lean-module', '--request-id', 'cli-module-check');
  assert.equal(module.workspace_input.check_mode, 'lean-module');
  assert.equal(module.workspace_input.revision, saved.revision);
  assert.equal(module.workspace_input.path, 'Proof.lean');
  assert.equal(module.build.scope, 'module');
  assert.equal(module.build.requested_path, 'Proof.lean');
  await assert.rejects(finish(module.check_result_id), /did not pass for this delivery/);
  await assert.rejects(command('judge', 'check', '--revision', saved.revision, '--check-mode', 'lean-module'), /INVALID_CONTRACT/);
  const started = Promise.withResolvers();
  const settle = Promise.withResolvers();
  holdBuild = () => { started.resolve(); return settle.promise; };
  const fencedResponse = assert.rejects(bridge.call({ operation: 'workspace_check', operation_id: 'late-project-check',
    payload: { revision: saved.revision, path: 'Helper.lean' } }), { code: 'NOT_ALLOWED', message: 'Bridge is stopping' });
  await started.promise;
  let stopping;
  try {
    assert.equal((await finish(scoped.check_result_id)).workspace_delivery.check.checked_tree, saved.git_tree);
    stopping = bridge.stop();
  } finally { settle.resolve(); }
  await fencedResponse;
  await stopping;
  const late = judge.getByRequestKey('late-project-check');
  assert.equal(late.status, 'RECEIVED');
  assert.equal(late.target_task_id, execution.task_id);
  assert.equal(late.execution_id, execution.execution_id);
  assert.equal(late.evidence.workspace_input.git_tree, saved.git_tree);
  assert.equal(service.getExecution(execution.execution_id).state, 'SUCCEEDED');
  assert.equal(service.getAgent(execution.owner_ref).state, 'CLOSED');
  const lateReceipt = judge.getAgentCheckResult(late.check_result_id);
  assert.deepEqual(judge.dispatch('get_check_result', { request_key: 'late-project-check' }, makeEnvelope({ actorRef: 'operator:test' })), lateReceipt);
  assert.equal(lateReceipt.workspace_input.git_tree, saved.git_tree);
  assert.equal(lateReceipt.workspace_input.revision, saved.revision);
  assert.equal(lateReceipt.verdict, 'PASS');
});

const mergeCheckerIdentity = { checker_ref: 'controlled-tree', checker_version: '1', environment_ref: 'network-disabled-test' };

test('registered CLI distinguishes a failed merge check from a changed main', async t => {
  let beforeResult;
  const { runtime, command, dispatch, guest } = await workspaceFixture(t, {
    mergeRequiredCheck: mergeCheckerIdentity,
    workspaceMergeChecker: { identity: mergeCheckerIdentity, timeoutMs: 5000,
      async check() { return beforeResult ? beforeResult() : { verdict: 'FAIL' }; },
    },
  });
  guest.files['addition.txt'] = Buffer.from('saved contribution');
  const saved = await dispatch('save', 'merge-feedback-source');
  await assert.rejects(command('workspace', 'merge', '--from', saved.revision, '--request-id', 'merge-scientific-fail'), error => {
    const result = JSON.parse(error.stderr);
    assert.equal(result.details.main_revision, '0.1');
    assert.equal(result.details.source_revision, saved.revision);
    assert.match(result.details.notice, /最终合成树未通过 1：FAIL/);
    return true;
  });
  const peer = await runtime.missionWorkspace.save({ workspaceId: 'workspace-default', baseRevision: '0.1',
    files: { 'input.txt': 'public project input', 'peer.txt': 'another contribution' } });
  beforeResult = async () => {
    await runtime.missionWorkspace.merge({ workspaceId: 'workspace-default', fromRevision: peer.revision });
    return { verdict: 'PASS' };
  };
  await assert.rejects(command('workspace', 'merge', '--from', saved.revision, '--request-id', 'merge-main-moved'), error => {
    const result = JSON.parse(error.stderr);
    assert.equal(result.code, 'MAIN_MOVED');
    assert.equal(result.details.observed_revision, '0.1');
    assert.match(result.details.notice, /检查后 main 已从 0\.1 前进到 .*本请求未覆盖 main/);
    return true;
  });
});

test('registered CLI merge checks the final combined public tree and preserves the private E worktree', async t => {
  const checked = [];
  const { runtime, command, dispatch, guest, execution } = await workspaceFixture(t, { mergeRequiredCheck: mergeCheckerIdentity, workspaceMergeChecker: {
    identity: mergeCheckerIdentity, timeoutMs: 5000,
    async check(plan) { checked.push(plan); return { verdict: 'PASS', check_result_id: 'controlled-combined-tree' }; },
  } });
  guest.files['local.txt'] = Buffer.from('local contribution');
  const source = await dispatch('save', 'merge-source');
  const peer = await runtime.missionWorkspace.save({ workspaceId: 'workspace-default', baseRevision: '0.1', files: { 'input.txt': 'public project input', 'peer.txt': 'peer contribution' } });
  await runtime.missionWorkspace.merge({ workspaceId: 'workspace-default', fromRevision: peer.revision, expectedMainRevision: '0.1' });
  const merged = await command('workspace', 'merge', '--from', source.revision, '--request-id', 'merge-public-source');
  assert.equal(checked.length, 1);
  assert.equal(String(checked[0].files['local.txt']), 'local contribution');
  assert.equal(String(checked[0].files['peer.txt']), 'peer contribution');
  assert.equal(merged.check.checked_tree, checked[0].tree);
  assert.deepEqual(merged.check.checker, mergeCheckerIdentity);
  const publicTree = await runtime.missionWorkspace.exportRevision({ workspaceId: 'workspace-default', revision: merged.main_revision });
  assert.equal(String(publicTree.files['peer.txt']), 'peer contribution');
  assert.equal(guest.files['peer.txt'], undefined);
  assert.equal((await dispatch('status', 'after-merge')).last_saved_revision, source.revision);
  guest.files['later.txt'] = Buffer.from('later private edit');
  assert.deepEqual(await command('workspace', 'merge', '--from', source.revision, '--request-id', 'merge-public-source'), merged);
  assert.equal(checked.length, 1);
  const included = await command('workspace', 'merge', '--from', source.revision, '--request-id', 'included-source');
  assert.equal(included.already_included, true);
  assert.equal(included.main_revision, merged.main_revision);
  assert.equal(checked.length, 1);
  const history = await runtime.missionWorkspace.history({ workspaceId: 'workspace-default', all: true, sourceExecution: execution.execution_id });
  assert.ok(history.items.some(revision => revision.revision === merged.main_revision));
});

test('required merge checker cannot be bypassed by missing configuration or caller fields', async t => {
  const { workspaceMerge, runtime, identity, dispatch, guest } = await workspaceFixture(t, { mergeRequiredCheck: mergeCheckerIdentity });
  guest.files['new.txt'] = Buffer.from('needs a real check');
  const saved = await dispatch('save', 'unconfigured-check-source');
  const noop = await workspaceMerge.merge({ from: '0.1' }, { ...identity, requestId: 'unconfigured-noop' });
  assert.equal(noop.already_included, true);
  await assert.rejects(workspaceMerge.merge({ from: saved.revision }, { ...identity, requestId: 'unconfigured' }), { code: 'SERVICE_NOT_READY' });
  await assert.rejects(workspaceMerge.merge({ from: '0.1', checker: null }, { ...identity, requestId: 'forged-policy' }), { code: 'INVALID_CONTRACT' });
  assert.equal((await runtime.missionWorkspace.get({ workspaceId: 'workspace-default' })).main_revision, '0.1');
});

for (const policy of ['task-done-only', 'conflicting', 'none']) test(`merge honors ${policy} Task and Mission check requirements`, async t => {
  let checks = 0;
  const { workspaceMerge, runtime, dispatch, guest, identity } = await workspaceFixture(t, {
    mergeRequiredCheck: policy === 'conflicting' ? { ...mergeCheckerIdentity, checker_version: 'other' } : null,
    completionContract: policy === 'none' ? {} : { required_check: mergeCheckerIdentity },
    workspaceMergeChecker: { identity: mergeCheckerIdentity, timeoutMs: 5000,
      async check() { checks += 1; return { verdict: 'PASS' }; } },
  });
  guest.files['policy.txt'] = Buffer.from('policy-bound contribution');
  const saved = await dispatch('save', `policy-${policy}`);
  const attempt = workspaceMerge.merge({ from: saved.revision }, { ...identity, requestId: `policy-${policy}` });
  if (policy === 'conflicting') {
    await assert.rejects(attempt, { code: 'SERVICE_NOT_READY' });
    assert.equal((await runtime.missionWorkspace.get({ workspaceId: 'workspace-default' })).main_revision, '0.1');
  } else {
    const result = await attempt;
    assert.equal(result.check, null);
  }
  assert.equal(checks, 0);
});

test('shutdown revokes and stops an active Agent before a different Core startup returns', { timeout: 15_000 }, async t => {
  const { service, runtime, startSession } = await fixture(t, { maxWorkers: 2 });
  const active = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession });
  const task = service.createTask({ gap: 'Resolve the boundary required by this test Mission', priority: 'medium', mission_id: 'mission:agents', summary: 'A bounded active responsibility', expected_output: 'Research note', acceptance_conditions: ['Readable'] }, makeEnvelope({ actorRef: active.agent.agent_id })).task;
  const take = service.takeTask(task.task_id, { owner_ref: active.agent.agent_id, core_id: 'core-1', take_key: 'shutdown-active' });
  await runtime.bindAgentExecution(take.execution.execution_id, active.session, { coreId: 'core-1' });
  let entered, release, stopped;
  const entering = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const activeStopped = new Promise(resolve => { stopped = resolve; });
  const stop = active.session.stop;
  active.session.stop = async () => { await stop(); stopped(); };
  const starting = runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-2', startSession: async options => { entered(); await held; return startSession(options); } });
  const rejected = assert.rejects(starting, /stopp|clos|cancel/i);
  await entering;
  const shuttingDown = runtime.shutdown();
  try {
    assert.equal(service.getAgent(active.agent.agent_id).state, 'CLOSING');
    assert.equal(service.getTask(task.task_id).state, 'RUNNING');
    assert.throws(() => service.createTask({ gap: 'Resolve the boundary required by this test Mission', priority: 'medium', mission_id: 'mission:agents', summary: 'Investigate another independent responsibility after shutdown', expected_output: 'Result', acceptance_conditions: ['Readable'] }, makeEnvelope({ actorRef: active.agent.agent_id })), { code: 'NOT_ALLOWED' });
    await activeStopped;
  } finally { release(); }
  await rejected;
  const result = await shuttingDown;
  assert.equal(result.active_process_count, 0);
  assert.deepEqual(result.cleanup_pending_agent_ids, []);
});

test('soft closeout allows real CLI save publish finish and receipt replay', async t => {
  const { service, execution, dispatch, command, guest } = await workspaceFixture(t);
  const saved = await dispatch('save', 'before-soft-save');
  service.db.prepare('UPDATE executions SET handoff_deadline = ? WHERE execution_id = ?').run(new Date(Date.now() - 1).toISOString(), execution.execution_id);
  const captures = guest.captures;
  assert.deepEqual(await dispatch('save', 'before-soft-save'), saved);
  assert.equal(guest.captures, captures);
  guest.files['note.txt'] = Buffer.from('Existing result saved during closeout');
  assert.ok((await command('workspace', 'save', '--request-id', 'soft-save')).revision);
  assert.ok((await command('material', 'publish', '--content', 'Existing conclusion', '--request-id', 'soft-note')).material.material_id);
  const finish = await command('task', 'finish', '--outcome', 'incomplete', '--request-id', 'soft-finish');
  assert.match(finish.notice, /结束请求 soft-finish 已持久受理.*不得再 save\/publish/);
  assert.notEqual(service.getExecution(execution.execution_id).state, 'RUNNING');
});

test('Mission stop policy permits original CLI save publish finish after a handoff reminder', async t => {
  const { service, runtime, command, execution } = await workspaceFixture(t);
  service.setMissionStopReader(() => true);
  service.recordHandoffReminder({ reminded_at: new Date().toISOString() }, makeEnvelope({
    operationId: 'mission-stop-reminder', actorRef: execution.owner_ref, taskId: execution.task_id,
    executionId: execution.execution_id, specVersion: execution.spec_version,
    stateVersion: execution.state_version, fencingVersion: execution.fencing_version,
  }));
  assert.ok(service.getExecution(execution.execution_id).handoff_reminder_sent_at);
  assert.ok((await command('workspace', 'save', '--request-id', 'closeout-save')).revision);
  assert.ok((await command('material', 'publish', '--content', 'Existing useful result saved during Mission closeout', '--request-id', 'closeout-material')).material.material_id);
  const finished = await command('task', 'finish', '--outcome', 'incomplete', '--request-id', 'closeout-finish');
  assert.ok(finished.execution);
  await runtime.waitForSettled(execution.execution_id);
  assert.equal(service.getAgent(execution.owner_ref).state, 'CLOSED');
});

test('Mission PASS while project preparation is pending prevents reserved execution activation and write grant', async t => {
  const { service, runtime, startSession } = await fixture(t);
  const { agent, session } = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession });
  const task = service.createTask({ gap: 'Resolve the boundary required by this test Mission', priority: 'medium', mission_id: agent.mission_id, summary: 'Inspect a delayed project preparation', expected_output: 'An independent note', acceptance_conditions: ['State evidence'] }, makeEnvelope({ actorRef: agent.agent_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'prepare-before-pass' });
  let enter;
  let proceed;
  const preparing = new Promise(resolve => { enter = resolve; });
  const release = new Promise(resolve => { proceed = resolve; });
  const prepare = runtime.sandboxManager.prepareAgentProject.bind(runtime.sandboxManager);
  runtime.sandboxManager.prepareAgentProject = async input => { enter(); await release; return prepare(input); };
  runtime.sandboxManager.grantAgentProject = () => assert.fail('accepted Mission granted writes to an undelivered take');
  const rejected = assert.rejects(runtime.bindAgentExecution(execution.execution_id, session, { coreId: agent.core_id }), { code: 'NOT_ALLOWED' });
  await preparing;
  assert.equal(service.getExecution(execution.execution_id).state, 'CREATED');
  service.setMissionStopReader(id => id === agent.mission_id);
  proceed();
  await rejected;
  assert.equal(service.getExecution(execution.execution_id).started_at, null);
  assert.equal(service.getExecution(execution.execution_id).state, 'FAILED');
  assert.equal(service.getAgent(agent.agent_id).state, 'CLOSED');
});

test('unbound CLI compares an unmerged public revision and keeps Workspace pages fixed', async t => {
  const { service, runtime, startSession } = await fixture(t);
  const workspace = runtime.missionWorkspace;
  const workspaceId = runtime.missionWorkspaceId;
  const candidate = await workspace.save({ workspaceId, baseRevision: '0.1', files: { 'a.txt': 'match', 'b.txt': 'match' } });
  const context = new ContextService(service.db, { taskService: service });
  const bridge = new ServicesBridge({ taskService: service, contextService: context, runtime, coreId: 'core-1',
    registry: createBuiltinServiceRegistry({ taskService: service, contextService: context, missionWorkspace: workspace }) });
  await bridge.start();
  t.after(() => bridge.stop());
  let env;
  const { agent } = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession: async input => {
    env = bridge.startAgentIdentity(input.agent.agent_id);
    return startSession(input);
  } });
  const call = (...args) => promisify(execFile)(process.execPath, ['dist/scripts/swarm.js', 'workspace', ...args], {
    env: { PATH: process.env.PATH, ...env }, timeout: 15_000,
  });
  const command = async (...args) => JSON.parse((await call(...args)).stdout);
  const diff = await command('diff', '--from', 'main', '--to', candidate.revision, '--limit', '1');
  assert.equal(diff.from.revision, '0.1');
  assert.equal(diff.to.reachable_from_main, false);
  assert.ok(diff.next_cursor);
  const first = await command('files', '--at', candidate.revision, '--limit', '1');
  assert.equal(first.files[0].path, 'a.txt');
  const second = await command('files', '--at', candidate.revision, '--cursor', first.next_cursor);
  assert.deepEqual(second.files.map(item => item.path), ['b.txt']);
  const exact = await command('files', 'a.txt', '--at', candidate.revision);
  assert.deepEqual(exact.files.map(item => item.path), ['a.txt']);
  const search = await command('search', 'match', '--at', candidate.revision, '--max-results', '1');
  assert.equal(search.matches[0].path, 'a.txt');
  const more = await command('search', 'match', '--cursor', search.next_cursor);
  assert.equal(more.matches[0].path, 'b.txt');
  await assert.rejects(call('diff', '--from', 'main'), /requires both --from and --to/);
  await assert.rejects(call('diff', '--from', 'main', '--to', candidate.revision, '--workspace-id', 'outside'), /configured Mission Workspace/);
  await assert.rejects(call('diff'), /not available|requires/i);
  assert.equal(service.getAgent(agent.agent_id).execution_id, null);
});

test('declared Workspace delivery verifies a published revision before accepting done', async t => {
  const { guest, command, dispatch, service, execution, runtime } = await workspaceFixture(t, {
    completionContract: { workspace_delivery: { paths: ['answer.txt'], require_main: true } },
  });
  await assert.rejects(command('task', 'finish', '--outcome', 'done', '--workspace-revision', '0.1'));
  guest.files['answer.txt'] = Buffer.from('candidate answer');
  const saved = await dispatch('save', 'actual-delivery');
  await assert.rejects(command('task', 'finish', '--outcome', 'done', '--workspace-revision', saved.revision));
  assert.equal(service.getExecution(execution.execution_id).state, 'RUNNING');
  const merged = await command('workspace', 'merge', '--from', saved.revision);
  const finished = await command('task', 'finish', '--outcome', 'done', '--workspace-revision', merged.main_revision);
  assert.equal(finished.workspace_delivery.merged_to_main, true);
  assert.equal(finished.workspace_delivery.files[0].content_hash,
    createHash('sha256').update(guest.files['answer.txt']).digest('hex'));
  assert.equal(service.getExecutionFinish(execution.execution_id).payload.workspace_delivery.revision, merged.main_revision);
  assert.equal((await runtime.missionWorkspace.get({ workspaceId: saved.workspace_id })).main_revision, merged.main_revision);
});

test('Agent CLI publishes, explicitly links, and cites a Material when finishing', async t => {
  const { command, service, execution, runtime } = await workspaceFixture(t);
  const { material } = await command('material', 'publish', '--title', 'Boundary case check',
    '--content', 'The boundary case follows from the empty intersection.', '--request-id', 'publish-t1');
  assert.equal(material.producer_task_id, execution.task_id);
  const finish = requestId => command('task', 'finish', '--outcome', 'done',
    '--material-ids', JSON.stringify([material.material_id]), '--request-id', requestId);

  await assert.rejects(finish('finish-unlinked'), error => {
    const { code, message, details } = JSON.parse(error.stderr);
    assert.equal(code, 'INVALID_CONTRACT');
    assert.match(message, /task finish.*swarm task link/);
    assert.deepEqual(details.unlinked_material_ids, [material.material_id]);
    return true;
  });
  assert.equal(service.getExecution(execution.execution_id).state, 'RUNNING');

  const { link } = await command('task', 'link', '--task-id', execution.task_id, '--material-id', material.material_id,
    '--role', 'experience', '--request-id', 'link-m1');
  assert.equal(link.material_id, material.material_id);
  assert.equal(link.task_id, execution.task_id);
  await finish('finish-t1');
  const receipt = service.getExecutionFinish(execution.execution_id);
  assert.equal(receipt.outcome, 'done');
  assert.deepEqual(receipt.payload.material_ids, [material.material_id]);
  await assertExecutionReleased(runtime, service, execution.execution_id, 1_000);
  assert.equal(service.getTask(execution.task_id).state, 'DONE');
});

test('Workspace provenance records explicit uses and exposes affected revisions in history', async t => {
  const { guest, command, dispatch, bridge, context } = await workspaceFixture(t);
  const materialId = 'material:workspace-use';
  await bridge.call({ operation: 'context_publish_material', operationId: 'material-for-use',
    payload: { material_id: materialId, content: 'Useful proof observation' } });
  guest.files['answer.txt'] = Buffer.from('candidate answer');
  await assert.rejects(dispatch('save', 'missing-use', { material_ids: [materialId] }), /recorded use/);
  await command('material', 'consume', '--material-ids', JSON.stringify([materialId]),
    '--action', 'workspace', '--impact', 'Established the case used in answer.txt.');
  context.db.prepare('UPDATE material_consumptions SET material_version = 99 WHERE material_id = ?').run(materialId);
  await assert.rejects(dispatch('save', 'wrong-use-version', { material_ids: [materialId] }), /recorded use/);
  context.db.prepare('UPDATE material_consumptions SET material_version = 1 WHERE material_id = ?').run(materialId);
  const saved = await command('workspace', 'save', '--material-ids', materialId, '--request-id', 'with-use');
  assert.equal(saved.source.material_uses[0].material_id, materialId);
  assert.equal(saved.source.material_uses[0].impact, 'Established the case used in answer.txt.');
  const history = await command('workspace', 'history', '--all', '--material-id', materialId);
  assert.deepEqual(history.items.map(item => item.revision), [saved.revision]);
});

test('Task main delivery checks the merged tree under its declared checker environment', async t => {
  const identity = mergeCheckerIdentity;
  const checked = [];
  const { command, dispatch, guest } = await workspaceFixture(t, {
    completionContract: { workspace_delivery: { paths: ['answer.txt'], require_main: true, check: identity } },
    workspaceMergeChecker: { identity, timeoutMs: 5000,
      async check(plan) { checked.push(plan.tree); return { verdict: 'PASS', check_result_id: 'delivery-merge-check' }; },
    },
  });
  guest.files['answer.txt'] = Buffer.from('draft answer');
  const saved = await dispatch('save', 'checked-delivery-save');
  const merged = await command('workspace', 'merge', '--from', saved.revision);
  const finished = await command('task', 'finish', '--outcome', 'done', '--workspace-revision', merged.main_revision);
  assert.deepEqual(checked, [finished.workspace_delivery.git_tree]);
  assert.equal(finished.workspace_delivery.check.check_result_id, 'delivery-merge-check');
  assert.equal(finished.workspace_delivery.check.environment_ref, identity.environment_ref);
});

test('Task main project checks require build coverage of every declared delivery file', async t => {
  for (const uncoveredPath of [null, 'README.md', 'lakefile.lean']) {
    await t.test(uncoveredPath ?? 'compiled Lean files', async t => {
      const identity = mergeCheckerIdentity;
      const checkedPaths = ['Proof.lean', 'Helper.lean'];
      const paths = ['Proof.lean', uncoveredPath ?? 'Helper.lean'];
      const { command, dispatch, guest } = await workspaceFixture(t, {
        completionContract: { workspace_delivery: { paths, require_main: true, check: identity } },
        runtimeOptions: { workspaceProjectCheck: true }, workspaceMergeChecker: { identity, timeoutMs: 5000,
          async check() { return { verdict: 'PASS', check_result_id: 'project-merge-check', check_mode: 'lean-project', checked_paths: checkedPaths }; },
        },
      });
      guest.files['Proof.lean'] = Buffer.from('import Helper');
      guest.files['Helper.lean'] = Buffer.from('theorem helper : True := True.intro');
      if (uncoveredPath) guest.files[uncoveredPath] = Buffer.from('candidate artifact outside compiler coverage');
      const saved = await dispatch('save', 'project-delivery-save');
      const merged = await command('workspace', 'merge', '--from', saved.revision);
      assert.deepEqual(merged.check.checked_paths, checkedPaths);
      const finish = () => command('task', 'finish', '--outcome', 'done', '--workspace-revision', merged.main_revision);
      if (uncoveredPath) await assert.rejects(finish(), /did not cover all declared Workspace delivery files/);
      else assert.equal((await finish()).workspace_delivery.check.check_result_id, 'project-merge-check');
    });
  }
});

test('Workspace merge rejects module-scoped evidence even when all delivery paths appear', async t => {
  const identity = mergeCheckerIdentity;
  const { command, dispatch, guest } = await workspaceFixture(t, {
    completionContract: { workspace_delivery: { paths: ['Proof.lean'], require_main: true, check: identity } },
    runtimeOptions: { workspaceProjectCheck: true }, workspaceMergeChecker: { identity, timeoutMs: 5000,
      async check() { return { verdict: 'PASS', check_result_id: 'module-merge-check', check_mode: 'lean-module', scope: 'module', checked_paths: ['Proof.lean'] }; },
    },
  });
  guest.files['Proof.lean'] = Buffer.from('theorem proof : True := trivial');
  const saved = await dispatch('save', 'module-main-save');
  await assert.rejects(command('workspace', 'merge', '--from', saved.revision), /module-scoped evidence is insufficient/);
});

test('Agent input preparation sends exact binary bytes through one authenticated bounded request', async t => {
  const uploads = [];
  const { service, runtime, startSession } = await fixture(t, {}, { beforeFetch: (url, options) => {
    if (url.endsWith('/command')) assert.fail('registered Agent input must not use per-chunk shell RPCs');
    if (url.endsWith('/project/prepare')) uploads.push(JSON.parse(options.body));
  } });
  const bytes = Buffer.alloc(2 * 1024 * 1024, 171);
  const saved = await runtime.missionWorkspace.save({ workspaceId: 'workspace-default', files: { 'binary.bin': bytes } });
  await runtime.missionWorkspace.merge({ workspaceId: 'workspace-default', fromRevision: saved.revision, expectedMainRevision: '0.1' });
  const { agent, session } = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession });
  const task = service.createTask({ gap: 'Resolve the boundary required by this test Mission', priority: 'medium', mission_id: agent.mission_id, summary: 'Inspect complete binary reference input', expected_output: 'Note', acceptance_conditions: ['Reviewed'] }, makeEnvelope({ actorRef: agent.agent_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'take:binary' });
  await runtime.bindAgentExecution(execution.execution_id, session, { coreId: 'core-1' });
  const transfers = uploads.filter(input => input.files);
  assert.equal(transfers.length, 1);
  assert.deepEqual(Buffer.from(transfers[0].files['binary.bin'], 'base64'), bytes);
  assert.equal(transfers[0].manifest['binary.bin'].content_hash, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(service.getAgent(agent.agent_id).state, 'ACTIVE');
});

test('slow Agent preparation keeps its reservation lease live before activation', async t => {
  const { service, runtime, manager, startSession } = await fixture(t);
  const { agent, session } = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession });
  const task = service.createTask({ gap: 'Resolve the boundary required by this test Mission', priority: 'medium', mission_id: agent.mission_id, summary: 'Inspect a slow public input', expected_output: 'Note', acceptance_conditions: ['Reviewed'] }, makeEnvelope({ actorRef: agent.agent_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'take:slow-lease' });
  let resume, entered;
  const gate = new Promise(resolve => { resume = resolve; });
  const copying = new Promise(resolve => { entered = resolve; });
  const sync = manager.syncWorkspace.bind(manager);
  manager.syncWorkspace = async input => { entered(); await gate; return sync(input); };
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const binding = runtime.bindAgentExecution(execution.execution_id, session, { coreId: 'core-1' });
  await copying;
  try {
    for (let step = 0; step < 4; step++) t.mock.timers.tick(10_000);
    assert.ok(Date.parse(service.getExecution(execution.execution_id).lease_expires_at) > Date.now(), 'preparation must retain a live lease beyond its original 30 seconds');
  } finally { resume(); }
  await binding;
  assert.equal(service.getAgent(agent.agent_id).state, 'ACTIVE');
  assert.doesNotThrow(() => runtime.heartbeat(execution.execution_id));
});

test('binding cannot revive an already expired preparation lease', async t => {
  const { service, runtime, startSession, manager } = await fixture(t);
  const { agent, session } = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', startSession });
  const task = service.createTask({ gap: 'Resolve the boundary required by this test Mission', priority: 'medium', mission_id: agent.mission_id, summary: 'Inspect expired preparation ownership', expected_output: 'Note', acceptance_conditions: ['Reviewed'] }, makeEnvelope({ actorRef: agent.agent_id })).task;
  const { execution } = service.takeTask(task.task_id, { owner_ref: agent.agent_id, core_id: agent.core_id, take_key: 'take:expired-preparation' });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(execution.lease_expires_at) + 1 });
  await assert.rejects(runtime.bindAgentExecution(execution.execution_id, session, { coreId: 'core-1' }), /lease has expired/);
  assert.equal(service.getAgent(agent.agent_id).state, 'CLOSED');
  assert.equal(manager.snapshot().executions.length, 0);
  assert.notEqual(service.getExecution(execution.execution_id).state, 'RUNNING');
});

for (const deployment of ['in-process', 'independent']) test(`authenticated Bridge takes and finishes the real lifecycle with ${deployment} services`, async t => {
  const { root, service, runtime, startSession } = await fixture(t);
  const peers = deployment === 'independent' ? await startIndependentServices({
    taskService: service, projectDir: root, logRoot: join(root, 'logs'),
    fixtureManifest: { fixture_id: 'lifecycle-integration', putnambench_commit: 'a'.repeat(40), problem_file: 'input.lean',
      problem_file_hash: 'b'.repeat(64), lean_toolchain: 'controlled', mathlib_version: 'controlled',
      checker_ref: 'controlled', checker_version: '1', environment_ref: 'controlled' }, checkerTimeoutMs: 1000,
  }) : null;
  try {
    const context = peers?.context ?? new ContextService(service.db, { taskService: service });
    runtime.contextService = context;
    const task = service.createTask({ mission_id: 'mission:agents', summary: 'Complete the fixed lifecycle responsibility', expected_output: 'Reviewed artifact', acceptance_conditions: ['Artifact reviewed'], workspace: { enabled: true } }, makeEnvelope({ actorRef: 'operator:test' })).task;
    let session;
    const bridge = new ServicesBridge({ taskService: service, contextService: context, runtime, coreId: 'core-1',
      registry: createBuiltinServiceRegistry({ taskService: service, contextService: context, judgeService: peers?.judge }),
      onTake: async take => {
        const bound = await runtime.bindAgentExecution(take.execution.execution_id, session, { sendInitialPrompt: false });
        take.execution = bound.execution;
      },
    });
    await bridge.start();
    t.after(() => bridge.stop());
    const started = await runtime.startAgent({ missionId: 'mission:agents', coreId: 'core-1', selectionTimeoutMs: 60_000,
      startSession: async options => { bridge.startAgentIdentity(options.agent.agent_id); return startSession(options); },
    });
    session = started.session;
    const take = { operation: 'task_take', operation_id: 'lifecycle-take', payload: { task_id: task.task_id } };
    const result = await bridge.call(take);
    assert.equal(service.getExecution(result.execution.execution_id).state, 'RUNNING');
    assert.equal(service.getAgent(started.agent.agent_id).execution_id, result.execution.execution_id);
    assert.equal(service.getExecution(result.execution.execution_id).owner_ref, started.agent.agent_id);
    if (peers) {
      const budget = peers.judge.getMissionCheckBudget('mission:agents');
      assert.equal(budget.max_requests, null);
      assert.equal(budget.max_concurrent, 4);
      assert.equal(budget.max_queued, 8);
      assert.equal(budget.queue_wait_ms, 120_000);
      assert.equal(budget.admitted_requests, 0);
    }
    const finish = { operation: 'task_finish', operation_id: 'lifecycle-finish', payload: { outcome: 'incomplete', summary: 'Controlled completion' } };
    await bridge.call(finish);
    assert.equal(service.getAgent(started.agent.agent_id).state, 'CLOSED');
    assert.equal(session.closed, true);
  } finally {
    try {
      await runtime.shutdown();
    } finally {
      await peers?.close();
    }
  }
});

test('Bridge stop fences an admitted merge and joins its owned final-tree checker', async t => {
  let entered, release, checkSignal, launchCheck;
  const checking = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { bridge, workspaceMerge, runtime, dispatch, guest } = await workspaceFixture(t, {
    mergeRequiredCheck: mergeCheckerIdentity,
    workspaceMergeChecker: { identity: mergeCheckerIdentity, timeoutMs: 5000,
      async check({ signal, startProcess }) { checkSignal = signal; launchCheck = startProcess; entered(); await gate; return { verdict: 'PASS' }; },
    },
  });
  guest.files['stop-check.txt'] = Buffer.from('contribution awaiting trusted check');
  const saved = await dispatch('save', 'bridge-stop-merge-source');
  const merge = bridge.call({ operation: 'workspace_merge', operation_id: 'bridge-stop-merge', payload: { from: saved.revision } });
  const rejected = assert.rejects(merge, { code: 'NOT_ALLOWED' });
  await checking;
  let joined = false;
  const closing = bridge.stop().then(receipt => { joined = true; return receipt; });
  try {
    assert.equal(checkSignal.aborted, true);
    let launched = false;
    assert.throws(() => launchCheck(() => { launched = true; }), { code: 'NOT_ALLOWED' });
    assert.equal(launched, false);
    assert.deepEqual(await workspaceMerge.close({ timeoutMs: 0 }), { cleanup: 'pending', pending_checks: 1 });
    assert.equal(joined, false);
  } finally { release(); }
  await rejected;
  assert.deepEqual(await closing, { cleanup: 'complete', pending_checks: 0 });
  assert.equal((await runtime.missionWorkspace.get({ workspaceId: 'workspace-default' })).main_revision, '0.1');
});
