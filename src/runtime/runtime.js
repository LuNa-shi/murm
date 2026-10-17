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

export class Runtime {
  constructor({ taskService, contextService, workspaceManager, agentAdapter, maxWorkers = 1, runtimeGeneration = 1, actorRef = 'runtime:local' }) {
    this.taskService = taskService;
    this.contextService = contextService;
    this.workspaceManager = workspaceManager;
    this.agentAdapter = agentAdapter;
    this.maxWorkers = maxWorkers;
    this.runtimeGeneration = runtimeGeneration;
    this.actorRef = actorRef;
    this.activeProcesses = new Map();
  }

  getActiveProcessCount() {
    return this.activeProcesses.size;
  }

  async startExecution(executionId) {
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
      const failed = this.#getExecution(executionId);
      if (!['FAILED', 'CANCELLED', 'FENCED', 'SUPERSEDED'].includes(failed.state)) {
        this.taskService.dispatch('stop_execution', { terminal_state: 'FAILED' }, this.#executionEnvelope(failed, operationId('start-failed')));
      }
      throw error;
    }
  }

  async wakeExecution(executionId, { wakeKey = null } = {}) {
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
    const active = this.activeProcesses.get(executionId);
    const execution = this.#getExecution(executionId);
    if (!active || execution.state !== 'RUNNING') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'only a running Runtime process can request wait');
    const workspace = await this.workspaceManager.saveWorkspaceRevision({
      workspaceRef: requireString(execution.workspace_ref, 'workspace_ref'), executionId, fencingVersion: execution.fencing_version, files,
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
    const execution = this.#getExecution(executionId);
    const result = this.taskService.dispatch('heartbeat', payload, this.#executionEnvelope(execution, operationId('heartbeat')));
    const active = this.activeProcesses.get(executionId);
    if (active) active.execution = result.execution;
    return result;
  }

  async stopExecution(executionId, terminalState = 'CANCELLED') {
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

  async #prepareWorkspace(execution) {
    const context = this.contextService.getInitialContext(execution.execution_id);
    if (!context || execution.initial_context_ref !== `sqlite://initial-context/${execution.execution_id}`) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Execution Initial Context is missing or does not match its reference');
    }
    if (execution.workspace_ref) {
      return this.workspaceManager.restoreWorkspace({
        workspaceRef: execution.workspace_ref,
        executionId: execution.execution_id,
        fencingVersion: execution.fencing_version,
      });
    }
    return this.workspaceManager.createWorkspace({
      executionId: execution.execution_id,
      fencingVersion: execution.fencing_version,
      initialContext: context.manifest,
      initialPrompt: execution.initial_prompt,
      inputSnapshotManifest: {
        input_snapshot_hash: execution.input_snapshot_hash,
        material_refs: execution.input_material_refs,
      },
      runtimeManifest: { runtime_generation: this.runtimeGeneration, actor_ref: this.actorRef },
    });
  }

  #saveWorkspaceReference(execution, workspace) {
    return this.taskService.dispatch('save_workspace_revision', {
      workspace_ref: workspace.workspace_ref,
      workspace_revision: workspace.workspace_revision,
      workspace_content_hash: workspace.content_hash,
    }, this.#executionEnvelope(execution, operationId('workspace'))).execution;
  }

  async #launch(execution, workspace) {
    const session = await this.agentAdapter.start({ executionId: execution.execution_id, sessionDir: join(workspace.workspace_ref, '.swarm', 'pi-session') });
    const manifestContent = JSON.stringify(session.manifest ?? {}, null, 2);
    const nextWorkspace = await this.workspaceManager.saveWorkspaceRevision({
      workspaceRef: workspace.workspace_ref,
      executionId: execution.execution_id,
      fencingVersion: execution.fencing_version,
      files: { 'runtime-manifest.json': manifestContent },
    });
    const current = this.#saveWorkspaceReference(execution, nextWorkspace);
    const active = { session, execution: current, workspace: nextWorkspace };
    this.activeProcesses.set(execution.execution_id, active);
    session.on('close', () => {
      void this.#processExit(execution.execution_id);
    });
    return { execution: current, workspace: nextWorkspace, session };
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
