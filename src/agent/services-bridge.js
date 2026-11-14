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
const WORKSPACE_OPERATIONS = new Set([
  'get_workspace', 'list_workspace_revisions', 'list_workspace_files',
  'read_workspace_file', 'write_workspace_file', 'workspace_diff',
  'sandbox_exec', 'sandbox_job',
]);
// A Bot may inspect Mission-scoped public state and propose work before it
// owns an Execution. Requiring an Execution for these operations makes a
// zero-Task Mission impossible to bootstrap.
const UNBOUND_OPERATIONS = new Set([
  'bot_exit',
  'task_list', 'task_view', 'task_status', 'task_create',
  'read_materials', 'context_search_materials', 'context_get_material',
  'material_read', 'material_search', 'material_get',
  'workspace_public_files', 'workspace_public_read', 'workspace_public_search',
  'mission_submit', 'mission_submission_get',
]);

function usesWorkspace(task) {
  const workspace = task?.workspace;
  const contract = task?.completion_contract ?? {};
  return Boolean((workspace && typeof workspace === 'object' && Object.keys(workspace).length > 0) ||
    contract.requires_workspace === true || contract.required_candidate?.workspace === true);
}

function requiredTaskCapabilities(payload = {}) {
  const explicit = payload.required_capabilities ?? payload.requiredCapabilities ??
    payload.capability_requirements ?? payload.capabilityRequirements ?? [];
  const required = Array.isArray(explicit)
    ? explicit.filter((value) => typeof value === 'string' && value.length > 0)
    : [];
  const conditions = payload.acceptance_conditions;
  // These acceptance keys are intentionally narrow, stable Task contract
  // vocabulary. They describe a result that cannot be verified by the
  // generic Task/Workspace surface; admission must fail before creating a
  // eligible Task when the corresponding registered capability is absent.
  if (conditions && typeof conditions === 'object' && !Array.isArray(conditions) &&
    (conditions.requires_exact_declarations === true || conditions.requires_verified_usage === true)) {
    required.push('mathlib_search');
  }
  return [...new Set(required)];
}

function availableTaskCapabilities(profile) {
  return new Set((profile?.capabilities ?? []).flatMap((capability) => [
    capability.id,
    capability.name,
    capability.operation,
    capability.tool_name,
    capability.toolName,
  ]).filter((value) => typeof value === 'string' && value.length > 0));
}

function assertTaskCapabilityAdmission(payload, profile) {
  const required = requiredTaskCapabilities(payload);
  if (required.length === 0) return;
  const available = availableTaskCapabilities(profile);
  const missing = required.filter((capability) => !available.has(capability));
  if (missing.length > 0) {
    const availableCapabilities = [...available].sort();
    throw new SwarmEnvError(ERROR_CODES.INVALID_TASK_CONTRACT,
      `Task requires capabilities unavailable to this Session: ${missing.join(', ')}`, {
        missing_capabilities: missing,
        required_capabilities: required,
        available_capabilities: availableCapabilities,
        admission: 'rejected',
        condition: 'task_creation_admission',
        action: 'modify_task_contract_or_register_capability',
        hint: 'Use exact capability IDs or operation names from available_capabilities; do not invent conceptual names. Register and verify the required Service before creating the Task if no listed capability is suitable.',
      });
  }
}
function blockedCapabilityId(payload) {
  const dependency = payload?.dependency;
  if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) return null;
  const kind = String(dependency.dependency_kind ?? dependency.dependencyKind ?? dependency.kind ?? '').toUpperCase();
  if (!['CAPABILITY', 'EXTERNAL_CAPABILITY', 'EXTERNAL'].includes(kind)) return null;
  const id = dependency.capability_id ?? dependency.capabilityId ?? dependency.required_capability ?? null;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * A capability block declares that the named capability is unavailable. When
 * the current Session can call it, the block is inconsistent with the
 * authoritative capability directory (r12: `swarmenv_workspace_get` was
 * accepted as an external blocker and stranded a Task). Reject it before any
 * lifecycle release so the Execution stays usable.
 */
