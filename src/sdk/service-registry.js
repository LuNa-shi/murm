import { createServiceManifest, manifestSnapshot, SERVICE_ROLES, stableHash } from './service-manifest.js';
import { createHttpJsonAdapter } from './service-adapter.js';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';

function clone(value) {
  return structuredClone(value);
}

function roleName(role) {
  if (!SERVICE_ROLES.includes(role)) throw new SwarmEnvError(ERROR_CODES.SERVICE_CAPABILITY_NOT_ALLOWED, `unsupported Agent role: ${role}`, { role, supported: SERVICE_ROLES });
  return role;
}

function capabilityView(manifest, capability) {
  const capabilityId = `${manifest.service_id}.${capability.name}`;
  return {
    id: capabilityId,
    capability_id: capabilityId,
    service_id: manifest.service_id,
    service_title: manifest.title,
    service_purpose: manifest.purpose,
    provider_version: manifest.provider_version,
    contract_version: manifest.contract_version,
    manifest_hash: manifest.manifest_hash,
    name: capability.name,
    operation: capability.operation,
    description: capability.description,
    input_schema: clone(capability.input_schema),
    output_schema: clone(capability.output_schema),
    audience: [...capability.audience],
    side_effect: capability.side_effect,
    scope: capability.scope ?? null,
    idempotent: capability.idempotent,
    context: [...capability.context],
    help: clone(capability.help),
    method: capability.method,
    path: capability.path,
    errors: clone(capability.errors),
  };
}

const RESERVED_SERVICE_IDS = new Set(['runtime', 'workspace', 'execution', 'task', 'context', 'judge', 'catalog']);

export class ServiceRegistry {
  constructor({ adapters = [], logger = null, requiredContractVersion = null } = {}) {
    this.adapters = new Map();
    this.services = new Map();
    this.logger = logger;
    this.requiredContractVersion = requiredContractVersion;
    for (const entry of adapters) {
      if (entry?.service_id && entry.adapter) this.adapters.set(entry.service_id, entry.adapter);
    }
  }

