import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { ServicesSDK } from '../sdk/services-sdk.js';
import { makeEnvelope } from '../protocol/envelope.js';
import { GENERIC_AGENT_PROMPT } from './agent-prompt.js';
import { AGENT_ROLES, buildCapabilityProfile } from './capability-profile.js';
import { runtimeCapabilityList } from '../runtime/runtime-capabilities.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
// The compatibility transport remains available to legacy fixtures and
// internal adapters, but a Mission-scoped Task must use the semantic API.
// Keeping this gate at the bridge (rather than only hiding catalog entries)
// prevents an Agent from bypassing the reduced Task-oriented surface by
// sending a raw swarmenv_call operation.
const MODERN_RETIRED_OPERATIONS = new Set([
  'heartbeat', 'request_wait', 'block_execution',
  'create_child_task', 'create_branch_group', 'add_required_subtask',
  'get_task_structure', 'propose_structure_change', 'explain_task_readiness',
  'create_rework_task', 'accept_task', 'request_rework',
]);

const WORKSPACE_OPERATIONS = new Set([
  'get_workspace', 'list_workspace_revisions', 'list_workspace_files',
  'read_workspace_file', 'write_workspace_file', 'workspace_diff',
]);

function usesWorkspace(task) {
  const workspace = task?.workspace;
  const contract = task?.completion_contract ?? {};
  return Boolean((workspace && typeof workspace === 'object' && Object.keys(workspace).length > 0) ||
    contract.requires_workspace === true || contract.required_candidate?.workspace === true);
}
function json(value) {
  return JSON.stringify(value ?? null);
}

function selectionCandidate(candidate) {
  return {
    task_id: candidate?.task_id ?? null,
    task_type: candidate?.task_type ?? null,
    parent_id: candidate?.parent_id ?? null,
    goal: candidate?.goal ?? null,
    expected_output: candidate?.expected_output ?? null,
    task_instructions: candidate?.task_instructions ?? null,
    acceptance_conditions: candidate?.acceptance_conditions ?? null,
    completion_contract: candidate?.completion_contract ?? null,
    priority: candidate?.priority ?? 0,
    state: candidate?.state ?? null,
    age_ms: candidate?.age_ms ?? null,
    fairness_protected: candidate?.fairness_protected ?? false,
    selection_rank: candidate?.selection_rank ?? null,
  };
}

function errorBody(error) {
  return {
    name: error?.name ?? 'Error',
    code: error?.code ?? 'BRIDGE_ERROR',
    message: error?.message ?? String(error),
    details: error?.details,
  };
}

