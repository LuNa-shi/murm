import { ERROR_CODES, SwarmEnvError } from '../errors.js';

const IDENTIFIER = /^[a-z][a-z0-9_-]*$/;
const registryEntries = new WeakMap();

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

function validateManifest(input) {
  if (!record(input) || !IDENTIFIER.test(input.id) || input.id === 'bot') {
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
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
      invalid('HTTP Service endpoint must use HTTP(S) without embedded credentials or fragment');
    }
  }
  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) {
    invalid('Service requires at least one capability');
  }
  const names = new Set();
  const operations = new Set();
  for (const capability of input.capabilities) {
    if (!record(capability) || !IDENTIFIER.test(capability.name) || !IDENTIFIER.test(capability.operation) ||
        !nonempty(capability.description) || !['read', 'write'].includes(capability.side_effect) ||
        typeof capability.idempotent !== 'boolean' || !record(capability.help) || !nonempty(capability.help.when) ||
        !record(capability.input_schema) || !record(capability.output_schema) || !Array.isArray(capability.errors)) {
      invalid('Service capability requires valid identity, help, schemas, effect, idempotency and errors');
    }
    if (capability.help.ref !== undefined && !nonempty(capability.help.ref)) invalid('Service help ref must be nonempty');
    if (capability.path !== undefined && (typeof capability.path !== 'string' || !capability.path.startsWith('/') ||
        capability.path.includes('..') || capability.path.startsWith('//'))) invalid('Service capability path must be a relative HTTP route');
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
    if (!adapter || typeof adapter.invoke !== 'function') invalid('Service adapter requires invoke(request)');
    if (registryEntries.get(this).has(snapshot.id)) {
      throw new SwarmEnvError(ERROR_CODES.CONFLICT, `Service is already registered: ${snapshot.id}`);
    }
    registryEntries.get(this).set(snapshot.id, Object.freeze({ manifest: snapshot, adapter }));
  }

}

export function createInProcessAdapter(implementation) {
  if (!implementation || typeof implementation.invoke !== 'function') invalid('In-process Service requires invoke(request)');
  return Object.freeze({ invoke: implementation.invoke.bind(implementation) });
}

export function snapshotServiceRegistry(services) {
  if (!registryEntries.has(services)) invalid('services must be a ServiceRegistry');
  return new Map(registryEntries.get(services));
}