  registerService({ manifest, adapter = null, trusted = false } = {}) {
    const normalized = createServiceManifest(manifest);
    if (this.services.has(normalized.service_id)) throw new SwarmEnvError(ERROR_CODES.SERVICE_ALREADY_REGISTERED, `service is already registered: ${normalized.service_id}`, { service_id: normalized.service_id });
    if (RESERVED_SERVICE_IDS.has(normalized.service_id) && trusted !== true) {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_MANIFEST_INVALID, `service id is reserved for a built-in provider: ${normalized.service_id}`, { service_id: normalized.service_id });
    }
    if (this.requiredContractVersion && normalized.contract_version !== this.requiredContractVersion) {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_VERSION_MISMATCH, `unsupported service contract version: ${normalized.contract_version}`, { service_id: normalized.service_id, expected: this.requiredContractVersion, actual: normalized.contract_version });
    }
    const resolvedAdapter = adapter ?? this.adapters.get(normalized.service_id) ?? (normalized.endpoint.transport === 'http-json' ? createHttpJsonAdapter() : null);
    if (!resolvedAdapter || typeof resolvedAdapter.invoke !== 'function') {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_MANIFEST_INVALID, `service adapter is required: ${normalized.service_id}`, { service_id: normalized.service_id });
    }
    this.services.set(normalized.service_id, { manifest: normalized, adapter: resolvedAdapter, ready: null });
    this.adapters.set(normalized.service_id, resolvedAdapter);
    this.logger?.({ event: 'service.registry.registered', service_id: normalized.service_id, manifest_hash: normalized.manifest_hash });
    return this.getServiceMetadata(normalized.service_id);
  }

  register(input) {
    return this.registerService(input);
  }

  unregisterService(serviceId) {
    if (!this.services.delete(serviceId)) throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_FOUND, `unknown service: ${serviceId}`, { service_id: serviceId });
    this.adapters.delete(serviceId);
  }

  getService(serviceId) {
    const entry = this.services.get(serviceId);
    if (!entry) throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_FOUND, `unknown service: ${serviceId}`, { service_id: serviceId });
    return entry;
  }

  listServices() {
    return [...this.services.values()]
      .sort((a, b) => a.manifest.service_id.localeCompare(b.manifest.service_id))
      .map(({ manifest }) => ({
        id: manifest.service_id,
        service_id: manifest.service_id,
        name: manifest.service_id,
        title: manifest.title,
        description: manifest.purpose,
        purpose: manifest.purpose,
        provider_version: manifest.provider_version,
        contract_version: manifest.contract_version,
        manifest_hash: manifest.manifest_hash,
        metadata: clone(manifest.metadata ?? {}),
        tool_count: manifest.capabilities.length,
      }));
  }

  getServiceMetadata(serviceId) {
    const { manifest } = this.getService(serviceId);
    return {
      ...clone(manifest),
      capabilities: manifest.capabilities.map((capability) => capabilityView(manifest, capability)),
    };
  }

  listTools(serviceId = null) {
    const entries = serviceId === null
      ? [...this.services.values()]
      : [this.getService(serviceId)];
    return entries
      .sort((a, b) => a.manifest.service_id.localeCompare(b.manifest.service_id))
      .flatMap(({ manifest }) => manifest.capabilities.map((capability) => capabilityView(manifest, capability)));
  }

  getCapability(serviceId, capabilityName) {
    const { manifest, adapter } = this.getService(serviceId);
    const capability = manifest.capabilities.find((candidate) => candidate.name === capabilityName || candidate.operation === capabilityName);
    if (!capability) throw new SwarmEnvError(ERROR_CODES.SERVICE_CAPABILITY_NOT_FOUND, `unknown capability: ${serviceId}.${capabilityName}`, { service_id: serviceId, capability: capabilityName });
    return { manifest, capability, adapter };
  }

  getCapabilityById(capabilityId) {
    if (typeof capabilityId !== 'string' || capabilityId.length === 0) {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_CAPABILITY_NOT_FOUND, 'capability_id is required');
    }
    for (const { manifest, adapter } of this.services.values()) {
      const capability = manifest.capabilities.find((candidate) => `${manifest.service_id}.${candidate.name}` === capabilityId);
      if (capability) return { manifest, capability, adapter };
    }
    throw new SwarmEnvError(ERROR_CODES.SERVICE_CAPABILITY_NOT_FOUND, `unknown capability_id: ${capabilityId}`, { capability_id: capabilityId });
  }

  getCapabilityProfile(role, context = {}) {
    const normalizedRole = roleName(role);
    const serviceEntries = [...this.services.values()].sort((a, b) => a.manifest.service_id.localeCompare(b.manifest.service_id));
    const capabilities = serviceEntries.flatMap(({ manifest }) => manifest.capabilities
      .filter((capability) => capability.audience.includes(normalizedRole))
      .map((capability) => capabilityView(manifest, capability)));
    const runtimeCapabilities = Array.isArray(context.runtimeCapabilities)
      ? context.runtimeCapabilities.map((capability) => ({ ...clone(capability), service_id: capability.service_id ?? 'runtime', runtime_owned: true }))
      : [];
    const allCapabilities = [...capabilities, ...runtimeCapabilities].sort((a, b) => `${a.service_id}.${a.name}`.localeCompare(`${b.service_id}.${b.name}`));
    const services = serviceEntries
      .map(({ manifest }) => ({
        service_id: manifest.service_id,
        title: manifest.title,
        purpose: manifest.purpose,
        provider_version: manifest.provider_version,
        contract_version: manifest.contract_version,
        manifest_hash: manifest.manifest_hash,
        capabilities: allCapabilities.filter((capability) => capability.service_id === manifest.service_id),
      }))
      .filter((service) => service.capabilities.length > 0);
    const snapshot = {
      role: normalizedRole,
      task_id: context.task_id ?? context.taskId ?? null,
      execution_id: context.execution_id ?? context.executionId ?? null,
      services,
      capabilities: allCapabilities,
    };
    const profileHash = stableHash(snapshot);
    return Object.freeze({
      ...snapshot,
      profile_version: `registry:${profileHash.slice(0, 16)}`,
      profileVersion: `registry:${profileHash.slice(0, 16)}`,
      profile_hash: profileHash,
      profileHash,
    });
  }

  profile(role, context = {}) {
    return this.getCapabilityProfile(role, context);
  }

  help(serviceId, capabilityName) {
    const { manifest, capability } = this.getCapability(serviceId, capabilityName);
    return {
      service_id: manifest.service_id,
      capability: capability.name,
      title: manifest.title,
      purpose: manifest.purpose,
      description: capability.description,
      help: clone(capability.help),
      input_schema: clone(capability.input_schema),
      output_schema: clone(capability.output_schema),
      errors: clone(capability.errors),
    };
  }

  invokeSync({ serviceId, service_id: serviceIdAlias, capability, capability_id: capabilityId, operation, input = {}, payload, envelope, role = null, signal = null } = {}) {
    const id = serviceId ?? serviceIdAlias;
    const name = capability ?? operation;
    const entry = capabilityId
      ? this.getCapabilityById(capabilityId)
      : this.getCapability(id, name);
    if (role !== null && !entry.capability.audience.includes(roleName(role))) {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_CAPABILITY_NOT_ALLOWED, `capability ${id}.${name} is not available to role ${role}`, { service_id: id, capability: name, role });
    }
    if (!envelope || typeof envelope !== 'object') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'service invocation envelope is required');
    return entry.adapter.invoke({ manifest: entry.manifest, capability: entry.capability, input: payload ?? input, envelope, role, signal });
  }

  async invoke(request = {}) {
    return this.invokeSync(request);
  }

  async checkHealth(serviceId, { signal = null } = {}) {
    const entry = this.getService(serviceId);
    if (typeof entry.adapter.health !== 'function') return { ok: true, service_id: serviceId };
    try {
      const result = await entry.adapter.health(entry.manifest, { signal });
      entry.ready = true;
      return result;
    } catch (error) {
      entry.ready = false;
      throw error;
    }
  }

  async checkReadiness(serviceId, { signal = null } = {}) {
    const entry = this.getService(serviceId);
    if (typeof entry.adapter.readiness !== 'function') return { ok: true, service_id: serviceId };
    try {
      const result = await entry.adapter.readiness(entry.manifest, { signal });
      entry.ready = true;
      return result;
    } catch (error) {
      entry.ready = false;
      throw error;
    }
  }

  snapshot() {
    return {
      services: [...this.services.values()]
        .sort((a, b) => a.manifest.service_id.localeCompare(b.manifest.service_id))
        .map(({ manifest }) => manifestSnapshot(manifest)),
    };
  }
}

export function createServiceRegistry(options = {}) {
  return new ServiceRegistry(options);
}
