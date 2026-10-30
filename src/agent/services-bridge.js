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
  constructor({ taskService, contextService, runtime, router, actorRef = 'agent:real', taskId = null, executionId = null, role = null, capabilityProfile = null, registry = null, runtimeCapabilities = null, onClaim = null, onClaimAccepted = null, onRelease = null, onWorkspaceWrite = null, onWorkUnit = null, onSubmitCandidate = null, onSchedulerStatus = null, onError = null, host = '127.0.0.1', logger = null, agentPrompt = GENERIC_AGENT_PROMPT } = {}) {
    if (!taskService || !contextService || !runtime) throw new TypeError('ServicesBridge requires Task Service, Context Service, and Runtime');
    this.taskService = taskService;
    this.contextService = contextService;
    this.runtime = runtime;
    this.router = router;
    this.actorRef = actorRef;
    this.taskId = taskId;
    this.executionId = executionId;
    this.role = role ?? (taskId || executionId ? AGENT_ROLES.BOUND : AGENT_ROLES.SELECTION);
    this.capabilityProfile = capabilityProfile;
    this.capabilityProfileRegistryRevision = null;
    this.registry = registry ?? router?.registry ?? null;
    this.runtimeCapabilities = runtimeCapabilities ?? runtimeCapabilityList();
    this.onClaim = onClaim;
    this.onClaimAccepted = onClaimAccepted;
    this.onRelease = onRelease;
    this.onWorkspaceWrite = onWorkspaceWrite;
    this.onWorkUnit = onWorkUnit;
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
        context: { task_id: this.taskId, execution_id: this.executionId },
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
      const service = this.router ?? { dispatch: (name, body, envelope) => {
        if (['get_task', 'get_execution', 'list_tasks', 'list_claimable_tasks', 'list_executions'].includes(name)) return this.taskService.dispatch(name, body, envelope);
        return this.contextService.dispatch(name, body, envelope);
      } };
      const bridgeOperationId = operationId ?? `bridge:${operation}:${randomUUID()}`;
      const isCatalogDiscovery = capability.service_id === 'catalog' && ['list_services', 'get_service_metadata', 'list_tools'].includes(operation);
      const isTaskDiscovery = capability.service_id === 'task' && ['list_tasks', 'list_claimable_tasks', 'get_task', 'list_executions', 'get_task_structure', 'explain_task_readiness'].includes(operation);
      if (isCatalogDiscovery || isTaskDiscovery || (capability.service_id === 'task' && operation === 'scheduler_status')) {
        if (this.role === AGENT_ROLES.SELECTION && isTaskDiscovery && !Array.isArray(this.selectionCandidates)) {
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
        const discoveryPayload = (operation === 'list_tasks' || operation === 'list_claimable_tasks') && this.taskId === null && payload.available_only !== false
          ? { ...payload, states: ['OPEN'] }
          : ((operation === 'get_task' || ['get_task_structure', 'explain_task_readiness'].includes(operation)) && payload.task_id === undefined && this.taskId
            ? { ...payload, task_id: this.taskId }
            : payload);
        const shortlistScopedOperations = ['get_task', 'list_executions', 'get_task_structure', 'explain_task_readiness'];
        if (this.role === AGENT_ROLES.SELECTION && Array.isArray(this.selectionCandidates) && shortlistScopedOperations.includes(operation)) {
          const taskId = discoveryPayload.task_id;
          if (typeof taskId !== 'string' || taskId.length === 0) {
            throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${operation} requires payload.task_id`);
          }
          const candidate = this.selectionCandidates.find((entry) => String(entry.task_id) === taskId);
          if (!candidate) {
            throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${operation} must target a task_id from the bounded shortlist`, { task_id: taskId });
          }
          if (operation === 'get_task') {
            const result = selectionCandidate(candidate);
            this.logger?.append({ event: 'bridge.complete', operation, ok: true, result });
            return result;
          }
        }
        if (isTaskDiscovery && ['list_tasks', 'list_claimable_tasks'].includes(operation) && Array.isArray(this.selectionCandidates)) {
          const result = this.selectionCandidates.map(selectionCandidate);
          this.logger?.append({ event: 'bridge.complete', operation, ok: true, result });
          return result;
        }
        const result = this.registry?.invoke
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
          const taskCapability = profile.capabilities.find((candidate) => candidate.service_id === 'task' && (candidate.operation === 'get_task' || candidate.name === 'get_task' || candidate.name === 'task_get'));
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
      let registeredService = null;
      if (this.registry?.getCapability && capability.service_id) {
        try { registeredService = this.registry.getCapability(capability.service_id, capability.name); } catch { registeredService = null; }
      }
      if (registeredService && !capability.runtime_owned && capability.service_id !== 'runtime') {
        const requiresBinding = Array.isArray(capability.context) && capability.context.length > 0;
        if (requiresBinding && (!this.taskId || !this.executionId)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `${operation} requires a claimed Task and Execution`, { operation });
        let result = await this.#invokeRegistered(capability, payload, bridgeOperationId);
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
        if (this.onWorkUnit && (operation !== 'submit_candidate' || capability.service_id === 'judge') && ['read_materials', 'consume_materials', 'publish_material', 'create_child_task', 'create_branch_group', 'add_required_subtask', 'propose_structure_change', 'create_rework_task', 'accept_task', 'request_rework', 'submit_candidate'].includes(operation)) {
          await this.onWorkUnit({ operation, taskId: this.taskId, executionId: this.executionId, payload, result });
        }
        this.logger?.append({ event: 'bridge.complete', operation, service_id: capability.service_id, ok: true, result });
        return result;
      }

      if (!this.taskId || !this.executionId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `${operation} requires a claimed Task and Execution`, { operation });
      const execution = this.taskService.getExecution(this.executionId);
      if (!execution) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown execution: ${this.executionId}`, { execution_id: this.executionId });
      if (execution.task_id !== this.taskId) throw new SwarmEnvError(ERROR_CODES.FENCED, 'bridge execution does not match task', { task_id: this.taskId, execution_id: this.executionId });
      const boundTaskId = this.taskId;
      const boundExecutionId = this.executionId;
      if (operation === 'task_block') {
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
        taskId: this.taskId,
        executionId: this.executionId,
        specVersion: execution.spec_version,
        stateVersion: execution.state_version,
        taskStateVersion: this.taskService.getTask(this.taskId)?.state_version ?? execution.state_version,
        fencingVersion: execution.fencing_version,
      });
      const options = { operationId: bridgeOperationId };
      let result;
      switch (operation) {
        case 'get_task': result = sdk.getTask(payload.task_id ?? this.taskId); break;
        case 'get_execution': result = sdk.getExecution(payload.execution_id ?? this.executionId); break;
        case 'read_materials': result = sdk.readMaterials(payload); break;
        case 'consume_materials': result = sdk.consumeMaterials(payload, options); break;
        case 'publish_material': result = sdk.publishMaterial(payload, options); break;
        case 'submit_candidate':
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
      if (this.onWorkUnit && ['read_materials', 'consume_materials', 'publish_material', 'create_child_task', 'create_branch_group', 'add_required_subtask', 'propose_structure_change', 'create_rework_task', 'accept_task', 'request_rework', 'submit_candidate'].includes(operation)) {
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
