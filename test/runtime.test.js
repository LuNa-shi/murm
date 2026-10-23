import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  constructor(executionId, { stopDelayMs = 0 } = {}) {
    super();
    this.executionId = executionId;
    this.manifest = { pi_package: '@earendil-works/pi-coding-agent', pi_version: '1.3.0', nurouter_version: '0.2.12', node_version: process.versions.node, launch_args: ['fake'] };
    this.closed = false;
    this.stopDelayMs = stopDelayMs;
    this.prompts = [];
  }

  async waitForReady() {}

  async prompt(message) {
    this.prompts.push(message);
    return { data: { disposition: 'handled' } };
  }

  stop() {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => setTimeout(() => {
      this.closed = true;
      this.emit('close', { code: 0, signal: 'SIGTERM' });
      resolve();
    }, this.stopDelayMs));
  }
}

class FakeAgentAdapter {
  constructor({ stopDelayMs = 0 } = {}) {
    this.sessions = [];
    this.starts = [];
    this.stopDelayMs = stopDelayMs;
  }

  async start(options) {
    this.starts.push(options);
    const { executionId } = options;
    const session = new FakeSession(executionId, { stopDelayMs: this.stopDelayMs });
    this.sessions.push(session);
    return session;
  }
}

async function fixture({ stopDelayMs = 0, runtimeOptions = {} } = {}) {
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
  const adapter = new FakeAgentAdapter({ stopDelayMs });
  const runtime = new Runtime({ taskService, contextService, workspaceManager: new WorkspaceManager({ rootDir }), agentAdapter: adapter, actorRef: 'runtime:local', ...runtimeOptions });
  return { taskService, contextService, sdk, task, claimed, rootDir, adapter, runtime };
}

test('Runtime waits for Agent exit before releasing a waiting Core', async () => {
  const fixtureData = await fixture({ stopDelayMs: 40 });
  const { runtime, taskService, claimed, rootDir, adapter } = fixtureData;
  try {
    const started = await runtime.startExecution(claimed.execution.execution_id);
    const stopStartedAt = Date.now();
    const waited = await runtime.requestWait(claimed.execution.execution_id, {
      waitCondition: { type: 'timer', deadline: new Date(Date.now() + 60_000).toISOString() },
      checkpoint: { step: 'before-wait' },
    });
    assert.ok(Date.now() - stopStartedAt >= 35);
    assert.equal(adapter.sessions[0].closed, true);
    assert.equal(runtime.getActiveProcessCount(), 0);
    assert.equal(waited.execution.workspace_ref, started.execution.workspace_ref);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    taskService.close();
  }
});

