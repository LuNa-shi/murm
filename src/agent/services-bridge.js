import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { ServicesSDK } from '../sdk/services-sdk.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const AGENT_OPERATIONS = new Set([
  'get_task', 'get_execution', 'read_materials', 'publish_material', 'submit_candidate',
  'heartbeat', 'create_child_task', 'request_wait',
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
  constructor({ taskService, contextService, runtime, router, actorRef = 'agent:real', taskId, executionId, host = '127.0.0.1' } = {}) {
    if (!taskService || !contextService || !runtime) throw new TypeError('ServicesBridge requires Task Service, Context Service, and Runtime');
    this.taskService = taskService;
    this.contextService = contextService;
    this.runtime = runtime;
    this.router = router;
    this.actorRef = actorRef;
    this.taskId = taskId;
    this.executionId = executionId;
    this.host = host;
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
    if (!AGENT_OPERATIONS.has(operation)) throw new Error(`Agent operation is not allowed: ${operation}`);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('bridge payload must be an object');
    const execution = this.taskService.getExecution(this.executionId);
    if (!execution) throw new Error(`unknown execution: ${this.executionId}`);
    if (execution.task_id !== this.taskId) throw new Error('bridge execution does not match task');
    if (operation === 'request_wait') {
      return this.runtime.requestWait(this.executionId, payload);
    }
    const service = this.router ?? { dispatch: (name, body, envelope) => {
      if (['get_task', 'get_execution', 'submit_candidate', 'heartbeat', 'create_child_task'].includes(name)) return this.taskService.dispatch(name, body, envelope);
      return this.contextService.dispatch(name, body, envelope);
    } };
    const sdk = new ServicesSDK(service, {
      actorRef: this.actorRef,
      taskId: this.taskId,
      executionId: this.executionId,
      specVersion: execution.spec_version,
      stateVersion: execution.state_version,
      fencingVersion: execution.fencing_version,
    });
    const options = { operationId: operationId ?? `bridge:${operation}:${randomUUID()}` };
    switch (operation) {
      case 'get_task': return sdk.getTask(payload.task_id ?? this.taskId);
      case 'get_execution': return sdk.getExecution(payload.execution_id ?? this.executionId);
      case 'read_materials': return sdk.readMaterials(payload);
      case 'publish_material': return sdk.publishMaterial(payload, options);
      case 'submit_candidate': return sdk.submitCandidate(payload, options);
      case 'heartbeat': return sdk.heartbeat(payload, options);
      case 'create_child_task': return sdk.createChildTask(payload, options);
      default: throw new Error(`unsupported Agent operation: ${operation}`);
    }
  }
}
