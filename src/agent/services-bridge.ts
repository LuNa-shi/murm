import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { createBuiltinServiceRegistry, MISSION_WORKSPACE_READS } from '../sdk/builtin-registry.js';
import { makeEnvelope, stableStringify } from '../protocol/envelope.js';
import { AGENT_ROLES, buildCapabilityProfile } from './capability-profile.js';
import { prepareWorkspaceCheckSource } from '../environments/flat/workspace-check-source.js';
import { createMissionSubmissionAccess } from '../environments/flat/mission-coordination.js';
import { agentCheckResult } from '../judge/check-result.js';
import { isSoftCloseout } from '../task/execution-budget.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
// Mission-scoped discovery remains available before taking an Execution.
const UNBOUND_OPERATIONS = new Set([
  'bot_exit', 'get_check_result', 'material_unsupersede', 'task_revise', 'task_cancel', 'task_dependency_replace',
  'task_list', 'task_view', 'task_status',
  'read_materials', 'context_search_materials', 'context_get_material',
  'workspace_public_files', 'workspace_public_read', 'workspace_public_search', 'workspace_public_diff', 'workspace_public_view', 'workspace_public_history',
  'mission_get', 'mission_submit', 'mission_submission_get',
]);
const COORDINATION_OPERATION_GRANTS = new Map<any, any>([
  ['material_unsupersede', 'unsupersede'],
  ['task_dependency_replace', 'task_dependency_replace'], ['mission_submit', 'mission_submit'],
]);

function botExecutionReceipt(execution: any) {
  const { execution_id, task_id, owner_ref, core_id, attempt_no, state, terminal_reason,
    input_material_refs, input_snapshot_hash, workspace_input, started_at, handoff_deadline,
    execution_deadline, created_at, updated_at } = execution;
  return { execution_id, task_id, owner_ref, core_id, attempt_no, state, terminal_reason,
    input_material_refs, input_snapshot_hash, workspace_input, started_at, handoff_deadline,
    execution_deadline, created_at, updated_at };
}

function botReceipt(result: any) {
  if (result?.execution?.execution_id) {
    const { execution, workspace, ...receipt } = result;
    return { ...receipt, execution: botExecutionReceipt(execution),
      ...(Object.hasOwn(result, 'workspace') ? { workspace: execution.workspace_input ?? null } : {}) };
  }
  if (result?.bot?.bot_id) {
    const { bot_id, mission_id, core_id, execution_id, state, exit_reason } = result.bot;
    return { ...result, bot: { bot_id, mission_id, core_id, execution_id, state, exit_reason } };
  }
  return result;
}

function json(value: any) {
  return JSON.stringify(value ?? null);
}



function errorBody(error: any) {
  return {
    name: error?.name ?? 'Error',
    code: error?.code ?? 'BRIDGE_ERROR',
    message: error?.message ?? String(error),
    details: error?.details,
    retryable: Boolean(error?.retryable),
  };
}

function send(response: any, status: any, body: any) {
  const content = json(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(content) });
  response.end(content);
}

