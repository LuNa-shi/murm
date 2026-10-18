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
    this.prompts = [];
  }

  async waitForReady() {}

  async prompt(message) {
    this.prompts.push(message);
    return { data: { disposition: 'handled' } };
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
    this.starts = [];
  }

  async start(options) {
    this.starts.push(options);
    const { executionId } = options;
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
  const claimed = sdk.withContext({ taskId: task.task_id, specVersion: 1, stateVersion: 0 }).claim({
    execution_id: 'execution-runtime', claim_key: 'runtime-claim', owner_ref: 'runtime:local', agent_prompt: 'run the fixture', input_material_refs: [],
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
  assert.equal(fixtureData.adapter.starts[0].cwd, started.workspace.workspace_ref);
  assert.equal(fixtureData.adapter.starts[0].sessionDir, join(started.workspace.workspace_ref, '.swarm', 'pi-session'));
  assert.equal(fixtureData.adapter.sessions[0].prompts[0], 'run the fixture');
  const workspaceManifest = JSON.parse(await readFile(join(started.workspace.workspace_ref, 'workspace-manifest.json'), 'utf8'));
  assert.equal(workspaceManifest.task_id, claimed.execution.task_id);
  assert.match(await readFile(join(started.workspace.workspace_ref, 'README.md'), 'utf8'), /Task instructions:/);
  await assert.rejects(() => readFile(join(started.workspace.workspace_ref, 'initial-context.json'), 'utf8'), { code: 'ENOENT' });
  await assert.rejects(() => readFile(join(started.workspace.workspace_ref, 'initial-prompt.txt'), 'utf8'), { code: 'ENOENT' });
  assert.equal(workspaceManifest.input_snapshot.workspace_snapshot_hash, claimed.execution.input_snapshot_hash);

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
    claim_key: 'second-runtime-claim', owner_ref: 'runtime:two', agent_prompt: 'duplicate', workspace_manifest_ref: 'workspace://other', input_snapshot_hash: 'other', input_material_refs: [],
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

test('Workspace resume copies a selected revision into a new lineage', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'swarmenv-workspace-lineage-'));
  const manager = new WorkspaceManager({ rootDir });
  const task = {
    task_id: 'task-lineage', root_id: 'task-lineage', task_type: 'proof',
    goal: 'preserve workspace lineage', expected_output: 'artifact',
    acceptance_conditions: {}, workspace: { problem_file: 'problem.lean', formal_source: 'theorem t : True := by trivial' },
  };
  const first = await manager.createWorkspace({ executionId: 'execution-one', fencingVersion: 1, task, workspaceManifest: {}, inputSnapshotManifest: {} });
  const second = await manager.saveWorkspaceRevision({
    workspaceRef: first.workspace_ref, executionId: 'execution-one', fencingVersion: 1,
    files: { 'progress.txt': 'revision two' },
  });
  const resumed = await manager.cloneWorkspace({
    sourceWorkspaceRef: first.workspace_ref,
    targetWorkspaceRef: join(rootDir, 'execution-two'),
    executionId: 'execution-two', fencingVersion: 1, revision: second.workspace_revision,
    task, workspaceManifest: { selection: { mode: 'resume', revision: second.workspace_revision } }, inputSnapshotManifest: {}, runtimeManifest: {},
  });
  assert.equal(resumed.execution_id, 'execution-two');
  assert.equal(resumed.workspace_revision, second.workspace_revision);
  assert.equal(await readFile(join(resumed.workspace_ref, 'progress.txt'), 'utf8'), 'revision two');
  const resumedMetadata = JSON.parse(await readFile(join(resumed.workspace_ref, '.swarm', 'workspace.json'), 'utf8'));
  assert.equal(resumedMetadata.parent_workspace_ref, first.workspace_ref);
  assert.equal(resumed.parent_workspace_ref, first.workspace_ref);
  assert.equal(resumed.parent_workspace_revision, second.workspace_revision);
  await rm(rootDir, { recursive: true, force: true });
});

test('Runtime binds a selected Workspace revision when a new Execution forks a prior one', async () => {
  const fixtureData = await fixture();
  const { runtime, taskService, claimed, rootDir, sdk } = fixtureData;
  const started = await runtime.startExecution(claimed.execution.execution_id);
  const waited = await runtime.requestWait(claimed.execution.execution_id, {
    waitCondition: { type: 'timer', deadline: new Date(Date.now() + 60_000).toISOString() },
    checkpoint: { phase: 'fork-source' },
    files: { 'progress.txt': 'source revision' },
  });
  const fenced = await runtime.fenceExecution(claimed.execution.execution_id);
  const source = taskService.getExecution(claimed.execution.execution_id);
  const task = taskService.getTask(fixtureData.task.task_id);
  const forkClaim = sdk.withContext({ taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version }).claim({
    claim_key: 'runtime-fork-claim', owner_ref: 'runtime:fork', workspace_mode: 'resume',
    workspace_source_execution_id: source.execution_id, workspace_revision: source.workspace_revision,
  }, { operationId: 'runtime-fork-claim' });
  const forked = await runtime.startExecution(forkClaim.execution.execution_id);
  assert.equal(forked.execution.workspace_revision, source.workspace_revision + 1);
  assert.equal(forked.workspace.parent_workspace_ref, source.workspace_ref);
  assert.equal(forked.workspace.parent_workspace_revision, source.workspace_revision);
  assert.equal(await readFile(join(forked.workspace.workspace_ref, 'progress.txt'), 'utf8'), 'source revision');
  assert.equal(fenced.execution.state, 'FENCED');
  await runtime.stopExecution(forked.execution.execution_id);
  await rm(rootDir, { recursive: true, force: true });
  fixtureData.taskService.close();
  assert.ok(waited.execution.workspace_ref);
  assert.ok(started.workspace.workspace_ref);
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
