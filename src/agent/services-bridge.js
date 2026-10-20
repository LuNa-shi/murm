import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { ServicesSDK } from '../sdk/services-sdk.js';
import { makeEnvelope } from '../protocol/envelope.js';
import { GENERIC_AGENT_PROMPT } from './agent-prompt.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const AGENT_OPERATIONS = new Set([
  'get_task', 'get_execution', 'read_materials', 'publish_material', 'submit_candidate',
  'heartbeat', 'create_child_task', 'request_wait', 'claim', 'claim_next', 'list_tasks', 'list_executions',
  'accept_task', 'request_rework', 'get_check_result',
  'list_services', 'get_service_metadata', 'list_tools', 'scheduler_status', 'get_workspace', 'list_workspace_revisions',
  'list_workspace_files', 'read_workspace_file', 'write_workspace_file', 'workspace_diff',
]);

function json(value) {
  return JSON.stringify(value ?? null);
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

function normalizeWaitCondition(condition, checkpoint = {}) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) return condition;
  if (condition.type) {
    if (condition.type === 'check_result_arrived' && !condition.check_request_key) {
      const checkRequestKey = condition.request_key ?? condition.candidate_material_id ?? checkpoint.candidate_material_id;
      return checkRequestKey ? { ...condition, check_request_key: checkRequestKey } : condition;
    }
    return condition;
  }
  if (condition.kind === 'time') {
    return { type: 'timer', deadline: condition.until ?? condition.deadline };
  }
  if (condition.kind === 'judge_result') {
    return {
      type: 'check_result_arrived',
      check_request_key: condition.check_request_key ?? condition.request_key ?? condition.candidate_material_id ?? checkpoint.candidate_material_id,
    };
  }
  return condition;
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
  constructor({ taskService, contextService, runtime, router, actorRef = 'agent:real', taskId = null, executionId = null, onClaim = null, onClaimAccepted = null, onRelease = null, onWorkspaceWrite = null, onWorkUnit = null, onSubmitCandidate = null, onSchedulerStatus = null, onError = null, host = '127.0.0.1', logger = null, agentPrompt = GENERIC_AGENT_PROMPT } = {}) {
    if (!taskService || !contextService || !runtime) throw new TypeError('ServicesBridge requires Task Service, Context Service, and Runtime');
    this.taskService = taskService;
    this.contextService = contextService;
    this.runtime = runtime;
    this.router = router;
    this.actorRef = actorRef;
    this.taskId = taskId;
    this.executionId = executionId;
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

  async releaseClaim({ result = null } = {}) {
    const released = { taskId: this.taskId, executionId: this.executionId, result };
    this.taskId = null;
    this.executionId = null;
    if (this.onRelease) await this.onRelease(released);
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
    } catch (error) {
      send(response, 400, { ok: false, error: errorBody(error) });
    }
  }

  async call({ operation, payload = {}, operation_id: operationId = null } = {}) {
    this.logger?.append({ event: 'bridge.start', operation, operation_id: operationId, task_id: this.taskId, execution_id: this.executionId, payload });
    try {
      if (!AGENT_OPERATIONS.has(operation)) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `Agent operation is not allowed: ${operation}`, { operation });
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'bridge payload must be an object');
      const service = this.router ?? { dispatch: (name, body, envelope) => {
        if (['get_task', 'get_execution', 'list_tasks', 'list_executions'].includes(name)) return this.taskService.dispatch(name, body, envelope);
        return this.contextService.dispatch(name, body, envelope);
      } };
      const bridgeOperationId = operationId ?? `bridge:${operation}:${randomUUID()}`;
      if (['list_services', 'get_service_metadata', 'list_tools', 'list_tasks', 'list_executions', 'scheduler_status'].includes(operation)) {
        if (operation === 'scheduler_status') {
          const result = await (this.onSchedulerStatus
            ? this.onSchedulerStatus({ ...payload, task_id: payload.task_id ?? this.taskId, execution_id: payload.execution_id ?? this.executionId })
            : this.runtime.getSchedulerStatus({ ...payload, task_id: payload.task_id ?? this.taskId, execution_id: payload.execution_id ?? this.executionId }));
          this.logger?.append({ event: 'bridge.complete', operation, ok: true, result });
          return result;
        }
        const result = service.dispatch(operation, payload, makeEnvelope({
          operationId: bridgeOperationId,
          actorRef: this.actorRef,
        }));
        this.logger?.append({ event: 'bridge.complete', operation, ok: true, result });
        return result;
      }
      if (operation === 'claim') {
        if (this.taskId || this.executionId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'claim is only available to an unbound worker bridge', { task_id: this.taskId, execution_id: this.executionId });
        const taskId = payload.task_id;
        if (typeof taskId !== 'string' || taskId.length === 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'claim requires payload.task_id');
        const task = this.taskService.getTask(taskId);
        if (!task) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown task: ${taskId}`, { task_id: taskId });
        // The bridge is the Agent identity boundary. A model may choose the
        // Task and Workspace lineage, but it cannot claim on behalf of a
        // different owner or replace the reusable startup prompt with
        // task-specific transport data.
        const result = service.dispatch('claim', { ...payload, owner_ref: this.actorRef, agent_prompt: this.agentPrompt }, makeEnvelope({
          operationId: bridgeOperationId,
          actorRef: this.actorRef,
          taskId: task.task_id,
          specVersion: task.spec_version,
          stateVersion: task.state_version,
        }));
        this.taskId = result.task.task_id;
        this.executionId = result.execution.execution_id;
        let handoffRequired = false;
        try {
          await this.onClaimAccepted?.(result);
          if (this.onClaim) {
            await this.onClaim(result);
            handoffRequired = true;
          }
        } catch (error) {
          const claimedExecution = this.taskService.getExecution(result.execution.execution_id);
          if (claimedExecution && ['CREATED', 'RUNNING', 'WAITING'].includes(claimedExecution.state)) {
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
          await this.onRelease?.({ taskId: result.task.task_id, executionId: result.execution.execution_id, result: null });
          throw error;
        }
        const response = handoffRequired
          ? { ...result, handoff_required: true, handoff_instruction: 'Runtime has started the bound Workspace session. Stop this turn and continue work there.' }
          : result;
        this.logger?.append({ event: 'bridge.complete', operation, ok: true, result: response });
        return response;
      }
      if (operation === 'claim_next') {
        if (this.taskId || this.executionId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'claim_next is only available to an unbound worker bridge', { task_id: this.taskId, execution_id: this.executionId });
        const result = this.taskService.dispatch('claim_next', payload, makeEnvelope({
          operationId: operationId ?? `bridge:claim_next:${randomUUID()}`,
          actorRef: this.actorRef,
        }));
        this.logger?.append({ event: 'bridge.complete', operation, ok: true, result });
        return result;
      }
      if (!this.taskId || !this.executionId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `${operation} requires a claimed Task and Execution`, { operation });
      const execution = this.taskService.getExecution(this.executionId);
      if (!execution) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unknown execution: ${this.executionId}`, { execution_id: this.executionId });
      if (execution.task_id !== this.taskId) throw new SwarmEnvError(ERROR_CODES.FENCED, 'bridge execution does not match task', { task_id: this.taskId, execution_id: this.executionId });
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
        const released = { taskId: this.taskId, executionId: this.executionId, result };
        this.taskId = null;
        this.executionId = null;
        if (this.onRelease) await this.onRelease(released);
        await this.onWorkUnit?.({ operation, taskId: released.taskId, executionId: released.executionId, payload, result });
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
        case 'publish_material': result = sdk.publishMaterial(payload, options); break;
        case 'submit_candidate':
          result = sdk.submitCandidate(payload, options);
          if (this.onSubmitCandidate) result = { ...result, ...(await this.onSubmitCandidate({ taskId: this.taskId, executionId: this.executionId, payload, result })) };
          break;
        case 'heartbeat': result = sdk.heartbeat(payload, options); break;
        case 'create_child_task': result = sdk.createChildTask(payload, options); break;
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
        await this.onWorkspaceWrite({ taskId: this.taskId, executionId: this.executionId, result });
      }
      if (this.onWorkUnit && ['publish_material', 'create_child_task', 'accept_task', 'request_rework', 'submit_candidate'].includes(operation)) {
        await this.onWorkUnit({ operation, taskId: this.taskId, executionId: this.executionId, payload, result });
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