async function readBody(request: any) {
  let size = 0;
  const chunks: any[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('bridge request body is too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export class ServicesBridge {
  declare pendingCalls: any;
  declare pendingHandlers: any;
  declare publicReadAbortController: any;
  declare taskService: any;
  declare contextService: any;
  declare runtime: any;
  declare missionSubmission: any;
  declare workspaceMerge: any;
  declare actorRef: any;
  declare coreId: any;
  declare taskId: any;
  declare executionId: any;
  declare role: any;
  declare capabilityProfile: any;
  declare capabilityProfileRegistryRevision: any;
  declare registry: any;
  declare onTake: any;
  declare onTakeAccepted: any;
  declare onRelease: any;
  declare onError: any;
  declare agentPrompt: any;
  declare host: any;
  declare publicUrl: any;
  declare logger: any;
  declare token: any;
  declare server: any;
  declare address: any;
  declare lastTakeOutcome: any;
  declare bindingPending: any;
  declare acceptedTake: any;
  declare stopping: any;
  declare mergeClosing: any;
  declare stopPromise: any;
  declare pendingTake: any;

  constructor({ taskService, contextService, runtime, missionSubmission = createMissionSubmissionAccess(), workspaceMerge = null, actorRef = 'agent:real', coreId = null, taskId = null, executionId = null, role = null, capabilityProfile = null, registry = null, onTake = null, onTakeAccepted = null, onRelease = null, onError = null, host = '127.0.0.1', publicUrl = null, logger = null, agentPrompt = null }: any = {}) {
    if (!taskService || !contextService || !runtime) throw new TypeError('ServicesBridge requires Task Service, Context Service, and Runtime');
    this.pendingCalls = new Set();
    this.pendingHandlers = new Set();
    this.publicReadAbortController = new AbortController();
    this.taskService = taskService;
    this.contextService = contextService;
    this.runtime = runtime;
    this.missionSubmission = missionSubmission;
    this.workspaceMerge = workspaceMerge;
    this.actorRef = actorRef;
    this.coreId = coreId;
    this.taskId = taskId;
    this.executionId = executionId;
    // An unbound Agent remains the same reusable identity; task_take is its
    // only canonical acquisition seam.
    this.role = role ?? AGENT_ROLES.BOUND;
    this.capabilityProfile = capabilityProfile;
    this.capabilityProfileRegistryRevision = null;
    this.registry = registry ?? createBuiltinServiceRegistry({
      taskService, contextService, judgeService: null,
      missionWorkspace: runtime.missionWorkspace,
    });
    this.onTake = onTake;
    this.onTakeAccepted = onTakeAccepted;
    this.onRelease = onRelease;
    this.onError = onError;
    this.agentPrompt = agentPrompt;
    this.host = host;
    if (publicUrl !== null && (typeof publicUrl !== 'string' || !publicUrl.includes('{port}'))) throw new TypeError('publicUrl must contain a {port} placeholder');
    this.publicUrl = publicUrl;
    this.logger = logger;
    this.token = randomUUID();
    this.server = null;
    this.address = null;
    // The most recent task_take attempt made through this identity, used by
    // the Core loop to distinguish "invalid choice" from "lost a take race".
    // It is reset by the Runner at the start of each discovery turn.
    this.lastTakeOutcome = null;
    this.bindingPending = false;
    this.acceptedTake = null;
  }

  beginTakeAttempt() {
    this.lastTakeOutcome = null;
  }

  startBotIdentity(botId: any) {
    const bot = this.taskService.getBot(botId);
    const previous = this.taskService.getBot(this.actorRef);
    if (!bot || bot.state !== 'STARTING' || bot.core_id !== this.coreId ||
        this.executionId || this.bindingPending || (previous && previous.state !== 'CLOSED')) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bridge cannot replace an occupied Bot');
    }
    this.acceptedTake = null;
    this.actorRef = botId;
    this.token = randomUUID();
    this.lastTakeOutcome = null;
    this.capabilityProfile = null;
    this.capabilityProfileRegistryRevision = null;
    return this.environment();
  }


  /** Bind the durable task_take result before Runtime activates the Execution. */
  async bindTake(result: any) {
    if (!result?.task?.task_id || !result?.execution?.execution_id) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'bindTake requires a Task and Execution result');
    }
    if (this.taskId || this.executionId) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'bridge already has a taken binding');
    this.bindingPending = true;
    this.taskId = result.task.task_id;
    this.executionId = result.execution.execution_id;
    this.coreId = this.coreId ?? result.execution.core_id ?? null;
    this.role = AGENT_ROLES.BOUND;
    this.capabilityProfile = null;
    this.capabilityProfileRegistryRevision = null;
    try {
      await this.onTakeAccepted?.(result);
      await this.onTake?.(result);
    } catch (error: any) {
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
    } finally { this.bindingPending = false; }
    return result;
  }

  #track(pending: any, operation: any) {
    const promise = Promise.resolve().then(operation);
    pending.add(promise);
    promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  }

  async start({ port = 0 }: any = {}) {
    if (this.stopping) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Stopped Bridge cannot restart; create a new Bridge');
    if (this.server) return this.environment();
    this.server = createServer((request: any, response: any) => {
      void this.#track(this.pendingHandlers, () => this.#handle(request, response)).catch((error: any) => {
        this.logger?.append({ event: 'bridge.handler_failed', code: error.code ?? 'HANDLER_ERROR' });
      });
    });
    const server = this.server;
    await new Promise<any>((resolve: any, reject: any) => {
      const cleanup = () => { server.off('listening', listening); server.off('close', closed); server.off('error', failed); };
      const listening = () => { cleanup(); resolve(); };
      const failed = (error: any) => { cleanup(); reject(error); };
      const closed = () => failed(new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bridge stopped before listening'));
      server.once('listening', listening); server.once('close', closed); server.once('error', failed);
      try { server.listen(port, this.host); } catch (error: any) { failed(error); }
    });
    if (this.stopping || this.server !== server) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bridge stopped during startup');
    const address = server.address();
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
        context: { task_id: this.taskId, execution_id: this.executionId, core_id: this.coreId },
      });
      this.capabilityProfileRegistryRevision = registryRevision;
    }
    const profile = structuredClone(this.capabilityProfile);
    return profile;
  }

  #profileCapability(profile: any, operation: any, { serviceId = null, capabilityId = null }: any = {}) {
    const matches = profile.capabilities.filter((candidate: any) => {
      if (capabilityId && (candidate.id ?? candidate.capability_id) !== capabilityId) return false;
      if (serviceId && candidate.service_id !== serviceId) return false;
      return candidate.operation === operation || candidate.name === operation || (capabilityId && (candidate.id ?? candidate.capability_id) === capabilityId);
    });
    if (matches.length > 1) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `ambiguous Agent capability: ${operation}`, {
        operation,
        capability_id: capabilityId,
        service_id: serviceId,
        matches: matches.map((candidate: any) => candidate.id ?? `${candidate.service_id}.${candidate.name}`),
      });
    }
    return matches[0] ?? null;
  }

  async #invokeRegistered(capability: any, payload: any, operationId: any, context: any = {}) {
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
      signal: Object.hasOwn(MISSION_WORKSPACE_READS, capability.operation) ? this.publicReadAbortController.signal : undefined,
    });
  }

  async #afterAcceptedFinish(result: any) {
    const executionId = result.execution.execution_id;
    const taskId = result.execution.task_id;
    let released;
    try {
      if (typeof this.runtime.releaseExecution !== 'function') throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'finish cleanup Runtime is unavailable');
      released = await this.runtime.releaseExecution(executionId);
    } catch (error: any) {
      this.logger?.append({ event: 'bridge.finish_cleanup_pending', execution_id: executionId, error_class: error?.code ?? error?.name });
      return { ...result, cleanup_pending: true };
    }
    if (this.executionId === executionId && this.taskId === taskId) {
      try { await this.releaseTake({ result: { ...result, ...released } }); }
      catch (error: any) { this.logger?.append({ event: 'bridge.finish_release_observer_error', execution_id: executionId, error_class: error?.code ?? error?.name }); }
    }
    return result;
  }

  async releaseTake({ result = null }: any = {}) {
    const released = { taskId: this.taskId, executionId: this.executionId, result };
    this.taskId = null;
    this.executionId = null;
    this.role = AGENT_ROLES.BOUND;
    this.capabilityProfile = null;
    this.capabilityProfileRegistryRevision = null;
    if (this.onRelease) await this.onRelease(released);
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.mergeClosing = this.workspaceMerge?.close();
    this.publicReadAbortController.abort(new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bridge is stopping'));
    this.stopPromise = this.#stop();
    return this.stopPromise;
  }

  async #stop() {
    // Stop admission and transport first; accepted lifecycle operations drain
    // concurrently with Runtime shutdown, never ahead of it.
    const server = this.server;
    this.server = null;
    this.address = null;
    const closed = server ? once(server, 'close').catch(() => undefined) : Promise.resolve();
    if (server) { server.close(); server.closeAllConnections?.(); }
    await Promise.allSettled([...this.pendingHandlers, ...this.pendingCalls]);
    await closed;
    await this.mergeClosing;
    return this.workspaceMerge?.close({ timeoutMs: 0 });
  }

  async #handle(request: any, response: any) {
    if (this.stopping) { send(response, 503, { ok: false, error: { code: 'NOT_ALLOWED', message: 'Bridge is stopping' } }); return; }
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
    let input;
    try {
      input = await readBody(request);
      if (input && typeof input === 'object' && !Array.isArray(input)) input.operation_id ??= `bridge:${input.operation}:${randomUUID()}`;
      if (authenticatedToken !== this.token) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot credentials changed while reading the request');
      const registeredBot = Boolean(this.taskService?.getBot?.(this.actorRef));
      const result = await this.call(input);
      const receipt = registeredBot ? botReceipt(result) : result;
      send(response, 200, { ok: true, result: receipt });
      this.logger?.append({ event: 'bridge.response_sent', operation: input.operation, operation_id: input.operation_id });
    } catch (error: any) {
      if (!response.writableEnded) {
        const body = errorBody(error);
        if (input && authenticatedToken === this.token && this.taskService.getBot?.(this.actorRef)) {
          const details = body.details ?? {};
          const operation = input.operation;
          let notice;
          if (operation === 'workspace_save' && !['NOT_ALLOWED', 'WORKSPACE_RESULT_UNKNOWN'].includes(body.code) && !details.phase) {
            notice = `工作目录未成功保存：${details.cause_code ?? body.code}。不得把私有文件声明为交付；在有效 E 和剩余重试额度内处理。`;
          } else if (operation === 'workspace_merge' && details.check && details.checked_tree) {
            notice = `固定 main ${details.main_revision} 与来源 ${details.source_revision} 的最终合成树未通过 ${details.check.checker?.checker_version ?? '未知版本'}：${details.check.verdict ?? body.code}。main、源版本和当前 E 保持不变。依据固定来源、main 与诊断修复并 save 新版本，再按剩余额度重试；运行中的文件目录不会自动接入公开版本。`;
          } else if (operation === 'workspace_merge' && body.code === 'MAIN_MOVED' && details.observed_revision) {
            notice = `检查后 main 已从 ${details.observed_revision} 前进到 ${details.actual_revision}；本请求未覆盖 main。可在剩余额度内重新合成并检查；若需修复，保留来源 ${details.source_revision} 的公开证据并 save 新版本后重试。`;
          } else if (details.phase === 'hard_stop') {
            notice = '已达到硬上限或发生强制停止，当前 E 不再有发布机会。此前未保存/发布的内容不视为已交接。';
          } else if (operation === 'bot_exit' && details.phase === 'discovery_required') {
            notice = 'Mission 尚未结束且选工时间仍有剩余。查看当前 Mission、公开 Workspace、材料和已有 Task，领取可推进的责任；没有合适 Task 时保持只读，按选工预算处理，不得创建占位 Task。';
          } else if (details.phase === 'selection_budget') {
            notice = '选工额度已到时间上限。尚未绑定 E 时使用 bot exit --reason selection-budget；不能为保持运行制造任务。';
          } else if (operation === 'task_take' && body.code === 'CONFLICT' && details.condition === 'task_occupied') {
            notice = `Task ${input.payload?.task_id} 当前由其他 Execution 占有。本请求未建立 E；仍在选工阶段，可在剩余预算内选择其他责任。`;
          } else if (body.code === 'NOT_ALLOWED') {
            const bot = this.taskService.getBot(this.actorRef);
            const execution = bot.execution_id && this.taskService.getExecution(bot.execution_id);
            const phase = details.phase ?? (bot.state === 'ACTIVE' && isSoftCloseout(execution) ? 'soft_closeout' : bot.state.toLowerCase());
            const allowed = phase === 'soft_closeout' ? ['workspace_save', 'context_publish_material', 'task_finish']
              : ['active', 'unbound'].includes(phase)
              ? this.getCapabilityProfile().capabilities.map((item: any) => item.operation).filter((item: any) =>
                typeof item === 'string' && (phase !== 'unbound' || item === 'task_take' || UNBOUND_OPERATIONS.has(item)) &&
                (phase === 'unbound' || !['task_revise', 'task_cancel'].includes(item)) &&
                (!COORDINATION_OPERATION_GRANTS.has(item) || bot.coordination_permissions.includes(COORDINATION_OPERATION_GRANTS.get(item))))
              : [];
            const allowedOperations = [...new Set(allowed)];
            body.details = { ...details, phase, allowed_operations: allowedOperations };
            notice = `操作 ${operation} 在阶段 ${phase} 未获授权。可用范围为 ${allowedOperations.join(', ') || '无'}，不能通过另一接口绕过。`;
          }
          if (notice) body.details = { ...body.details, request_id: input.operation_id ?? null, notice };
        }
        send(response, 400, { ok: false, error: body });
      }
      else this.logger?.append({ event: 'bridge.error_after_response', operation: input?.operation ?? null, ok: false, error: { name: error.name, code: error.code, message: error.message } });
    }
  }

  async call(request: any = {}) {
    if (this.stopping) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bridge is stopping');
    return this.#track(this.pendingCalls, () => this.#admittedCall(request));
  }

  async #admittedCall(request: any) {
    if (this.stopping) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bridge is stopping');
    // Coalesce only an explicit take request, for this live credential. A lost
    // CLI response must not turn in-flight preparation into a second take.
    const key = request.operation === 'task_take' && request.operation_id;
    const capability = key ? this.#profileCapability(this.getCapabilityProfile(), request.operation, { serviceId: request.service_id, capabilityId: request.capability_id }) : null;
    if (key && !capability) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Task take capability is not available for this request');
    const fingerprint = key ? stableStringify({ capability: capability.id, payload: request.payload ?? {} }) : null;
    if (key && this.pendingTake?.operation_id === key) {
      const pending = this.pendingTake;
      if (pending.token !== this.token) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot credentials changed before retry');
      if (pending.fingerprint !== fingerprint) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'take request ID was reused with another payload');
      if (this.taskService.getBot?.(this.actorRef)) this.taskService.assertBotDeadline(this.actorRef);
      const result = await pending.promise;
      if (pending.token !== this.token) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot credentials changed before retry completed');
      return structuredClone(result);
    }
    const promise = this.#call(request);
    if (!key || this.pendingTake) return promise;
    const pending = { operation_id: key, token: this.token, fingerprint, promise };
    this.pendingTake = pending;
    try { return await promise; }
    finally { if (this.pendingTake === pending) this.pendingTake = null; }
  }

  async #call({ operation, payload = {}, operation_id: operationId = null, service_id: serviceId = null, capability_id: capabilityId = null }: any = {}) {
    if (this.bindingPending) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Task contribution binding is still being prepared');
    const identityToken = this.token;
    const assertIdentity = (beforeDispatch: any = false) => {
      if (this.stopping) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bridge is stopping');
      if (this.bindingPending) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Task contribution binding is still being prepared');
      if (this.token !== identityToken) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot credentials changed before dispatch');
      const bot = beforeDispatch ? this.taskService.getBot?.(this.actorRef) : null;
      if (bot && !['bot_exit', 'task_finish'].includes(operation)) this.taskService.assertBotDeadline(this.actorRef);
      if (bot && !['UNBOUND', 'ACTIVE'].includes(bot.state) && !['bot_exit', 'task_finish'].includes(operation)) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot stopped before dispatch');
      }
    };
    const bridgeOperationId = operationId ?? `bridge:${operation}:${randomUUID()}`;
    const bridgeCallId = randomUUID();
    const log = (event: any) => this.logger?.append({ ...event, operation_id: bridgeOperationId, bridge_call_id: bridgeCallId });
    log({ event: 'bridge.start', operation, operation_id: bridgeOperationId, task_id: this.taskId, execution_id: this.executionId, payload });
    try {
      const profile = this.getCapabilityProfile();
      const capability = this.#profileCapability(profile, operation, { serviceId, capabilityId });
      if (!capability) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `Agent capability is not available for this Session: ${operation}`, {
        operation,
        role: this.role,
        profile_hash: profile.profile_hash,
        action: 'call_list_tools_or_get_service_metadata',
        available_capabilities: profile.capabilities.map((candidate: any) => candidate.tool_name ?? candidate.name),
      });
      if (capability.operation === 'task_create' && capability.service_id === 'task') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot Task creation is not supported');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'bridge payload must be an object', {
          operation,
          expected: 'object',
          action: 'retry_with_the_registered_input_schema',
        });
      }
      const boundTask = this.taskId ? this.taskService.getTask(this.taskId) : null;
      const bot = this.taskService.getBot?.(this.actorRef);
      if (bot && !['bot_exit', 'task_finish', 'mission_submission_get'].includes(operation)) {
        const execution = bot.execution_id && this.taskService.getExecution(bot.execution_id);
        if (execution && (Date.parse(bot.hard_deadline) <= Date.now() || Date.parse(execution.execution_deadline) <= Date.now() ||
            (['CLOSING', 'CLOSED'].includes(bot.state) && !this.taskService.getExecutionFinish(execution.execution_id)))) {
          throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot contribution is closed', { phase: 'hard_stop' });
        }
        if (bot.state === 'UNBOUND' && Date.parse(bot.selection_deadline) <= Date.now()) {
          throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot selection deadline elapsed', { phase: 'selection_budget' });
        }
      }
      if (bot && !['bot_exit', 'task_finish'].includes(operation)) this.taskService.assertBotDeadline(this.actorRef);
      if (bot && !['UNBOUND', 'ACTIVE'].includes(bot.state) && !['bot_exit', 'task_finish'].includes(operation)) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bot is not authorized to contribute in its current state', { bot_state: bot.state });
      }
      // Scope is established by Runtime's durable Bot binding, never by CLI
      // flags. Only add fields supported by each public request schema.
      if (bot) {
        if (['workspace_save', 'workspace_status', 'workspace_current_diff'].includes(operation)) {
          assertIdentity(true);
          const execution = this.executionId && this.taskService.getExecution(this.executionId);
          if (!execution) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Workspace operation requires an active E');
          const result = await this.runtime.dispatchExecutionWorkspace((({ workspace_save: 'save', workspace_status: 'status', workspace_current_diff: 'diff' } as Record<string, any>))[operation], payload,
            { actorRef: this.actorRef, taskId: this.taskId, executionId: this.executionId, fencingVersion: execution.fencing_version, requestId: bridgeOperationId });
          log({ event: 'bridge.complete', operation, operation_id: bridgeOperationId, ok: true, result });
          return { ...result, request_id: bridgeOperationId };
        }
        if (operation === 'workspace_merge') {
          const execution = this.executionId && this.taskService.getExecution(this.executionId);
          if (!this.workspaceMerge) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Workspace merge is not enabled');
          const result = await this.workspaceMerge.merge(payload, { actorRef: this.actorRef, taskId: this.taskId, executionId: this.executionId, fencingVersion: execution?.fencing_version, requestId: bridgeOperationId });
          assertIdentity();
          log({ event: 'bridge.complete', operation, operation_id: bridgeOperationId, ok: true, result });
          return { ...result, request_id: bridgeOperationId };
        }
        if (operation === 'mission_submit') {
          if (Object.keys(payload).some((key: any) => key !== 'material_ids') || !Array.isArray(payload.material_ids)) {
            throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Mission submit accepts only an explicit material_ids selection');
          }
          const result = await this.missionSubmission.submit({ missionId: bot.mission_id,
            actorRef: bot.bot_id, taskId: this.taskId ?? null, executionId: this.executionId ?? null,
            materialIds: payload.material_ids, requestId: bridgeOperationId,
            fencingVersion: this.executionId ? this.taskService.getExecution(this.executionId)?.fencing_version : null });
          const observed = await this.missionSubmission.describe({ missionId: bot.mission_id, submissionId: result.submission_id });
          assertIdentity();
          log({ event: 'bridge.complete', operation, ok: true, result: observed ?? result });
          return observed ?? result;
        }
        if (payload.mission_id !== undefined && payload.mission_id !== bot.mission_id) {
          throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'request must stay within the Bot Mission');
        }
        if (operation === 'mission_submission_get') {
          const result = await this.missionSubmission.describe({ missionId: bot.mission_id, submissionId: payload.submission_id ?? null });
          assertIdentity();
          log({ event: 'bridge.complete', operation, ok: true, result });
          return result;
        }
        if (['mission_get', 'mission_submit', 'mission_submission_get', 'task_list', 'task_status', 'read_materials', 'context_search_materials'].includes(operation)) {
          payload = { ...payload, mission_id: bot.mission_id };
        }
        if (['task_view', 'task_take', 'task_revise', 'task_cancel', 'task_dependency_replace'].includes(operation) && payload.task_id !== undefined) {
          const target = this.taskService.getTask(payload.task_id);
          if (!target || target.mission_id !== bot.mission_id) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Task is not readable in the Bot Mission');
        }
        if (operation === 'context_get_material') {
          const target = this.contextService.getMaterial(payload.material_id);
          if (!target || target.mission_id !== bot.mission_id) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Material is not readable in the Bot Mission');
        }
        if (Object.hasOwn(MISSION_WORKSPACE_READS, operation)) {
          const workspaceId = this.runtime?.missionWorkspaceId;
          if (!workspaceId || (payload.workspace_id !== undefined && payload.workspace_id !== workspaceId)) {
            throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Workspace must match the configured Mission Workspace');
          }
          const workspace = await this.runtime.missionWorkspace.get({ workspaceId, signal: this.publicReadAbortController.signal });
          assertIdentity(true);
          if (workspace.mission_id !== bot.mission_id) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Workspace belongs to another Mission');
          payload = { ...payload, workspace_id: workspaceId };
        }
      }
      if (operation === 'task_take' && this.acceptedTake?.operation_id === bridgeOperationId) {
        if (this.acceptedTake.fingerprint !== stableStringify({ capability: capability.id, payload })) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'take request ID was reused with another payload');
        log({ event: 'bridge.complete', operation, operation_id: bridgeOperationId, ok: true, replayed: true, result: this.acceptedTake.result });
        return structuredClone(this.acceptedTake.result);
      }
      if (operation === 'bot_exit') {
        return this.taskService.dispatch('bot_exit', payload, makeEnvelope({ actorRef: this.actorRef, operationId: bridgeOperationId }));
      }
      const boundTaskScope = boundTask?.mission_id ? boundTask : null;
      const isCatalogDiscovery = capability.service_id === 'catalog' && ['list_services', 'get_service_metadata', 'list_tools'].includes(operation);
      const isTaskDiscovery = capability.service_id === 'task' && ['task_list', 'task_view', 'task_status'].includes(operation);
      if (isCatalogDiscovery || isTaskDiscovery) {
        const discoveryPayload = operation === 'task_status' && payload.mission_id === undefined && boundTaskScope?.mission_id
          ? { ...payload, mission_id: boundTaskScope.mission_id }
          : (operation === 'task_view' && payload.task_id === undefined && this.taskId
            ? { ...payload, task_id: this.taskId }
            : payload);
        const result = await this.#invokeRegistered(capability, discoveryPayload, bridgeOperationId);
        log({ event: 'bridge.complete', operation, ok: true, result });
        return result;
      }
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
          // actor; only the selected Task comes from the
          // request.
          ...Object.fromEntries(Object.entries(payload).filter(([key]: any) => !['owner_ref', 'agent_prompt', 'initial_prompt'].includes(key))),
          owner_ref: this.actorRef,
          agent_prompt: this.agentPrompt,
          // The lane is authenticated runtime state, never a model choice.
          core_id: this.coreId ?? currentExecution?.core_id ?? null,
        }
        : payload;
      const invoke = async () => {
        assertIdentity(true);
        if (operation === 'task_take') this.lastTakeOutcome = { attempted: true, ok: false, task_id: invocationPayload.task_id ?? null };
        let registeredPayload = invocationPayload;
        if (operation === 'workspace_check') {
          if (!bot) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Workspace checks require a registered Bot');
          const identity = { actorRef: this.actorRef, taskId: this.taskId, executionId: this.executionId, fencingVersion: currentExecution?.fencing_version };
          const source: any = await prepareWorkspaceCheckSource(payload, { workspace: this.runtime.missionWorkspace,
            workspaceId: this.runtime.missionWorkspaceId, projectCheck: this.runtime.workspaceProjectCheck,
            guard: () => this.runtime.assertExecutionWorkspace(identity) });
          if (['lean-project', 'lean-module'].includes(source.check_mode)) {
            assertIdentity(true);
            return this.#invokeRegistered(capability, { source, request_key: payload.request_key ?? bridgeOperationId }, bridgeOperationId);
          }
          registeredPayload = {
            source,
            request_key: payload.request_key ?? bridgeOperationId,
            source_attestation: {
              task_id: this.taskId,
              execution_id: this.executionId,
              path: source.path,
              revision: source.revision,
              workspace_revision: source.workspace_revision,
              workspace_id: source.workspace_id,
              content_hash: source.content_hash,
            },
          };
        }
        assertIdentity(true);
        return this.#invokeRegistered(capability, registeredPayload, bridgeOperationId);
      };
      let result = await invoke();
      assertIdentity();
      if (bot && ['workspace_check', 'get_check_result'].includes(operation) && result) {
        const target = this.taskService.getTask(result.target_task_id);
        if (!target || target.mission_id !== bot.mission_id) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Judge result is not readable in the Bot Mission');
        result = agentCheckResult(result);
      }
      if (operation === 'task_take') {
        await this.bindTake(result);
        this.acceptedTake = { operation_id: bridgeOperationId, fingerprint: stableStringify({ capability: capability.id, payload }), result: structuredClone(result) };
        this.lastTakeOutcome = { attempted: true, ok: true, task_id: result.task.task_id, execution_id: result.execution.execution_id };
      }
      if (operation === 'task_finish') {
        const finish = result.disposition === 'closing'
          ? { request_id: bridgeOperationId, notice: `结束请求 ${bridgeOperationId} 已持久受理，E ${result.execution.execution_id} 正在 closing。不得再 save/publish；Runtime 停止全部进程，连接可能断开。` } : {};
        result = await this.#afterAcceptedFinish(result);
        result = { ...result, ...finish };
        log({ event: 'bridge.complete', operation, service_id: capability.service_id, ok: true, result });
        return result;
      }
      log({ event: 'bridge.complete', operation, service_id: capability.service_id, ok: true, result });
      return result;
    } catch (error: any) {
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
      log({
        event: 'bridge.complete',
        operation,
        ok: false,
        error: { name: error.name, code: error.code, message: error.message },
      });
      throw error;
    }
  }
}
