import Ajv from 'ajv';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';

const IDENTIFIER = /^[a-z][a-z0-9_-]*$/;
const registryEntries = new WeakMap();
const validators = new WeakMap();
const adapterMetadata = new WeakMap();
const adapterPrivateValues = new WeakMap();

/** Register host authentication material with the private trace redactor. */
export function registerServicePrivateValues(registrations, register) {
  for (const { adapter } of registrations.values()) register(adapterPrivateValues.get(adapter) ?? []);
}

/** Internal non-credential effective adapter configuration for run evidence. */
export function getAdapterMetadata(adapter) { return adapterMetadata.get(adapter); }

export function isJson(value, seen = new Set(), depth = 0) {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || seen.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) return false;
  seen.add(value);
  const valid = Object.values(value).every(item => isJson(item, seen, depth + 1));
  seen.delete(value);
  return valid;
}

function compile(manifest) {
  const ajv = new Ajv({ strict: true, coerceTypes: false, useDefaults: false, removeAdditional: false, ownProperties: true, addUsedSchema: false });
  return new Map(manifest.capabilities.map(capability => {
    const input = ajv.compile(capability.input_schema);
    const output = ajv.compile(capability.output_schema);
    if (input.$async || output.$async) invalid('Asynchronous Service schemas are unsupported');
    return [capability.operation, { input, output }];
  }));
}

