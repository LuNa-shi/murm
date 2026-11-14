const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'catalog_list_services', service: 'catalog', operation: 'list_services', version: '1.0',
    description: 'List every available SwarmEnv Service and its tool count.',
    scope: 'public-read', side_effect: false,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'catalog_get_service_metadata', service: 'catalog', operation: 'get_service_metadata', version: '1.0',
    description: 'Read one Service description and its complete named tool metadata.',
    scope: 'public-read', side_effect: false,
    parameters: { type: 'object', required: ['service'], properties: { service: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'catalog_list_tools', service: 'catalog', operation: 'list_tools', version: '1.0',
    description: 'List all named Service tools or only the tools owned by one Service.',
    scope: 'public-read', side_effect: false,
    parameters: { type: 'object', properties: { service: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'task_list', service: 'task', operation: 'list_tasks', version: '1.0',
    description: 'List the highest-priority eligible Tasks in a Mission.',
    scope: 'public-read', side_effect: false,
    parameters: { type: 'object', properties: { root_id: { type: 'string' }, states: { type: 'array', items: { type: 'string' } }, task_type: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, available_only: { type: 'boolean' } }, additionalProperties: false },
  },
  {
    name: 'execution_get', service: 'execution', operation: 'get_execution', version: '1.0',
    description: 'Read the current Execution lease, Workspace revision and checkpoint.',
    scope: 'execution-read', side_effect: false,
    parameters: { type: 'object', properties: { execution_id: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'workspace_get', service: 'workspace', operation: 'get_workspace', version: '1.0',
    description: 'Read the current Workspace materialization and revision.',
    scope: 'execution-read', side_effect: false,
    parameters: { type: 'object', additionalProperties: false },
  },
  {
    name: 'workspace_revisions', service: 'workspace', operation: 'list_workspace_revisions', version: '1.0',
    description: 'List Workspace revisions available to the current Execution.',
    scope: 'execution-read', side_effect: false,
    parameters: { type: 'object', additionalProperties: false },
  },
  {
    name: 'workspace_list_files', service: 'workspace', operation: 'list_workspace_files', version: '1.0',
    description: 'List project files in the current Workspace. Runtime metadata is excluded.',
    scope: 'execution-read', side_effect: false,
    parameters: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'workspace_read_file', service: 'workspace', operation: 'read_workspace_file', version: '1.0',
    description: 'Read a text file from the current Workspace.',
    scope: 'execution-read', side_effect: false,
    parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, max_bytes: { type: 'integer', minimum: 1, maximum: 10000000 } }, additionalProperties: false },
  },
  {
    name: 'workspace_write_file', service: 'workspace', operation: 'write_workspace_file', version: '1.0',
    description: 'Create or replace one project file in the current Workspace and save an auditable revision.',
    scope: 'execution-write', side_effect: true,
    parameters: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' }, expected_revision: { type: 'integer', minimum: 1 } }, additionalProperties: false },
  },
  {
    name: 'workspace_diff', service: 'workspace', operation: 'workspace_diff', version: '1.0',
    description: 'Show file hash changes between two Workspace revisions.',
    scope: 'execution-read', side_effect: false,
    parameters: { type: 'object', properties: { from_revision: { type: 'integer', minimum: 1 }, to_revision: { type: 'integer', minimum: 1 } }, additionalProperties: false },
  },
  {
    name: 'context_read', service: 'context', operation: 'read_materials', version: '1.0',
    description: 'Read immutable shared Materials published by other Executions.',
    scope: 'public-read', side_effect: false,
    parameters: { type: 'object', additionalProperties: true },
  },
  {
    name: 'context_consume', service: 'context', operation: 'consume_materials', version: '1.0',
    description: 'Record which bounded shared Material IDs this Execution used for a route, Task, Workspace source, or integration action.',
    scope: 'execution-write', side_effect: true,
    parameters: {
      type: 'object',
      required: ['material_ids', 'action'],
      properties: {
        material_ids: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1 } },
        action: { type: 'string', enum: ['route', 'task', 'workspace', 'integration'] },
        action_ref: { type: ['string', 'null'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'context_publish', service: 'context', operation: 'publish_material', version: '1.0',
    description: 'Publish a versioned shared Material for other Executions.',
    scope: 'execution-write', side_effect: true,
    parameters: { type: 'object', required: ['kind', 'scope', 'content'], properties: { kind: { type: 'string', enum: ['assumption', 'fact', 'conjecture', 'experience', 'failure', 'artifact', 'steer', 'check_result'] }, scope: { type: 'string' }, content: {}, evidence_state: { type: 'string', enum: ['proposed', 'observed', 'checked', 'accepted', 'rejected', 'stale'] } }, additionalProperties: true },
  },
  {
    name: 'judge_workspace_check', service: 'judge', operation: 'workspace_check', version: '1.0',
    description: 'Check a Workspace file reference against the configured checker and return a durable CheckResult.',
    scope: 'execution-write', side_effect: true,
    parameters: { type: 'object', required: ['revision', 'path'], properties: { workspace_id: { type: 'string', minLength: 1 }, revision: { type: 'string', pattern: '^\\d+\\.\\d+$' }, path: { type: 'string', minLength: 1 }, request_key: { type: 'string', minLength: 1 } }, additionalProperties: false },
  },
  {
    name: 'judge_get_check_result', service: 'judge', operation: 'get_check_result', version: '1.0',
    description: 'Read a Judge CheckResult, checker process status, result class, retryability, and diagnostic feedback.',
    scope: 'execution-read', side_effect: false,
    parameters: { type: 'object', properties: { check_result_id: { type: 'string' }, request_key: { type: 'string' } }, additionalProperties: false },
  },
]);

// The legacy catalog above remains available to internal adapters while the
// Agent-facing projection is deliberately small.  Runtime lease/liveness
// operations and the old structural Task vocabulary are not callable tools in
// a normal bound Agent profile.  The target operations use a stable semantic
// name even when an adapter temporarily maps them to an older implementation.
const publicTaskTools = [
  {
    name: 'bot_exit', service: 'task', operation: 'bot_exit', version: '1.0',
    description: 'End this unbound Bot after finding no useful work or exhausting its selection budget. Runtime releases the Core after confirmed cleanup.',
    scope: 'task-write', side_effect: true,
    parameters: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', enum: ['no-work', 'selection-budget'] } }, additionalProperties: false },
  },
  {
    name: 'task_status', service: 'task', operation: 'task_status', version: '1.0',
    description: 'Read the authoritative Mission, Task counts, eligible work, and observation timestamp.',
    scope: 'task-read', side_effect: false,
    parameters: { type: 'object', required: ['mission_id'], properties: { mission_id: { type: 'string' }, states: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer', minimum: 1, maximum: 500 } }, additionalProperties: false },
  },
  {
    name: 'task_take', service: 'task', operation: 'task_take', version: '1.0',
    description: 'Take an existing Mission or ordinary Task using the caller identity and Core lane.',
    scope: 'task-write', side_effect: true,
    parameters: { type: 'object', required: ['task_id'], properties: { task_id: { type: 'string' }, take_key: { type: 'string' }, input_material_refs: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
  },
  {
    name: 'task_feedback', service: 'task', operation: 'task_feedback', version: '1.0',
    description: 'Record this Execution\'s durable decision and action for delivered feedback; another Execution may retain its own handling state.',
    scope: 'task-write', side_effect: true,
    parameters: { type: 'object', required: ['notification_id', 'decision', 'action'], properties: { notification_id: { type: 'string' }, decision: { type: 'string' }, action: { type: 'string' }, details: { type: 'object' } }, additionalProperties: false },
  },
  {
    name: 'execution_progress', service: 'task', operation: 'execution_progress', version: '1.0',
    description: 'Save a bounded Progress Material and either continue the current Execution or hand it off.',
    scope: 'execution-write', side_effect: true,
    parameters: { type: 'object', required: ['kind', 'progress'], properties: {
      kind: { type: 'string', enum: ['checkpoint', 'handoff'] },
      progress: { type: 'object', required: ['completed_work', 'findings', 'open_questions', 'next_step'] },
      checkpoint: { type: 'object' },
      files: { type: 'object' },
      reason: { type: 'string' },
      summary: { type: 'string' },
    }, additionalProperties: false },
  },
  {
    name: 'task_list', service: 'task', operation: 'task_list', version: '1.0',
    description: 'List Mission Tasks and search their short summaries before proposing new work.',
    scope: 'task-read', side_effect: false,
    parameters: { type: 'object', properties: { mission_id: { type: 'string' }, query: { type: 'string' }, state: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
  },
  {
    name: 'task_view', service: 'task', operation: 'task_view', version: '1.0',
    description: 'Read one Task, its two relations, state, current Execution, and linked Materials.',
    scope: 'task-read', side_effect: false,
    parameters: { type: 'object', properties: { task_id: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'task_create', service: 'task', operation: 'task_create', version: '1.0',
    description: 'Create one substantial ordinary Task with a summary, expected output, acceptance condition, and optional relations.',
    scope: 'task-write', side_effect: true,
    parameters: {
      type: 'object',
      required: ['mission_id', 'summary', 'expected_output', 'acceptance_conditions'],
      properties: {
        mission_id: { type: 'string' },
        summary: { type: 'string' },
        goal: { type: 'string' },
        task_type: { type: 'string' },
        task_instructions: { type: 'string' },
        expected_output: { type: 'string' },
        acceptance_conditions: { oneOf: [{ type: 'array' }, { type: 'object' }] },
        required_capabilities: { type: 'array', items: { type: 'string', minLength: 1 } },
        completion_contract: { type: 'object' },
        workspace: { type: 'object' },
        input_material_refs: { type: 'array', items: { type: 'string' } },
        responsibility_key: { type: 'string', minLength: 1, maxLength: 256 },
        priority: { type: 'integer', minimum: 0 },
        spawned_from: { type: 'string' },
        depends_on: { type: 'array', items: { type: 'string' } },
        timebox_ms: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'task_link_material', service: 'task', operation: 'task_link_material', version: '1.0',
    description: 'Link an immutable Material to a Task with an input, response, handoff, or experience role.',
    scope: 'task-write', side_effect: true,
    parameters: { type: 'object', required: ['task_id', 'material_id', 'role'], properties: { task_id: { type: 'string' }, material_id: { type: 'string' }, role: { type: 'string', enum: ['input', 'response', 'handoff', 'experience'] }, receiving_task_id: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'task_finish', service: 'task', operation: 'task_finish', version: '1.0',
    description: 'Persist a finish intent (done, incomplete, blocked, or cancelled). Cleanup closes the Execution before the Task is released; inspect Task detail for closure.',
    scope: 'task-write', side_effect: true,
    parameters: { type: 'object', required: ['outcome'], properties: {
      outcome: { type: 'string', enum: ['done', 'incomplete', 'blocked', 'cancelled'] },
      material_ids: { type: 'array', items: { type: 'string' } }, check_result_id: { type: 'string' },
      handoff_material_id: { type: 'string' }, blocker: { type: 'object' }, dependency: { type: 'object' }, wait_for: { type: ['string', 'object'] }, replacement_task_id: { type: 'string' }, reason: { type: 'string' },
    }, additionalProperties: false },
  },

];

const publicContextTools = [
  {
    name: 'context_search_materials', service: 'context', operation: 'context_search_materials', version: '1.0',
    description: 'Search shared immutable Materials by summary, role, Task, producer, or Mission.',
    scope: 'context-read', side_effect: false,
    parameters: { type: 'object', properties: { mission_id: { type: 'string' }, query: { type: 'string' }, role: { type: 'string' }, task_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
  },
  {
    name: 'context_get_material', service: 'context', operation: 'context_get_material', version: '1.0',
    description: 'Read one immutable Material and its producer Task/Execution provenance.',
    scope: 'context-read', side_effect: false,
    parameters: { type: 'object', required: ['material_id'], properties: { material_id: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'context_publish_material', service: 'context', operation: 'context_publish_material', version: '1.0',
    description: 'Publish durable Response, Handoff, or Experience Material with current Task/Execution provenance.',
    scope: 'context-write', side_effect: true,
    parameters: { type: 'object', required: ['role', 'content'], properties: {
      role: { type: 'string', enum: ['response', 'handoff', 'experience'] },
      kind: { type: 'string', description: 'Material kind, for example fact, experience, failure, or artifact.' },
      scope: { type: 'string', description: 'The bounded collaboration or proof scope for the Material.' },
      evidence_state: { type: 'string', enum: ['proposed', 'observed', 'checked', 'accepted', 'rejected', 'stale'] },
      content: {}, summary: { type: 'string' }, receiving_task_id: { type: 'string' },
      // A revised Workspace artifact must be able to identify the failed source it
      // replaces; without this field the Agent cannot record repair lineage.
      supersedes: { type: 'string' },
    }, additionalProperties: false },
  },
];

// Workspace is a Runtime-owned capability attached to the bound Task, not a
// separately registered external Service. Keep the stable workspace tool
// names for the Agent bridge, but project them under Task with an explicit
// capability marker so discovery has one Task boundary.
const publicWorkspaceTools = TOOL_DEFINITIONS
  .filter((tool) => tool.service === 'workspace')
  .map((tool) => ({ ...tool, service: 'task', capability: 'workspace' }));
const publicMissionWorkspaceTools = [
  { name: 'workspace_public_view', service: 'task', operation: 'workspace_public_view', version: '1.0',
    description: 'Read the public Mission Workspace and current main.', scope: 'mission-read', side_effect: false, capability: 'mission-workspace',
    parameters: { type: 'object', required: ['workspace_id'], properties: { workspace_id: { type: 'string' } }, additionalProperties: false } },
  { name: 'workspace_public_history', service: 'task', operation: 'workspace_public_history', version: '1.0',
    description: 'Read main history by default or all saved revisions, with provenance and bounded snapshot pagination.', scope: 'mission-read', side_effect: false, capability: 'mission-workspace',
    parameters: { type: 'object', required: ['workspace_id'], properties: { workspace_id: { type: 'string' }, all: { type: 'boolean' }, source_task: { type: 'string' }, source_execution: { type: 'string' }, path: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string' } }, additionalProperties: false } },
  { name: 'workspace_status', service: 'task', operation: 'workspace_status', version: '1.0',
    description: 'Inspect the current E tree, initial revision and saved lineage.', scope: 'execution-read', side_effect: false, capability: 'mission-workspace',
    parameters: { type: 'object', required: [], properties: {  }, additionalProperties: false } },
  { name: 'workspace_current_diff', service: 'task', operation: 'workspace_current_diff', version: '1.0',
    description: 'Compare the current E tree with its last saved revision.', scope: 'execution-read', side_effect: false, capability: 'mission-workspace',
    parameters: { type: 'object', required: [], properties: {  }, additionalProperties: false } },
  {
    name: 'mission_get', service: 'task', operation: 'mission_get', version: '1.0',
    description: 'Read the current Mission goal and acceptance conditions.',
    scope: 'mission-read', side_effect: false,
    parameters: { type: 'object', required: ['mission_id'], properties: { mission_id: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'workspace_public_files', service: 'task', operation: 'workspace_public_files', version: '1.0',
    description: 'List files in the immutable Mission Workspace revision before a Task is taken.',
    scope: 'mission-read', side_effect: false, capability: 'mission-workspace',
    parameters: { type: 'object', required: ['workspace_id'], properties: { workspace_id: { type: 'string' }, revision: { type: 'string' }, path: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'workspace_public_read', service: 'task', operation: 'workspace_public_read', version: '1.0',
    description: 'Read one file from an immutable Mission Workspace revision before a Task is taken.',
    scope: 'mission-read', side_effect: false, capability: 'mission-workspace',
    parameters: { type: 'object', required: ['workspace_id', 'path'], properties: { workspace_id: { type: 'string' }, revision: { type: 'string' }, path: { type: 'string' }, max_bytes: { type: 'integer', minimum: 1, maximum: 10000000 } }, additionalProperties: false },
  },
  {
    name: 'workspace_public_search', service: 'task', operation: 'workspace_public_search', version: '1.0',
    description: 'Search text in an immutable Mission Workspace revision before a Task is taken.',
    scope: 'mission-read', side_effect: false, capability: 'mission-workspace',
    parameters: { type: 'object', required: ['workspace_id', 'query'], properties: { workspace_id: { type: 'string' }, revision: { type: 'string' }, path: { type: 'string' }, query: { type: 'string' }, max_results: { type: 'integer', minimum: 1, maximum: 500 } }, additionalProperties: false },
  },
  {
    name: 'workspace_public_apply', service: 'task', operation: 'workspace_public_apply', version: '1.0',
    description: 'Apply a fixed public revision by three-way merge into the current E, retaining conflicts and parents.',
    scope: 'execution-write', side_effect: true, capability: 'mission-workspace',
    parameters: { type: 'object', required: ['from'], properties: { from: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'workspace_save', service: 'task', operation: 'workspace_save', version: '1.0',
    description: 'Save a complete public Mission Workspace file tree as an immutable revision without advancing main.',
    scope: 'execution-write', side_effect: true, capability: 'mission-workspace',
    parameters: { type: 'object', properties: { resolved: { type: 'boolean' } }, additionalProperties: false },
  },
  {
    name: 'workspace_merge', service: 'task', operation: 'workspace_merge', version: '1.0',
    description: 'Conditionally merge one complete public Workspace revision into main after conflict and check validation.',
    scope: 'execution-write', side_effect: true, capability: 'mission-workspace',
    parameters: { type: 'object', required: ['workspace_id', 'from_revision', 'expected_main_revision'], properties: { workspace_id: { type: 'string' }, from_revision: { type: 'string' }, expected_main_revision: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'mission_submit', service: 'task', operation: 'mission_submit', version: '1.0',
    description: 'Freeze the selected Workspace main revision and immutable Material/checker inputs for Mission acceptance.',
    scope: 'mission-write', side_effect: true, capability: 'mission-coordination',
    parameters: { type: 'object', required: ['mission_id', 'workspace_id', 'main_revision', 'actor_ref'], properties: { mission_id: { type: 'string' }, workspace_id: { type: 'string' }, main_revision: { type: 'string' }, material_ids: { type: 'array', items: { type: 'string' } }, checker: { type: ['string', 'null'] }, environment: { type: ['string', 'null'] }, acceptance: { type: 'object' }, actor_ref: { type: 'string' }, request_id: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'mission_submission_get', service: 'task', operation: 'mission_submission_get', version: '1.0',
    description: 'Read the durable Mission submission state and its immutable acceptance snapshot.',
    scope: 'mission-read', side_effect: false, capability: 'mission-coordination',
    parameters: { type: 'object', required: ['mission_id'], properties: { mission_id: { type: 'string' }, submission_id: { type: 'string' } }, additionalProperties: false },
  },
];
const publicJudgeTools = TOOL_DEFINITIONS.filter((tool) => tool.service === 'judge');
const publicCatalogTools = TOOL_DEFINITIONS.filter((tool) => tool.service === 'catalog');

// These definitions remain available to internal Runtime/Task Service callers,
// but they are not part of the Agent-facing fallback projection. Runtime owns
// the Execution lease/liveness controls; modern Mission Tasks use the semantic
// entries above and the Registry-backed profile.
const SERVICE_DEFINITIONS = Object.freeze([
  {
    name: 'task',
    version: '1.0',
    description: 'Task goals, Mission-scoped Material links, semantic completion, explicit dependencies, and canonical task_take.',
    tools: [...publicTaskTools, ...publicWorkspaceTools, ...publicMissionWorkspaceTools],
  },
  { name: 'execution', version: '1.0', description: 'Internal Execution lease, heartbeat, wait, and lifecycle metadata.', tools: TOOL_DEFINITIONS.filter((tool) => tool.service === 'execution') },
  { name: 'workspace', version: '1.0', description: 'Runtime-owned Workspace materialization, revisions, and checkpoint lineage.', tools: TOOL_DEFINITIONS.filter((tool) => tool.service === 'workspace') },
  {
    name: 'context',
    version: '1.0',
    description: 'Shared immutable Materials with producer provenance and semantic collaboration roles.',
    tools: [...TOOL_DEFINITIONS.filter((tool) => tool.service === 'context'), ...publicContextTools],
  },
  { name: 'judge', version: '1.0', description: 'Workspace file checks and independent completion results.', tools: publicJudgeTools },
  { name: 'catalog', version: '1.0', description: 'Service and named tool discovery metadata.', tools: publicCatalogTools },
]);

function clone(value) {
  return structuredClone(value);
}

export function isLegacyAgentSurface(tool, { runtimeOwned = false } = {}) {
  return false;
}

function normalizeCatalogOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return { includeInternal: false };
  return { includeInternal: options.includeInternal === true };
}

function deduplicateNamedTools(tools) {
  const byName = new Map();
  for (const tool of tools) byName.set(tool.name, tool);
  return [...byName.values()];
}

function toolsForService(service, options) {
  const { includeInternal } = normalizeCatalogOptions(options);
  const tools = includeInternal
    ? service.tools
    : deduplicateNamedTools(service.tools.filter((tool) => !isLegacyAgentSurface(tool)));
  return clone(tools);
}

export function listServices(options = {}) {
  const { includeInternal } = normalizeCatalogOptions(options);
  return clone(SERVICE_DEFINITIONS.map(({ name, version, description, tools }) => ({
    name,
    version,
    description,
    tool_count: includeInternal
      ? tools.length
      : deduplicateNamedTools(tools.filter((tool) => !isLegacyAgentSurface(tool))).length,
  })));
}

export function getServiceMetadata(name, options = {}) {
  const service = SERVICE_DEFINITIONS.find((candidate) => candidate.name === name);
  return service ? { ...clone(service), tools: toolsForService(service, options) } : null;
}

export function listTools(service = null, options = {}) {
  const selected = service === null
    ? SERVICE_DEFINITIONS.flatMap((definition) => definition.tools)
    : SERVICE_DEFINITIONS.find((definition) => definition.name === service)?.tools ?? [];
  const { includeInternal } = normalizeCatalogOptions(options);
  return clone(includeInternal
    ? selected
    : deduplicateNamedTools(selected.filter((tool) => !isLegacyAgentSurface(tool))));
}

export function serviceCatalog(options = {}) {
  return { services: listServices(options), tools: listTools(null, options) };
}
