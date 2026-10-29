import { ERROR_CODES, SwarmEnvError } from '../errors.js';

function errorCodeForStatus(status) {
  if (status === 401 || status === 403) return ERROR_CODES.SERVICE_CAPABILITY_NOT_ALLOWED;
  if (status === 408 || status === 504) return ERROR_CODES.SERVICE_TIMEOUT;
  if (status === 409) return ERROR_CODES.CONFLICT;
  if (status >= 500) return ERROR_CODES.SERVICE_UNAVAILABLE;
  return ERROR_CODES.INVALID_CONTRACT;
}

function retryableForStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function joinUrl(base, path) {
  return `${String(base).replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`;
}

async function responseJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch (error) {
    throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, 'service returned invalid JSON', { status: response.status }, { cause: error, retryable: response.status >= 500 });
  }
}

export class HttpJsonServiceAdapter {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 30_000, token = null, logger = null } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('HttpJsonServiceAdapter requires fetch');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.token = token;
    this.logger = logger;
    this.kind = 'http-json';
  }

  async invoke({ manifest, capability, input = {}, envelope, role = null, signal = null } = {}) {
    if (!manifest?.endpoint?.url) throw new SwarmEnvError(ERROR_CODES.SERVICE_MANIFEST_INVALID, 'HTTP adapter requires a manifest endpoint URL');
    if (!capability?.path) throw new SwarmEnvError(ERROR_CODES.SERVICE_MANIFEST_INVALID, 'HTTP adapter requires a capability route');
    const url = joinUrl(manifest.endpoint.url, capability.path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('service request timed out')), this.timeoutMs);
    const onAbort = () => controller.abort(signal.reason ?? new Error('service request aborted'));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      'idempotency-key': envelope?.operation_id ?? '',
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    try {
      this.logger?.({ event: 'service.http.start', service_id: manifest.service_id, capability: capability.name, url });
      const response = await this.fetch(url, {
        method: capability.method ?? 'POST',
        headers,
        body: JSON.stringify({ envelope, input, ...(role ? { role } : {}) }),
        signal: controller.signal,
      });
      const body = await responseJson(response);
      if (!response.ok || body.ok === false) {
        const error = body.error ?? {};
        throw new SwarmEnvError(
          error.code ?? errorCodeForStatus(response.status),
          error.message ?? `service request failed with HTTP ${response.status}`,
          error.details,
          { retryable: error.retryable ?? retryableForStatus(response.status) },
        );
      }
      this.logger?.({ event: 'service.http.complete', service_id: manifest.service_id, capability: capability.name, status: response.status, ok: true });
      return body.result === undefined ? body : body.result;
    } catch (error) {
      if (error instanceof SwarmEnvError) {
        this.logger?.({ event: 'service.http.complete', service_id: manifest.service_id, capability: capability.name, ok: false, code: error.code });
        throw error;
      }
      if (controller.signal.aborted) {
        const timedOut = !signal?.aborted;
        throw new SwarmEnvError(timedOut ? ERROR_CODES.SERVICE_TIMEOUT : ERROR_CODES.SERVICE_UNAVAILABLE, timedOut ? `service request timed out after ${this.timeoutMs}ms` : 'service request aborted', { service_id: manifest.service_id, capability: capability.name }, { cause: error, retryable: timedOut });
      }
      throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, error?.message ?? 'service request failed', { service_id: manifest.service_id, capability: capability.name }, { cause: error, retryable: true });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async health(manifest, { signal = null } = {}) {
    return this.#get(manifest, manifest?.health?.path ?? '/healthz', signal);
  }

  async readiness(manifest, { signal = null } = {}) {
    return this.#get(manifest, manifest?.readiness?.path ?? '/readyz', signal);
  }

  async manifest(manifest, { signal = null } = {}) {
    return this.#get(manifest, '/v1/manifest', signal);
  }

  async #get(manifest, path, signal) {
    if (!manifest?.endpoint?.url) throw new SwarmEnvError(ERROR_CODES.SERVICE_MANIFEST_INVALID, 'HTTP adapter requires a manifest endpoint URL');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('service probe timed out')), this.timeoutMs);
    const onAbort = () => controller.abort(signal.reason ?? new Error('service probe aborted'));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const headers = { accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    try {
      const response = await this.fetch(joinUrl(manifest.endpoint.url, path), { method: 'GET', headers, signal: controller.signal });
      const body = await responseJson(response);
      if (!response.ok || body.ok === false) {
        const error = body.error ?? {};
        throw new SwarmEnvError(error.code ?? errorCodeForStatus(response.status), error.message ?? `service probe failed with HTTP ${response.status}`, error.details, { retryable: error.retryable ?? retryableForStatus(response.status) });
      }
      return body.result === undefined ? body : body.result;
    } catch (error) {
      if (error instanceof SwarmEnvError) throw error;
      if (controller.signal.aborted) throw new SwarmEnvError(ERROR_CODES.SERVICE_TIMEOUT, `service probe timed out after ${this.timeoutMs}ms`, { service_id: manifest.service_id }, { cause: error, retryable: true });
      throw new SwarmEnvError(ERROR_CODES.SERVICE_UNAVAILABLE, error?.message ?? 'service probe failed', { service_id: manifest.service_id }, { cause: error, retryable: true });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

export function createHttpJsonAdapter(options = {}) {
  return new HttpJsonServiceAdapter(options);
}

export class InProcessServiceAdapter {
  constructor({ invoke, health = null, readiness = null } = {}) {
    if (typeof invoke !== 'function') throw new TypeError('InProcessServiceAdapter requires invoke');
    this.invokeHandler = invoke;
    this.healthHandler = health;
    this.readinessHandler = readiness;
    this.kind = 'in-process';
  }

  invoke(request) { return this.invokeHandler(request); }
  health(manifest, options) { return this.healthHandler ? this.healthHandler(manifest, options) : { ok: true, service_id: manifest.service_id }; }
  readiness(manifest, options) { return this.readinessHandler ? this.readinessHandler(manifest, options) : { ok: true, service_id: manifest.service_id }; }
}

export function createInProcessAdapter(options = {}) {
  return new InProcessServiceAdapter(options);
}
