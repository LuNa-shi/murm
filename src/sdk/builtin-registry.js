import { createInProcessAdapter, createHttpJsonAdapter } from './service-adapter.js';
import { createServiceManifest } from './service-manifest.js';
import { ServiceRegistry } from './service-registry.js';
import { listTools } from './service-catalog.js';

const SERVICE_INFO = Object.freeze({
  task: { title: 'Task Service', purpose: 'Durable Task goals, claims, structure, and completion evidence.' },
  context: { title: 'Context Service', purpose: 'Versioned shared Materials and provenance.' },
  judge: { title: 'Judge Service', purpose: 'Candidate checking and structured CheckResults.' },
  catalog: { title: 'Service Catalog', purpose: 'Role-scoped Service and capability discovery.' },
});

const ALL_ROLES = Object.freeze(['selection', 'bound', 'recovery']);
const SELECTION_OPERATIONS = new Set(['list_claimable_tasks', 'claim']);
// Selection can inspect only the bounded Task contract it is about to choose.
// Execution-scoped projections (Materials, CheckResults, and prior Executions)
// belong to the bound/recovery roles and must not leak into the selection turn.
const SHARED_READ_OPERATIONS = new Set(['get_task']);
const EXPOSED_OPERATIONS = Object.freeze({
  task: new Set(['list_tasks', 'list_claimable_tasks', 'get_task', 'list_executions', 'claim', 'create_child_task', 'propose_task']),
  context: new Set(['publish_material', 'read_materials', 'consume_materials']),
  judge: new Set(['submit_candidate', 'get_check_result']),
  catalog: new Set(['list_services', 'get_service_metadata', 'list_tools']),
});

const TOOL_OVERRIDES = Object.freeze({
  list_tasks: { name: 'task_discover', description: 'Discover the bounded Mission Task view and relevant shared work.' },
  get_task: { name: 'task_view', description: 'Read one Task contract, current state, provenance, and result references.' },
  propose_task: { name: 'task_create', description: 'Propose a substantial peer Task with an explicit output and acceptance contract.' },
  accept_task: { name: 'task_complete', description: 'Complete the current Task after its own contract and result references are satisfied.' },
});

function publicTools(serviceId) {
  return listTools(serviceId, { includeInternal: true })
    .filter((tool) => EXPOSED_OPERATIONS[serviceId]?.has(tool.operation))
    .map((tool) => ({ ...tool, ...(TOOL_OVERRIDES[tool.operation] ?? {}) }));
}

function strictInputSchema(parameters) {
  const schema = parameters && typeof parameters === 'object' && !Array.isArray(parameters)
    ? structuredClone(parameters)
    : { type: 'object', properties: {} };
  schema.type = 'object';
  schema.properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties
    : {};
  schema.additionalProperties = false;
  return schema;
}

function audienceFor(tool) {
  if (SELECTION_OPERATIONS.has(tool.operation)) return ['selection'];
  if (tool.operation === 'list_tasks') return ALL_ROLES;
  if (SHARED_READ_OPERATIONS.has(tool.operation)) return ALL_ROLES;
  if (tool.service === 'catalog' && tool.scope === 'public-read' && tool.side_effect === false) return ALL_ROLES;
  return ['bound', 'recovery'];
}

function manifestForService(serviceId, tools) {
  const info = SERVICE_INFO[serviceId] ?? { title: serviceId, purpose: `${serviceId} capabilities.` };
  return createServiceManifest({
    id: serviceId,
    title: info.title,
    purpose: info.purpose,
    provider_version: 'builtin-1',
    contract_version: '1',
    endpoint: { transport: 'in-process' },
    capabilities: tools.map((tool) => ({
      name: tool.name,
      operation: tool.operation,
      description: tool.description,
      audience: audienceFor(tool),
      side_effect: tool.side_effect ? 'write' : 'read',
      idempotent: !tool.side_effect,
      context: serviceId === 'catalog' ? [] : ['task', 'execution'],
      help: { when: tool.description, ref: `service://${serviceId}/${tool.operation}` },
      input_schema: strictInputSchema(tool.parameters),
      output_schema: { type: 'object', properties: {}, additionalProperties: false },
      path: `/v1/${tool.operation}`,
      errors: [],
    })),
  });
}

function serviceDispatch(serviceId, services, registry) {
  return ({ capability, input, envelope }) => {
    if (serviceId === 'catalog') {
      if (capability.operation === 'list_services') return { services: registry.listServices() };
      if (capability.operation === 'get_service_metadata') return registry.getServiceMetadata(input?.service ?? null);
      if (capability.operation === 'list_tools') return { tools: registry.listTools(input?.service ?? null) };
    }
    const service = services[serviceId];
    if (serviceId === 'judge' && ['submit_candidate', 'apply_check_result'].includes(capability.operation)) {
      return services.task?.dispatch(capability.operation, input ?? {}, envelope);
    }
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
export function createBuiltinServiceRegistry({ taskService, contextService, judgeService = null, customServices = [], logger = null } = {}) {
  const registry = new ServiceRegistry({ logger });
  const services = { task: taskService, context: contextService, judge: judgeService };
  for (const serviceId of ['task', 'context', 'judge']) {
    const tools = publicTools(serviceId);
    if (tools.length === 0) continue;
    registry.registerService({
      manifest: manifestForService(serviceId, tools),
      adapter: createInProcessAdapter({ invoke: serviceDispatch(serviceId, services, registry) }),
    });
  }
  registry.registerService({
    manifest: manifestForService('catalog', publicTools('catalog')),
    adapter: createInProcessAdapter({ invoke: serviceDispatch('catalog', services, registry) }),
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

export function builtInServiceManifest(serviceId) {
  const tools = publicTools(serviceId);
  return tools.length === 0 ? null : manifestForService(serviceId, tools);
}