function invalid(message) {
  throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, message);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function validateManifest(input, builtin = false) {
  if (!record(input) || !isJson(input) || typeof input.id !== 'string' || !IDENTIFIER.test(input.id) || (input.id === 'bot' && !builtin)) {
    invalid('Service id must be a valid identifier and bot is reserved');
  }
  if (![input.title, input.purpose, input.provider_version].every(nonempty) || input.contract_version !== '2') {
    invalid('Service requires title, purpose, provider_version and contract_version 2');
  }
  if (!record(input.endpoint) || !['in-process', 'http-json'].includes(input.endpoint.transport)) {
    invalid('Service endpoint transport must be in-process or http-json');
  }
  if (input.endpoint.transport === 'http-json') {
    let url;
    try { url = new URL(input.endpoint.url); } catch { invalid('HTTP Service endpoint requires a valid URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
      invalid('HTTP Service endpoint must use HTTP(S) without embedded credentials or fragment');
    }
  }
  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) {
    invalid('Service requires at least one capability');
  }
  const names = new Set();
  const operations = new Set();
  for (const capability of input.capabilities) {
    if (!record(capability) || typeof capability.name !== 'string' || !IDENTIFIER.test(capability.name) || typeof capability.operation !== 'string' || !IDENTIFIER.test(capability.operation) ||
        !nonempty(capability.description) || !['read', 'write'].includes(capability.side_effect) ||
        typeof capability.idempotent !== 'boolean' || !record(capability.help) || !nonempty(capability.help.when) ||
        !record(capability.input_schema) || !record(capability.output_schema) || !Array.isArray(capability.errors)) {
      invalid('Service capability requires valid identity, help, schemas, effect, idempotency and errors');
    }
    if (capability.timeout_ms !== undefined && (!Number.isSafeInteger(capability.timeout_ms) || capability.timeout_ms < 1 || capability.timeout_ms > 86_400_000)) invalid('Service timeout_ms must be between 1 and 86400000');
    if (capability.help.ref !== undefined && !nonempty(capability.help.ref)) invalid('Service help ref must be nonempty');
    if (capability.path !== undefined && (typeof capability.path !== 'string' || !capability.path.startsWith('/') ||
        capability.path.includes('..') || capability.path.startsWith('//') || /[?#\\]/.test(capability.path))) invalid('Service capability path must be a relative HTTP route');
    if (capability.errors.some(error => !record(error) || !nonempty(error.code) || typeof error.retryable !== 'boolean')) {
      invalid('Service errors require code and retryable');
    }
    if (names.has(capability.name) || operations.has(capability.operation)) invalid('Service capability names and operations must be unique');
    names.add(capability.name);
    operations.add(capability.operation);
  }
  try { return freeze(structuredClone(input)); } catch { invalid('Service manifest must contain cloneable data'); }
}

export class ServiceRegistry {
  constructor() {
    registryEntries.set(this, new Map());
  }

  registerService({ manifest, adapter } = {}) {
    const snapshot = validateManifest(manifest);
    try { validators.set(snapshot, compile(snapshot)); } catch { invalid('Service schemas must compile as strict synchronous JSON Schema draft-07 without remote resolution'); }
    if (!adapter || typeof adapter.invoke !== 'function') invalid('Service adapter requires invoke(request)');
    if (registryEntries.get(this).has(snapshot.id)) {
      throw new SwarmEnvError(ERROR_CODES.CONFLICT, `Service is already registered: ${snapshot.id}`);
    }
    registryEntries.get(this).set(snapshot.id, Object.freeze({ manifest: snapshot, adapter }));
  }

}

// Internal Core assembly only; the public registry continues to reject bot.
export function builtinBotRegistration(manifest, adapter) {
  if (manifest.id !== 'bot') invalid('Built-in registration must be bot');
  const snapshot = validateManifest(manifest, true);
  validators.set(snapshot, compile(snapshot));
  return Object.freeze({ manifest: snapshot, adapter: Object.freeze(adapter) });
}

export function createInProcessAdapter(implementation) {
  if (!implementation || typeof implementation.invoke !== 'function') invalid('In-process Service requires invoke(request)');
  if (implementation.exportState !== undefined && typeof implementation.exportState !== 'function') invalid('Service exportState must be a function');
  return Object.freeze({ invoke: implementation.invoke.bind(implementation),
    ...(implementation.exportState ? { exportState: implementation.exportState.bind(implementation) } : {}) });
}

export function snapshotServiceRegistry(services) {
  if (!registryEntries.has(services)) invalid('services must be a ServiceRegistry');
  return new Map([...registryEntries.get(services)].map(([id, registration]) => {
    const { manifest, adapter } = registration;
    if (typeof adapter.invoke !== 'function') invalid('Service adapter requires invoke(request)');
    if (adapter.exportState !== undefined && typeof adapter.exportState !== 'function') invalid('Service exportState must be a function');
    const captured = Object.freeze({ invoke: adapter.invoke.bind(adapter),
      ...(adapter.exportState ? { exportState: adapter.exportState.bind(adapter) } : {}) });
    const metadata = getAdapterMetadata(adapter);
    if (metadata) adapterMetadata.set(captured, metadata);
    const privateValues = adapterPrivateValues.get(adapter);
    if (privateValues) adapterPrivateValues.set(captured, privateValues);
    return [id, Object.freeze({ manifest, adapter: captured })];
  }));
}

// One invocation only. Service business logic owns idempotency and retries.
export async function invokeService(registration, { operation, input, envelope, caller, signal, recordService, assertAuthorized }, timeoutMs = 30_000) {
  const { manifest, adapter } = registration;
  const capability = manifest.capabilities.find(item => item.operation === operation);
  const identity = { service_id: manifest.id, operation, operation_id: envelope.operation_id };
  const record = (state, outcome, error) => recordService?.({ runtimeId: caller.runtimeId, botId: caller.botId, profile: caller.profile,
    serviceId: manifest.id, operation, operationId: envelope.operation_id, state, outcome, ...(error ? { error } : {}) });
  record('validation', 'pending');
  if (!capability) {
    record('validation', 'not_executed', { code: 'NOT_FOUND', retryable: false });
    throw new SwarmEnvError('NOT_FOUND', 'Service operation is not registered', identity);
  }
  const rules = validators.get(manifest).get(operation);
  if (!isJson(input) || !rules.input(input)) {
    record('validation', 'not_executed', { code: 'SERVICE_INPUT_INVALID', retryable: false });
    throw new SwarmEnvError('SERVICE_INPUT_INVALID', 'Service input violates its schema', { ...identity, request_outcome: 'not_executed' });
  }
  record('validation', 'passed');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  let timer;
  let invoked = false;
  try {
    if (controller.signal.aborted) throw new SwarmEnvError('NOT_ALLOWED', 'Service caller has closed', identity);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { reject(new SwarmEnvError('SERVICE_TIMEOUT', 'Service invocation timed out', { ...identity, request_outcome: 'unknown' })); controller.abort(); }, capability.timeout_ms ?? timeoutMs);
      controller.signal.addEventListener('abort', () => reject(new SwarmEnvError('SERVICE_UNAVAILABLE', 'Service invocation was aborted', { ...identity, request_outcome: 'unknown' })), { once: true });
    });
    invoked = true;
    record('invocation', 'pending');
    const result = await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return adapter.invoke({ manifest, capability, input: structuredClone(input), envelope: Object.freeze({ operation_id: envelope.operation_id }), caller: Object.freeze({ ...caller }), signal: controller.signal,
        assertAuthorized: () => { if(controller.signal.aborted) throw new SwarmEnvError('NOT_ALLOWED','Service caller authority was revoked'); assertAuthorized?.(); } });
    }), timeout]);
    if (!isJson(result) || !rules.output(result)) throw new SwarmEnvError('SERVICE_OUTPUT_INVALID', 'Service output violates its schema', { ...identity, request_outcome: capability.side_effect === 'write' ? 'unknown' : 'invalid_output' });
    record('settled', 'succeeded');
    return result;
  } catch (error) {
    const knownCode = ['NOT_ALLOWED', 'SERVICE_INPUT_INVALID', 'SERVICE_OUTPUT_INVALID', 'SERVICE_TIMEOUT', 'SERVICE_UNAVAILABLE'].includes(error?.code)
      || capability.errors.some(item => item.code === error?.code);
    record('settled', !invoked ? 'not_executed' : error?.details?.request_outcome === 'invalid_output' ? 'invalid_output' : 'unknown',
      { code: knownCode ? error.code : 'SERVICE_UNAVAILABLE', retryable: capability.errors.find(item => item.code === error?.code)?.retryable ?? false });
    if (error instanceof SwarmEnvError) { error.details = { ...error.details, ...identity }; throw error; }
    const declared = capability.errors.find(item => item.code === error?.code);
    if (declared) throw new SwarmEnvError(declared.code, error.message ?? 'Service operation failed', identity, { retryable: declared.retryable });
    throw new SwarmEnvError('SERVICE_UNAVAILABLE', 'Service invocation failed', { ...identity, request_outcome: 'unknown' });
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

/** Host-configured HTTP adapter. Its credential never enters Bot environments. */
export function createHttpJsonAdapter({ token, timeoutMs = 30_000, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000 ||
      (token !== undefined && (typeof token !== 'string' || !token))) invalid('HTTP adapter requires a bounded timeout, fetch and optional host token');
  const adapter = Object.freeze({ async invoke({ manifest, capability, input, envelope, caller, signal }) {
    if (manifest.endpoint.transport !== 'http-json') invalid('HTTP adapter requires an HTTP Service endpoint');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const base = manifest.endpoint.url.replace(/\/$/, '');
      const response = await fetchImpl(base + (capability.path ?? `/v2/${capability.operation}`), {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': envelope.operation_id,
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
        body: JSON.stringify({ input, envelope, caller }),
      });
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body ?? []) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) throw new Error('Response body limit');
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new SwarmEnvError('SERVICE_UNAVAILABLE', 'HTTP Service returned invalid JSON'); }
      if (!response.ok || body?.ok !== true) {
        const code = response.status === 401 || response.status === 403 ? 'NOT_ALLOWED' : response.status === 504 ? 'SERVICE_TIMEOUT' : 'SERVICE_UNAVAILABLE';
        throw new SwarmEnvError(body?.error?.code ?? code, body?.error?.message ?? 'HTTP Service invocation failed', { request_outcome: 'unknown' });
      }
      return body.result;
    } catch (error) {
      if (signal?.aborted) throw new SwarmEnvError('SERVICE_UNAVAILABLE', 'HTTP Service invocation was cancelled', { request_outcome: 'unknown' });
      if (controller.signal.aborted) throw new SwarmEnvError('SERVICE_TIMEOUT', 'HTTP Service invocation timed out', { request_outcome: 'unknown' });
      if (error instanceof SwarmEnvError) throw error;
      throw new SwarmEnvError('SERVICE_UNAVAILABLE', 'HTTP Service is unavailable', { request_outcome: 'unknown' });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  } });
  adapterMetadata.set(adapter, Object.freeze({ transport: 'http-json', timeoutMs }));
  if (token !== undefined) adapterPrivateValues.set(adapter, [token]);
  return adapter;
}