test('Runtime creates an isolated workspace before Pi, saves checkpoint before wait, and restores the same lineage', async () => {
  const fixtureData = await fixture();
  const { runtime, taskService, claimed, rootDir } = fixtureData;
  const started = await runtime.startExecution(claimed.execution.execution_id);
  assert.equal(started.execution.state, 'RUNNING');
  assert.equal(runtime.getActiveProcessCount(), 1);
  assert.equal(fixtureData.adapter.starts[0].cwd, started.workspace.workspace_ref);
  assert.equal(fixtureData.adapter.starts[0].sessionDir, join(started.workspace.workspace_ref, '.swarm', 'pi-session'));
  const piSettings = JSON.parse((await runtime.readWorkspaceFile(claimed.execution.execution_id, { path: '.pi/settings.json' })).content);
  assert.deepEqual(piSettings, {
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 15, baseDelayMs: 2_000, maxAgentDelayMs: 60_000 },
  });
  assert.equal(fixtureData.adapter.sessions[0].prompts[0], 'run the fixture');
  const workspaceManifest = JSON.parse(await readFile(join(started.workspace.workspace_ref, 'workspace-manifest.json'), 'utf8'));
  assert.equal(workspaceManifest.task_id, claimed.execution.task_id);
  assert.match(await readFile(join(started.workspace.workspace_ref, 'README.md'), 'utf8'), /Task instructions:/);
  await assert.rejects(() => readFile(join(started.workspace.workspace_ref, 'initial-context.json'), 'utf8'), { code: 'ENOENT' });
  await assert.rejects(() => readFile(join(started.workspace.workspace_ref, 'initial-prompt.txt'), 'utf8'), { code: 'ENOENT' });
  assert.equal(workspaceManifest.input_snapshot.workspace_snapshot_hash, claimed.execution.input_snapshot_hash);

  const files = await runtime.listWorkspaceFiles(claimed.execution.execution_id);
  assert.ok(files.files.some((file) => file.path === 'README.md'));
  assert.equal(files.files.some((file) => file.path.startsWith('.swarm/')), false);
  const readme = await runtime.readWorkspaceFile(claimed.execution.execution_id, { path: 'README.md' });
  assert.match(readme.content, /Expected output: proof/);
  const written = await runtime.writeWorkspaceFile(claimed.execution.execution_id, {
    path: 'notes/progress.md',
    content: '# Progress\n\nThe Agent inspected the fixture.\n',
    expectedRevision: started.workspace.workspace_revision,
    saveOperationId: 'runtime:workspace-write',
  });
  assert.equal(written.workspace.workspace_revision, started.workspace.workspace_revision + 1);
  assert.match(written.file.content, /inspected the fixture/);
  assert.ok(written.diff.changed_files.some((file) => file.path === 'notes/progress.md' && file.status === 'added'));
  assert.equal(taskService.getExecution(claimed.execution.execution_id).workspace_revision, written.workspace.workspace_revision);
  await assert.rejects(
    () => runtime.writeWorkspaceFile(claimed.execution.execution_id, { path: 'stale.txt', content: 'stale', expectedRevision: started.workspace.workspace_revision }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.STALE_VERSION,
  );
  await assert.rejects(
    () => runtime.readWorkspaceFile(claimed.execution.execution_id, { path: '../outside.txt' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.NOT_ALLOWED,
  );
  await assert.rejects(
    () => runtime.readWorkspaceFile(claimed.execution.execution_id, { path: '.swarm/workspace.json' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.NOT_ALLOWED,
  );
  await assert.rejects(
    () => runtime.writeWorkspaceFile(claimed.execution.execution_id, { path: '.swarm/escape.txt', content: 'escape' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.NOT_ALLOWED,
  );
  const outsideTarget = join(rootDir, 'outside-target.txt');
  await writeFile(outsideTarget, 'outside');
  await symlink(outsideTarget, join(started.workspace.workspace_ref, 'link.txt'));
  await assert.rejects(
    () => runtime.readWorkspaceFile(claimed.execution.execution_id, { path: 'link.txt' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.NOT_ALLOWED,
  );
  await assert.rejects(
    () => runtime.writeWorkspaceFile(claimed.execution.execution_id, { path: 'link.txt', content: 'overwrite' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.NOT_ALLOWED,
  );
  await assert.rejects(
    () => runtime.writeWorkspaceFile(claimed.execution.execution_id, { path: 'link.txt/child', content: 'escape' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.NOT_ALLOWED,
  );

  const waited = await runtime.requestWait(claimed.execution.execution_id, {
    waitCondition: { type: 'timer', deadline: new Date(Date.now() + 60_000).toISOString() },
    checkpoint: { step: 'before-judge' },
    files: { 'progress.txt': 'checkpointed', 'checkpoint.json': { step: 'before-judge', source: 'Agent checkpoint' } },
  });
  assert.equal(waited.execution.state, 'WAITING');
  assert.equal(waited.task.state, 'WAITING');
  assert.equal(runtime.getActiveProcessCount(), 0);
  assert.ok(waited.execution.checkpoint_ref);
  assert.ok(waited.execution.workspace_content_hash);
  assert.deepEqual(JSON.parse(await readFile(join(started.workspace.workspace_ref, 'checkpoint.json'), 'utf8')), { step: 'before-judge', source: 'Agent checkpoint' });
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

test('final provider retry failure starts a fresh Session from the durable Workspace lineage', async () => {
  const fixtureData = await fixture();
  const { runtime, taskService, claimed, rootDir, adapter } = fixtureData;
  try {
    const started = await runtime.startExecution(claimed.execution.execution_id);
    const oldSession = adapter.sessions[0];
    const oldAgent = fixtureData.sdk.withContext({ actorRef: 'agent:old', taskId: fixtureData.task.task_id, executionId: claimed.execution.execution_id, specVersion: 1, stateVersion: started.execution.state_version, fencingVersion: started.execution.fencing_version });
    oldSession.emit('rpc', { type: 'auto_retry_end', success: false, attempt: 15, finalError: 'provider unavailable' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(oldSession.closed, true);
    assert.equal(runtime.getActiveProcessCount(), 1);
    assert.equal(adapter.sessions.length, 2);
    const executions = taskService.listExecutions(fixtureData.task.task_id);
    assert.equal(executions.length, 1);
    const replacement = executions[0];
    assert.equal(replacement.state, 'RUNNING');
    assert.equal(replacement.execution_id, started.execution.execution_id);
    assert.equal(replacement.attempt_no, started.execution.attempt_no + 1);
    assert.equal(replacement.fencing_version, started.execution.fencing_version + 1);
    assert.equal(adapter.starts[1].sessionDir, adapter.starts[0].sessionDir);
    assert.notEqual(adapter.starts[1].sessionId, adapter.starts[0].sessionId);
    assert.equal(adapter.sessions[1].prompts[0].includes('provider_failure'), true);
    assert.throws(
      () => oldAgent.publishMaterial({ kind: 'failure', scope: 'operational', content: { message: 'late' } }, { operationId: 'late-recovery-material' }),
      (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.FENCED,
    );
    await runtime.stopExecution(replacement.execution_id);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    taskService.close();
  }
});

test('Runtime notifies the owner when recovery replaces a failed Session', async () => {
  const sessionEvents = [];
  const fixtureData = await fixture({ runtimeOptions: { onSessionStarted: (event) => sessionEvents.push(event) } });
  const { runtime, adapter, claimed, rootDir, taskService } = fixtureData;
  try {
    const started = await runtime.startExecution(claimed.execution.execution_id);
    const oldSession = adapter.sessions[0];
    oldSession.emit('rpc', { type: 'auto_retry_end', success: false, attempt: 15, finalError: 'provider unavailable' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const recovery = sessionEvents.find((event) => event.recovery);
    assert.ok(recovery);
    assert.equal(recovery.session, adapter.sessions[1]);
    assert.equal(recovery.execution.execution_id, started.execution.execution_id);
    assert.equal(recovery.execution.fencing_version, started.execution.fencing_version + 1);
    assert.equal(runtime.getActiveProcessCount(), 1);
    await runtime.stopExecution(started.execution.execution_id);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    taskService.close();
  }
});

test('watchdog recovers a heartbeat-only stalled Session but not an active turn', async () => {
  const fixtureData = await fixture({ runtimeOptions: { watchdogTimeoutMs: 1_000 } });
  const { runtime, adapter, claimed, rootDir, taskService } = fixtureData;
  try {
    await runtime.startExecution(claimed.execution.execution_id);
    const session = adapter.sessions[0];
    session.emit('rpc', { type: 'turn_start' });
    const activeTurn = await runtime.sweepWatchdog(new Date(Date.now() + 2_000));
    assert.equal(activeTurn.length, 0);
    session.emit('rpc', { type: 'turn_end' });
    runtime.heartbeat(claimed.execution.execution_id);
    const stalled = await runtime.sweepWatchdog(new Date(Date.now() + 4_000));
    assert.equal(stalled.length, 1);
    assert.equal(adapter.sessions.length, 2);
    const recovered = taskService.listExecutions(fixtureData.task.task_id)[0];
    assert.equal(recovered.state, 'RUNNING');
    assert.equal(recovered.fencing_version, claimed.execution.fencing_version + 1);
    await runtime.stopExecution(taskService.listActiveExecutions()[0].execution_id);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    taskService.close();
  }
});

test('compaction failure is classified and recovered with a fresh Session', async () => {
  const fixtureData = await fixture();
  const { runtime, adapter, claimed, rootDir, taskService } = fixtureData;
  try {
    await runtime.startExecution(claimed.execution.execution_id);
    adapter.sessions[0].emit('rpc', { type: 'compaction_end', reason: 'overflow', aborted: false, errorMessage: 'summary provider failed' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(adapter.sessions.length, 2);
    assert.equal(adapter.sessions[1].prompts[0].includes('compaction_failure'), true);
    assert.equal(taskService.listExecutions(fixtureData.task.task_id).filter((execution) => execution.state === 'RUNNING').length, 1);
    await runtime.stopExecution(taskService.listActiveExecutions()[0].execution_id);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    taskService.close();
  }
});

test('fresh-session recovery is bounded and fences the Execution after exhaustion', async () => {
  const fixtureData = await fixture();
  const { runtime, adapter, claimed, rootDir, taskService } = fixtureData;
  try {
    await runtime.startExecution(claimed.execution.execution_id);
    adapter.sessions[0].emit('rpc', { type: 'auto_retry_end', success: false, attempt: 15, finalError: 'provider unavailable' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    adapter.sessions[1].emit('rpc', { type: 'auto_retry_end', success: false, attempt: 15, finalError: 'provider unavailable' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(runtime.getActiveProcessCount(), 0);
    assert.equal(taskService.getExecution(claimed.execution.execution_id).state, 'FENCED');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    taskService.close();
  }
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
  const task = {
    task_id: 'task-path', root_id: 'task-path', task_type: 'proof', goal: 'path safety', expected_output: 'artifact',
    acceptance_conditions: {}, workspace: { problem_file: '../outside.lean', formal_source: 'blocked' },
  };
  await assert.rejects(
    () => manager.createWorkspace({ executionId: 'execution-path', fencingVersion: 1, task, workspaceManifest: {}, inputSnapshotManifest: {} }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.NOT_ALLOWED,
  );
  const outsideDir = await mkdtemp(join(tmpdir(), 'swarmenv-outside-'));
  const symlinkedWorkspace = join(rootDir, 'symlinked-workspace');
  await symlink(outsideDir, symlinkedWorkspace);
  await assert.rejects(
    () => manager.createWorkspace({
      executionId: 'execution-symlink', fencingVersion: 1, workspaceRef: symlinkedWorkspace,
      task: { ...task, workspace: { problem_file: 'problem.lean', formal_source: 'blocked' } }, workspaceManifest: {}, inputSnapshotManifest: {},
    }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.NOT_ALLOWED,
  );
  await rm(outsideDir, { recursive: true, force: true });
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
  await manager.saveWorkspaceRevision({
    workspaceRef: first.workspace_ref, executionId: 'execution-one', fencingVersion: 1,
    files: { 'progress.txt': 'revision three' },
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
  const resumedDiff = await manager.diff({
    workspaceRef: resumed.workspace_ref,
    executionId: resumed.execution_id,
    fencingVersion: resumed.fencing_version,
    fromRevision: 1,
    toRevision: resumed.workspace_revision,
  });
  assert.ok(resumedDiff.changed_files.some((file) => file.path === 'progress.txt' && file.status === 'added'));
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
