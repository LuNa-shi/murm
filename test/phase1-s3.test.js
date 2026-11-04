import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextService,
  Runtime,
  TaskService,
  WorkspaceManager,
  makeEnvelope,
} from '../src/index.js';

function env(operationId, actorRef, fields = {}) {
  return makeEnvelope({ operationId, actorRef, ...fields });
}

function setup() {
  const database = new DatabaseSync(':memory:');
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  return { database, contextService, taskService };
}

function makeTask(taskService, missionId, taskId) {
  return taskService.dispatch('propose_task', {
    task_id: taskId,
    task_type: 'research',
    goal: `Investigate ${taskId} as an independently useful responsibility.`,
    expected_output: 'durable feedback result',
    acceptance_conditions: { result: true },
    parallel_quota: 3,
  }, env(`create:${taskId}`, 'operator:test')).task;
}

function claim(taskService, task, executionId, actorRef) {
  return taskService.dispatch('claim', {
    claim_key: `claim:${executionId}`,
    execution_id: executionId,
    owner_ref: actorRef,
    agent_prompt: 'execute the current Task',
  }, env(`claim:${executionId}`, actorRef, {
    taskId: task.task_id,
    specVersion: task.spec_version,
    stateVersion: task.state_version,
  })).execution;
}

function bound(taskService, taskId, executionId, actorRef, operationId) {
  const execution = taskService.getExecution(executionId);
  return env(operationId, actorRef, {
    taskId,
    executionId,
    specVersion: execution.spec_version,
    stateVersion: execution.state_version,
    fencingVersion: execution.fencing_version,
  });
}

test('feedback delivery and handling remain independent across successor Executions', () => {
  const { taskService } = setup();
  try {
    taskService.dispatch('mission.create', { mission_id: 'mission:s3-feedback', goal: 'feedback' }, env('mission', 'operator:test'));
    const task = makeTask(taskService, 'mission:s3-feedback', 'task:feedback');
    claim(taskService, task, 'execution:old', 'agent:old');
    const notification = taskService.enqueueNotification({
      deliveryKey: 'feedback:one', missionId: 'mission:s3-feedback', recipientTaskId: task.task_id,
      type: 'material_available', payload: { feedback: 'try the alternate route' },
    });

    taskService.markNotificationDelivered(notification.notification_id, 'execution:old');
    assert.equal(taskService.listPendingNotifications(task.task_id, 'execution:old').length, 0);
    taskService.dispatch('fence_execution', { terminal_reason: 'identity_rotation' }, bound(taskService, task.task_id, 'execution:old', 'agent:old', 'fence:old'));

    const successor = claim(taskService, taskService.getTask(task.task_id), 'execution:new', 'agent:new');
    const pending = taskService.listUnprocessedNotifications(task.task_id, successor.execution_id);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].recipient_delivery, null, 'successor has not received the predecessor delivery receipt');

    const handled = taskService.dispatch('task_feedback', {
      notification_id: notification.notification_id,
      decision: 'route_changed',
      action: 'publish_revised_candidate',
      details: { basis: 'feedback was read after successor claim' },
    }, bound(taskService, task.task_id, successor.execution_id, 'agent:new', 'feedback:handled'));
    assert.equal(handled.notification.handled, false, 'task-level notification stays open for other recipients');
    assert.equal(handled.receipt.handling_decision, 'route_changed');
    assert.equal(handled.receipt.handling_action, 'publish_revised_candidate');

    const third = claim(taskService, taskService.getTask(task.task_id), 'execution:third', 'agent:third');
    assert.equal(taskService.listUnprocessedNotifications(task.task_id, third.execution_id).length, 1);
  } finally {
    taskService.close();
  }
});

class CompactionSession extends EventEmitter {
  constructor(id, contextWindow = 500) {
    super();
    this.sessionId = id;
    this.contextWindow = contextWindow;
    this.manifest = { test: true };
    this.prompts = [];
    this.closed = false;
  }

  async waitForReady() {}

  async setAutoCompaction() {}

  async setAutoRetry() {}

