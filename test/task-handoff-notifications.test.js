import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextService,
  ERROR_CODES,
  Runtime,
  SwarmEnvError,
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

function makeTask(taskService, missionId, taskId, summary = taskId, overrides = {}) {
  const taskSummary = summary === taskId ? `Investigate ${taskId} as an independently useful responsibility.` : summary;
  return taskService.dispatch('task.create', {
    mission_id: missionId,
    task_id: taskId,
    summary: taskSummary,
    goal: summary,
    expected_output: 'durable Material',
    acceptance_conditions: ['publish a useful result'],
    ...overrides,
  }, env(`create:${taskId}`, 'operator:test')).task;
}

function claim(taskService, task, executionId, actorRef) {
  const result = taskService.dispatch('claim', {
    claim_key: `claim:${executionId}`,
    execution_id: executionId,
    owner_ref: actorRef,
    agent_prompt: 'execute the current Task',
  }, env(`claim:${executionId}`, actorRef, {
    taskId: task.task_id,
    specVersion: task.spec_version,
    stateVersion: task.state_version,
  }));
  return result.execution;
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

test('semantic handoff requires linked Handoff Material and returns Task to OPEN', () => {
  const { database, contextService, taskService } = setup();
  try {
    taskService.dispatch('mission.create', { mission_id: 'mission:handoff', goal: 'handoff' }, env('mission', 'operator:test'));
    const task = makeTask(taskService, 'mission:handoff', 'task:handoff');
    claim(taskService, task, 'execution:handoff', 'agent:handoff');
    assert.throws(() => taskService.dispatch('task.handoff', {
      handoff_material_id: 'missing',
    }, bound(taskService, task.task_id, 'execution:handoff', 'agent:handoff', 'handoff:missing')), (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.INVALID_CONTRACT);
    assert.equal(taskService.getTask(task.task_id).state, 'RUNNING');

    const material = contextService.dispatch('context_publish_material', {
      role: 'handoff',
      content: { explored: ['route A'], next_step: 'try route B' },
    }, bound(taskService, task.task_id, 'execution:handoff', 'agent:handoff', 'material:handoff'));
    const handed = taskService.dispatch('task.handoff', {
      handoff_material_id: material.material.material_id,
    }, bound(taskService, task.task_id, 'execution:handoff', 'agent:handoff', 'handoff:valid'));
    assert.equal(handed.task.state, 'OPEN');
    assert.equal(handed.execution.state, 'HANDED_OFF');
    assert.equal(handed.handoff.material.role, 'handoff');
    assert.equal(taskService.dispatch('task.materials', { task_id: task.task_id }, env('materials:handoff', 'agent:reader')).links[0].role, 'handoff');
  } finally {
    taskService.close();
  }
});

test('semantic block requires Handoff Material, records typed dependency, and reopens with a notification', () => {
  const { database, contextService, taskService } = setup();
  try {
    taskService.dispatch('mission.create', { mission_id: 'mission:block', goal: 'block' }, env('mission', 'operator:test'));
    const blocked = makeTask(taskService, 'mission:block', 'task:blocked');
    const prerequisite = makeTask(taskService, 'mission:block', 'task:prerequisite');
    claim(taskService, blocked, 'execution:blocked', 'agent:blocked');
    const material = contextService.dispatch('context.publish_material', {
      role: 'handoff', kind: 'failure', scope: 'mission', content: { blocker: 'needs prerequisite' },
    }, bound(taskService, blocked.task_id, 'execution:blocked', 'agent:blocked', 'material:block'));
    taskService.dispatch('task.link_material', {
      task_id: blocked.task_id, material_id: material.material.material_id, role: 'handoff',
    }, bound(taskService, blocked.task_id, 'execution:blocked', 'agent:blocked', 'link:block'));
    const result = taskService.dispatch('task.block', {
      blocker: { reason: 'waiting for prerequisite' },
      dependency: { dependency_kind: 'TASK', prerequisite_task_id: prerequisite.task_id },
      handoff_material_id: material.material.material_id,
    }, bound(taskService, blocked.task_id, 'execution:blocked', 'agent:blocked', 'block:valid'));
    assert.equal(result.task.state, 'BLOCKED');
    assert.equal(result.execution.state, 'HANDED_OFF');
    assert.equal(taskService.listPendingNotifications(blocked.task_id).length, 0);

    const prerequisiteExecution = claim(taskService, prerequisite, 'execution:prerequisite', 'agent:prerequisite');
    const prerequisiteMaterial = contextService.dispatch('context.publish_material', {
      role: 'experience', kind: 'fact', scope: 'mission', content: { result: 'prerequisite complete' },
    }, bound(taskService, prerequisite.task_id, prerequisiteExecution.execution_id, 'agent:prerequisite', 'material:prerequisite'));
    taskService.dispatch('task.link_material', {
      task_id: prerequisite.task_id,
      material_id: prerequisiteMaterial.material.material_id,
      role: 'experience',
    }, bound(taskService, prerequisite.task_id, prerequisiteExecution.execution_id, 'agent:prerequisite', 'link:prerequisite'));
    const completed = taskService.dispatch('task.complete', {}, bound(taskService, prerequisite.task_id, prerequisiteExecution.execution_id, 'agent:prerequisite', 'complete:prerequisite'));
    assert.equal(completed.task.state, 'DONE');
    const reopened = taskService.dispatch('reconcile_task', { task_id: blocked.task_id }, env('reconcile:blocked', 'controller:test'));
    assert.equal(reopened.task.state, 'OPEN');
    const pending = taskService.listPendingNotifications(blocked.task_id);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].notification_type, 'task_reopened');
  } finally {
    taskService.close();
  }
});