function assertCapabilityBlockIsUnavailable(payload, profile) {
  const capabilityId = blockedCapabilityId(payload);
  if (!capabilityId) return;
  const available = availableTaskCapabilities(profile);
  const bare = capabilityId.startsWith('swarmenv_') ? capabilityId.slice('swarmenv_'.length) : capabilityId;
  if (!available.has(capabilityId) && !available.has(bare)) return;
  throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT,
    `capability ${capabilityId} is callable in this Session; it is not an external blocker`, {
      capability_id: capabilityId,
      condition: 'capability_block_admission',
      action: 'call_the_capability_or_block_on_a_real_dependency',
      hint: 'Call the listed tool directly. If it returned an error, treat that structured error as feedback; block only on a capability absent from the Callable capability directory or on a prerequisite Task.',
      retryable: false,
    });
}

function json(value) {
  return JSON.stringify(value ?? null);
}



function errorBody(error) {
  return {
    name: error?.name ?? 'Error',
    code: error?.code ?? 'BRIDGE_ERROR',
    message: error?.message ?? String(error),
    details: error?.details,
    retryable: Boolean(error?.retryable),
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
  constructor({ taskService, contextService, runtime, router, actorRef = 'agent:real', coreId = null, taskId = null, executionId = null, role = null, capabilityProfile = null, registry = null, runtimeCapabilities = null, taskCreateMutex = null, onTake = null, onTakeAccepted = null, onRelease = null, onWorkspaceWrite = null, onWorkUnit = null, onTaskCreate = null, onSchedulerStatus = null, onError = null, host = '127.0.0.1', publicUrl = null, logger = null, agentPrompt = GENERIC_AGENT_PROMPT } = {}) {
    if (!taskService || !contextService || !runtime) throw new TypeError('ServicesBridge requires Task Service, Context Service, and Runtime');
    this.taskService = taskService;
    this.contextService = contextService;
    this.runtime = runtime;
    this.router = router;
    this.actorRef = actorRef;
    this.coreId = coreId;
    this.taskId = taskId;
    this.executionId = executionId;
    // An unbound Agent remains the same reusable identity; task_take is its
    // only canonical acquisition seam.
    this.role = role ?? AGENT_ROLES.BOUND;
    this.capabilityProfile = capabilityProfile;
    this.capabilityProfileRegistryRevision = null;
    this.registry = registry ?? router?.registry ?? null;
    // An explicit capability list is authoritative. The default Runtime list
    // must not advertise a tool this deployment cannot execute.
    this.runtimeCapabilities = runtimeCapabilities ?? runtimeCapabilityList()
      .filter((capability) => runtime?.sandboxManager || !['sandbox_exec', 'sandbox_job'].includes(capability.operation));
    this.taskCreateMutex = taskCreateMutex;
    this.onTake = onTake;
    this.onTakeAccepted = onTakeAccepted;
    this.onRelease = onRelease;
    this.onWorkspaceWrite = onWorkspaceWrite;
    this.onWorkUnit = onWorkUnit;
    this.onTaskCreate = onTaskCreate;
    this.onSchedulerStatus = onSchedulerStatus;
    this.onError = onError;
    this.agentPrompt = agentPrompt;
    this.host = host;
    if (publicUrl !== null && (typeof publicUrl !== 'string' || !publicUrl.includes('{port}'))) throw new TypeError('publicUrl must contain a {port} placeholder');
    this.publicUrl = publicUrl;
    this.logger = logger;
    this.token = randomUUID();
    this.server = null;
    this.address = null;
    // Workspace source feedback is returned synchronously. A normal-flow checker
    // failure may then stage a typed Task block, which is applied only after
    // the HTTP response has been handed to the Agent.
    this.deferredLifecycle = null;
    this.deferredLifecyclePromise = null;
    // The most recent task_take attempt made through this identity, used by
    // the Core loop to distinguish "invalid choice" from "lost a take race".
    // It is reset by the Runner at the start of each discovery turn.
    this.lastTakeOutcome = null;
  }

  beginTakeAttempt() {
    this.lastTakeOutcome = null;
  }

  startBotIdentity(botId) {
    const bot = this.taskService.getBot(botId);
    const previous = this.taskService.getBot(this.actorRef);
    if (!bot || bot.state !== 'STARTING' || bot.core_id !== this.coreId ||
        this.executionId || (previous && previous.state !== 'CLOSED')) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bridge cannot replace an occupied Bot');
    }
    this.actorRef = botId;
    this.token = randomUUID();
    this.lastTakeOutcome = null;
    this.capabilityProfile = null;
    this.capabilityProfileRegistryRevision = null;
    return this.environment();
  }


  /** Bind the durable task_take result before Runtime activates the Execution. */
  async bindTake(result) {
    if (!result?.task?.task_id || !result?.execution?.execution_id) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'bindTake requires a Task and Execution result');
    }
    if (this.taskId || this.executionId) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'bridge already has a taken binding');
    this.taskId = result.task.task_id;
    this.executionId = result.execution.execution_id;
    this.coreId = this.coreId ?? result.execution.core_id ?? null;
    this.role = AGENT_ROLES.BOUND;
    this.capabilityProfile = null;
    this.capabilityProfileRegistryRevision = null;
    try {
      await this.onTakeAccepted?.(result);
      await this.onTake?.(result);
    } catch (error) {
      const released = { taskId: this.taskId, executionId: this.executionId, result: null };
      // task_take activation is a prepare/commit boundary. If the Runtime
      // cannot bind the already-created Execution, fence the provisional
      // owner before clearing the in-memory identity so it cannot remain
      // eligible through a stale bridge.
      try {
        let rolledBack = false;
        // releaseExecution only removes a process/Workspace for an Execution
        // that is already terminal. A provisional task_take binding is still
        // CREATED/RUNNING, so it must be stopped durably; otherwise the Task
        // stays RUNNING with no valid owner and becomes uneligible.
        if (typeof this.runtime?.stopExecution === 'function') {
          await this.runtime.stopExecution(this.executionId, 'FAILED', 'task_take_bind_failed');
          rolledBack = true;
        }
        if (!rolledBack && typeof this.taskService?.dispatch === 'function') {
          const execution = this.taskService.getExecution?.(this.executionId);
          this.taskService.dispatch('stop_execution', { terminal_state: 'FAILED', reason: 'task_take_bind_failed' }, makeEnvelope({
            operationId: `bridge:task-take-rollback:${this.executionId}`,
            actorRef: this.actorRef,
            taskId: this.taskId,
            executionId: this.executionId,
            specVersion: execution?.spec_version ?? null,
            stateVersion: execution?.state_version ?? null,
            fencingVersion: execution?.fencing_version ?? null,
          }));
          rolledBack = true;
        }
        if (!rolledBack && typeof this.runtime?.fenceExecution === 'function') {
          await this.runtime.fenceExecution(this.executionId, { reason: 'task_take_bind_failed' });
        }
      } catch { /* preserve the original bind failure; cleanup is best effort */ }
      this.taskId = null;
      this.executionId = null;
      this.role = AGENT_ROLES.BOUND;
      this.capabilityProfile = null;
      this.capabilityProfileRegistryRevision = null;
      // A failed handoff still owns a durable take until the caller fences it.
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
      SWARMENV_BRIDGE_URL: this.publicUrl
        ? this.publicUrl.replaceAll('{port}', String(this.address.port)).replace(/\/$/, '')
        : `http://${this.host === '0.0.0.0' || this.host === '::' ? '127.0.0.1' : this.host}:${this.address.port}`,
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

  async #afterAcceptedFinish(result, payload) {
    const executionId = result.execution.execution_id;
    const taskId = result.execution.task_id;
    try {
      await this.onWorkUnit?.({ operation: 'task_finish', taskId, executionId, payload, result });
    } catch (error) {
      this.logger?.append({ event: 'bridge.finish_observer_error', execution_id: executionId, error_class: error?.code ?? error?.name });
    }
    let released;
    try {
      if (typeof this.runtime.releaseExecution !== 'function') throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'finish cleanup Runtime is unavailable');
      released = await this.runtime.releaseExecution(executionId);
    } catch (error) {
      this.logger?.append({ event: 'bridge.finish_cleanup_pending', execution_id: executionId, error_class: error?.code ?? error?.name });
      return { ...result, cleanup_pending: true };
    }
    if (this.executionId === executionId && this.taskId === taskId) {
      try { await this.releaseTake({ result: { ...result, ...released } }); }
      catch (error) { this.logger?.append({ event: 'bridge.finish_release_observer_error', execution_id: executionId, error_class: error?.code ?? error?.name }); }
    }
    return result;
  }

  async releaseTake({ result = null } = {}) {
    const released = { taskId: this.taskId, executionId: this.executionId, result };
    this.taskId = null;
    this.executionId = null;
    this.role = AGENT_ROLES.BOUND;
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
      await this.releaseTake({
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
    // A synchronous Judge response may stage a typed block to run after the
    // HTTP response is sent. Drain that lifecycle work before the caller
    // tears down Runtime/log directories; otherwise the setImmediate
    // callback can write after experiment cleanup and surface an unhandled
    // ENOENT instead of a durable Task transition.
    if (this.deferredLifecycle) {
      try {
        await this.flushDeferredLifecycle();
      } catch (error) {
        this.logger?.append({ event: 'bridge.lifecycle_error', operation: 'deferred_block', ok: false, error: { name: error.name, code: error.code, message: error.message } });
      }
    }
    if (this.deferredLifecyclePromise) await this.deferredLifecyclePromise.catch(() => undefined);
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
    const authenticatedToken = this.token;
    try {
      const input = await readBody(request);
      if (authenticatedToken !== this.token) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot credentials changed while reading the request');
      const result = await this.call(input);
      send(response, 200, { ok: true, result });
      this.logger?.append({ event: 'bridge.response_sent', operation: input.operation });
      if (this.deferredLifecycle && !this.deferredLifecyclePromise) {
        const deferredPromise = Promise.resolve().then(() => this.flushDeferredLifecycle()).catch((error) => {
          this.logger?.append({ event: 'bridge.lifecycle_error', operation: 'deferred_block', ok: false, error: { name: error.name, code: error.code, message: error.message } });
        }).finally(() => {
          if (this.deferredLifecyclePromise === deferredPromise) this.deferredLifecyclePromise = null;
        });
        this.deferredLifecyclePromise = deferredPromise;
      }
    } catch (error) {
      if (!response.writableEnded) send(response, 400, { ok: false, error: errorBody(error) });
      else this.logger?.append({ event: 'bridge.error_after_response', operation: input?.operation ?? null, ok: false, error: { name: error.name, code: error.code, message: error.message } });
    }
  }

  async call({ operation, payload = {}, operation_id: operationId = null, service_id: serviceId = null, capability_id: capabilityId = null } = {}) {
    const identityToken = this.token;
    const assertIdentity = (beforeDispatch = false) => {
      if (this.token !== identityToken) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot credentials changed before dispatch');
      const bot = beforeDispatch ? this.taskService.getBot?.(this.actorRef) : null;
      if (bot && !['bot_exit', 'task_finish'].includes(operation)) this.taskService.assertBotDeadline(this.actorRef);
      if (bot && !['UNBOUND', 'ACTIVE'].includes(bot.state) && !['bot_exit', 'task_finish'].includes(operation)) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot stopped before dispatch');
      }
    };
    const bridgeOperationId = operationId ?? `bridge:${operation}:${randomUUID()}`;
    this.logger?.append({ event: 'bridge.start', operation, operation_id: bridgeOperationId, task_id: this.taskId, execution_id: this.executionId, payload });
    try {
      const profile = this.getCapabilityProfile();
      const capability = this.#profileCapability(profile, operation, { serviceId, capabilityId });
      if (!capability) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `Agent capability is not available for this Session: ${operation}`, {
        operation,
        role: this.role,
        profile_hash: profile.profile_hash,
        action: 'call_list_tools_or_get_service_metadata',
        available_capabilities: profile.capabilities.map((candidate) => candidate.tool_name ?? candidate.name),
      });
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'bridge payload must be an object', {
          operation,
          expected: 'object',
          action: 'retry_with_the_registered_input_schema',
        });
      }
      const boundTask = this.taskId ? this.taskService.getTask(this.taskId) : null;
      const bot = this.taskService.getBot?.(this.actorRef);
      if (bot && !['bot_exit', 'task_finish'].includes(operation)) this.taskService.assertBotDeadline(this.actorRef);
      if (bot && !['UNBOUND', 'ACTIVE'].includes(bot.state) && !['bot_exit', 'task_finish'].includes(operation)) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot is not authorized to contribute in its current state', { bot_state: bot.state });
      }
      if (operation === 'bot_exit') {
        return this.taskService.dispatch('bot_exit', payload, makeEnvelope({ actorRef: this.actorRef, operationId: bridgeOperationId }));
      }
      const modernBoundTask = boundTask?.mission_id ? boundTask : null;
      if (modernBoundTask && WORKSPACE_OPERATIONS.has(operation) && !usesWorkspace(modernBoundTask)) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Workspace capability is not enabled by the current Task contract', { operation, task_id: modernBoundTask.task_id });
      }
      const service = this.router ?? { dispatch: (name, body, envelope) => {
        if (['get_execution', 'list_tasks', 'list_executions', 'task_list', 'task_view', 'task_create', 'task_link_material', 'task_finish', 'task_status', 'task_take', 'task_feedback', 'execution_progress'].includes(name)) return this.taskService.dispatch(name, body, envelope);
        return this.contextService.dispatch(name, body, envelope);
      } };
      if (operation === 'execution_progress') {
        if (!this.taskId || !this.executionId || ![AGENT_ROLES.BOUND, AGENT_ROLES.RECOVERY].includes(this.role)) {
          throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'execution_progress requires a bound Task Execution', { role: this.role });
        }
        if (typeof this.runtime?.executionProgress !== 'function') {
          throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Runtime does not expose execution_progress');
        }
        const result = await this.runtime.executionProgress(this.executionId, { ...payload, actorRef: this.actorRef });
        await this.onWorkUnit?.({ operation, taskId: this.taskId, executionId: this.executionId, payload, result });
        if (payload.kind === 'handoff') await this.releaseTake({ result });
        this.logger?.append({ event: 'bridge.complete', operation, ok: true, result });
        return result;
      }
      const isCatalogDiscovery = capability.service_id === 'catalog' && ['list_services', 'get_service_metadata', 'list_tools'].includes(operation);
      const isTaskDiscovery = capability.service_id === 'task' && [
        'list_tasks', 'list_executions',
        'task_view', 'task_status',
      ].includes(operation);
      if (isCatalogDiscovery || isTaskDiscovery || (capability.service_id === 'task' && operation === 'scheduler_status')) {
        if (capability.service_id === 'task' && operation === 'scheduler_status') {
          const result = await (this.onSchedulerStatus
            ? this.onSchedulerStatus({ ...payload, task_id: payload.task_id ?? this.taskId, execution_id: payload.execution_id ?? this.executionId })
            : this.runtime.getSchedulerStatus({ ...payload, task_id: payload.task_id ?? this.taskId, execution_id: payload.execution_id ?? this.executionId }));
          this.logger?.append({ event: 'bridge.complete', operation, ok: true, result });
          return result;
        }
        const discoveryPayload = operation === 'task_status' && payload.mission_id === undefined && modernBoundTask?.mission_id
          ? { ...payload, mission_id: modernBoundTask.mission_id }
          : operation === 'list_tasks' && this.taskId === null && payload.available_only !== false
          ? { ...payload, states: ['OPEN', 'RUNNING', 'WAITING'] }
          : (operation === 'task_view' && payload.task_id === undefined && this.taskId
            ? { ...payload, task_id: this.taskId }
            : payload);
        const result = this.registry?.invoke
            ? await this.#invokeRegistered(capability, discoveryPayload, bridgeOperationId)
            : service.dispatch(operation, discoveryPayload, makeEnvelope({
            operationId: bridgeOperationId,
            actorRef: this.actorRef,
          }));
        this.logger?.append({ event: 'bridge.complete', operation, ok: true, result });
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
        if (operation === 'task_take' && (this.taskId || this.executionId)) {
          throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'task_take requires the current Execution binding to be released', { task_id: this.taskId, execution_id: this.executionId });
        }
        const requiresBinding = operation !== 'task_take' && !UNBOUND_OPERATIONS.has(operation) && Array.isArray(capability.context) && capability.context.length > 0;
        if (requiresBinding && (!this.taskId || !this.executionId)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `${operation} requires a taken Task and Execution`, { operation });
        const currentExecution = this.executionId ? this.taskService.getExecution(this.executionId) : null;
        const invocationPayload = operation === 'task_take'
          ? {
            // Caller-supplied owner/prompt fields are not trusted identity
            // claims. Runtime supplies the stable prompt and authenticated
            // actor; only task choice and workspace lineage come from the
            // request.
            ...Object.fromEntries(Object.entries(payload).filter(([key]) => !['owner_ref', 'agent_prompt', 'initial_prompt'].includes(key))),
            ...(this.taskService.isModernTask?.(payload.task_id)
              ? {
                workspace_mode: 'clean',
                workspace_revision: undefined,
                workspace_source_execution_id: undefined,
                workspace_source_ref: undefined,
              }
              : {}),
            owner_ref: this.actorRef,
            agent_prompt: this.agentPrompt,
            // The lane is authenticated runtime state, never a model choice.
            core_id: this.coreId ?? currentExecution?.core_id ?? null,
          }
          : payload;
        const invoke = async () => {
          assertIdentity(true);
          if (operation === 'task_create') {
            const guard = this.onTaskCreate?.({ taskId: this.taskId, executionId: this.executionId, payload });
            if (guard && typeof guard.then === 'function') await guard;
            assertIdentity(true);
            assertTaskCapabilityAdmission(payload, profile);
          }
          if (operation === 'task_take') this.lastTakeOutcome = { attempted: true, ok: false, task_id: invocationPayload.task_id ?? null };
          let registeredPayload = operation === 'task_create'
            ? (({ progress: _progress, ...rest }) => ({ ...rest, required_capabilities: requiredTaskCapabilities(payload) }))(invocationPayload)
            : invocationPayload;
          if (operation === 'workspace_check') {
            const source = await this.runtime.readWorkspaceFile(this.executionId, { path: payload.path, maxBytes: payload.max_bytes });
            if (typeof payload.path !== 'string' || payload.path.length === 0 || payload.path.startsWith('/') || payload.path.split('/').includes('..')) {
              throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'workspace_check.path must stay within the Execution Workspace');
            }
            if (payload.workspace_revision !== undefined && Number(payload.workspace_revision) !== Number(source.workspace_revision ?? source.revision)) {
              throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'workspace_check revision is stale', {
                expected: source.workspace_revision ?? source.revision,
                actual: payload.workspace_revision,
              });
            }
            if (payload.content_hash !== undefined && payload.content_hash !== source.content_hash) {
              throw new SwarmEnvError(ERROR_CODES.STALE_VERSION, 'workspace_check content_hash does not match the Workspace file');
            }
            registeredPayload = {
              ...payload,
              source: {
                revision: source.revision ?? source.workspace_revision,
                path: payload.path,
                content: source.content,
                content_hash: source.content_hash,
                workspace_revision: source.workspace_revision ?? source.revision,
                input_snapshot_hash: source.input_snapshot_hash ?? null,
                ...((source.workspace_id ?? source.workspace_ref) ? { workspace_id: source.workspace_id ?? source.workspace_ref } : {}),
              },
              source_attestation: {
                task_id: this.taskId,
                execution_id: this.executionId,
                path: payload.path,
                workspace_revision: source.workspace_revision ?? source.revision,
                revision: source.revision ?? source.workspace_revision,
                content_hash: source.content_hash,
                ...((source.workspace_id ?? source.workspace_ref) ? { workspace_id: source.workspace_id ?? source.workspace_ref } : {}),
              },
            };
          }
          assertIdentity(true);
          return this.#invokeRegistered(capability, registeredPayload, bridgeOperationId);
        };
        let result = operation === 'task_create' && this.taskCreateMutex
          ? await this.taskCreateMutex.run(invoke)
          : await invoke();
        assertIdentity();
        if (operation === 'task_take') {
          await this.bindTake(result);
          this.lastTakeOutcome = { attempted: true, ok: true, task_id: result.task.task_id, execution_id: result.execution.execution_id };
        }
        if (operation === 'task_finish') {
          result = await this.#afterAcceptedFinish(result, payload);
          this.logger?.append({ event: 'bridge.complete', operation, service_id: capability.service_id, ok: true, result });
          return result;
        }
        if (this.onWorkUnit && ['read_materials', 'context_search_materials', 'context_get_material', 'consume_materials', 'publish_material', 'context_publish_material', 'task_create', 'task_take', 'task_link_material', 'task_finish'].includes(operation)) {
          await this.onWorkUnit({ operation, taskId: this.taskId, executionId: this.executionId, payload, result });
        }
        this.logger?.append({ event: 'bridge.complete', operation, service_id: capability.service_id, ok: true, result });
        return result;
      }

      const unboundCanonicalTake = operation === 'task_take' && !this.taskId && !this.executionId;
      if ((!this.taskId || !this.executionId) && !unboundCanonicalTake) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `${operation} requires a taken Task and Execution`, { operation });
      const execution = this.executionId ? this.taskService.getExecution(this.executionId) : null;
      if (!unboundCanonicalTake && !execution) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown execution: ${this.executionId}`, { execution_id: this.executionId });
      if (!unboundCanonicalTake && execution.task_id !== this.taskId) throw new SwarmEnvError(ERROR_CODES.FENCED, 'bridge execution does not match task', { task_id: this.taskId, execution_id: this.executionId });
      const boundTaskId = this.taskId;
      const boundExecutionId = this.executionId;
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
        case 'get_execution': result = sdk.getExecution(payload.execution_id ?? this.executionId); break;
        case 'task_list': result = sdk.listMissionTasks(payload); break;
        case 'task_status': result = sdk.taskStatus(payload); break;
        case 'task_view': result = sdk.viewTask(payload.task_id ?? this.taskId); break;
        case 'task_create':
          {
            const createTask = async () => {
              assertIdentity(true);
              const guard = this.onTaskCreate?.({ taskId: boundTaskId, executionId: boundExecutionId, payload });
              if (guard && typeof guard.then === 'function') await guard;
              assertIdentity(true);
              assertTaskCapabilityAdmission(payload, profile);
              return sdk.createTask(payload, options);
            };
            result = this.taskCreateMutex
              ? await this.taskCreateMutex.run(createTask)
              : await createTask();
          }
          break;
        case 'task_take':
          this.lastTakeOutcome = { attempted: true, ok: false, task_id: payload.task_id ?? null };
          {
            // Task Service owns the canonical clean Workspace admission. Do
            // not rewrite a caller's Workspace mode or lineage at the Bridge.
            result = sdk.taskTake(payload, options);
          }
          await this.bindTake(result);
          this.lastTakeOutcome = { attempted: true, ok: true, task_id: result.task.task_id, execution_id: result.execution.execution_id };
          break;
        case 'task_link_material': result = sdk.linkMaterial(payload, options); break;
        case 'task_finish':
          result = await this.#afterAcceptedFinish(sdk.finishTask(payload, options), payload);
          break;
        case 'context_search_materials': result = sdk.searchMaterials(payload); break;
        case 'context_get_material': result = sdk.getMaterial(payload.material_id ?? payload.materialId); break;
        case 'context_publish_material': result = sdk.publishCollaborationMaterial(payload, options); break;
        case 'read_materials': result = sdk.readMaterials(payload); break;
        case 'consume_materials': result = sdk.consumeMaterials(payload, options); break;
        case 'publish_material': result = sdk.publishMaterial(payload, options); break;
        case 'heartbeat': result = sdk.heartbeat(payload, options); break;
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
        case 'sandbox_exec': result = await this.runtime.sandboxExec(this.executionId, {
          command: payload.command,
          cwd: payload.cwd,
          timeout_ms: payload.timeout_ms,
          env: payload.env,
          background: payload.background,
        }); break;
        case 'sandbox_job': result = await this.runtime.sandboxJob(this.executionId, {
          action: payload.action ?? 'status',
          job_id: payload.job_id,
        }); break;
        case 'get_check_result': result = sdk.getCheckResult(payload.check_result_id); break;
        case 'workspace_check': {
          const source = await this.runtime.readWorkspaceFile(this.executionId, {
            path: payload.path,
            maxBytes: payload.max_bytes,
          });
          result = await this.#invokeRegistered(capability, {
            ...payload,
            source: {
              revision: source.revision ?? source.workspace_revision,
              path: payload.path,
              content: source.content,
              content_hash: source.content_hash,
              workspace_revision: source.workspace_revision ?? source.revision,
              input_snapshot_hash: source.input_snapshot_hash ?? null,
              ...((source.workspace_id ?? source.workspace_ref) ? { workspace_id: source.workspace_id ?? source.workspace_ref } : {}),
            },
            source_attestation: {
              task_id: boundTaskId,
              execution_id: boundExecutionId,
              path: payload.path,
              workspace_revision: source.workspace_revision ?? source.revision,
              revision: source.revision ?? source.workspace_revision,
              content_hash: source.content_hash,
              ...((source.workspace_id ?? source.workspace_ref) ? { workspace_id: source.workspace_id ?? source.workspace_ref } : {}),
            },
          }, bridgeOperationId);
          break;
        }
        default: throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `unsupported Agent operation: ${operation}`, { operation });
      }
      if (operation === 'write_workspace_file' && this.onWorkspaceWrite) {
        await this.onWorkspaceWrite({ taskId: boundTaskId, executionId: boundExecutionId, result });
      }
      if (this.onWorkUnit && ['read_materials', 'context_search_materials', 'context_get_material', 'consume_materials', 'publish_material', 'context_publish_material', 'task_create', 'task_link_material'].includes(operation)) {
        await this.onWorkUnit({ operation, taskId: boundTaskId, executionId: boundExecutionId, payload, result });
      }
      this.logger?.append({ event: 'bridge.complete', operation, ok: true, result });
      return result;
    } catch (error) {
      if (operation === 'task_take' && this.token === identityToken) {
        this.lastTakeOutcome = {
          attempted: true, ok: false, task_id: payload?.task_id ?? null, operation_id: bridgeOperationId,
          code: error.code ?? 'SERVICE_UNAVAILABLE', message: error.message,
        };
      }
      try {
        await this.onError?.({ operation, operationId: bridgeOperationId, error });
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
