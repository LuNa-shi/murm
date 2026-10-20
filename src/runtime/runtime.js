import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { makeEnvelope } from '../protocol/envelope.js';

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${field} is required`);
  return value;
}

function operationId(prefix) {
  return `runtime:${prefix}:${randomUUID()}`;
}

function normalizeWaitFiles(files) {
  if (files === undefined || files === null) return {};
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'wait files must be a path-to-content object');
  }
  return Object.fromEntries(Object.entries(files).map(([path, content]) => {
    if (typeof content === 'string') return [path, content];
    if (content === undefined) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `wait file content must be text: ${path}`);
    return [path, JSON.stringify(content, null, 2)];
  }));
}

export class Runtime {
  constructor({ taskService, contextService, workspaceManager, agentAdapter, maxWorkers = 1, runtimeGeneration = 1, actorRef = 'runtime:local', logger = null, agentLogger = null }) {
    this.taskService = taskService;
    this.contextService = contextService;
    this.workspaceManager = workspaceManager;
    this.agentAdapter = agentAdapter;
    this.maxWorkers = maxWorkers;
    this.runtimeGeneration = runtimeGeneration;
    this.actorRef = actorRef;
    this.logger = logger;
    this.agentLogger = agentLogger;
    this.activeProcesses = new Map();
  }

  getActiveProcessCount() {
    return this.activeProcesses.size;
  }

  getSchedulerStatus({ rootId = null, taskId = null, executionId = null, limit = 100 } = {}) {
    const readyTasks = this.taskService.listTasks({ rootId, limit, availableOnly: true });
    const executions = this.taskService.listActiveExecutions();
    const waitingExecutions = executions.filter((execution) => execution.state === 'WAITING');
    return {
      core_count: this.maxWorkers,
      active_core_count: this.activeProcesses.size,
      idle_core_count: Math.max(0, this.maxWorkers - this.activeProcesses.size),
      waiting_execution_count: waitingExecutions.length,
      ready_task_count: readyTasks.length,
      ready_task_ids: readyTasks.map((task) => task.task_id),
      ready_tasks: readyTasks,
      current_task_id: taskId,
      current_execution_id: executionId,
      current_root_id: rootId ?? (taskId ? this.taskService.getTask(taskId)?.root_id ?? null : null),
    };
  }

  async getWorkspace(executionId) {
    const execution = this.#getExecution(executionId);
    if (!execution.workspace_ref) return { workspace: null, revisions: [] };
    const workspace = await this.workspaceManager.restoreWorkspace({
      workspaceRef: execution.workspace_ref,
      executionId,
      fencingVersion: execution.fencing_version,
    });
    const revisions = await this.workspaceManager.listRevisions({
      workspaceRef: execution.workspace_ref,
      executionId,
      fencingVersion: execution.fencing_version,
    });
    return { workspace, revisions };
  }

  async listWorkspaceFiles(executionId, { path = '' } = {}) {
    const execution = this.#getExecution(executionId);
    if (!execution.workspace_ref) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Execution has no materialized Workspace');
    return this.workspaceManager.listFiles({
      workspaceRef: execution.workspace_ref,
      executionId,
      fencingVersion: execution.fencing_version,
      path,
    });
  }

  async readWorkspaceFile(executionId, { path, maxBytes = 1_000_000 } = {}) {
    const execution = this.#getExecution(executionId);
    if (!execution.workspace_ref) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Execution has no materialized Workspace');
    return this.workspaceManager.readWorkspaceFile({
      workspaceRef: execution.workspace_ref,
      executionId,
      fencingVersion: execution.fencing_version,
      path,
      maxBytes,
    });
  }

  async writeWorkspaceFile(executionId, { path, content, expectedRevision = undefined, saveOperationId = null } = {}) {
    const execution = this.#getExecution(executionId);
    requireString(path, 'workspace file path');
    if (typeof content !== 'string') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'workspace file content must be a string');
    if (!['CREATED', 'RUNNING'].includes(execution.state)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `Workspace is not writable while Execution is ${execution.state}`);
    }
    if (!this.activeProcesses.has(executionId)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Workspace writes require an active Runtime Execution');
    }
    if (!execution.workspace_ref) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Execution has no materialized Workspace');
    const revision = expectedRevision ?? execution.workspace_revision;
    if (!Number.isInteger(revision) || revision < 1) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'expected_revision is required after Workspace materialization');
    const workspace = await this.workspaceManager.saveWorkspaceRevision({
      workspaceRef: execution.workspace_ref,
      executionId,
      fencingVersion: execution.fencing_version,
      expectedRevision: revision,
      files: { [path]: content },
    });
    const current = this.#saveWorkspaceReference(execution, workspace, saveOperationId ?? operationId('workspace-write'));
    const active = this.activeProcesses.get(executionId);
    if (active) {
      active.execution = current;
      active.workspace = workspace;
    }
    return {
      workspace,
      file: await this.readWorkspaceFile(executionId, { path }),
      diff: await this.workspaceDiff(executionId, { fromRevision: revision, toRevision: workspace.workspace_revision }),
      execution: current,
    };
  }

  async workspaceDiff(executionId, { fromRevision = null, toRevision = null } = {}) {
    const execution = this.#getExecution(executionId);
    if (!execution.workspace_ref) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Execution has no materialized Workspace');
    return this.workspaceManager.diff({
      workspaceRef: execution.workspace_ref,
      executionId,
      fencingVersion: execution.fencing_version,
      fromRevision,
      toRevision,
    });
  }

  async startExecution(executionId) {
    this.logger?.append({ event: 'runtime.start_execution', execution_id: executionId });
    const execution = this.#getExecution(executionId);
    if (execution.state !== 'CREATED') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `Runtime can only start CREATED executions, got ${execution.state}`);
    if (this.activeProcesses.size >= this.maxWorkers) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Runtime capacity is exhausted');
    const workspace = await this.#prepareWorkspace(execution);
    // A recovery start restores the already persisted revision. Rewriting that
    // same revision would violate the Workspace Manager's monotonic CAS rule.
    let current = execution.workspace_ref ? execution : this.#saveWorkspaceReference(execution, workspace);
    const started = this.taskService.dispatch('start_execution', {}, this.#executionEnvelope(current, operationId('start')));
    current = started.execution;
    try {
      return await this.#launch(current, workspace);
    } catch (error) {
      const active = this.activeProcesses.get(executionId);
      active?.session.stop?.();
      this.activeProcesses.delete(executionId);
      const failed = this.#getExecution(executionId);
      if (!['FAILED', 'CANCELLED', 'FENCED', 'SUPERSEDED'].includes(failed.state)) {
        this.taskService.dispatch('stop_execution', { terminal_state: 'FAILED' }, this.#executionEnvelope(failed, operationId('start-failed')));
      }
      throw error;
    }
  }

  async bindAgentExecution(executionId, session = null, { workspaceRef, startSession = null, agentPrompt = null } = {}) {
    this.logger?.append({ event: 'runtime.bind_execution', execution_id: executionId });
    if ((!session || typeof session.stop !== 'function') && typeof startSession !== 'function') {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Agent session or startSession is required');
    }
    const execution = this.#getExecution(executionId);
    if (execution.state !== 'CREATED') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `Runtime can only bind CREATED executions, got ${execution.state}`);
    if (this.activeProcesses.size >= this.maxWorkers) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Runtime capacity is exhausted');
    const workspace = await this.#prepareWorkspace(execution, workspaceRef);
    let current = execution.workspace_ref ? execution : this.#saveWorkspaceReference(execution, workspace);
    current = this.taskService.dispatch('start_execution', {}, this.#executionEnvelope(current, operationId('bind'))).execution;
    let boundSession = session;
    try {
      if (!boundSession) boundSession = await startSession({ execution: current, workspace });
      if (!boundSession || typeof boundSession.stop !== 'function') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'startSession must return an Agent session');
      this.#registerActiveProcess(current, workspace, boundSession);
      await this.#sendInitialPrompt(boundSession, agentPrompt);
      return { execution: current, workspace, session: boundSession };
    } catch (error) {
      boundSession?.stop?.();
      this.activeProcesses.delete(executionId);
      const failed = this.#getExecution(executionId);
      if (!['FAILED', 'CANCELLED', 'FENCED', 'SUPERSEDED'].includes(failed.state)) {
        this.taskService.dispatch('stop_execution', { terminal_state: 'FAILED' }, this.#executionEnvelope(failed, operationId('bind-failed')));
      }
      throw error;
    }
  }

  async wakeExecution(executionId, { wakeKey = null } = {}) {
    this.logger?.append({ event: 'runtime.wake_execution', execution_id: executionId, wake_key: wakeKey });
    const waiting = this.#getExecution(executionId);
    const key = wakeKey ?? waiting.resume_token ?? `wake:${executionId}`;
    if (waiting.state !== 'WAITING') {
      const active = this.activeProcesses.get(executionId);
      if (active) return { execution: active.execution, workspace: active.workspace, session: active.session };
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `Runtime can only wake WAITING executions, got ${waiting.state}`);
    }
    if (this.activeProcesses.size >= this.maxWorkers) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Runtime capacity is exhausted');
    const resumed = this.taskService.dispatch('wake_execution', { wake_key: key }, this.#executionEnvelope(waiting, operationId('wake'))).execution;
    const workspace = await this.workspaceManager.restoreWorkspace({ workspaceRef: requireString(resumed.workspace_ref, 'workspace_ref'), executionId, fencingVersion: resumed.fencing_version });
    return this.#launch(resumed, workspace);
  }

  async requestWait(executionId, { waitCondition, checkpoint = {}, files = {}, deadline = null }) {
    this.logger?.append({ event: 'runtime.request_wait', execution_id: executionId, wait_condition: waitCondition, deadline });
    const active = this.activeProcesses.get(executionId);
    const execution = this.#getExecution(executionId);
    if (!active || execution.state !== 'RUNNING') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'only a running Runtime process can request wait');
    const workspace = await this.workspaceManager.saveWorkspaceRevision({
      workspaceRef: requireString(execution.workspace_ref, 'workspace_ref'), executionId, fencingVersion: execution.fencing_version, files: normalizeWaitFiles(files),
    });
    let current = this.#saveWorkspaceReference(execution, workspace);
    const savedCheckpoint = await this.workspaceManager.saveCheckpoint({
      workspaceRef: workspace.workspace_ref, executionId, fencingVersion: execution.fencing_version, checkpoint,
    });
    const checkpointResult = this.taskService.dispatch('save_checkpoint', savedCheckpoint, this.#executionEnvelope(current, operationId('checkpoint')));
    current = checkpointResult.execution;
    const waited = this.taskService.dispatch('request_wait', {
      checkpoint_ref: savedCheckpoint.checkpoint_ref,
      checkpoint_hash: savedCheckpoint.checkpoint_hash,
      workspace_ref: workspace.workspace_ref,
      workspace_revision: workspace.workspace_revision,
      workspace_content_hash: workspace.content_hash,
      wait_condition: waitCondition,
      wait_deadline: deadline ?? waitCondition?.deadline ?? null,
    }, this.#executionEnvelope(current, operationId('wait')));
    active.session.stop();
    this.activeProcesses.delete(executionId);
    await this.workspaceManager.releaseWorkspace({ workspaceRef: workspace.workspace_ref, executionId, fencingVersion: execution.fencing_version });
    return waited;
  }

  heartbeat(executionId, payload = {}) {
    this.logger?.append({ event: 'runtime.heartbeat', execution_id: executionId });
    const execution = this.#getExecution(executionId);
    const result = this.taskService.dispatch('heartbeat', payload, this.#executionEnvelope(execution, operationId('heartbeat')));
    const active = this.activeProcesses.get(executionId);
    if (active) active.execution = result.execution;
    return result;
  }

  async stopExecution(executionId, terminalState = 'CANCELLED') {
    this.logger?.append({ event: 'runtime.stop_execution', execution_id: executionId, terminal_state: terminalState });
    const execution = this.#getExecution(executionId);
    const active = this.activeProcesses.get(executionId);
    if (active) {
      active.session.stop();
      this.activeProcesses.delete(executionId);
    }
    const result = this.taskService.dispatch('stop_execution', { terminal_state: terminalState }, this.#executionEnvelope(execution, operationId('stop')));
    if (execution.workspace_ref) {
      await this.workspaceManager.releaseWorkspace({ workspaceRef: execution.workspace_ref, executionId, fencingVersion: execution.fencing_version });
    }
    return result;
  }

  async fenceExecution(executionId) {
    this.logger?.append({ event: 'runtime.fence_execution', execution_id: executionId });
    const execution = this.#getExecution(executionId);
    const newFencingVersion = execution.fencing_version + 1;
    if (execution.workspace_ref) {
      await this.workspaceManager.fenceWorkspace({ workspaceRef: execution.workspace_ref, executionId, fencingVersion: execution.fencing_version, newFencingVersion });
    }
    const result = this.taskService.dispatch('fence_execution', { runtime_generation: this.runtimeGeneration }, this.#executionEnvelope(execution, operationId('fence')));
    const active = this.activeProcesses.get(executionId);
    if (active) {
      active.session.stop();
      this.activeProcesses.delete(executionId);
    }
    return result;
  }

  async sweepExpired(at = new Date()) {
    this.logger?.append({ event: 'runtime.sweep_expired', at: at.toISOString() });
    const expired = [];
    for (const execution of this.taskService.listActiveExecutions()) {
      if (!['CREATED', 'RUNNING'].includes(execution.state) || Date.parse(execution.lease_expires_at) > at.getTime()) continue;
      if (execution.workspace_ref) {
        await this.workspaceManager.fenceWorkspace({ workspaceRef: execution.workspace_ref, executionId: execution.execution_id, fencingVersion: execution.fencing_version, newFencingVersion: execution.fencing_version + 1 });
      }
      const result = this.taskService.dispatch('expire_execution', { runtime_generation: this.runtimeGeneration }, this.#executionEnvelope(execution, operationId('expire')));
      const active = this.activeProcesses.get(execution.execution_id);
      if (active) {
        active.session.stop();
        this.activeProcesses.delete(execution.execution_id);
      }
      expired.push(result);
    }
    return expired;
  }

  async restart() {
    this.runtimeGeneration += 1;
    for (const execution of this.taskService.listActiveExecutions()) {
      if (execution.state === 'RUNNING' || execution.state === 'CREATED') {
        await this.fenceExecution(execution.execution_id);
      }
    }
    for (const active of this.activeProcesses.values()) active.session.stop();
    this.activeProcesses.clear();
    return { runtime_generation: this.runtimeGeneration, active_executions: this.taskService.listActiveExecutions() };
  }

  #getExecution(executionId) {
    const execution = this.taskService.getExecution(requireString(executionId, 'execution_id'));
    if (!execution) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown execution: ${executionId}`);
    return execution;
  }

  async #prepareWorkspace(execution, workspaceRef = null) {
    const task = this.taskService.getTask(execution.task_id);
    if (!task) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `Task is missing for execution: ${execution.execution_id}`);
    if (execution.workspace_ref) {
      return this.workspaceManager.restoreWorkspace({
        workspaceRef: execution.workspace_ref,
        executionId: execution.execution_id,
        fencingVersion: execution.fencing_version,
      });
    }
    const workspaceManifest = {
      task_id: task.task_id,
      spec_version: execution.spec_version,
      spec_hash: execution.spec_hash,
      workspace_snapshot_hash: execution.input_snapshot_hash,
      material_refs: execution.input_material_refs,
      selection: execution.workspace_selection ?? { mode: 'clean', revision: null },
    };
    const inputSnapshotManifest = {
      workspace_snapshot_hash: execution.input_snapshot_hash,
      material_refs: execution.input_material_refs,
    };
    const selection = execution.workspace_selection ?? {};
    if (selection.mode === 'resume' && selection.source_workspace_ref) {
      return this.workspaceManager.cloneWorkspace({
        sourceWorkspaceRef: selection.source_workspace_ref,
        targetWorkspaceRef: workspaceRef ?? this.workspaceManager.workspacePath(execution.execution_id),
        executionId: execution.execution_id,
        fencingVersion: execution.fencing_version,
        revision: selection.revision,
        task,
        workspaceManifest,
        inputSnapshotManifest,
        runtimeManifest: { runtime_generation: this.runtimeGeneration, actor_ref: this.actorRef },
      });
    }
    return this.workspaceManager.createWorkspace({
      executionId: execution.execution_id,
      fencingVersion: execution.fencing_version,
      task,
      ...(workspaceRef ? { workspaceRef } : {}),
      workspaceManifest,
      inputSnapshotManifest,
      runtimeManifest: { runtime_generation: this.runtimeGeneration, actor_ref: this.actorRef },
    });
  }

  #saveWorkspaceReference(execution, workspace, saveOperationId = operationId('workspace')) {
    return this.taskService.dispatch('save_workspace_revision', {
      workspace_ref: workspace.workspace_ref,
      workspace_revision: workspace.workspace_revision,
      workspace_content_hash: workspace.content_hash,
    }, this.#executionEnvelope(execution, saveOperationId)).execution;
  }

  async #launch(execution, workspace) {
    const session = await this.agentAdapter.start({
      executionId: execution.execution_id,
      sessionDir: join(workspace.workspace_ref, '.swarm', 'pi-session'),
      cwd: workspace.workspace_ref,
      logger: this.agentLogger,
    });
    const manifestContent = JSON.stringify(session.manifest ?? {}, null, 2);
    const nextWorkspace = await this.workspaceManager.saveWorkspaceRevision({
      workspaceRef: workspace.workspace_ref,
      executionId: execution.execution_id,
      fencingVersion: execution.fencing_version,
      files: { 'runtime-manifest.json': manifestContent },
    });
    const current = this.#saveWorkspaceReference(execution, nextWorkspace);
    this.#registerActiveProcess(current, nextWorkspace, session);
    await this.#sendInitialPrompt(session, execution.agent_prompt);
    const active = this.activeProcesses.get(execution.execution_id);
    return { execution: current, workspace: nextWorkspace, session };
  }

  async #sendInitialPrompt(session, prompt) {
    if (!prompt || typeof session.prompt !== 'function') return;
    await session.waitForReady?.({ timeoutMs: 30_000 });
    await session.prompt(prompt, { timeoutMs: 30_000 });
  }

  #registerActiveProcess(execution, workspace, session) {
    const active = { session, execution, workspace };
    this.activeProcesses.set(execution.execution_id, active);
    session.on('close', () => {
      void this.#processExit(execution.execution_id);
    });
  }

  async #processExit(executionId) {
    const active = this.activeProcesses.get(executionId);
    if (!active) return;
    this.activeProcesses.delete(executionId);
    const execution = this.#getExecution(executionId);
    if (execution.state === 'RUNNING') {
      this.taskService.dispatch('stop_execution', { terminal_state: 'FAILED' }, this.#executionEnvelope(execution, operationId('process-exit')));
    }
  }

  #executionEnvelope(execution, id) {
    return makeEnvelope({
      operationId: id,
      actorRef: this.actorRef,
      taskId: execution.task_id,
      executionId: execution.execution_id,
      specVersion: execution.spec_version,
      stateVersion: execution.state_version,
      fencingVersion: execution.fencing_version,
    });
  }
}