test('Response Material notification is keyed, provenance-aware, and at-least-once', () => {
  const { database, contextService, taskService } = setup();
  try {
    taskService.dispatch('mission.create', { mission_id: 'mission:notify', goal: 'notify' }, env('mission', 'operator:test'));
    const producer = makeTask(taskService, 'mission:notify', 'task:producer');
    const receiver = makeTask(taskService, 'mission:notify', 'task:receiver');
    claim(taskService, producer, 'execution:producer', 'agent:producer');
    const receiverExecution = claim(taskService, receiver, 'execution:receiver', 'agent:receiver');
    const material = contextService.dispatch('context.publish_material', {
      role: 'response', kind: 'fact', scope: 'mission', content: { result: 'usable' },
    }, bound(taskService, producer.task_id, 'execution:producer', 'agent:producer', 'material:response'));
    const link = taskService.dispatch('task.link_material', {
      task_id: receiver.task_id,
      receiving_task_id: receiver.task_id,
      material_id: material.material.material_id,
      role: 'response',
    }, bound(taskService, producer.task_id, 'execution:producer', 'agent:producer', 'link:response'));
    assert.equal(link.link.producer_execution_id, 'execution:producer');
    const pending = taskService.listPendingNotifications(receiver.task_id, receiverExecution.execution_id);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].notification_type, 'material_available');
    assert.equal(pending[0].payload.action, 'inspect_material_and_record_task_feedback');
    assert.equal(pending[0].payload.producer_task_id, producer.task_id);
    assert.equal(pending[0].payload.material_id, material.material.material_id);
    assert.equal(taskService.markNotificationDelivered(pending[0].notification_id, receiverExecution.execution_id).delivered, true);
    assert.equal(taskService.listPendingNotifications(receiver.task_id, receiverExecution.execution_id).length, 0);
    assert.equal(taskService.markNotificationDelivered(pending[0].notification_id, receiverExecution.execution_id).delivered, true);
  } finally {
    taskService.close();
  }
});

class NotificationSession extends EventEmitter {
  constructor() {
    super();
    this.prompts = [];
    this.manifest = { test: true };
  }

  async waitForReady() {}

  async waitForSettled() {}

  async prompt(message, options = {}) {
    this.prompts.push({ message, options });
  }

  async stop() {
    this.emit('close', { code: 0 });
  }
}

