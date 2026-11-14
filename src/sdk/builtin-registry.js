import { createInProcessAdapter, createHttpJsonAdapter } from './service-adapter.js';
import { createServiceManifest } from './service-manifest.js';
import { ServiceRegistry } from './service-registry.js';
import { listTools } from './service-catalog.js';

const SERVICE_INFO = Object.freeze({
  task: { title: 'Task Service', purpose: 'Durable Task goals, takes, structure, and completion evidence.' },
  context: { title: 'Context Service', purpose: 'Versioned shared Materials and provenance.' },
  judge: { title: 'Judge Service', purpose: 'Workspace source checking and structured CheckResults.' },
  catalog: { title: 'Service Catalog', purpose: 'Role-scoped Service and capability discovery.' },
});

const ALL_ROLES = Object.freeze(['bound', 'recovery']);
const SHARED_READ_OPERATIONS = new Set(['task_status']);
const EXPOSED_OPERATIONS = Object.freeze({
  task: new Set([
    'bot_exit',
    'list_tasks', 'list_executions',
    'task_list', 'task_view', 'task_create', 'task_link_material', 'task_finish',
    'task_status', 'task_take', 'task_feedback', 'execution_progress',
    'workspace_public_files', 'workspace_public_read', 'workspace_public_search', 'workspace_public_apply',
    'workspace_save', 'workspace_merge', 'mission_submit', 'mission_submission_get',
  ]),
  context: new Set(['publish_material', 'read_materials', 'consume_materials', 'context_search_materials', 'context_get_material', 'context_publish_material']),
  judge: new Set(['workspace_check', 'get_check_result']),
  catalog: new Set(['list_services', 'get_service_metadata', 'list_tools']),
});

const TOOL_OVERRIDES = Object.freeze({
  list_tasks: { name: 'task_discover', description: 'Discover the bounded Mission Task view and relevant shared work.' },
});

function publicTools(serviceId) {
  const selected = listTools(serviceId)
    .filter((tool) => EXPOSED_OPERATIONS[serviceId]?.has(tool.operation));
  const modernNames = new Set(selected.filter((tool) => tool.operation === tool.name).map((tool) => tool.name));
  const seen = new Set();
  return selected.map((tool) => {
    const override = TOOL_OVERRIDES[tool.operation] ?? {};
    if (override.name && modernNames.has(override.name) && tool.operation !== override.name) return null;
    return { ...tool, ...override };
  }).filter((tool) => {
    if (!tool || seen.has(tool.name) || seen.has(tool.operation)) return false;
    seen.add(tool.name);
    seen.add(tool.operation);
    return true;
  });
}

function strictInputSchema(parameters) {
  const schema = parameters && typeof parameters === 'object' && !Array.isArray(parameters)
    ? structuredClone(parameters)
    : { type: 'object', properties: {} };
  schema.type = 'object';
  schema.properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties
    : {};
  // Preserve an explicitly open built-in contract. Missing declarations still
  // default to a closed object so a service cannot accidentally advertise an
  // unbounded payload.
  if (schema.additionalProperties === undefined) schema.additionalProperties = false;
  return schema;
}

function audienceFor(tool) {
  if (['workspace_public_files', 'workspace_public_read', 'workspace_public_search', 'mission_submission_get'].includes(tool.operation)) return ALL_ROLES;
  if (['list_tasks', 'task_list', 'task_view'].includes(tool.operation)) return ALL_ROLES;
  if (SHARED_READ_OPERATIONS.has(tool.operation)) return ALL_ROLES;
  if (tool.service === 'catalog' && tool.scope === 'public-read' && tool.side_effect === false) return ALL_ROLES;
  return ['bound', 'recovery'];
}

