import { createServiceManifest, manifestSnapshot, SERVICE_ROLES, stableHash } from './service-manifest.js';
import { createHttpJsonAdapter } from './service-adapter.js';
import { resolveBundleDocument } from './service-bundle.js';
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
    requires_binding: capability.requires_binding === true,
    help: clone(capability.help),
    documentation_resource: capability.help?.ref?.startsWith('service://')
      ? capability.help.ref.slice(`service://${manifest.service_id}/`.length)
      : null,
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
    this.revision = 0;
    this.logger = logger;
    this.requiredContractVersion = requiredContractVersion;
    for (const entry of adapters) {
      if (entry?.service_id && entry.adapter) this.adapters.set(entry.service_id, entry.adapter);
    }
  }

  registerService({ manifest, adapter = null, trusted = false, bundle = null } = {}) {
    const normalized = createServiceManifest(manifest, { allowOpenObjects: trusted === true });
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
    if (bundle) {
      if (bundle.service_id !== normalized.service_id) {
        throw new SwarmEnvError(ERROR_CODES.SERVICE_MANIFEST_INVALID, 'service bundle identity does not match its manifest', { bundle_service_id: bundle.service_id, manifest_service_id: normalized.service_id });
      }
      if (bundle.manifest?.manifest_hash !== normalized.manifest_hash) {
        throw new SwarmEnvError(ERROR_CODES.SERVICE_MANIFEST_INVALID, 'service bundle documentation manifest does not match the registered manifest', { expected: normalized.manifest_hash, observed: bundle.manifest?.manifest_hash ?? null });
      }
      this.#validateDocumentation(normalized, bundle);
    }
    this.services.set(normalized.service_id, { manifest: normalized, adapter: resolvedAdapter, ready: null, bundle });
    this.adapters.set(normalized.service_id, resolvedAdapter);
    this.revision += 1;
    this.logger?.({ event: 'service.registry.registered', service_id: normalized.service_id, manifest_hash: normalized.manifest_hash, documentation_count: bundle?.documents?.length ?? 0 });
    return this.getServiceMetadata(normalized.service_id);
  }

  async registerBundle({ bundle, adapter = null, trusted = false } = {}) {
    if (!bundle?.manifest) throw new TypeError('registerBundle requires a loaded service bundle');
    return this.registerService({ manifest: bundle.manifest, adapter, trusted, bundle });
  }

  #validateDocumentation(manifest, bundle) {
    for (const capability of manifest.capabilities) {
      const ref = capability.help?.ref;
      if (typeof ref !== 'string' || !ref.startsWith('service://')) {
        throw new SwarmEnvError(ERROR_CODES.SERVICE_MANIFEST_INVALID, 'bundled capability help.ref must be a service:// resource', { service_id: manifest.service_id, capability: capability.name, ref: ref ?? null });
      }
      try {
        resolveBundleDocument(bundle, ref);
      } catch (error) {
        throw new SwarmEnvError(ERROR_CODES.SERVICE_MANIFEST_INVALID, `bundled capability documentation is not resolvable: ${capability.name}`, { service_id: manifest.service_id, capability: capability.name, ref }, { cause: error });
      }
    }
  }

  register(input) {
    return this.registerService(input);
  }

  unregisterService(serviceId) {
    if (!this.services.delete(serviceId)) throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_FOUND, `unknown service: ${serviceId}`, { service_id: serviceId });
    this.adapters.delete(serviceId);
    this.revision += 1;
  }

  getRevision() {
    return this.revision;
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

  #documentedCapabilityView(entry, capability) {
    const view = capabilityView(entry.manifest, capability);
    if (entry.bundle && view.help?.ref) {
      try {
        const document = resolveBundleDocument(entry.bundle, view.help.ref);
        view.help = {
          ...view.help,
          text: document.text,
          resource: document.resource,
          document_sha256: document.sha256,
          provider_version: document.provider_version ?? entry.manifest.provider_version,
          manifest_hash: document.manifest_hash ?? entry.manifest.manifest_hash,
        };
      } catch {
        // Validation at registration rejects unresolvable bundle refs. A
        // programmatic service without a bundle keeps its inline help text.
      }
    }
    return view;
  }

  #serviceDocumentation(entry) {
    if (!entry.bundle) return [];
    return entry.bundle.documents.map((document) => ({
      resource: document.id,
      path: document.resource,
      sha256: document.sha256,
      bytes: document.bytes,
      provider_version: entry.manifest.provider_version,
      manifest_hash: entry.manifest.manifest_hash,
      text: document.text,
    }));
  }

  getServiceDocumentation(serviceId, { role = null } = {}) {
    const entry = this.getService(serviceId);
    const capabilities = role === null
      ? entry.manifest.capabilities.map((capability) => this.#documentedCapabilityView(entry, capability))
      : entry.manifest.capabilities
        .filter((capability) => capability.audience.includes(roleName(role)))
        .map((capability) => this.#documentedCapabilityView(entry, capability));
    return {
      service_id: entry.manifest.service_id,
      provider_version: entry.manifest.provider_version,
      manifest_hash: entry.manifest.manifest_hash,
      documents: this.#serviceDocumentation(entry),
      capabilities,
    };
  }

  getCapabilityProfile(role, context = {}) {
    const normalizedRole = roleName(role);
    const serviceEntries = [...this.services.values()].sort((a, b) => a.manifest.service_id.localeCompare(b.manifest.service_id));
    const capabilities = serviceEntries.flatMap((entry) => entry.manifest.capabilities
      .filter((capability) => capability.audience.includes(normalizedRole))
      .map((capability) => this.#documentedCapabilityView(entry, capability)));
    const runtimeCapabilities = Array.isArray(context.runtimeCapabilities)
      ? context.runtimeCapabilities.map((capability) => ({ ...clone(capability), service_id: capability.service_id ?? 'runtime', runtime_owned: true }))
      : [];
    const allCapabilities = [...capabilities, ...runtimeCapabilities].sort((a, b) => `${a.service_id}.${a.name}`.localeCompare(`${b.service_id}.${b.name}`));
    const services = serviceEntries
      .map((entry) => ({
        service_id: entry.manifest.service_id,
        title: entry.manifest.title,
        purpose: entry.manifest.purpose,
        provider_version: entry.manifest.provider_version,
        contract_version: entry.manifest.contract_version,
        manifest_hash: entry.manifest.manifest_hash,
        documentation: this.#serviceDocumentation(entry).map((document) => ({
          resource: document.resource,
          path: document.path,
          sha256: document.sha256,
          bytes: document.bytes,
          text: document.text,
        })),
        capabilities: allCapabilities.filter((capability) => capability.service_id === entry.manifest.service_id),
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
    const helpText = capability.help?.text ?? null;
    return {
      service_id: manifest.service_id,
      capability: capability.name,
      title: manifest.title,
      purpose: manifest.purpose,
      description: capability.description,
      help: clone(capability.help),
      help_text: helpText,
      input_schema: clone(capability.input_schema),
      output_schema: clone(capability.output_schema),
      errors: clone(capability.errors),
    };
  }

  /**
   * Resolve only registry-owned service:// references.  A model-supplied
   * filesystem path, URL, or traversal segment is never fetched here.
   */
  resolveHelpRef(ref) {
    if (typeof ref !== 'string' || !ref.startsWith('service://')) {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_MANIFEST_INVALID, 'help.ref must be a registry-owned service:// reference');
    }
    const match = /^service:\/\/([a-z][a-z0-9._-]*)\/(.+)$/.exec(ref);
    if (!match || match[2].startsWith('/') || match[2].split('/').includes('..')) {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_MANIFEST_INVALID, 'help.ref has an invalid service resource path');
    }
    const entry = this.getService(match[1]);
    if (entry.bundle) {
      const document = resolveBundleDocument(entry.bundle, ref);
      return {
        service_id: document.service_id,
        capability: match[2],
        resource: document.resource,
        path: document.path,
        provider_version: document.provider_version ?? entry.manifest.provider_version,
        manifest_hash: document.manifest_hash ?? entry.manifest.manifest_hash,
        document_sha256: document.sha256,
        text: document.text,
      };
    }
    const direct = entry.manifest.capabilities.find((capability) => capability.help?.ref === ref);
    if (direct) {
      return {
        service_id: entry.manifest.service_id,
        capability: direct.name,
        resource: match[2],
        provider_version: entry.manifest.provider_version,
        manifest_hash: entry.manifest.manifest_hash,
        text: direct.help?.text ?? null,
      };
    }
    const result = this.help(match[1], match[2]);
    return {
      service_id: result.service_id,
      capability: result.capability,
      provider_version: entry.manifest.provider_version,
      manifest_hash: entry.manifest.manifest_hash,
      text: result.help_text,
    };
  }

  invokeSync({ serviceId, service_id: serviceIdAlias, capability, capability_id: capabilityId, operation, input = {}, payload, envelope, role = null, signal = null } = {}) {
    const id = serviceId ?? serviceIdAlias;
    const name = capability ?? operation;
    const entry = capabilityId
      ? this.getCapabilityById(capabilityId)
      : this.getCapability(id, name);
    const actorRole = /^agent:(bound|recovery)$/.exec(envelope?.actor_ref ?? '')?.[1] ?? null;
    if (actorRole && role !== null && actorRole !== role) {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_CAPABILITY_NOT_ALLOWED, 'service role does not match the Agent envelope', { service_id: entry.manifest.service_id, capability: entry.capability.name, role, actor_role: actorRole });
    }
    const effectiveRole = role ?? actorRole;
    if (effectiveRole !== null && !entry.capability.audience.includes(roleName(effectiveRole))) {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_CAPABILITY_NOT_ALLOWED, `capability ${id}.${name} is not available to role ${effectiveRole}`, { service_id: id, capability: name, role: effectiveRole });
    }
    if (!envelope || typeof envelope !== 'object') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'service invocation envelope is required');
    // Mandatory Execution binding is a server-side property of the
    // capability, not a Bridge-only convention. A caller reaching the
    // Registry directly (an old adapter, a stale token, or a replay) cannot
    // invoke binding-required research work without the authenticated
    // Task/Execution identity.
    if (entry.capability.requires_binding === true && (!envelope.task_id || !envelope.execution_id)) {
      throw new SwarmEnvError(
        ERROR_CODES.NOT_ALLOWED,
        `capability ${entry.manifest.service_id}.${entry.capability.name} requires a bound Task and Execution`,
        { service_id: entry.manifest.service_id, capability: entry.capability.name, requires: ['task', 'execution'] },
      );
    }
    return entry.adapter.invoke({ manifest: entry.manifest, capability: entry.capability, input: payload ?? input, envelope, role: effectiveRole, signal });
  }

  async invoke(request = {}) {
    const id = request.serviceId ?? request.service_id;
    const entry = request.capability_id
      ? this.getCapabilityById(request.capability_id)
      : this.getCapability(id, request.capability ?? request.operation);
    if (entry.adapter.kind === 'http-json' && entry.ready !== true) await this.checkReadiness(entry.manifest.service_id, { signal: request.signal ?? null });
    return this.invokeSync(request);
  }

  async checkManifest(serviceId, { signal = null } = {}) {
    const entry = this.getService(serviceId);
    if (typeof entry.adapter.manifest !== 'function') {
      entry.manifest_verified = true;
      return { ok: true, service_id: serviceId, manifest_hash: entry.manifest.manifest_hash, verified: false };
    }
    let observed;
    try {
      observed = await entry.adapter.manifest(entry.manifest, { signal });
      if (!observed || typeof observed !== 'object' || Array.isArray(observed)) throw new Error('service manifest response must be an object');
      const normalized = createServiceManifest(observed, { allowOpenObjects: true });
      if (observed.manifest_hash && observed.manifest_hash !== normalized.manifest_hash) {
        throw new SwarmEnvError(ERROR_CODES.SERVICE_MANIFEST_INVALID, 'service advertised an invalid manifest hash', { service_id: serviceId, observed_manifest_hash: observed.manifest_hash, computed_manifest_hash: normalized.manifest_hash });
      }
      if (normalized.service_id !== entry.manifest.service_id || normalized.manifest_hash !== entry.manifest.manifest_hash) {
        throw new SwarmEnvError(ERROR_CODES.SERVICE_MANIFEST_INVALID, 'service manifest does not match the registered contract', {
          service_id: serviceId,
          expected_service_id: entry.manifest.service_id,
          observed_service_id: normalized.service_id,
          expected_manifest_hash: entry.manifest.manifest_hash,
          observed_manifest_hash: normalized.manifest_hash,
        });
      }
      entry.manifest_verified = true;
      return { ok: true, service_id: serviceId, manifest_hash: normalized.manifest_hash, verified: true };
    } catch (error) {
      entry.manifest_verified = false;
      if (error instanceof SwarmEnvError) throw error;
      throw new SwarmEnvError(ERROR_CODES.SERVICE_MANIFEST_INVALID, error?.message ?? 'service manifest verification failed', { service_id: serviceId }, { cause: error, retryable: true });
    }
  }

  async checkHealth(serviceId, { signal = null } = {}) {
    const entry = this.getService(serviceId);
    await this.checkManifest(serviceId, { signal });
    if (typeof entry.adapter.health !== 'function') {
      entry.ready = true;
      return { ok: true, service_id: serviceId };
    }
    try {
      const result = await entry.adapter.health(entry.manifest, { signal });
      if (result?.service_id && result.service_id !== entry.manifest.service_id) {
        throw new SwarmEnvError(ERROR_CODES.SERVICE_MANIFEST_INVALID, 'service health response has the wrong service identity', { service_id: serviceId, observed_service_id: result.service_id });
      }
      entry.ready = true;
      return result;
    } catch (error) {
      entry.ready = false;
      throw error;
    }
  }

  async checkReadiness(serviceId, { signal = null } = {}) {
    const entry = this.getService(serviceId);
    await this.checkManifest(serviceId, { signal });
    if (typeof entry.adapter.readiness !== 'function') {
      entry.ready = true;
      return { ok: true, service_id: serviceId };
    }
    try {
      const result = await entry.adapter.readiness(entry.manifest, { signal });
      if (result?.service_id && result.service_id !== entry.manifest.service_id) {
        throw new SwarmEnvError(ERROR_CODES.SERVICE_MANIFEST_INVALID, 'service readiness response has the wrong service identity', { service_id: serviceId, observed_service_id: result.service_id });
      }
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
