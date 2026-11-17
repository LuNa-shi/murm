import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { makeEnvelope } from '../protocol/envelope.js';

function required(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} is required`);
  return value;
}

function safeDiagnostic(value) {
  return String(value ?? '').replace(/(?:bearer\s+|api[-_]?key\s*[=:]\s*)[^\s,;]+/ig, '[redacted]').slice(0, 2_000);
}

/**
 * Synchronous domain seam used only inside legacy synchronous service
 * handlers. It keeps Task/Context's existing transaction-facing methods
 * usable while the owning process crosses an HTTP boundary. The shell client
 * is argv-based, bounded, and never invokes a shell string.
 */
export class HttpDomainProxy {
  constructor({ serviceId, url, token = null, actorRef = `service:${serviceId}`, timeoutMs = 15_000, curlCommand = 'curl', spawnSyncImpl = spawnSync } = {}) {
    this.serviceId = required(serviceId, 'serviceId');
    this.url = required(url, 'url').replace(/\/$/, '');
    this.token = token;
    this.actorRef = required(actorRef, 'actorRef');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new TypeError('timeoutMs must be between 1 and 120000');
    this.timeoutMs = timeoutMs;
    this.curlCommand = required(curlCommand, 'curlCommand');
    if (typeof spawnSyncImpl !== 'function') throw new TypeError('spawnSyncImpl must be a function');
    this.spawnSync = spawnSyncImpl;
  }

  dispatch(operation, input = {}, envelope = null, { role = 'recovery' } = {}) {
    const requestEnvelope = envelope?.operation_id && envelope?.actor_ref
      ? envelope
      : makeEnvelope({ operationId: `proxy:${this.serviceId}:${operation}:${randomUUID()}`, actorRef: this.actorRef });
    if (requestEnvelope.actor_ref !== this.actorRef) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'A domain peer credential cannot relay another actor identity');
    }
    const body = JSON.stringify({ envelope: requestEnvelope, input, role });
    const args = ['--disable', '--silent', '--show-error', '--max-time', String(Math.ceil(this.timeoutMs / 1000)), '--request', 'POST', `${this.url}/v1/${operation}`, '--header', 'accept: application/json', '--header', 'content-type: application/json', '--header', `idempotency-key: ${requestEnvelope.operation_id}`, '--data-binary', '@-', '--write-out', '\n%{http_code}'];
    if (this.token) args.splice(args.length - 4, 0, '--header', `authorization: Bearer ${this.token}`);
    const result = this.spawnSync(this.curlCommand, args, { input: body, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: this.timeoutMs + 2_000 });
    if (result.error) throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, `HTTP ${this.serviceId} proxy failed: ${result.error.message}`, { service_id: this.serviceId }, { cause: result.error, retryable: true });
    const output = String(result.stdout ?? '');
    const marker = output.lastIndexOf('\n');
    const status = Number.parseInt(output.slice(marker + 1).trim(), 10);
    const payloadText = marker < 0 ? output : output.slice(0, marker);
    let payload = {};
    try { payload = payloadText ? JSON.parse(payloadText) : {}; } catch (error) {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, `HTTP ${this.serviceId} proxy returned invalid JSON`, { service_id: this.serviceId, diagnostic: safeDiagnostic(payloadText) }, { cause: error, retryable: true });
    }
    if (result.status !== 0 || !Number.isInteger(status) || status < 200 || status >= 300 || payload.ok === false) {
      const error = payload.error ?? {};
      throw new SwarmEnvError(error.code ?? (result.status !== 0 || status >= 500 || !status ? ERROR_CODES.SERVICE_UNAVAILABLE : ERROR_CODES.INVALID_CONTRACT), error.message ?? `HTTP ${this.serviceId} proxy returned ${status || result.status}`, { service_id: this.serviceId, diagnostic: safeDiagnostic(error.details ?? error.message) }, { retryable: Boolean(error.retryable) || result.status !== 0 || status >= 500 || !status });
    }
    return payload.result ?? payload;
  }

  getExecution(executionId) { const result = this.dispatch('get_execution', { execution_id: executionId }); return result.execution ?? result; }
  listTaskMaterialIds(taskId) {
    const result = this.dispatch('list_task_materials', { task_id: taskId });
    return (result.links ?? result.materials ?? []).map((link) => link.material_id ?? link.id).filter(Boolean);
  }
  notifyDependencyEvent(event) {
    try {
      return this.dispatch('reconcile_task', { task_id: event.task_id }, { operation_id: `proxy:reconcile:${event.task_id ?? 'all'}:${randomUUID()}`, actor_ref: this.actorRef, task_id: event.task_id ?? null, execution_id: null, spec_version: null, state_version: null }, { role: 'recovery' });
    } catch (error) {
      // Dependency wake is a notification side effect. A committed Material
      // remains authoritative when the Task controller endpoint is briefly
      // unavailable; its normal sweep will observe the fact later.
      if ([ERROR_CODES.SERVICE_UNAVAILABLE, ERROR_CODES.SERVICE_TIMEOUT, ERROR_CODES.SERVICE_CAPABILITY_NOT_FOUND].includes(error?.code)) return null;
      throw error;
    }
  }
  getMaterial(materialId) { return this.dispatch('context_get_material', { material_id: materialId }).material ?? null; }
  readMaterials(filters = {}) { const result = this.dispatch('read_materials', filters); return result.materials ?? result; }
  listMaterialConsumptions(filters = {}) { const result = this.dispatch('list_material_consumptions', filters); return result.consumptions ?? result; }
  publishMaterialForTask(payload, envelope) { return this.dispatch('context_publish_material', payload, envelope, { role: 'recovery' }); }
}

export function createHttpDomainProxy(options = {}) { return new HttpDomainProxy(options); }
