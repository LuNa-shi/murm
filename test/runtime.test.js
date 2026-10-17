import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import {
  ContextService,
  ERROR_CODES,
  Runtime,
  ServicesRouter,
  ServicesSDK,
  SwarmEnvError,
  TaskService,
  WorkspaceManager,
} from '../src/index.js';

class FakeSession extends EventEmitter {
  constructor(executionId) {
    super();
    this.executionId = executionId;
    this.manifest = { pi_package: '@earendil-works/pi-coding-agent', pi_version: '1.3.0', nurouter_version: '0.2.12', node_version: process.versions.node, launch_args: ['fake'] };
    this.closed = false;
  }

  stop() {
    if (!this.closed) {
      this.closed = true;
      queueMicrotask(() => this.emit('close', { code: 0, signal: 'SIGTERM' }));
    }
  }
}

class FakeAgentAdapter {
  constructor() {
    this.sessions = [];
  }

  async start({ executionId }) {
    const session = new FakeSession(executionId);
    this.sessions.push(session);
    return session;
  }
}

async function fixture() {
  const database = new DatabaseSync(':memory:');
  const taskService = new TaskService(database);
  const contextService = new ContextService(database, { taskService });
  const router = new ServicesRouter({ taskService, contextService });
  const sdk = new ServicesSDK(router, { actorRef: 'owner:root' });
  const task = sdk.proposeTask({ task_type: 'proof', goal: 'runtime fixture', expected_output: 'proof', acceptance_conditions: { fixture: true }, owner_ref: 'owner:root' }, { operationId: 'runtime-proposal' }).task;
  const frozen = sdk.freezeInitialContext({
    freeze_key: 'runtime-freeze', task_id: task.task_id, execution_id: 'execution-runtime', spec_version: 1, spec_hash: task.spec_hash,
    task_spec: { task_id: task.task_id, goal: task.goal, task_type: task.task_type, completion_contract: task.completion_contract },
    initial_prompt: 'run the fixture', material_refs: [], service_environment: { runtime: 'test' },
  }, { operationId: 'runtime-freeze-op', taskId: task.task_id, executionId: 'execution-runtime', specVersion: 1, fencingVersion: 1 });
  const claimed = sdk.withContext({ taskId: task.task_id, specVersion: 1, stateVersion: 0 }).claim({
    execution_id: 'execution-runtime', claim_key: 'runtime-claim', owner_ref: 'runtime:local', initial_prompt: 'run the fixture',
    initial_context_ref: frozen.initial_context_ref, input_snapshot_hash: frozen.input_snapshot_hash, input_material_refs: [],
  }, { operationId: 'runtime-claim-op' });
  const rootDir = await mkdtemp(join(tmpdir(), 'swarmenv-workspace-'));
  const adapter = new FakeAgentAdapter();
  const runtime = new Runtime({ taskService, contextService, workspaceManager: new WorkspaceManager({ rootDir }), agentAdapter: adapter, actorRef: 'runtime:local' });
  return { taskService, contextService, sdk, task, claimed, rootDir, adapter, runtime };
}

