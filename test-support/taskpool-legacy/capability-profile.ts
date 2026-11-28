import { createHash } from 'node:crypto';
import { stableStringify } from '../../examples/taskpool/persistence/envelope.js';

export const AGENT_ROLES = Object.freeze({
  BOUND: 'bound',
  RECOVERY: 'recovery',
});

const PROFILE_VERSION = '1';
const INTERNAL_AUDIENCES = new Set(['runtime', 'daemon', 'internal']);

function clone(value: any) {
  return value === undefined ? undefined : structuredClone(value);
}

function digest(value: any) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function asList(value: any) {
  if (Array.isArray(value)) return value.filter((item: any) => typeof item === 'string');
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

function canonicalRole(role: any) {
  if (role === AGENT_ROLES.BOUND || role === AGENT_ROLES.RECOVERY) return role;
  throw new TypeError(`unknown Agent role: ${role}`);
}

function operationOf(capability: any) {
  return capability.operation ?? capability.operation_name ?? capability.name ?? capability.id ?? null;
}

function serviceIdOf(capability: any) {
  return capability.service_id ?? capability.serviceId ?? capability.service ?? capability.provider_id ?? 'runtime';
}

function capabilityNameOf(capability: any) {
  return capability.tool_name ?? capability.toolName ?? capability.name ?? operationOf(capability);
}

function safeToolName(serviceId: any, name: any) {
  return `${serviceId}_${name}`.replace(/[^A-Za-z0-9_]/g, '_');
}

function audienceOf(capability: any) {
  return asList(capability.audience ?? capability.roles ?? capability.role_scope ?? capability.roleScope);
}

function inferredAudience(capability: any) {
  const service = serviceIdOf(capability);
  const operation = operationOf(capability);
  const scope = capability.scope;
  const sideEffect = capability.side_effect ?? capability.sideEffect;

  // Registry manifests should always provide an audience. This fallback keeps
  // Current built-in metadata used by the Registry projection.
  if (service === 'workspace' || service === 'execution' || service === 'context' || service === 'judge' || capability.runtime_owned === true) {
    return [AGENT_ROLES.BOUND, AGENT_ROLES.RECOVERY];
  }
  if (operation === 'task_list' || operation === 'task_view' || operation === 'task_status') {
    return [AGENT_ROLES.BOUND, AGENT_ROLES.RECOVERY];
  }
  if (scope === 'public-read' && sideEffect === false) {
    return [AGENT_ROLES.BOUND, AGENT_ROLES.RECOVERY];
  }
  return [AGENT_ROLES.BOUND, AGENT_ROLES.RECOVERY];
}

function allowsRole(capability: any, role: any) {
  const audience = audienceOf(capability);
  const allowed = audience.length > 0 ? audience : inferredAudience(capability);
  return allowed.includes(role) || allowed.includes('all') || allowed.includes('*');
}

function normalizeCapability(capability: any, role: any) {
  const operation = operationOf(capability);
  const name = capabilityNameOf(capability);
  if (!operation || !name) return null;
  if (!allowsRole(capability, role)) return null;
  const serviceId = serviceIdOf(capability);
  const runtimeOwned = capability.runtime_owned === true || serviceId === 'runtime';
  const audience = audienceOf(capability);
  // Execution process controls remain Runtime-owned and are not public commands.
  const sideEffect = capability.side_effect ?? capability.sideEffect;
  if (serviceId === 'execution' && (sideEffect === true || sideEffect === 'write')) return null;
  if (audience.some((item: any) => INTERNAL_AUDIENCES.has(item))) return null;
  return {
    id: capability.id ?? `${serviceId}.${operation}`,
    name,
    tool_name: capability.tool_name ?? capability.toolName ?? null,
    operation,
    service_id: serviceId,
    service_title: capability.service_title ?? capability.serviceTitle ?? capability.title ?? serviceId,
    service_purpose: capability.service_purpose ?? capability.servicePurpose ?? capability.purpose ?? '',
    provider_version: capability.provider_version ?? capability.providerVersion ?? null,
    contract_version: capability.contract_version ?? capability.contractVersion ?? null,
    manifest_hash: capability.manifest_hash ?? capability.manifestHash ?? null,
    description: capability.description ?? '',
    input_schema: clone(capability.input_schema ?? capability.inputSchema ?? capability.parameters ?? { type: 'object' }),
    output_schema: clone(capability.output_schema ?? capability.outputSchema ?? null),
    side_effect: capability.side_effect ?? capability.sideEffect ?? false,
    idempotent: capability.idempotent ?? capability.idempotency ?? false,
    help: clone(capability.help ?? capability.help_ref ?? capability.helpRef ?? null),
    context: clone(capability.context ?? capability.required_context ?? null),
    path: capability.path ?? null,
    audience: audience.length > 0 ? audience : inferredAudience(capability),
    runtime_owned: runtimeOwned || serviceId === 'workspace' || serviceId === 'execution',
  };
}

function sourceCapabilities({ registry, role, context }: any) {
  if (!registry || typeof registry.getCapabilityProfile !== 'function') throw new TypeError('capability profile requires a Service Registry');
  const profile = registry.getCapabilityProfile(role, context);
  if (!profile || !Array.isArray(profile.capabilities)) throw new TypeError('Registry returned an invalid capability profile');
  return { profile, capabilities: profile.capabilities };
}

function normalizeServices(capabilities: any, profileServices: any = []) {
  const grouped = new Map<any, any>();
  for (const capability of capabilities) {
    const service = grouped.get(capability.service_id) ?? {
      id: capability.service_id,
      service_id: capability.service_id,
      title: capability.service_title,
      purpose: capability.service_purpose,
      provider_version: capability.provider_version ?? null,
      contract_version: capability.contract_version ?? null,
      manifest_hash: capability.manifest_hash ?? null,
      documentation: [],
      capabilities: [],
    };
    service.capabilities.push(capability.tool_name ?? capability.name);
    grouped.set(capability.service_id, service);
  }
  for (const service of grouped.values()) {
    const source = Array.isArray(profileServices)
      ? profileServices.find((candidate: any) => (candidate.service_id ?? candidate.id) === service.id)
      : null;
    if (!source) continue;
    if (source.purpose) service.purpose = source.purpose;
    if (source.provider_version) service.provider_version = source.provider_version;
    if (source.contract_version) service.contract_version = source.contract_version;
    if (source.manifest_hash) service.manifest_hash = source.manifest_hash;
    if (Array.isArray(source.documentation)) service.documentation = clone(source.documentation);
  }
  return [...grouped.values()]
    .map((service: any) => ({ ...service, capabilities: [...service.capabilities].sort() }))
    .sort((a: any, b: any) => a.id.localeCompare(b.id));
}

/**
 * Build the exact capability set visible to one Agent Session. Registry
 * profiles are authoritative; the built-in catalog fallback is only for the
 * projection and is intentionally normalized through the same projection.
 */
export function buildCapabilityProfile({ role = AGENT_ROLES.BOUND, registry = null, context = {} }: any = {}) {
  const canonical = canonicalRole(role);
  const source = sourceCapabilities({ registry, role: canonical, context });
  const candidates = source.capabilities ?? [];
  const normalizedCapabilities = candidates
    .map((capability: any) => normalizeCapability(capability, canonical))
    .filter(Boolean)
    .filter((capability: any, index: any, all: any) => all.findIndex((candidate: any) => candidate.id === capability.id) === index)
    .sort((a: any, b: any) => a.id.localeCompare(b.id));
  const nameCounts = new Map<any, any>();
  for (const capability of normalizedCapabilities) nameCounts.set(capability.name, (nameCounts.get(capability.name) ?? 0) + 1);
  const preferredServices = new Map<any, any>();
  for (const capability of normalizedCapabilities) {
    if (nameCounts.get(capability.name) > 1 && capability.service_id !== 'runtime' && !preferredServices.has(capability.name)) {
      preferredServices.set(capability.name, capability.service_id);
    }
  }
  const usedNames = new Set();
  const capabilities = normalizedCapabilities.map((capability: any) => {
    // Keep the first deterministic capability name stable and qualify later
    // names so profile metadata remains one-to-one.
    let name = capability.name;
    if (nameCounts.get(name) > 1 && (usedNames.has(name) || (capability.service_id === 'runtime' && preferredServices.has(name)))) {
      name = `${capability.service_id}_${name}`;
    }
    while (usedNames.has(name)) name = `${capability.service_id}_${name}`;
    usedNames.add(name);
    const toolName = nameCounts.get(capability.name) > 1
      ? safeToolName(capability.service_id, capability.name)
      : (capability.tool_name ?? capability.name);
    return { ...capability, name, tool_name: toolName };
  });
  const services = normalizeServices(capabilities, source.profile?.services);
  const identity = {
    profile_version: source.profile?.profile_version ?? source.profile?.profileVersion ?? PROFILE_VERSION,
    role: canonical,
    capabilities,
    services,
  };
  const generatedNames = capabilities.some((capability: any) => capability.tool_name !== capability.name);
  const usedToolNames = new Set();
  const disambiguatedCapabilities = capabilities.map((capability: any) => {
    let toolName = capability.tool_name ?? capability.name;
    if (usedToolNames.has(toolName)) toolName = `${toolName}_${digest(capability.id).slice(0, 8)}`;
    usedToolNames.add(toolName);
    return { ...capability, tool_name: toolName };
  });
  const finalIdentity = { ...identity, capabilities: disambiguatedCapabilities, services: normalizeServices(disambiguatedCapabilities, source.profile?.services) };
  const profileHash = generatedNames || disambiguatedCapabilities.some((capability: any, index: any) => capability.tool_name !== capabilities[index].tool_name)
    ? digest(finalIdentity)
    : (source.profile?.profile_hash ?? source.profile?.profileHash ?? digest(identity));
  return {
    role: canonical,
    profile_version: identity.profile_version,
    profile_hash: profileHash,
    capabilities: disambiguatedCapabilities,
    services: normalizeServices(disambiguatedCapabilities, source.profile?.services),
  };
}