  async prompt(message) {
    this.prompts.push(message);
  }

  async stop() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', { code: 0, signal: 'SIGTERM' });
  }
}

async function runtimeFixture({ maxCompactions = 3, handoffWindowRatio = 0.8, contextWindow = 500, logger = null } = {}) {
  const database = new DatabaseSync(':memory:');
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  taskService.dispatch('propose_task', {
    task_id: 'task:compaction', task_type: 'research', goal: 'compaction fixture', expected_output: 'checkpoint',
    acceptance_conditions: { fixture: true }, owner_ref: 'owner:root', parallel_quota: 1,
  }, env('proposal', 'owner:root'));
  const task = taskService.getTask('task:compaction');
  const claimed = claim(taskService, task, 'execution-compaction', 'agent:compaction');
  const rootDir = await mkdtemp(join(tmpdir(), 'swarmenv-s3-compaction-'));
  const sessions = [];
  const adapter = { async start() { const session = new CompactionSession(`identity-${sessions.length + 1}`, contextWindow); sessions.push(session); return session; } };
  const events = [];
  const runtime = new Runtime({
    taskService, contextService, workspaceManager: new WorkspaceManager({ rootDir }), agentAdapter: adapter,
    actorRef: 'runtime:s3', coreIds: ['core-s3'], maxCompactions, handoffWindowRatio, logger: { append(event) { events.push(event); logger?.append?.(event); } },
  });
  return { taskService, contextService, claimed, runtime, sessions, events, rootDir };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 5));
}