test('Runtime creates an isolated workspace before Pi, saves checkpoint before wait, and restores the same lineage', async () => {
  const fixtureData = await fixture();
  const { runtime, taskService, claimed, rootDir } = fixtureData;
  const started = await runtime.startExecution(claimed.execution.execution_id);
  assert.equal(started.execution.state, 'RUNNING');
  assert.equal(runtime.getActiveProcessCount(), 1);
  assert.equal(JSON.parse(await readFile(join(started.workspace.workspace_ref, 'initial-context.json'), 'utf8')).execution_id, claimed.execution.execution_id);
  assert.equal(await readFile(join(started.workspace.workspace_ref, 'initial-prompt.txt'), 'utf8'), 'run the fixture');
  assert.equal(await readFile(join(started.workspace.workspace_ref, 'input-snapshot.json'), 'utf8').then(JSON.parse).then((value) => value.input_snapshot_hash), claimed.execution.input_snapshot_hash);

  const waited = await runtime.requestWait(claimed.execution.execution_id, {
    waitCondition: { type: 'timer', deadline: new Date(Date.now() + 60_000).toISOString() },
    checkpoint: { step: 'before-judge' },
    files: { 'progress.txt': 'checkpointed' },
  });
  assert.equal(waited.execution.state, 'WAITING');
  assert.equal(waited.task.state, 'WAITING');
  assert.equal(runtime.getActiveProcessCount(), 0);
  assert.ok(waited.execution.checkpoint_ref);
  assert.ok(waited.execution.workspace_content_hash);
  assert.equal(taskService.listActiveExecutions().length, 1);

  assert.throws(
    () => fixtureData.sdk.withContext({ taskId: fixtureData.task.task_id, specVersion: 1, stateVersion: waited.task.state_version }).claim({
      claim_key: 'second-runtime-claim', owner_ref: 'runtime:two', initial_prompt: 'duplicate', initial_context_ref: 'context://other', input_snapshot_hash: 'other', input_material_refs: [],
    }, { operationId: 'second-runtime-op' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.CONFLICT,
  );
  const resumed = await runtime.wakeExecution(claimed.execution.execution_id);
  assert.equal(resumed.execution.state, 'RUNNING');
  assert.equal(resumed.execution.workspace_ref, started.execution.workspace_ref);
  assert.equal(resumed.execution.input_snapshot_hash, claimed.execution.input_snapshot_hash);
  await runtime.stopExecution(claimed.execution.execution_id);
  await rm(rootDir, { recursive: true, force: true });
  fixtureData.taskService.close();
});

test('fencing and Runtime restart prevent old workspace writes and leave an auditable workspace', async () => {
  const fixtureData = await fixture();
  const { runtime, taskService, claimed, rootDir } = fixtureData;
  const started = await runtime.startExecution(claimed.execution.execution_id);
  const oldAgent = fixtureData.sdk.withContext({ actorRef: 'agent:old', taskId: fixtureData.task.task_id, executionId: claimed.execution.execution_id, specVersion: 1, stateVersion: started.execution.state_version, fencingVersion: 1 });
  const fenced = await runtime.fenceExecution(claimed.execution.execution_id);
  assert.equal(fenced.execution.state, 'FENCED');
  assert.equal(fenced.execution.fencing_version, 2);
  assert.throws(
    () => oldAgent.publishMaterial({ kind: 'failure', scope: 'operational', content: { message: 'late' } }, { operationId: 'late-material' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.FENCED,
  );
  await assert.rejects(
    () => fixtureData.runtime.workspaceManager.saveWorkspaceRevision({ workspaceRef: started.workspace.workspace_ref, executionId: claimed.execution.execution_id, fencingVersion: 1, files: { 'late.txt': 'old process' } }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.FENCED,
  );
  assert.equal(taskService.getTask(fixtureData.task.task_id).state, 'OPEN');
  assert.equal(runtime.getActiveProcessCount(), 0);
  await rm(rootDir, { recursive: true, force: true });
  fixtureData.taskService.close();
});

test('Runtime restart fences CREATED/RUNNING owners but preserves WAITING responsibility', async () => {
  const fixtureData = await fixture();
  const { runtime, taskService, claimed, rootDir } = fixtureData;
  await runtime.startExecution(claimed.execution.execution_id);
  const result = await runtime.restart();
  assert.equal(result.runtime_generation, 2);
  assert.equal(taskService.getExecution(claimed.execution.execution_id).state, 'FENCED');
  assert.equal(taskService.getExecution(claimed.execution.execution_id).runtime_generation, 2);
  assert.equal(runtime.getActiveProcessCount(), 0);
  await rm(rootDir, { recursive: true, force: true });
  fixtureData.taskService.close();
});

test('startup failure preserves the prepared workspace and ends the Execution without leaking capacity', async () => {
  const fixtureData = await fixture();
  const { runtime, taskService, claimed, rootDir } = fixtureData;
  runtime.agentAdapter.start = async () => {
    throw new SwarmEnvError(ERROR_CODES.START_FAILED, 'controlled startup failure');
  };
  await assert.rejects(() => runtime.startExecution(claimed.execution.execution_id), (error) => error.code === ERROR_CODES.START_FAILED);
  const execution = taskService.getExecution(claimed.execution.execution_id);
  assert.equal(execution.state, 'FAILED');
  assert.ok(execution.workspace_ref);
  assert.equal(runtime.getActiveProcessCount(), 0);
  await rm(rootDir, { recursive: true, force: true });
  fixtureData.taskService.close();
});

test('Workspace Manager rejects execution and file paths that escape its root', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'swarmenv-path-'));
  const manager = new WorkspaceManager({ rootDir });
  await assert.rejects(
    () => manager.createWorkspace({ executionId: '../outside', fencingVersion: 1, initialContext: {}, initialPrompt: 'p', inputSnapshotManifest: {} }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.INVALID_CONTRACT,
  );
  await rm(rootDir, { recursive: true, force: true });
});

test('lease sweep fences an expired running Execution and releases its process slot', async () => {
  const fixtureData = await fixture();
  const { runtime, taskService, claimed, rootDir } = fixtureData;
  const started = await runtime.startExecution(claimed.execution.execution_id);
  taskService.db.prepare('UPDATE executions SET lease_expires_at = ? WHERE execution_id = ?').run(new Date(0).toISOString(), claimed.execution.execution_id);
  const expired = await runtime.sweepExpired(new Date());
  assert.equal(expired.length, 1);
  assert.equal(expired[0].execution.state, 'EXPIRED');
  assert.equal(taskService.getExecution(claimed.execution.execution_id).fencing_version, 2);
  assert.equal(runtime.getActiveProcessCount(), 0);
  assert.ok(started.workspace.workspace_ref);
  await rm(rootDir, { recursive: true, force: true });
  fixtureData.taskService.close();
});