function send(response, status, body) {
  const content = json(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(content) });
  response.end(content);
}

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('bridge request body is too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export class ServicesBridge {
  constructor({ taskService, contextService, runtime, router, actorRef = 'agent:real', coreId = null, taskId = null, executionId = null, role = null, capabilityProfile = null, registry = null, runtimeCapabilities = null, taskCreateMutex = null, onClaim = null, onClaimAccepted = null, onRelease = null, onWorkspaceWrite = null, onWorkUnit = null, onTaskCreate = null, onBeforeSubmitCandidate = null, onSubmitCandidate = null, onSchedulerStatus = null, onError = null, host = '127.0.0.1', logger = null, agentPrompt = GENERIC_AGENT_PROMPT } = {}) {
    if (!taskService || !contextService || !runtime) throw new TypeError('ServicesBridge requires Task Service, Context Service, and Runtime');
    this.taskService = taskService;
    this.contextService = contextService;
    this.runtime = runtime;
    this.router = router;
    this.actorRef = actorRef;
    this.coreId = coreId;
    this.taskId = taskId;
    this.executionId = executionId;
    this.role = role ?? (taskId || executionId ? AGENT_ROLES.BOUND : AGENT_ROLES.SELECTION);
    this.capabilityProfile = capabilityProfile;
    this.capabilityProfileRegistryRevision = null;
    this.registry = registry ?? router?.registry ?? null;
    this.runtimeCapabilities = runtimeCapabilities ?? runtimeCapabilityList();
    this.taskCreateMutex = taskCreateMutex;
    this.onClaim = onClaim;
    this.onClaimAccepted = onClaimAccepted;
    this.onRelease = onRelease;
    this.onWorkspaceWrite = onWorkspaceWrite;
    this.onWorkUnit = onWorkUnit;
    this.onTaskCreate = onTaskCreate;
    this.onBeforeSubmitCandidate = onBeforeSubmitCandidate;
    this.onSubmitCandidate = onSubmitCandidate;
    this.onSchedulerStatus = onSchedulerStatus;
    this.onError = onError;
    this.agentPrompt = agentPrompt;
    this.host = host;
    this.logger = logger;
    this.token = randomUUID();
    this.server = null;
    this.address = null;
    // Candidate feedback is returned synchronously. A normal-flow checker
    // failure may then stage a typed Task block, which is applied only after
    // the HTTP response has been handed to the Agent.
    this.deferredLifecycle = null;
    this.selectionCandidates = null;
    this.selectionClaimAttempted = false;
  }

  /** Set the complete bounded view visible to the next stateless selection turn. */
  setSelectionCandidates(candidates = null) {
    this.selectionCandidates = Array.isArray(candidates) ? candidates.map(selectionCandidate) : null;
    this.selectionClaimAttempted = false;
    return this.selectionCandidates ? this.selectionCandidates.map((candidate) => ({ ...candidate })) : null;
  }

  /** Bind a durable Daemon claim before Runtime starts the fresh Task Session. */
  async bindClaim(result) {
    if (!result?.task?.task_id || !result?.execution?.execution_id) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'bindClaim requires a Task and Execution result');
    }
    if (this.taskId || this.executionId) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'bridge already has a claimed binding');
    this.taskId = result.task.task_id;
    this.executionId = result.execution.execution_id;
    this.coreId = this.coreId ?? result.execution.core_id ?? null;
    this.role = AGENT_ROLES.BOUND;
    this.capabilityProfile = null;
    this.capabilityProfileRegistryRevision = null;
    this.selectionCandidates = null;
    try {
      await this.onClaimAccepted?.(result);
      await this.onClaim?.(result);
    } catch (error) {
      const released = { taskId: this.taskId, executionId: this.executionId, result: null };
      this.taskId = null;
      this.executionId = null;
      this.role = AGENT_ROLES.SELECTION;
      this.capabilityProfile = null;
      this.capabilityProfileRegistryRevision = null;
      // A failed handoff still owns a durable claim until the caller fences it.
      // Deliver the original binding to the release hook before surfacing the
      // handoff error, so a Core cannot retain a stale Execution identity.
      try { await this.onRelease?.(released); } catch { /* preserve handoff failure */ }
      throw error;
    }
    return result;
  }

  async start({ port = 0 } = {}) {
    if (this.server) return this.environment();
    this.server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    this.server.listen(port, this.host);
    await once(this.server, 'listening');
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('bridge did not receive a loopback address');
    this.address = address;
    return this.environment();
  }

  environment() {
    if (!this.address) throw new Error('ServicesBridge has not started');
    return {
      SWARMENV_BRIDGE_URL: `http://${this.host}:${this.address.port}`,
      SWARMENV_BRIDGE_TOKEN: this.token,
    };
  }

  getCapabilityProfile() {
    const registryRevision = typeof this.registry?.getRevision === 'function' ? this.registry.getRevision() : null;
    if (this.capabilityProfile?.role !== this.role || this.capabilityProfileRegistryRevision !== registryRevision) {
      this.capabilityProfile = null;
    }
    if (!this.capabilityProfile) {
      this.capabilityProfile = buildCapabilityProfile({
        role: this.role,
        registry: this.registry,
        runtimeCapabilities: this.runtimeCapabilities,
        context: { task_id: this.taskId, execution_id: this.executionId, core_id: this.coreId },
      });
      this.capabilityProfileRegistryRevision = registryRevision;
    }
    return structuredClone(this.capabilityProfile);
  }

  #profileCapability(profile, operation, { serviceId = null, capabilityId = null } = {}) {
    const matches = profile.capabilities.filter((candidate) => {
      if (capabilityId && (candidate.id ?? candidate.capability_id) !== capabilityId) return false;
      if (serviceId && candidate.service_id !== serviceId) return false;
      return candidate.operation === operation || candidate.name === operation || (capabilityId && (candidate.id ?? candidate.capability_id) === capabilityId);
    });
    // Keep the old bridge operation available while the Agent-facing Registry
    // advertises the semantic Task name.  The transport alias is resolved to
    // the registered task_view capability, so the implementation still goes
    // through the current Services boundary and does not reintroduce a
    // generic service call surface.
    if (matches.length === 0 && operation === 'get_task') {
      matches.push(...profile.capabilities.filter((candidate) => {
        if (capabilityId && (candidate.id ?? candidate.capability_id) !== capabilityId) return false;
        if (serviceId && candidate.service_id !== serviceId) return false;
        return candidate.operation === 'task_view' || candidate.name === 'task_view';
      }));
    }
    if (matches.length > 1 && operation === 'task_block') {
      // The legacy Runtime typed block and the modern Task Service semantic
      // block intentionally share the Agent operation. Resolve the boundary
      // from the bound Task contract: Mission Tasks use the Service contract
      // (which carries Handoff Material), while legacy records retain the
      // Runtime checkpoint/block contract.
      const boundTask = this.taskId ? this.taskService?.getTask?.(this.taskId) : null;
      const preferred = boundTask?.mission_id
        ? matches.find((candidate) => candidate.service_id === 'task')
        : matches.find((candidate) => candidate.runtime_owned === true || candidate.service_id === 'runtime');
      if (preferred) return preferred;
    }
    if (matches.length > 1) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `ambiguous Agent capability: ${operation}`, {
        operation,
        capability_id: capabilityId,
        service_id: serviceId,
        matches: matches.map((candidate) => candidate.id ?? `${candidate.service_id}.${candidate.name}`),
      });
    }
    return matches[0] ?? null;
  }

  async #invokeRegistered(capability, payload, operationId, context = {}) {
    if (!this.registry?.invoke) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, `registered Service is unavailable: ${capability.service_id}`);
    const taskId = context.taskId ?? this.taskId;
    const executionId = context.executionId ?? this.executionId;
    const currentExecution = executionId && typeof this.taskService?.getExecution === 'function'
      ? this.taskService.getExecution(executionId)
      : null;
    const currentTask = taskId && typeof this.taskService?.getTask === 'function'
      ? this.taskService.getTask(taskId)
      : null;
    return this.registry.invoke({
      serviceId: capability.service_id,
      capability: capability.name,
      capability_id: capability.id ?? `${capability.service_id}.${capability.name}`,
      input: payload,
      envelope: makeEnvelope({
        operationId,
        actorRef: this.actorRef,
        taskId,
        executionId,
        specVersion: context.specVersion ?? currentExecution?.spec_version ?? currentTask?.spec_version ?? null,
        stateVersion: context.stateVersion ?? currentExecution?.state_version ?? currentTask?.state_version ?? null,
        fencingVersion: currentExecution?.fencing_version ?? null,
      }),
      role: this.role,
    });
  }

  async releaseClaim({ result = null } = {}) {
    const released = { taskId: this.taskId, executionId: this.executionId, result };
    this.taskId = null;
    this.executionId = null;
    this.role = AGENT_ROLES.SELECTION;
    this.capabilityProfile = null;
    this.capabilityProfileRegistryRevision = null;
    if (this.onRelease) await this.onRelease(released);
  }

  /** Apply a staged typed block after the Agent has received its result. */
  async flushDeferredLifecycle() {
    const deferred = this.deferredLifecycle;
    if (!deferred) return null;
    this.deferredLifecycle = null;
    const settled = await this.runtime.blockExecution(deferred.executionId, deferred.block);
    if (this.taskId === deferred.taskId && this.executionId === deferred.executionId) {
      await this.releaseClaim({
        result: {
          ...deferred.result,
          applied: {
            ...(deferred.result?.applied ?? {}),
            execution: settled?.execution ?? deferred.result?.applied?.execution,
            task: settled?.task ?? deferred.result?.applied?.task,
          },
        },
      });
    }
    return settled;
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.address = null;
    server.close();
    await once(server, 'close').catch(() => undefined);
  }

  async #handle(request, response) {
    if (request.method === 'GET' && request.url === '/health') {
      send(response, 200, { ok: true, service: 'swarmenv-agent-bridge' });
      return;
    }
    if (request.method === 'GET' && request.url === '/profile') {
      if (request.headers.authorization !== `Bearer ${this.token}`) {
        send(response, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'invalid bridge token' } });
        return;
      }
      send(response, 200, { ok: true, profile: this.getCapabilityProfile() });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/call') {
      send(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'unknown bridge route' } });
      return;
    }
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      send(response, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'invalid bridge token' } });
      return;
    }
    try {
      const input = await readBody(request);
      const result = await this.call(input);
      send(response, 200, { ok: true, result });
      this.logger?.append({ event: 'bridge.response_sent', operation: input.operation });
      if (this.deferredLifecycle) {
        setImmediate(() => {
          void this.flushDeferredLifecycle().catch((error) => {
            this.logger?.append({ event: 'bridge.lifecycle_error', operation: 'deferred_block', ok: false, error: { name: error.name, code: error.code, message: error.message } });
          });
        });
      }
    } catch (error) {
      if (!response.writableEnded) send(response, 400, { ok: false, error: errorBody(error) });
      else this.logger?.append({ event: 'bridge.error_after_response', operation: input?.operation ?? null, ok: false, error: { name: error.name, code: error.code, message: error.message } });
    }
  }

  async call({ operation, payload = {}, operation_id: operationId = null, service_id: serviceId = null, capability_id: capabilityId = null } = {}) {
    this.logger?.append({ event: 'bridge.start', operation, operation_id: operationId, task_id: this.taskId, execution_id: this.executionId, payload });
    try {
      const profile = this.getCapabilityProfile();
      const capability = this.#profileCapability(profile, operation, { serviceId, capabilityId });
      if (!capability) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `Agent capability is not available for this Session: ${operation}`, { operation, role: this.role, profile_hash: profile.profile_hash });
      if (this.role === AGENT_ROLES.SELECTION && capability.side_effect !== false && capability.side_effect !== 'read' && !(capability.service_id === 'task' && operation === 'claim')) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Selection role may only invoke read-only capabilities and task.claim', { operation, service_id: capability.service_id });
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'bridge payload must be an object');
      const boundTask = this.taskId ? this.taskService.getTask(this.taskId) : null;
      const modernBoundTask = boundTask?.mission_id ? boundTask : null;
      if (modernBoundTask && MODERN_RETIRED_OPERATIONS.has(operation)) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `${operation} is retired from the modern Mission Task Agent surface`, { operation, task_id: modernBoundTask.task_id });
      }
      if (modernBoundTask && WORKSPACE_OPERATIONS.has(operation) && !usesWorkspace(modernBoundTask)) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Workspace capability is not enabled by the current Task contract', { operation, task_id: modernBoundTask.task_id });
      }
      const service = this.router ?? { dispatch: (name, body, envelope) => {
        if (['get_task', 'get_execution', 'list_tasks', 'list_claimable_tasks', 'list_executions', 'task_status', 'task_register', 'task_take'].includes(name)) return this.taskService.dispatch(name, body, envelope);
        return this.contextService.dispatch(name, body, envelope);
      } };
      const bridgeOperationId = operationId ?? `bridge:${operation}:${randomUUID()}`;
      if (operation === 'select_task') {
        if (this.taskId || this.executionId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'select_task is only available to an unbound selection Session');
        if (!Array.isArray(this.selectionCandidates)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'select_task is only available during a Core Daemon selection turn');
        const selectedTaskId = payload.task_id;
        if (typeof selectedTaskId !== 'string' || selectedTaskId.length === 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'select_task requires payload.task_id');
        const selected = this.selectionCandidates.find((candidate) => String(candidate.task_id ?? candidate.taskId ?? candidate.id) === selectedTaskId);
        if (!selected) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'select_task must choose a task_id from the bounded shortlist', { task_id: selectedTaskId });
        await this.onSelectTask?.({ task_id: selectedTaskId, task: { ...selected } });
        const result = { selected_task_id: selectedTaskId };
        this.logger?.append({ event: 'bridge.complete', operation, ok: true, result });
        return result;
      }
      const isCatalogDiscovery = capability.service_id === 'catalog' && ['list_services', 'get_service_metadata', 'list_tools'].includes(operation);
      const isTaskDiscovery = capability.service_id === 'task' && [
        'list_tasks', 'list_claimable_tasks', 'get_task', 'list_executions',
        'get_task_structure', 'explain_task_readiness', 'task_list', 'task_view', 'task_status',
      ].includes(operation);
      if (isCatalogDiscovery || isTaskDiscovery || (capability.service_id === 'task' && operation === 'scheduler_status')) {
        const shortlistRequired = isTaskDiscovery && operation !== 'task_status';
        if (this.role === AGENT_ROLES.SELECTION && shortlistRequired && !Array.isArray(this.selectionCandidates)) {
          throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Selection task discovery requires a bounded shortlist', {
            operation,
            role: this.role,
          });
        }
        if (operation === 'list_claimable_tasks' && this.taskId !== null) {
          throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'claimable discovery is only available to an unbound selection Session');
        }
        if (capability.service_id === 'task' && operation === 'scheduler_status') {
          const result = await (this.onSchedulerStatus
            ? this.onSchedulerStatus({ ...payload, task_id: payload.task_id ?? this.taskId, execution_id: payload.execution_id ?? this.executionId })
            : this.runtime.getSchedulerStatus({ ...payload, task_id: payload.task_id ?? this.taskId, execution_id: payload.execution_id ?? this.executionId }));
          this.logger?.append({ event: 'bridge.complete', operation, ok: true, result });
          return result;
        }
        const discoveryPayload = operation === 'task_status' && payload.mission_id === undefined && modernBoundTask?.mission_id
          ? { ...payload, mission_id: modernBoundTask.mission_id }
          : (operation === 'list_tasks' || operation === 'list_claimable_tasks' || operation === 'task_list') && this.taskId === null && payload.available_only !== false
          ? { ...payload, states: ['OPEN', 'RUNNING', 'WAITING'] }
          : ((operation === 'get_task' || operation === 'task_view' || ['get_task_structure', 'explain_task_readiness'].includes(operation)) && payload.task_id === undefined && this.taskId
            ? { ...payload, task_id: this.taskId }
            : payload);
        const shortlistScopedOperations = ['get_task', 'task_view', 'list_executions', 'get_task_structure', 'explain_task_readiness'];
        if (this.role === AGENT_ROLES.SELECTION && Array.isArray(this.selectionCandidates) && shortlistScopedOperations.includes(operation)) {
          const taskId = discoveryPayload.task_id;
          if (typeof taskId !== 'string' || taskId.length === 0) {
            throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${operation} requires payload.task_id`);
          }
          const candidate = this.selectionCandidates.find((entry) => String(entry.task_id) === taskId);
          if (!candidate) {
            throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${operation} must target a task_id from the bounded shortlist`, { task_id: taskId });
          }
          if (operation === 'get_task' || operation === 'task_view') {
            const result = selectionCandidate(candidate);
            this.logger?.append({ event: 'bridge.complete', operation, ok: true, result });
            return result;
          }
        }
        if (isTaskDiscovery && ['list_tasks', 'list_claimable_tasks', 'task_list'].includes(operation) && Array.isArray(this.selectionCandidates)) {
          const result = this.selectionCandidates.map(selectionCandidate);
          this.logger?.append({ event: 'bridge.complete', operation, ok: true, result });
          return result;
        }
        // Legacy Task records predate Mission metadata and therefore cannot
        // be read through the semantic task_view projection. Keep the
        // compatibility read on the local Task Service boundary; modern
        // task_view calls continue through the Registry above.
        const result = operation === 'get_task' && typeof this.taskService?.dispatch === 'function'
          ? this.taskService.dispatch('get_task', discoveryPayload, makeEnvelope({
            operationId: bridgeOperationId,
            actorRef: this.actorRef,
            taskId: discoveryPayload.task_id ?? this.taskId ?? null,
            executionId: this.executionId,
          }))
          : this.registry?.invoke
            ? await this.#invokeRegistered(capability, discoveryPayload, bridgeOperationId)
            : service.dispatch(operation, discoveryPayload, makeEnvelope({
            operationId: bridgeOperationId,
            actorRef: this.actorRef,
          }));
        this.logger?.append({ event: 'bridge.complete', operation, ok: true, result });
        return result;
      }
      if (capability.service_id === 'task' && operation === 'claim') {
        if (this.role !== AGENT_ROLES.SELECTION || this.taskId || this.executionId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'claim is only available to a Selection Session', { role: this.role, task_id: this.taskId, execution_id: this.executionId });
        const taskId = payload.task_id;
        if (typeof taskId !== 'string' || taskId.length === 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'claim requires payload.task_id');
        if (!Array.isArray(this.selectionCandidates)) {
          throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'claim requires a bounded shortlist');
        }
        if (!this.selectionCandidates.some((candidate) => String(candidate.task_id ?? candidate.taskId ?? candidate.id) === taskId)) {
          throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'claim must target a task_id from the bounded shortlist', { task_id: taskId });
        }
        if (this.selectionClaimAttempted) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'a Selection Session may claim exactly one Task');
        this.selectionClaimAttempted = true;
        let task = typeof this.taskService?.getTask === 'function' ? this.taskService.getTask(taskId) : null;
        if (!task && this.registry?.invoke) {
          const taskCapability = profile.capabilities.find((candidate) => candidate.service_id === 'task' && (
            candidate.operation === 'get_task' || candidate.operation === 'task_view' ||
            candidate.name === 'get_task' || candidate.name === 'task_get' || candidate.name === 'task_view'
          ));
          if (taskCapability) {
            const remoteTask = await this.#invokeRegistered(taskCapability, { task_id: taskId }, `${bridgeOperationId}:view`, { taskId });
            task = remoteTask?.task ?? remoteTask;
          }
        }
        if (!task) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown task: ${taskId}`, { task_id: taskId });
        // The bridge is the Agent identity boundary. A model may choose the
        // Task and Workspace lineage, but it cannot claim on behalf of a
        // different owner or replace the reusable startup prompt with
        // task-specific transport data.
        const claimPayload = { ...payload, owner_ref: this.actorRef, agent_prompt: this.agentPrompt };
        const result = this.registry?.invoke
          ? await this.#invokeRegistered(capability, claimPayload, bridgeOperationId, {
            taskId: task.task_id,
            specVersion: task.spec_version,
            stateVersion: task.state_version,
          })
          : service.dispatch('claim', claimPayload, makeEnvelope({
            operationId: bridgeOperationId,
            actorRef: this.actorRef,
            taskId: task.task_id,
            specVersion: task.spec_version,
            stateVersion: task.state_version,
          }));
        this.taskId = result.task.task_id;
        this.executionId = result.execution.execution_id;
        this.role = AGENT_ROLES.BOUND;
        this.capabilityProfile = null;
        this.capabilityProfileRegistryRevision = null;
        // End the bounded selection view before the bound prompt.
        this.selectionCandidates = null;
        let handoffRequired = false;
        try {
          await this.onClaimAccepted?.(result);
          if (this.onClaim) {
            await this.onClaim(result);
            handoffRequired = true;
          }
        } catch (error) {
          const claimedExecution = this.taskService.getExecution(result.execution.execution_id);
          if (claimedExecution && ['CREATED', 'RUNNING'].includes(claimedExecution.state)) {
            try {
              service.dispatch('stop_execution', { terminal_state: 'FAILED' }, makeEnvelope({
                operationId: `bridge:claim-rollback:${claimedExecution.execution_id}`,
                actorRef: this.actorRef,
                taskId: claimedExecution.task_id,
                executionId: claimedExecution.execution_id,
                specVersion: claimedExecution.spec_version,
                stateVersion: claimedExecution.state_version,
                fencingVersion: claimedExecution.fencing_version,
              }));
            } catch {
              // Preserve the binding failure as the Agent-visible error. The
              // Runtime startup path already fences or stops its own process
              // when it owns the failed handoff.
            }
          }
          this.taskId = null;
          this.executionId = null;
          this.role = AGENT_ROLES.SELECTION;
          this.capabilityProfile = null;
          this.capabilityProfileRegistryRevision = null;
          await this.onRelease?.({ taskId: result.task.task_id, executionId: result.execution.execution_id, result: null });
          throw error;
        }
        const response = handoffRequired
          ? { ...result, handoff_required: true, handoff_instruction: 'Runtime has started the bound Workspace session. Stop this turn and continue work there.' }
          : result;
        this.logger?.append({ event: 'bridge.complete', operation, ok: true, result: response });
        return response;
      }

      // User-defined registered Services are invoked through the Registry's
      // adapter boundary. This keeps a remote HTTP provider on the same
      // Agent/Core path as a local provider and avoids reintroducing a generic
      // catch-all service call tool.
      // Semantic handoff and typed block are Runtime lifecycle boundaries even
      // when the Task Service is reached through the Registry. Route them
      // through Runtime first so the durable Task transition and the physical
      // Session/Core/Workspace release happen as one Agent-visible action.
      if (this.registry?.invoke && capability.service_id === 'task' && (operation === 'task_handoff' || operation === 'task_block')) {
        if (!this.taskId || !this.executionId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `${operation} requires a claimed Task and Execution`, { operation });
        const execution = this.taskService.getExecution(this.executionId);
        if (!execution) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown execution: ${this.executionId}`, { execution_id: this.executionId });
        if (execution.task_id !== this.taskId) throw new SwarmEnvError(ERROR_CODES.FENCED, 'bridge execution does not match task', { task_id: this.taskId, execution_id: this.executionId });
        const boundTaskId = this.taskId;
        const boundExecutionId = this.executionId;
        const currentTask = this.taskService.getTask(boundTaskId);
        const modernTask = currentTask?.mission_id ? currentTask : null;
        const legacyBlock = operation === 'task_block' && !modernTask;
        const method = operation === 'task_handoff' ? 'handoffTask' : (legacyBlock ? 'blockExecution' : 'blockTask');
        if (typeof this.runtime?.[method] !== 'function') {
          throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `Runtime does not expose semantic ${operation} boundary`);
        }
        const result = await this.runtime[method](boundExecutionId, legacyBlock
          ? {
            ...payload,
            reason: payload.reason ?? payload.block_reason,
            dependency: payload.dependency,
            checkpoint: payload.checkpoint ?? {},
            files: payload.files ?? {},
            terminalState: payload.terminal_state ?? 'FENCED',
          }
          : payload);
        await this.onWorkUnit?.({ operation, taskId: boundTaskId, executionId: boundExecutionId, payload, result });
        await this.releaseClaim({ result });
        this.logger?.append({ event: 'bridge.complete', operation, service_id: capability.service_id, ok: true, result });
        return result;
      }
      let registeredService = null;
      if (this.registry?.getCapability && capability.service_id) {
        try {
          registeredService = this.registry.getCapabilityById?.(capability.id)
            ?? this.registry.getCapability(capability.service_id, capability.operation ?? capability.name);
        } catch { registeredService = null; }
      }
      if (registeredService && !capability.runtime_owned && capability.service_id !== 'runtime') {
        if (operation === 'task_take' && this.role === AGENT_ROLES.SELECTION) {
          throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'task_take requires a bound or recovery identity; Selection must not choose a Task', { role: this.role });
        }
        if (operation === 'task_take' && (this.taskId || this.executionId)) {
          throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'task_take requires the current Execution binding to be released', { task_id: this.taskId, execution_id: this.executionId });
        }
        const requiresBinding = operation !== 'task_take' && Array.isArray(capability.context) && capability.context.length > 0;
        if (requiresBinding && (!this.taskId || !this.executionId)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `${operation} requires a claimed Task and Execution`, { operation });
        if (operation === 'submit_candidate') {
          const guard = this.onBeforeSubmitCandidate?.({ taskId: this.taskId, executionId: this.executionId, payload });
          if (guard && typeof guard.then === 'function') await guard;
        }
        const currentExecution = this.executionId ? this.taskService.getExecution(this.executionId) : null;
        const invocationPayload = operation === 'task_take'
          ? {
            ...payload,
            owner_ref: this.actorRef,
            core_id: this.coreId ?? currentExecution?.core_id ?? payload.core_id ?? null,
          }
          : payload;
        const invoke = async () => {
          if (operation === 'task_create') {
            const guard = this.onTaskCreate?.({ taskId: this.taskId, executionId: this.executionId, payload });
            if (guard && typeof guard.then === 'function') await guard;
          }
          return this.#invokeRegistered(capability, invocationPayload, bridgeOperationId);
        };
        let result = operation === 'task_create' && this.taskCreateMutex
          ? await this.taskCreateMutex.run(invoke)
          : await invoke();
        if (operation === 'task_take') {
          await this.bindClaim(result);
        }
        if (operation === 'task_complete') {
          await this.onWorkUnit?.({ operation, taskId: this.taskId, executionId: this.executionId, payload, result });
          // The Task Service commits the semantic completion; Runtime owns the
          // physical Session/Core/Workspace release that follows it.
          await this.runtime.releaseExecution?.(this.executionId);
          await this.releaseClaim({ result });
          this.logger?.append({ event: 'bridge.complete', operation, service_id: capability.service_id, ok: true, result });
          return result;
        }
        if (capability.service_id === 'judge' && operation === 'submit_candidate' && this.onSubmitCandidate) {
          const callbackResult = await this.onSubmitCandidate({ taskId: this.taskId, executionId: this.executionId, payload, result });
          const { deferred_block: deferredBlock = null, ...visibleCallbackResult } = callbackResult ?? {};
          result = { ...result, ...visibleCallbackResult };
          if (deferredBlock) {
            if (this.deferredLifecycle) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'a candidate Task block is already pending');
            this.deferredLifecycle = {
              taskId: this.taskId,
              executionId: this.executionId,
              block: {
                reason: deferredBlock.reason,
                dependency: deferredBlock.dependency,
                checkpoint: deferredBlock.checkpoint ?? {},
                files: deferredBlock.files ?? {},
                terminalState: deferredBlock.terminal_state ?? 'FENCED',
              },
              result,
            };
          }
        }
        if (this.onWorkUnit && (operation !== 'submit_candidate' || capability.service_id === 'judge') && ['read_materials', 'context_search_materials', 'context_get_material', 'consume_materials', 'publish_material', 'context_publish_material', 'task_create', 'task_register', 'task_take', 'task_link_material', 'task_handoff', 'task_block', 'create_child_task', 'create_branch_group', 'add_required_subtask', 'propose_structure_change', 'create_rework_task', 'accept_task', 'request_rework', 'submit_candidate'].includes(operation)) {
          await this.onWorkUnit({ operation, taskId: this.taskId, executionId: this.executionId, payload, result });
        }
        this.logger?.append({ event: 'bridge.complete', operation, service_id: capability.service_id, ok: true, result });
        return result;
      }

      const unboundCanonicalTake = operation === 'task_take' && this.role !== AGENT_ROLES.SELECTION && !this.taskId && !this.executionId;
      if ((!this.taskId || !this.executionId) && !unboundCanonicalTake) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `${operation} requires a claimed Task and Execution`, { operation });
      const execution = this.executionId ? this.taskService.getExecution(this.executionId) : null;
      if (!unboundCanonicalTake && !execution) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown execution: ${this.executionId}`, { execution_id: this.executionId });
      if (!unboundCanonicalTake && execution.task_id !== this.taskId) throw new SwarmEnvError(ERROR_CODES.FENCED, 'bridge execution does not match task', { task_id: this.taskId, execution_id: this.executionId });
      const boundTaskId = this.taskId;
      const boundExecutionId = this.executionId;
      if (operation === 'task_handoff' || operation === 'task_block') {
        // `task_block` is the semantic Mission operation for modern Tasks.
        // Legacy Tasks retain the historical typed block contract, which has
        // no Handoff Material requirement and is still routed through the
        // Runtime/Task Service boundary for compatibility fixtures.
        const legacyBlock = operation === 'task_block' && !modernBoundTask;
        const method = operation === 'task_handoff' ? 'handoffTask' : (legacyBlock ? 'blockExecution' : 'blockTask');
        if (typeof this.runtime?.[method] !== 'function') {
          throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `Runtime does not expose semantic ${operation} boundary`);
        }
        const result = await this.runtime[method](boundExecutionId, legacyBlock
          ? {
            ...payload,
            reason: payload.reason ?? payload.block_reason,
            dependency: payload.dependency,
            checkpoint: payload.checkpoint ?? {},
            files: payload.files ?? {},
            terminalState: payload.terminal_state ?? 'FENCED',
          }
          : payload);
        await this.onWorkUnit?.({ operation, taskId: boundTaskId, executionId: boundExecutionId, payload, result });
        await this.releaseClaim({ result });
        this.logger?.append({ event: 'bridge.complete', operation, ok: true, result });
        return result;
      }
      if (operation === 'request_wait') {
        const waitCondition = normalizeWaitCondition(payload.waitCondition ?? payload.wait_condition, payload.checkpoint);
        if (waitCondition?.type === 'check_result_arrived') {
          throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'candidate checks are synchronous submit_candidate tool work; request_wait only accepts Task dependencies');
        }
        const result = await this.runtime.requestWait(this.executionId, {
          ...payload,
          waitCondition,
          deadline: payload.deadline ?? payload.wait_deadline,
        });
        if (result?.disposition === 'already_satisfied') {
          this.logger?.append({ event: 'bridge.wait_already_satisfied', operation, result });
          return result;
        }
        const released = { taskId: this.taskId, executionId: this.executionId, result };
        // Record the durable wait request before releasing the bridge binding;
        // the runner uses this ordering to measure physical Core release.
        await this.onWorkUnit?.({ operation, taskId: released.taskId, executionId: released.executionId, payload, result });
        this.taskId = null;
        this.executionId = null;
        if (this.onRelease) await this.onRelease(released);
        this.logger?.append({ event: 'bridge.complete', operation, ok: true, result });
        return result;
      }
      if (operation === 'block_execution') {
        const result = await this.runtime.blockExecution(this.executionId, {
          ...payload,
          reason: payload.reason ?? payload.block_reason,
          dependency: payload.dependency,
          checkpoint: payload.checkpoint ?? {},
          files: payload.files ?? {},
          terminalState: payload.terminal_state ?? 'FENCED',
        });
        const released = { taskId: this.taskId, executionId: this.executionId, result };
        await this.onWorkUnit?.({ operation, taskId: released.taskId, executionId: released.executionId, payload, result });
        this.taskId = null;
        this.executionId = null;
        this.role = AGENT_ROLES.SELECTION;
        this.capabilityProfile = null;
        this.capabilityProfileRegistryRevision = null;
        await this.onRelease?.(released);
        this.logger?.append({ event: 'bridge.complete', operation, ok: true, result });
        return result;
      }
      const sdk = new ServicesSDK(service, {
        actorRef: this.actorRef,
        coreId: this.coreId ?? execution?.core_id ?? null,
        taskId: this.taskId,
        executionId: this.executionId,
        specVersion: execution?.spec_version ?? null,
        stateVersion: execution?.state_version ?? null,
        taskStateVersion: this.taskService.getTask(this.taskId)?.state_version ?? execution?.state_version ?? null,
        fencingVersion: execution?.fencing_version ?? null,
      });
      const options = { operationId: bridgeOperationId };
      let result;
      switch (operation) {
        case 'get_task':
          result = modernBoundTask
            ? sdk.viewTask(payload.task_id ?? this.taskId).task
            : sdk.getTask(payload.task_id ?? this.taskId);
          break;
        case 'get_execution': result = sdk.getExecution(payload.execution_id ?? this.executionId); break;
        case 'task_list': result = sdk.listMissionTasks(payload); break;
        case 'task_status': result = sdk.taskStatus(payload); break;
        case 'task_view': result = sdk.viewTask(payload.task_id ?? this.taskId); break;
        case 'task_create':
          {
            const createTask = async () => {
              const guard = this.onTaskCreate?.({ taskId: boundTaskId, executionId: boundExecutionId, payload });
              if (guard && typeof guard.then === 'function') await guard;
              return sdk.createTask(payload, options);
            };
            result = this.taskCreateMutex
              ? await this.taskCreateMutex.run(createTask)
              : await createTask();
          }
          break;
        case 'task_register': result = sdk.taskRegister(payload, options); break;
        case 'task_take':
          result = sdk.taskTake(payload, options);
          await this.bindClaim(result);
          break;
        case 'task_link_material': result = sdk.linkMaterial(payload, options); break;
        case 'task_complete':
          result = sdk.completeTask(payload, options);
          await this.onWorkUnit?.({ operation, taskId: boundTaskId, executionId: boundExecutionId, payload, result });
          // Task Service records the semantic DONE/SUCCEEDED transition first.
          // Runtime then releases the live Session/Core/Workspace without
          // attempting a second Task transition.  Test doubles that do not
          // materialize a Runtime process may omit this optional seam.
          if (typeof this.runtime.releaseExecution === 'function') {
            await this.runtime.releaseExecution(boundExecutionId);
          }
          await this.releaseClaim({ result });
          break;
        case 'task_close': result = sdk.closeTask(payload, options); break;
        case 'context_search_materials': result = sdk.searchMaterials(payload); break;
        case 'context_get_material': result = sdk.getMaterial(payload.material_id ?? payload.materialId); break;
        case 'context_publish_material': result = sdk.publishCollaborationMaterial(payload, options); break;
        case 'read_materials': result = sdk.readMaterials(payload); break;
        case 'consume_materials': result = sdk.consumeMaterials(payload, options); break;
        case 'publish_material': result = sdk.publishMaterial(payload, options); break;
        case 'submit_candidate':
          {
            const guard = this.onBeforeSubmitCandidate?.({ taskId: boundTaskId, executionId: boundExecutionId, payload });
            if (guard && typeof guard.then === 'function') await guard;
          }
          result = sdk.submitCandidate(payload, options);
          if (this.onSubmitCandidate) {
            const callbackResult = await this.onSubmitCandidate({ taskId: boundTaskId, executionId: boundExecutionId, payload, result });
            const { deferred_block: deferredBlock = null, ...visibleCallbackResult } = callbackResult ?? {};
            result = { ...result, ...visibleCallbackResult };
            if (deferredBlock) {
              if (this.deferredLifecycle) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'a candidate Task block is already pending');
              this.deferredLifecycle = {
                taskId: boundTaskId,
                executionId: boundExecutionId,
                block: {
                  reason: deferredBlock.reason,
                  dependency: deferredBlock.dependency,
                  checkpoint: deferredBlock.checkpoint ?? {},
                  files: deferredBlock.files ?? {},
                  terminalState: deferredBlock.terminal_state ?? 'FENCED',
                },
                result,
              };
            }
          }
          break;
        case 'heartbeat': result = sdk.heartbeat(payload, options); break;
        case 'create_child_task': result = sdk.createChildTask(payload, options); break;
        case 'create_branch_group': result = sdk.createBranchGroup(payload, options); break;
        case 'add_required_subtask': result = sdk.addRequiredSubtask(payload, options); break;
        case 'get_task_structure': result = sdk.getTaskStructure(payload); break;
        case 'propose_structure_change': result = sdk.proposeStructureChange(payload, options); break;
        case 'explain_task_readiness': result = sdk.explainTaskReadiness(payload); break;
        case 'create_rework_task': result = sdk.createReworkTask(payload, options); break;
        case 'get_workspace': result = await this.runtime.getWorkspace(this.executionId); break;
        case 'list_workspace_revisions': result = (await this.runtime.getWorkspace(this.executionId)).revisions; break;
        case 'list_workspace_files': result = await this.runtime.listWorkspaceFiles(this.executionId, { path: payload.path ?? '' }); break;
        case 'read_workspace_file': result = await this.runtime.readWorkspaceFile(this.executionId, { path: payload.path, maxBytes: payload.max_bytes }); break;
        case 'write_workspace_file': result = await this.runtime.writeWorkspaceFile(this.executionId, {
          path: payload.path,
          content: payload.content,
          expectedRevision: payload.expected_revision,
          saveOperationId: bridgeOperationId,
        }); break;
        case 'workspace_diff': result = await this.runtime.workspaceDiff(this.executionId, {
          fromRevision: payload.from_revision,
          toRevision: payload.to_revision,
        }); break;
        case 'accept_task': result = sdk.acceptTask(payload, options); break;
        case 'request_rework': result = sdk.requestRework(payload, options); break;
        case 'get_check_result': result = sdk.getCheckResult(payload.check_result_id); break;
        default: throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `unsupported Agent operation: ${operation}`, { operation });
      }
      if (operation === 'write_workspace_file' && this.onWorkspaceWrite) {
        await this.onWorkspaceWrite({ taskId: boundTaskId, executionId: boundExecutionId, result });
      }
      if (this.onWorkUnit && ['read_materials', 'context_search_materials', 'context_get_material', 'consume_materials', 'publish_material', 'context_publish_material', 'task_create', 'task_link_material', 'create_child_task', 'create_branch_group', 'add_required_subtask', 'propose_structure_change', 'create_rework_task', 'accept_task', 'request_rework', 'submit_candidate'].includes(operation)) {
        await this.onWorkUnit({ operation, taskId: boundTaskId, executionId: boundExecutionId, payload, result });
      }
      this.logger?.append({ event: 'bridge.complete', operation, ok: true, result });
      return result;
    } catch (error) {
      try {
        await this.onError?.({ operation, operationId, error });
      } catch {
        // Preserve the original Agent-visible Service error if audit delivery
        // itself fails.
      }
      this.logger?.append({
        event: 'bridge.complete',
        operation,
        ok: false,
        error: { name: error.name, code: error.code, message: error.message },
      });
      throw error;
    }
  }
}