function normalizeServiceEndpoint(serviceId, configured) {
  if (configured === undefined || configured === null) {
    return { endpoint: { transport: 'in-process' }, adapter: null, manifest: null };
  }
  if (typeof configured === 'string') {
    return { endpoint: { transport: 'http-json', url: configured }, adapter: null, manifest: null };
  }
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
    throw new TypeError(`service endpoint for ${serviceId} must be a URL or configuration object`);
  }
  const suppliedManifest = configured.manifest ?? null;
  const endpoint = configured.endpoint
    ?? (configured.url ? { transport: 'http-json', url: configured.url } : null)
    ?? (suppliedManifest?.endpoint ?? { transport: 'in-process' });
  if (!endpoint || typeof endpoint !== 'object') {
    throw new TypeError(`service endpoint for ${serviceId} must include endpoint or url`);
  }
  return {
    endpoint,
    adapter: configured.adapter ?? null,
    token: configured.token ?? null,
    manifest: suppliedManifest,
  };
}

function manifestForService(serviceId, tools, { endpoint = { transport: 'in-process' }, manifest = null } = {}) {
  if (manifest) {
    const supplied = createServiceManifest({ ...manifest, endpoint }, { allowOpenObjects: true });
    if (supplied.service_id !== serviceId) {
      throw new TypeError(`service manifest id does not match configured provider: expected ${serviceId}, got ${supplied.service_id}`);
    }
    return supplied;
  }
  const info = SERVICE_INFO[serviceId] ?? { title: serviceId, purpose: `${serviceId} capabilities.` };
  return createServiceManifest({
    id: serviceId,
    title: info.title,
    purpose: info.purpose,
    provider_version: 'builtin-1',
    contract_version: '1',
    endpoint,
    capabilities: tools.map((tool) => ({
      name: tool.name,
      operation: tool.operation,
      description: tool.description,
      audience: audienceFor(tool),
      side_effect: tool.side_effect ? 'write' : 'read',
      idempotent: !tool.side_effect,
      context: serviceId === 'catalog' || ['bot_exit', 'workspace_public_files', 'workspace_public_read', 'workspace_public_search', 'mission_submit', 'mission_submission_get'].includes(tool.operation) ? [] : ['task', 'execution'],
      help: {
        when: tool.description,
        ref: `service://${serviceId}/${tool.operation}`,
        text: `Purpose: ${info.purpose}\nUse when: ${tool.description}\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code.`,
      },
      input_schema: strictInputSchema(tool.parameters),
      // Built-in results intentionally use a JSON value schema: Task and
      // Context reads include arrays while writes return structured objects.
      output_schema: { type: ['object', 'array', 'string', 'number', 'boolean', 'null'] },
      path: `/v1/${tool.operation}`,
      errors: [],
      scope: tool.scope ?? null,
      capability: tool.capability ?? null,
    })),
  }, { allowOpenObjects: true });
}

function serviceDispatch(serviceId, services, registry) {
  return ({ capability, input, envelope, role = null }) => {
    if (serviceId === 'catalog') {
      const allowed = (candidate) => role === null || candidate.audience.includes(role);
      if (capability.operation === 'list_services') {
        return { services: registry.listServices().filter((service) => registry.getServiceMetadata(service.service_id).capabilities.some(allowed)) };
      }
      if (capability.operation === 'get_service_metadata') {
        const metadata = registry.getServiceMetadata(input?.service ?? null);
        return { ...metadata, capabilities: metadata.capabilities.filter(allowed) };
      }
      if (capability.operation === 'list_tools') {
        return { tools: registry.listTools(input?.service ?? null).filter(allowed) };
      }
    }
    if (serviceId === 'task' && ['workspace_public_files', 'workspace_public_read', 'workspace_public_search', 'workspace_public_apply', 'workspace_save', 'workspace_merge'].includes(capability.operation)) {
      if (!services.missionWorkspace) {
        const error = new Error('Mission Workspace is unavailable');
        error.code = 'SERVICE_UNAVAILABLE';
        throw error;
      }
      if (capability.operation === 'workspace_public_files') return services.missionWorkspace.files({ workspaceId: input?.workspace_id, revision: input?.revision, prefix: input?.path ?? '' });
      if (capability.operation === 'workspace_public_read') return services.missionWorkspace.read({ workspaceId: input?.workspace_id, revision: input?.revision, path: input?.path, maxBytes: input?.max_bytes });
      if (capability.operation === 'workspace_public_search') return services.missionWorkspace.search({ workspaceId: input?.workspace_id, revision: input?.revision, prefix: input?.path ?? '', query: input?.query, maxResults: input?.max_results });
      if (capability.operation === 'workspace_public_apply') return services.missionWorkspace.apply({ workspaceId: input?.workspace_id, revision: input?.revision, targetDir: input?.target_dir });
      if (capability.operation === 'workspace_save') return services.missionWorkspace.save(input ?? {});
      if (capability.operation === 'workspace_merge') return services.missionWorkspace.merge(input ?? {});
    }
    if (serviceId === 'task' && ['mission_submit', 'mission_submission_get'].includes(capability.operation)) {
      if (!services.missionSubmissionStore) {
        const error = new Error('Mission submission is unavailable');
        error.code = 'SERVICE_UNAVAILABLE';
        throw error;
      }
      if (capability.operation === 'mission_submit') return services.missionSubmissionStore.submit({ ...input, actorRef: input?.actor_ref ?? envelope?.actor_ref });
      return services.missionSubmissionStore.get({ missionId: input?.mission_id, submissionId: input?.submission_id ?? null });
    }
    const service = services[serviceId];
    if (!service || typeof service.dispatch !== 'function') {
      const error = new Error(`built-in Service is unavailable: ${serviceId}`);
      error.code = 'SERVICE_UNAVAILABLE';
      throw error;
    }
    return service.dispatch(capability.operation, input ?? {}, envelope);
  };
}

