import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ContextService,
  Runtime,
  ServicesRouter,
  ServicesSDK,
  TaskService,
  WorkspaceManager,
} from '../src/index.js';

class ProgressSession extends EventEmitter {
  constructor() {
    super();
    this.sessionId = 'progress-session';
    this.manifest = { fake: true, pi_version: 'phase1-progress' };
    this.closed = false;
  }

  async waitForReady() {}

  async prompt() {
    return { data: { disposition: 'handled' } };
  }

  async stop() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', { code: 0, signal: 'SIGTERM' });
  }
}

class ProgressAdapter {
  constructor() {
    this.sessions = [];
  }

  async start() {
    const session = new ProgressSession();
    this.sessions.push(session);
    return session;
  }
}

test('execution_progress saves linked Progress Material, then hands off the same Execution', async () => {
  const database = new DatabaseSync(':memory:');
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  const router = new ServicesRouter({ taskService, contextService });
  const owner = new ServicesSDK(router, { actorRef: 'owner:phase1', coreId: 'core:progress' });
  const mission = owner.createMission({ mission_id: 'mission:progress', goal: 'preserve progress' }, { operationId: 'progress:mission' }).mission;
  const task = owner.createTask({
    mission_id: mission.mission_id,
    task_id: 'task:progress',
    summary: 'Preserve a durable progress handoff for the current research route.',
    goal: 'Preserve the current research route and leave an auditable handoff for the next Agent.',
    expected_output: 'a durable handoff',
    acceptance_conditions: ['progress is linked'],
  }, { operationId: 'progress:task' }).task;
  const claimed = owner.withContext({ taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version }).taskTake({
    task_id: task.task_id,
    claim_key: 'progress:take',
  }, { operationId: 'progress:take' });
  const rootDir = await mkdtemp(join(tmpdir(), 'swarmenv-phase1-progress-'));
  const runtime = new Runtime({
    taskService,
    contextService,
    workspaceManager: new WorkspaceManager({ rootDir }),
    agentAdapter: new ProgressAdapter(),
    actorRef: 'runtime:progress',
    coreIds: ['core:progress'],
  });

  try {
    await runtime.startExecution(claimed.execution.execution_id);
    const checkpoint = await runtime.executionProgress(claimed.execution.execution_id, {
      kind: 'checkpoint',
      progress: {
        completed_work: ['read the input'],
        findings: ['the route is viable'],
        open_questions: ['which branch should be checked next'],
        next_step: 'check the viable route',
      },
      files: { 'notes/progress.md': 'viable route\n' },
      checkpoint: { phase: 'route-found' },
    });
    assert.equal(checkpoint.kind, 'checkpoint');
    assert.equal(checkpoint.disposition, 'continued');
    assert.equal(checkpoint.save_status, 'saved');
    assert.equal(checkpoint.loss.unsaved_progress, false);
    assert.ok(checkpoint.progress_material.material_id);
    assert.ok(checkpoint.progress_link.link_id);
    assert.equal(taskService.listTaskMaterials(task.task_id).links.at(-1).role, 'experience');
    assert.equal(taskService.getExecution(claimed.execution.execution_id).state, 'RUNNING');

    const handoff = await runtime.executionProgress(claimed.execution.execution_id, {
      kind: 'handoff',
      progress: {
        completed_work: ['saved the viable route'],
        findings: ['the next Agent can continue from the checkpoint'],
        open_questions: [],
        next_step: 'run the focused check',
      },
      reason: 'bounded_progress_handoff',
      summary: 'continue from the saved route',
    });
    assert.equal(handoff.kind, 'handoff');
    assert.equal(handoff.disposition, 'handed_off');
    assert.equal(handoff.save_status, 'saved');
    assert.equal(handoff.execution.state, 'FENCED');
    assert.equal(handoff.task.state, 'OPEN');
    assert.equal(runtime.getActiveProcessCount(), 0);
    assert.equal(taskService.listTaskMaterials(task.task_id).links.filter((link) => link.role === 'experience').length, 2);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    taskService.close();
  }
});

test('execution_progress records a bounded save failure and still releases on handoff', async () => {
  const database = new DatabaseSync(':memory:');
  const contextService = new ContextService(database);
  const taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  const router = new ServicesRouter({ taskService, contextService });
  const owner = new ServicesSDK(router, { actorRef: 'owner:phase1', coreId: 'core:progress-failure' });
  const mission = owner.createMission({ mission_id: 'mission:progress-failure', goal: 'bound save failure' }, { operationId: 'progress-failure:mission' }).mission;
  const task = owner.createTask({
    mission_id: mission.mission_id,
    task_id: 'task:progress-failure',
    summary: 'Record a bounded progress save failure without stranding the execution.',
    goal: 'Record a bounded progress save failure without stranding the execution.',
    expected_output: 'a bounded loss record',
    acceptance_conditions: ['the execution can still hand off'],
  }, { operationId: 'progress-failure:task' }).task;
  const claimed = owner.withContext({ taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version }).taskTake({
    task_id: task.task_id,
    claim_key: 'progress-failure:take',
  }, { operationId: 'progress-failure:take' });
  const rootDir = await mkdtemp(join(tmpdir(), 'swarmenv-phase1-progress-failure-'));
  const runtime = new Runtime({
    taskService,
    contextService,
    workspaceManager: new WorkspaceManager({ rootDir }),
    agentAdapter: new ProgressAdapter(),
    actorRef: 'runtime:progress-failure',
    coreIds: ['core:progress-failure'],
  });

  try {
    await runtime.startExecution(claimed.execution.execution_id);
    runtime.workspaceManager.saveWorkspaceRevision = async () => {
      const error = new Error('controlled commit failure');
      error.code = 'CONTROLLED_SAVE_FAILURE';
      throw error;
    };
    const progress = {
      completed_work: ['attempted one bounded save'],
      findings: ['the save path is unavailable'],
      open_questions: ['which operator should repair the path'],
      next_step: 'resume from the last valid snapshot',
    };
    const checkpoint = await runtime.executionProgress(claimed.execution.execution_id, {
      kind: 'checkpoint', progress, files: { 'notes/lost.md': 'not persisted\n' },
    });
    assert.equal(checkpoint.save_status, 'save_failed');
    assert.equal(checkpoint.loss.unsaved_progress, true);
    assert.equal(checkpoint.loss.phase, 'workspace');
    assert.equal(checkpoint.execution.state, 'RUNNING');
    assert.ok(checkpoint.progress_material.material_id);
    assert.ok(checkpoint.progress_link.link_id);

    const handoff = await runtime.executionProgress(claimed.execution.execution_id, {
      kind: 'handoff', progress, reason: 'save_failure_handoff',
    });
    assert.equal(handoff.save_status, 'save_failed');
    assert.equal(handoff.loss.unsaved_progress, true);
    assert.equal(handoff.execution.state, 'FENCED');
    assert.equal(handoff.task.state, 'OPEN');
    assert.equal(runtime.getActiveProcessCount(), 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    taskService.close();
  }
});
