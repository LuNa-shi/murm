import { createHash } from 'node:crypto';
import { isLegacyAgentSurface, listTools } from '../sdk/service-catalog.js';
import { stableStringify } from '../protocol/envelope.js';

export const AGENT_ROLES = Object.freeze({
  BOUND: 'bound',
  RECOVERY: 'recovery',
});

const PROFILE_VERSION = '1';
const INTERNAL_AUDIENCES = new Set(['runtime', 'daemon', 'internal']);

// The catalog still contains historical Task/Execution entries for bounded
// observability imports. They must not leak through the no-Registry migration
// path into a live Agent profile. Registry-backed profiles are authoritative;
// this allowlist keeps the fallback equally aligned with the current Agent
// contract while callers migrate to a Registry.
const CURRENT_AGENT_OPERATIONS = new Set([
  'list_services', 'get_service_metadata', 'list_tools',
  'list_tasks', 'get_task', 'list_executions',
  'create_child_task', 'propose_task',
  'task_list', 'task_view', 'task_create', 'task_link_material', 'task_complete', 'task_handoff', 'task_block', 'task_close',
  'task_status', 'task_register', 'task_take', 'task_feedback', 'execution_progress',
  'publish_material', 'read_materials', 'consume_materials',
  'context_search_materials', 'context_get_material', 'context_publish_material',
  'submit_candidate', 'get_check_result', 'get_execution',
  'get_workspace', 'list_workspace_revisions', 'list_workspace_files',
  'read_workspace_file', 'write_workspace_file', 'workspace_diff',
]);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function digest(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function asList(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string');
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

function canonicalRole(role) {
  if (role === AGENT_ROLES.BOUND || role === AGENT_ROLES.RECOVERY) return role;
  throw new TypeError(`unknown Agent role: ${role}`);
}

function operationOf(capability) {
  return capability.operation ?? capability.operation_name ?? capability.name ?? capability.id ?? null;
}

function serviceIdOf(capability) {
  return capability.service_id ?? capability.serviceId ?? capability.service ?? capability.provider_id ?? 'runtime';
}

function capabilityNameOf(capability) {
  return capability.tool_name ?? capability.toolName ?? capability.name ?? operationOf(capability);
}

function safeToolName(serviceId, name) {
  return `${serviceId}_${name}`.replace(/[^A-Za-z0-9_]/g, '_');
}

function audienceOf(capability) {
  return asList(capability.audience ?? capability.roles ?? capability.role_scope ?? capability.roleScope);
}

function inferredAudience(capability) {
  const service = serviceIdOf(capability);
  const operation = operationOf(capability);
  const scope = capability.scope;
  const sideEffect = capability.side_effect ?? capability.sideEffect;

  // Registry manifests should always provide an audience. This fallback keeps
  // current built-in metadata useful while it is migrated to the Registry.
  if (service === 'workspace' || service === 'execution' || service === 'context' || service === 'judge' || capability.runtime_owned === true || operation === 'scheduler_status') {
    return [AGENT_ROLES.BOUND, AGENT_ROLES.RECOVERY];
  }
  if (operation === 'list_tasks' || operation === 'task_list' || operation === 'task_view' || operation === 'get_task' || operation === 'task_status') {
    return [AGENT_ROLES.BOUND, AGENT_ROLES.RECOVERY];
  }
  if (scope === 'public-read' && sideEffect === false) {
    return [AGENT_ROLES.BOUND, AGENT_ROLES.RECOVERY];
  }
  return [AGENT_ROLES.BOUND, AGENT_ROLES.RECOVERY];
}

function allowsRole(capability, role) {
  const audience = audienceOf(capability);
  const allowed = audience.length > 0 ? audience : inferredAudience(capability);
  return allowed.includes(role) || allowed.includes('all') || allowed.includes('*');
}

function normalizeCapability(capability, role) {
  const operation = operationOf(capability);
  const name = capabilityNameOf(capability);
  if (!operation || !name) return null;
  if (!allowsRole(capability, role)) return null;
  const serviceId = serviceIdOf(capability);
  const audience = audienceOf(capability);
  const runtimeOwned = capability.runtime_owned === true || serviceId === 'runtime';
  if (isLegacyAgentSurface({ ...capability, name, operation }, { runtimeOwned })) return null;
  // Execution lease/process controls remain Runtime-owned. Only the read-only
  // Execution projection may appear in a bound profile; typed Task actions
  // are supplied separately as Runtime capabilities.
  const sideEffect = capability.side_effect ?? capability.sideEffect;
  if (serviceId === 'execution' && (sideEffect === true || sideEffect === 'write')) return null;
  if (audience.some((item) => INTERNAL_AUDIENCES.has(item))) return null;
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

function sourceCapabilities({ registry, role, context, tools }) {
  if (registry && typeof registry.getCapabilityProfile === 'function') {
    const profile = registry.getCapabilityProfile(role, context);
    if (profile && typeof profile === 'object') return { profile, capabilities: profile.capabilities ?? [] };
  }
  if (registry && typeof registry.getProfile === 'function') {
    const profile = registry.getProfile(role, context);
    if (profile && typeof profile === 'object') return { profile, capabilities: profile.capabilities ?? [] };
  }
  if (registry && typeof registry.listTools === 'function') {
    return { profile: null, capabilities: registry.listTools(null, context) ?? [] };
  }
  const catalog = tools ?? listTools();
  return { profile: null, capabilities: catalog.filter((capability) => CURRENT_AGENT_OPERATIONS.has(operationOf(capability))) };
}

function normalizeServices(capabilities, profileServices = []) {
  const grouped = new Map();
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
      ? profileServices.find((candidate) => (candidate.service_id ?? candidate.id) === service.id)
      : null;
    if (!source) continue;
    if (source.purpose) service.purpose = source.purpose;
    if (source.provider_version) service.provider_version = source.provider_version;
    if (source.contract_version) service.contract_version = source.contract_version;
    if (source.manifest_hash) service.manifest_hash = source.manifest_hash;
    if (Array.isArray(source.documentation)) service.documentation = clone(source.documentation);
  }
  return [...grouped.values()]
    .map((service) => ({ ...service, capabilities: [...service.capabilities].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Build the exact capability set visible to one Agent Session. Registry
 * profiles are authoritative; the built-in catalog fallback is only for the
 * migration seam and is intentionally normalized through the same projection.
 */
export function buildCapabilityProfile({ role = AGENT_ROLES.BOUND, registry = null, context = {}, tools = null, runtimeCapabilities = [] } = {}) {
  const canonical = canonicalRole(role);
  const source = sourceCapabilities({ registry, role: canonical, context: { ...context, runtimeCapabilities }, tools });
  const candidates = [...(source.capabilities ?? []), ...runtimeCapabilities];
  const normalizedCapabilities = candidates
    .map((capability) => normalizeCapability(capability, canonical))
    .filter(Boolean)
    .filter((capability, index, all) => all.findIndex((candidate) => candidate.id === capability.id) === index)
    .sort((a, b) => a.id.localeCompare(b.id));
  const nameCounts = new Map();
  for (const capability of normalizedCapabilities) nameCounts.set(capability.name, (nameCounts.get(capability.name) ?? 0) + 1);
  const preferredServices = new Map();
  for (const capability of normalizedCapabilities) {
    if (nameCounts.get(capability.name) > 1 && capability.service_id !== 'runtime' && !preferredServices.has(capability.name)) {
      preferredServices.set(capability.name, capability.service_id);
    }
  }
  const usedNames = new Set();
  const capabilities = normalizedCapabilities.map((capability) => {
    // A Runtime-owned compatibility alias (for example accept_task) may
    // share the semantic name of a registered Task capability. Keep the
    // first deterministic capability name stable and qualify later names so
    // profile metadata remains one-to-one while operation routing continues
    // to use the explicit operation field.
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
  const generatedNames = capabilities.some((capability) => capability.tool_name !== capability.name);
  const usedToolNames = new Set();
  const disambiguatedCapabilities = capabilities.map((capability) => {
    let toolName = capability.tool_name ?? capability.name;
    if (usedToolNames.has(toolName)) toolName = `${toolName}_${digest(capability.id).slice(0, 8)}`;
    usedToolNames.add(toolName);
    return { ...capability, tool_name: toolName };
  });
  const finalIdentity = { ...identity, capabilities: disambiguatedCapabilities, services: normalizeServices(disambiguatedCapabilities, source.profile?.services) };
  const profileHash = generatedNames || disambiguatedCapabilities.some((capability, index) => capability.tool_name !== capabilities[index].tool_name)
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

export function profileToolNames(profile) {
  return [...(profile?.capabilities ?? [])]
    .map((capability) => capability.tool_name ?? capability.name)
    .filter((name) => typeof name === 'string' && name.length > 0)
    .sort();
}

export function capabilityDirectory(profile) {
  const lines = [];
  for (const service of profile?.services ?? []) {
    lines.push(`- ${service.title || service.id}${service.purpose ? ` — ${service.purpose}` : ''}`);
    for (const name of service.capabilities) {
      const capability = profile.capabilities.find((candidate) => (candidate.tool_name ?? candidate.name) === name && candidate.service_id === service.id);
      if (!capability) continue;
      const guidance = capability.help?.when ?? capability.help?.usage ?? capability.help?.summary ?? null;
      const effect = capability.side_effect === false || capability.side_effect === 'read' ? 'read-only' : 'writes state';
      lines.push(`  - swarmenv_${name}: ${capability.description || 'Use the registered capability.'} (logical operation ${capability.service_id}.${capability.operation}; ${effect}${guidance ? `; ${guidance}` : ''})`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : '- No callable provider capabilities are available in this Session.';
}

export function profileSnapshot(profile) {
  return {
    profile_version: profile?.profile_version ?? PROFILE_VERSION,
    profile_hash: profile?.profile_hash ?? null,
    role: profile?.role ?? null,
    capabilities: profileToolNames(profile),
  };
}