/**
 * Register the local domain providers through the same Manifest and adapter
 * seam used by independently hosted providers. `customServices` accepts the
 * exact `{ manifest, adapter }` pair used by `ServiceRegistry.registerService`.
 */
export function createBuiltinServiceRegistry({
  taskService,
  contextService,
  judgeService = null,
  missionWorkspace = null,
  missionSubmissionStore = null,
  customServices = [],
  // A configured endpoint replaces the local provider for that Service. Each
  // value may be a URL, `{ url, token }`, or `{ endpoint, manifest, adapter }`.
  // This lets Task, Context, Judge, and Catalog run as independent HTTP hosts
  // without changing the Registry, Bridge, or Agent-facing contract.
  serviceEndpoints = {},
  endpoints = serviceEndpoints,
  logger = null,
} = {}) {
  const registry = new ServiceRegistry({ logger });
  const services = { task: taskService, context: contextService, judge: judgeService, missionWorkspace, missionSubmissionStore };
  for (const serviceId of ['task', 'context', 'judge']) {
    const tools = publicTools(serviceId);
    if (tools.length === 0) continue;
    const configured = normalizeServiceEndpoint(serviceId, endpoints?.[serviceId]);
    const manifest = manifestForService(serviceId, tools, configured);
    const adapter = configured.adapter
      ?? (manifest.endpoint.transport === 'http-json' ? createHttpJsonAdapter({ token: configured.token }) : createInProcessAdapter({ invoke: serviceDispatch(serviceId, services, registry) }));
    registry.registerService({
      manifest,
      adapter,
      trusted: true,
    });
  }
  const catalogEndpoint = normalizeServiceEndpoint('catalog', endpoints?.catalog);
  registry.registerService({
    manifest: manifestForService('catalog', publicTools('catalog'), catalogEndpoint),
    adapter: catalogEndpoint.adapter
      ?? (catalogEndpoint.endpoint.transport === 'http-json'
        ? createHttpJsonAdapter({ token: catalogEndpoint.token })
        : createInProcessAdapter({ invoke: serviceDispatch('catalog', services, registry) })),
    trusted: true,
  });
  for (const definition of customServices) {
    if (!definition?.manifest) throw new TypeError('custom service registration requires a manifest');
    registry.registerService(definition);
  }
  return registry;
}

export function registerUserService(registry, { manifest, adapter = null, token = null } = {}) {
  if (!registry || typeof registry.registerService !== 'function') throw new TypeError('registerUserService requires a ServiceRegistry');
  const resolvedAdapter = adapter ?? (manifest?.endpoint?.transport === 'http-json' ? createHttpJsonAdapter({ token }) : null);
  return registry.registerService({ manifest, adapter: resolvedAdapter });
}

export function builtInServiceManifest(serviceId, options = {}) {
  const tools = publicTools(serviceId);
  return tools.length === 0 ? null : manifestForService(serviceId, tools, options);
}