test('Runtime delivers active notifications in order and inactive notifications on next start', async () => {
  const { database, taskService, contextService } = setup();
  const rootDir = await mkdtemp(join(tmpdir(), 'swarmenv-issue100-notify-'));
  let currentTime = Date.parse('2030-01-01T00:00:00.000Z');
  const sessions = [];
  const adapter = { async start() { const session = new NotificationSession(); sessions.push(session); return session; } };
  const runtime = new Runtime({
    taskService,
    contextService,
    workspaceManager: new WorkspaceManager({ rootDir }),
    agentAdapter: adapter,
    actorRef: 'runtime:test',
    coreIds: ['core-test'],
    clock: () => currentTime,
    executionTimeoutMs: 60_000,
    handoffReminderMs: 50_000,
  });
  try {
    taskService.dispatch('mission.create', { mission_id: 'mission:runtime-notify', goal: 'runtime notification' }, env('mission:runtime', 'operator:test'));
    const activeTask = makeTask(taskService, 'mission:runtime-notify', 'task:active');
    const inactiveTask = makeTask(taskService, 'mission:runtime-notify', 'task:inactive');
    const activeExecution = claim(taskService, activeTask, 'execution_active', 'agent:active');
    await runtime.startExecution(activeExecution.execution_id, { coreId: 'core-test' });
    taskService.enqueueNotification({
      deliveryKey: 'test:active:one', missionId: 'mission:runtime-notify', recipientTaskId: activeTask.task_id,
      recipientExecutionId: activeExecution.execution_id, type: 'material_available', materialId: 'material:x',
      sourceTaskId: 'task:producer', sourceExecutionId: 'execution:producer', payload: { material_id: 'material:x' },
    });
    taskService.enqueueNotification({
      deliveryKey: 'test:active:two', missionId: 'mission:runtime-notify', recipientTaskId: activeTask.task_id,
      recipientExecutionId: activeExecution.execution_id, type: 'task_reopened', payload: { task_id: activeTask.task_id },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sessions[0].prompts.length, 3, 'initial prompt and two serialized follow-ups');
    assert.equal(sessions[0].prompts[1].options.streamingBehavior, 'followUp');
    assert.equal(sessions[0].prompts[2].options.streamingBehavior, 'followUp');
    assert.equal(taskService.listPendingNotifications(activeTask.task_id, activeExecution.execution_id).length, 0);

    const inactiveExecution = claim(taskService, inactiveTask, 'execution_inactive', 'agent:inactive');
    // The inactive Task has no Runtime-owned Session yet; a Task-level
    // notification is carried into its next initial prompt.
    taskService.enqueueNotification({
      deliveryKey: 'test:inactive:one', missionId: 'mission:runtime-notify', recipientTaskId: inactiveTask.task_id,
      type: 'material_available', materialId: 'material:y', payload: { material_id: 'material:y' },
    });
    await runtime.handoffExecution(activeExecution.execution_id, { reason: 'test_release' });
    await runtime.startExecution(inactiveExecution.execution_id, { coreId: 'core-test' });
    assert.match(sessions[1].prompts[0].message, /test:inactive:one|material:y/);
    assert.equal(taskService.listPendingNotifications(inactiveTask.task_id, inactiveExecution.execution_id).length, 0);
  } finally {
    await runtime.shutdown().catch(() => undefined);
    taskService.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('Runtime delivers pending Task notifications after a reusable binding skips the initial prompt', async () => {
  const { taskService, contextService } = setup();
  const rootDir = await mkdtemp(join(tmpdir(), 'swarmenv-issue113-rebind-notify-'));
  const session = new NotificationSession();
  const runtime = new Runtime({
    taskService,
    contextService,
    workspaceManager: new WorkspaceManager({ rootDir }),
    agentAdapter: { async start() { return session; } },
    actorRef: 'runtime:rebind-notify',
    coreIds: ['core-rebind-notify'],
  });
  try {
    taskService.dispatch('mission.create', { mission_id: 'mission:rebind-notify', goal: 'rebind notification' }, env('rebind:mission', 'operator:test'));
    const task = makeTask(taskService, 'mission:rebind-notify', 'task:rebind-notify');
    const execution = claim(taskService, task, 'execution:rebind-notify', 'agent:rebind-notify');
    taskService.enqueueNotification({
      deliveryKey: 'rebind:pending', missionId: 'mission:rebind-notify', recipientTaskId: task.task_id,
      type: 'material_available', materialId: 'material:pending', payload: { material_id: 'material:pending' },
    });
    await runtime.bindAgentExecution(execution.execution_id, session, {
      workspaceRef: join(rootDir, execution.execution_id),
      coreId: 'core-rebind-notify',
      sendInitialPrompt: false,
      agentPrompt: 'current bound turn already owns the first prompt',
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(session.prompts.length, 1);
    assert.equal(session.prompts[0].options.streamingBehavior, 'followUp');
    assert.match(session.prompts[0].message, /material:pending/);
    assert.equal(taskService.listPendingNotifications(task.task_id, execution.execution_id).length, 0);
  } finally {
    await runtime.shutdown().catch(() => undefined);
    taskService.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('Runtime deadline warning is a durable notification and expiry records missing handoff without synthetic Material', async () => {
  const { database, taskService, contextService } = setup();
  const rootDir = await mkdtemp(join(tmpdir(), 'swarmenv-issue100-deadline-'));
  const adapter = { async start() { return new NotificationSession(); } };
  let currentTime = Date.parse('2030-01-01T00:00:00.000Z');
  const runtime = new Runtime({
    taskService, contextService, workspaceManager: new WorkspaceManager({ rootDir }), agentAdapter: adapter,
    actorRef: 'runtime:deadline', coreIds: ['core-deadline'], clock: () => currentTime,
    executionTimeoutMs: 60_000, handoffReminderMs: 50_000,
  });
  try {
    taskService.dispatch('mission.create', { mission_id: 'mission:deadline', goal: 'deadline' }, env('mission:deadline', 'operator:test'));
    const task = makeTask(taskService, 'mission:deadline', 'task:deadline', 'task:deadline', { timebox_ms: 60_000 });
    const claimed = claim(taskService, task, 'execution_deadline', 'agent:deadline');
    await runtime.startExecution(claimed.execution_id, { coreId: 'core-deadline' });
    currentTime += 50_000;
    const reminder = await runtime.sweepExecutionTimeouts(new Date(currentTime), { executionIds: [claimed.execution_id] });
    assert.equal(reminder.length, 1);
    assert.equal(reminder[0].kind, 'handoff_reminder');
    assert.equal(reminder[0].notification.notification_type, 'handoff_warning');
    currentTime += 10_000;
    const timeout = await runtime.sweepExecutionTimeouts(new Date(currentTime), { executionIds: [claimed.execution_id] });
    assert.equal(timeout.length, 1);
    assert.equal(timeout[0].execution.state, 'EXPIRED');
    assert.equal(timeout[0].execution.handoff_metadata.handoff_missing, true);
    assert.equal(contextService.readMaterials({ role: 'handoff' }).length, 0);
  } finally {
    await runtime.shutdown().catch(() => undefined);
    taskService.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});