async function waitFor(predicate, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for controlled Runtime event');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('third compaction continues below threshold then rotates before a fourth', async () => {
  const fixture = await runtimeFixture();
  const { runtime, taskService, claimed, sessions, events, rootDir } = fixture;
  try {
    await runtime.startExecution(claimed.execution_id, { coreId: 'core-s3' });
    for (let count = 1; count <= 3; count += 1) {
      sessions[0].emit('rpc', { type: 'compaction_end', reason: `c${count}`, result: { tokensBefore: 490, estimatedTokensAfter: 100 }, aborted: false });
      await settle();
    }
    await waitFor(() => events.filter((event) => event.event === 'runtime.compaction_checkpoint_saved').length === 3);
    assert.equal(sessions.length, 1, 'third compaction below 80% does not retire the identity');
    assert.equal(events.filter((event) => event.event === 'runtime.compaction_checkpoint_saved').length, 3);

    sessions[0].emit('rpc', { type: 'turn_end', usage: { tokens: 450, total_tokens: 450 } , contextWindow: 500 });
    await waitFor(() => events.filter((event) => event.event === 'runtime.identity_rotation_completed').length === 1);
    assert.equal(sessions.length, 2, '80% usage after the third compaction rotates the identity');
    assert.equal(events.filter((event) => event.event === 'runtime.identity_rotation_completed').at(-1).new_compaction_count, 0);

    for (let count = 1; count <= 3; count += 1) {
      sessions[1].emit('rpc', { type: 'compaction_end', reason: `next-${count}`, result: { tokensBefore: 100 }, aborted: false });
      await settle();
    }
    sessions[1].emit('rpc', { type: 'compaction_start', reason: 'would-be-fourth', contextWindow: 500, usage: { tokens: 490 } });
    await waitFor(() => events.filter((event) => event.event === 'runtime.identity_rotation_completed').length === 2);
    assert.equal(sessions.length, 3, 'fourth compaction is intercepted by identity rotation');
    assert.equal(events.some((event) => event.event === 'runtime.compaction_completed' && event.compaction_count === 4), false);
    await runtime.stopExecution(taskService.listActiveExecutions()[0].execution_id);
  } finally {
    await runtime.shutdown().catch(() => undefined);
    taskService.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('unknown context usage after the compaction limit takes the conservative rotation path', async () => {
  const fixture = await runtimeFixture({ maxCompactions: 1, contextWindow: null });
  const { runtime, taskService, claimed, sessions, events, rootDir } = fixture;
  try {
    await runtime.startExecution(claimed.execution_id, { coreId: 'core-s3' });
    sessions[0].emit('rpc', { type: 'compaction_end', reason: 'unknown-window', result: { tokensBefore: 100 }, aborted: false });
    await waitFor(() => events.some((event) => event.event === 'runtime.identity_rotation_completed'));
    assert.equal(sessions.length, 2);
    assert.equal(events.some((event) => event.event === 'runtime.identity_rotation_started' && event.reason === 'compaction_window_unknown'), true);
    await runtime.stopExecution(taskService.listActiveExecutions()[0].execution_id);
  } finally {
    await runtime.shutdown().catch(() => undefined);
    taskService.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('compaction checkpoint failure does not strand the active Execution', async () => {
  const fixture = await runtimeFixture();
  const { runtime, taskService, claimed, sessions, events, rootDir } = fixture;
  try {
    const originalSave = runtime.workspaceManager.saveWorkspaceRevision.bind(runtime.workspaceManager);
    runtime.workspaceManager.saveWorkspaceRevision = async (...args) => {
      if (args[0]?.files && Object.keys(args[0].files).length === 0) throw Object.assign(new Error('controlled checkpoint failure'), { code: 'CHECKPOINT_FAILED' });
      return originalSave(...args);
    };
    await runtime.startExecution(claimed.execution_id, { coreId: 'core-s3' });
    sessions[0].emit('rpc', { type: 'compaction_end', reason: 'save-failure', result: { tokensBefore: 100 }, aborted: false });
    await settle();
    assert.equal(runtime.getActiveProcessCount(), 1);
    assert.equal(taskService.getExecution(claimed.execution_id).state, 'RUNNING');
    assert.equal(events.some((event) => event.event === 'runtime.compaction_checkpoint_failed' && event.error_class === 'CHECKPOINT_FAILED'), true);
    await runtime.stopExecution(claimed.execution_id);
  } finally {
    await runtime.shutdown().catch(() => undefined);
    taskService.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('shutdown drains a compaction checkpoint before releasing its Workspace', async () => {
  const fixture = await runtimeFixture();
  const { runtime, taskService, claimed, sessions, rootDir } = fixture;
  let saveStarted;
  let unblockSave;
  const saveStartedPromise = new Promise((resolve) => { saveStarted = resolve; });
  const saveGate = new Promise((resolve) => { unblockSave = resolve; });
  const originalSave = runtime.workspaceManager.saveWorkspaceRevision.bind(runtime.workspaceManager);
  runtime.workspaceManager.saveWorkspaceRevision = async (...args) => {
    if (args[0]?.files && Object.keys(args[0].files).length === 0) {
      saveStarted();
      await saveGate;
    }
    return originalSave(...args);
  };
  try {
    await runtime.startExecution(claimed.execution_id, { coreId: 'core-s3' });
    const running = taskService.getExecution(claimed.execution_id);
    sessions[0].emit('rpc', { type: 'compaction_end', reason: 'shutdown-drain', result: { tokensBefore: 100 }, aborted: false });
    await saveStartedPromise;

    let shutdownSettled = false;
    const shutdownPromise = runtime.shutdown().then(() => { shutdownSettled = true; });
    await settle();
    assert.equal(shutdownSettled, false, 'shutdown waits for the in-flight checkpoint');
    sessions[0].emit('rpc', { type: 'compaction_end', reason: 'late-after-stop', result: { tokensBefore: 90 }, aborted: false });
    unblockSave();
    await shutdownPromise;
    assert.equal(fixture.events.filter((event) => event.event === 'runtime.compaction_checkpoint_saved').length, 1, 'late compaction events are ignored after shutdown begins');

    await assert.rejects(
      runtime.workspaceManager.saveWorkspaceRevision({
        workspaceRef: running.workspace_ref,
        executionId: claimed.execution_id,
        fencingVersion: running.fencing_version,
        files: { late: 'write' },
      }),
      (error) => error?.code === 'FENCED',
      'released Workspaces reject late writes with the old execution fence',
    );
  } finally {
    unblockSave();
    await runtime.shutdown().catch(() => undefined);
    taskService.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});
