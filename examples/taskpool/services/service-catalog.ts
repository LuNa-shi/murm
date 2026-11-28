const TASK_PRIORITY = { oneOf: [{ type: 'string', enum: ['high', 'medium', 'low'] }, { type: 'integer', minimum: 0, maximum: 2 }] };
const TASK_REVISION_FIELDS = {
  summary: { type: 'string', minLength: 1, maxLength: 240 },
  gap: { type: 'string', minLength: 1, maxLength: 4000 },
  expected_output: { type: 'string', minLength: 1, maxLength: 4000 },
  acceptance_conditions: { oneOf: [{ type: 'array', minItems: 1 }, { type: 'object', minProperties: 1 }] },
  priority: TASK_PRIORITY,
  depends_on: { type: 'array', items: { type: 'string' } },
  input_material_refs: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 100 },
  workspace: { type: 'object' },
  base_revision: { type: 'string', pattern: '^[0-9]+[.][0-9]+$' },
  task_instructions: { type: 'string' },
};

const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'catalog_list_services', service: 'catalog', operation: 'list_services', version: '1.0',
    description: 'List every available murm Service and its tool count.',
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
    name: 'read_materials', service: 'context', operation: 'read_materials', version: '1.0',
    description: 'List one page of shared Material summaries. Use an exact Material ID to read its complete content.',
    scope: 'public-read', side_effect: false,
    parameters: { type: 'object', properties: { mission_id: { type: 'string' }, material_id: { type: 'string' }, task_id: { type: 'string' },
      producer_task_id: { type: 'string' }, producer_execution_id: { type: 'string' }, include_history: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'consume_materials', service: 'context', operation: 'consume_materials', version: '1.0',
    description: 'Record which bounded shared Material IDs this Execution used for a route, Task, Workspace source, or integration action.',
    scope: 'execution-write', side_effect: true,
    parameters: {
      type: 'object',
      required: ['material_ids', 'action', 'impact'],
      properties: {
        material_ids: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1 } },
        action: { type: 'string', enum: ['route', 'task', 'workspace', 'integration'] },
        impact: { type: 'string', minLength: 1, maxLength: 2000 },
        action_ref: { type: ['string', 'null'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'judge_workspace_check', service: 'judge', operation: 'workspace_check', version: '1.0',
    description: 'Build a fixed public Lean Workspace revision when project checking is configured. An optional path identifies a checked delivery file. Legacy single-file checkers require a path.',
    scope: 'execution-write', side_effect: true,
    parameters: { type: 'object', required: ['revision'], properties: { workspace_id: { type: 'string', minLength: 1 }, revision: { type: 'string', pattern: '^\\d+\\.\\d+$' }, path: { type: 'string', minLength: 1 }, check_mode: { type: 'string', enum: ['lean-project', 'lean-module'] }, request_key: { type: 'string', minLength: 1 } }, additionalProperties: false },
  },
  {
    name: 'judge_get_check_result', service: 'judge', operation: 'get_check_result', version: '1.0',
    description: 'Read a Judge CheckResult, checker process status, result class, retryability, and diagnostic feedback.',
    scope: 'execution-read', side_effect: false,
    parameters: { type: 'object', properties: { check_result_id: { type: 'string' }, request_key: { type: 'string' } }, additionalProperties: false },
  },
]);

// Runtime-owned tools are kept in the service catalog for authenticated internal calls.
const publicTaskTools = [
  {
    name: 'agent_exit', service: 'task', operation: 'agent_exit', version: '1.0',
    description: 'End this unbound Agent after finding no useful work or exhausting its selection budget. Runtime releases the Core after confirmed cleanup.',
    scope: 'task-write', side_effect: true,
    parameters: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', enum: ['no-work', 'selection-budget'] } }, additionalProperties: false },
  },
  {
    name: 'task_status', service: 'task', operation: 'task_status', version: '1.0',
    description: 'Read Mission counts and bounded Task and eligibility previews; use Task list to continue discovery.',
    scope: 'task-read', side_effect: false,
    parameters: { type: 'object', required: ['mission_id'], properties: { mission_id: { type: 'string' }, states: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
  },
  {
    name: 'task_take', service: 'task', operation: 'task_take', version: '1.0',
    description: 'Take an existing Task in this Mission using the caller Agent and Core.',
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
    name: 'task_list', service: 'task', operation: 'task_list', version: '1.0',
    description: 'Search bounded Task summaries across states; follow next_cursor and read Task detail before taking work.',
    scope: 'task-read', side_effect: false,
    parameters: { type: 'object', properties: { mission_id: { type: 'string' }, query: { type: 'string' }, state: { type: 'string' }, states: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 16 }, available_only: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'task_view', service: 'task', operation: 'task_view', version: '1.0',
    description: 'Read a Task contract, gap and priority, dependencies, Executions and Materials. Continue contract history using contract_history_page.next_after_version.',
    scope: 'task-read', side_effect: false,
    parameters: { type: 'object', properties: { task_id: { type: 'string' }, contract_history_after_version: { type: 'integer', minimum: 0 }, contract_history_limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
  },
  {
    name: 'task_create', service: 'task', operation: 'task_create', version: '1.0',
    description: 'Propose one independently useful responsibility with a short summary, Mission gap, output, completion conditions and explicit high/medium/low priority. Agent proposals require explicit Harness registration and current Mission authority. Optional base_revision pins input; otherwise take uses main.',
    scope: 'task-write', side_effect: true,
    parameters: {
      type: 'object',
      required: ['summary', 'gap', 'expected_output', 'acceptance_conditions', 'priority'],
      properties: {
        mission_id: { type: 'string' },
        ...TASK_REVISION_FIELDS,
        goal: { type: 'string' },
        required_capabilities: { type: 'array', items: { type: 'string', minLength: 1 } },
        completion_contract: { type: 'object' },
        workspace: { type: 'object', description: 'Compatibility input. If both workspace.revision and base_revision are supplied, they must match.' },
        responsibility_key: { type: 'string', minLength: 1, maxLength: 256 },
        timebox_ms: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'task_revise', service: 'task', operation: 'task_revise', version: '1.0',
    description: 'An UNBOUND Agent may revise an open, unowned Task in its Mission, including previously executed work. Supply observed contract/state versions and a reason. Running, preparing, cleaning up and closed responsibilities are protected; old Executions retain their original contract.',
    scope: 'task-write', side_effect: true,
    parameters: { type: 'object', required: ['task_id', 'expected_spec_version', 'expected_state_version', 'reason', 'changes'], properties: {
      task_id: { type: 'string' }, expected_spec_version: { type: 'integer', minimum: 1 }, expected_state_version: { type: 'integer', minimum: 0 },
      reason: { type: 'string', minLength: 1 }, changes: { type: 'object', minProperties: 1, properties: TASK_REVISION_FIELDS, additionalProperties: false },
    }, additionalProperties: false },
  },
  {
    name: 'task_link_material', service: 'task', operation: 'task_link_material', version: '1.0',
    description: 'Link an immutable Material to a Task. For a response, use the receiving Task as task_id; the authenticated Execution supplies the producer. An input link targets the current Task.',
    scope: 'task-write', side_effect: true,
    parameters: { type: 'object', required: ['task_id', 'material_id', 'role'], properties: { task_id: { type: 'string' }, material_id: { type: 'string' }, role: { type: 'string', enum: ['input', 'response', 'handoff', 'experience'] }, receiving_task_id: { type: 'string', description: 'For a response this field is optional and must equal task_id when provided.' } }, additionalProperties: false },
  },
  {
    name: 'task_finish', service: 'task', operation: 'task_finish', version: '1.0',
    description: 'Persist a finish intent (done, incomplete, blocked, or cancelled). Cleanup closes the Execution before the Task is released; inspect Task detail for closure.',
    scope: 'task-write', side_effect: true,
    parameters: { type: 'object', required: ['outcome'], properties: {
      outcome: { type: 'string', enum: ['done', 'incomplete', 'blocked', 'cancelled'] },
      material_ids: { type: 'array', items: { type: 'string' } }, workspace_revision: { type: 'string' }, check_result_id: { type: 'string' },
      handoff_material_id: { type: 'string' }, blocker: { type: 'object' }, wait_for: { type: 'string' }, replacement_task_id: { type: 'string' }, reason: { type: 'string' },
    }, additionalProperties: false },
  },

  {
    name: 'task_cancel', service: 'task', operation: 'task_cancel', version: '1.0',
    description: 'An UNBOUND Agent may cancel an open, unowned Task in its Mission using observed versions and a reason. Historical contracts remain readable; cancellation does not satisfy dependencies.',
    scope: 'mission-write', side_effect: true,
    parameters: { type: 'object', required: ['task_id', 'expected_spec_version', 'expected_state_version', 'reason'], properties: {
      task_id: { type: 'string' }, expected_spec_version: { type: 'integer', minimum: 1 }, expected_state_version: { type: 'integer', minimum: 0 },
      reason: { type: 'string' }, replacement_task_id: { type: 'string' },
    }, additionalProperties: false },
  },
  {
    name: 'task_dependency_replace', service: 'task', operation: 'task_dependency_replace', version: '1.0',
    description: 'Replace one cancelled prerequisite of an unowned blocked Task, preserving every other dependency and historical edge.',
    scope: 'mission-write', side_effect: true,
    parameters: { type: 'object', required: ['task_id', 'from_task_id', 'to_task_id', 'expected_spec_version', 'expected_state_version', 'reason'], properties: {
      task_id: { type: 'string' }, from_task_id: { type: 'string' }, to_task_id: { type: 'string' },
      expected_spec_version: { type: 'integer', minimum: 1 }, expected_state_version: { type: 'integer', minimum: 0 }, reason: { type: 'string' },
    }, additionalProperties: false },
  },

];

const publicContextTools = [
  ...['dispute', 'supersede', 'unsupersede'].map((action: any) => ({
    name: `material_${action}`, service: 'context', operation: `material_${action}`, version: '1.0',
    description: action === 'dispute' ? 'Record a specific claim or section and the reason it needs correction; keep the Material visible.'
      : action === 'supersede' ? 'Replace an entire Material with a complete successor using its observed relation_version.'
        : 'Revoke only the matching successor using the observed relation_version and a reason; preserve all history.',
    scope: 'context-write', side_effect: true,
    parameters: { type: 'object', required: action === 'dispute' ? ['material_id', 'claim', 'reason']
      : ['material_id', 'replacement_material_id', 'expected_version', 'reason'], properties: {
      material_id: { type: 'string' }, reason: { type: 'string' },
      ...(action === 'dispute' ? { claim: { type: 'string' } } : {
        replacement_material_id: { type: 'string' }, expected_version: { type: 'integer', minimum: 0 },
      }),
    }, additionalProperties: false },
  })),

  {
    name: 'context_search_materials', service: 'context', operation: 'context_search_materials', version: '1.0',
    description: 'Search immutable Material summaries by keyword, Task, producer, or Mission. Follow continuation cursors and read exact IDs for full content.',
    scope: 'context-read', side_effect: false,
    parameters: { type: 'object', properties: { mission_id: { type: 'string' }, query: { type: 'string' }, task_id: { type: 'string' },
      producer_task_id: { type: 'string' }, producer_execution_id: { type: 'string' }, include_history: { type: 'boolean' },
      relation_kind: { type: 'string', enum: ['supersede', 'dispute'] }, related_material_id: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'context_get_material', service: 'context', operation: 'context_get_material', version: '1.0',
    description: 'Read one immutable Material and its producer Task/Execution provenance.',
    scope: 'context-read', side_effect: false,
    parameters: { type: 'object', required: ['material_id'], properties: { material_id: { type: 'string' }, attachment_name: { type: 'string' },
      usage_limit: { type: 'integer', minimum: 1, maximum: 100 }, usage_cursor: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'context_publish_material', service: 'context', operation: 'context_publish_material', version: '1.0',
    description: 'Publish immutable research content and optional attachments with current Task/Execution provenance. Explain evidence in the body where applicable.',
    scope: 'context-write', side_effect: true,
    parameters: { type: 'object', required: ['content'], properties: {
      content: {}, title: { type: 'string', maxLength: 120 }, summary: { type: 'string', maxLength: 500 },
      media_type: { type: 'string' }, receiving_task_id: { type: 'string' },
      used_material_ids: { type: 'array', maxItems: 100, items: { type: 'string' } },
      attachments: { type: 'array', maxItems: 16, items: { type: 'object', required: ['name'],
        properties: { name: { type: 'string' }, media_type: { type: 'string' }, content_base64: { type: 'string' },
          content_hash: { type: 'string' }, source: { type: 'object', required: ['material_id', 'attachment_name'],
            properties: { material_id: { type: 'string' }, attachment_name: { type: 'string' } }, additionalProperties: false } }, additionalProperties: false } },
      supersedes: { type: 'string' }, expected_version: { type: 'integer', minimum: 0 }, supersede_reason: { type: 'string' },
    }, additionalProperties: false },
  },
];

// Workspace is a Runtime-owned capability attached to the bound Task, not a
// separately registered external Service. Keep the stable workspace tool
// names for the Agent bridge, but project them under Task with an explicit
// capability marker so discovery has one Task boundary.
const publicWorkspaceTools = TOOL_DEFINITIONS
  .filter((tool: any) => tool.service === 'workspace')
  .map((tool: any) => ({ ...tool, service: 'task', capability: 'workspace' }));
const publicMissionWorkspaceTools = [
  { name: 'workspace_public_view', service: 'task', operation: 'workspace_public_view', version: '1.0',
    description: 'Read the public Mission Workspace and current main.', scope: 'mission-read', side_effect: false, capability: 'mission-workspace',
    parameters: { type: 'object', required: ['workspace_id'], properties: { workspace_id: { type: 'string' } }, additionalProperties: false } },
  { name: 'workspace_public_history', service: 'task', operation: 'workspace_public_history', version: '1.0',
    description: 'Read main history by default or all saved revisions, with provenance and bounded snapshot pagination.', scope: 'mission-read', side_effect: false, capability: 'mission-workspace',
    parameters: { type: 'object', required: ['workspace_id'], properties: { workspace_id: { type: 'string' }, all: { type: 'boolean' }, producer_task_id: { type: 'string' }, producer_execution_id: { type: 'string' }, material_id: { type: 'string' }, path: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string' } }, additionalProperties: false } },
  { name: 'workspace_public_diff', service: 'task', operation: 'workspace_public_diff', version: '1.0',
    description: 'Compare any two published Mission Workspace revisions, including unmerged saves. Pages pin both revisions.',
    scope: 'mission-read', side_effect: false, capability: 'mission-workspace',
    parameters: { type: 'object', required: ['workspace_id', 'from', 'to'], properties: { workspace_id: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, path: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string' } }, additionalProperties: false } },
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
    parameters: { type: 'object', required: ['workspace_id'], properties: { workspace_id: { type: 'string' }, revision: { type: 'string' }, path: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string' } }, additionalProperties: false },
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
    parameters: { type: 'object', required: ['workspace_id', 'query'], properties: { workspace_id: { type: 'string' }, revision: { type: 'string' }, path: { type: 'string' }, query: { type: 'string', maxLength: 1024 }, max_results: { type: 'integer', minimum: 1, maximum: 500 }, cursor: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'workspace_save', service: 'task', operation: 'workspace_save', version: '1.0',
    description: 'Save a complete public Mission Workspace file tree as an immutable revision without advancing main.',
    scope: 'execution-write', side_effect: true, capability: 'mission-workspace',
    parameters: { type: 'object', properties: { resolved: { type: 'boolean' }, material_ids: { type: 'array', maxItems: 20, uniqueItems: true, items: { type: 'string' } } }, additionalProperties: false },
  },
  {
    name: 'workspace_merge', service: 'task', operation: 'workspace_merge', version: '1.0',
    description: 'Conditionally merge one complete public Workspace revision into main after conflict and check validation.',
    scope: 'execution-write', side_effect: true, capability: 'mission-workspace',
    parameters: { type: 'object', required: ['from'], properties: { from: { type: 'string', pattern: '^\\d+\\.\\d+$' } }, additionalProperties: false },
  },
  {
    name: 'mission_submit', service: 'task', operation: 'mission_submit', version: '1.0',
    description: 'Freeze the selected Workspace main revision and immutable Material/checker inputs for Mission acceptance.',
    scope: 'mission-write', side_effect: true, capability: 'mission-coordination',
    parameters: { type: 'object', required: ['material_ids'], properties: { material_ids: { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string' } } }, additionalProperties: false },
  },
  {
    name: 'mission_submission_get', service: 'task', operation: 'mission_submission_get', version: '1.0',
    description: 'Read the durable Mission submission state and its immutable acceptance snapshot.',
    scope: 'mission-read', side_effect: false, capability: 'mission-coordination',
    parameters: { type: 'object', required: ['mission_id'], properties: { mission_id: { type: 'string' }, submission_id: { type: 'string' } }, additionalProperties: false },
  },
];
const publicJudgeTools = TOOL_DEFINITIONS.filter((tool: any) => tool.service === 'judge');
const publicCatalogTools = TOOL_DEFINITIONS.filter((tool: any) => tool.service === 'catalog');

const SERVICE_DEFINITIONS = Object.freeze([
  {
    name: 'task',
    version: '1.0',
    description: 'Task goals, Mission-scoped Material links, semantic completion, explicit dependencies, and canonical task_take.',
    tools: [...publicTaskTools, ...publicMissionWorkspaceTools],
  },
  { name: 'execution', version: '1.0', description: 'Internal Execution lease, heartbeat, wait, and lifecycle metadata.', tools: TOOL_DEFINITIONS.filter((tool: any) => tool.service === 'execution') },
  { name: 'workspace', version: '1.0', description: 'Runtime-owned Workspace materialization, revisions, and checkpoint lineage.', tools: TOOL_DEFINITIONS.filter((tool: any) => tool.service === 'workspace') },
  {
    name: 'context',
    version: '1.0',
    description: 'Shared immutable Materials with producer provenance and semantic collaboration roles.',
    tools: [...TOOL_DEFINITIONS.filter((tool: any) => tool.service === 'context'), ...publicContextTools],
  },
  { name: 'judge', version: '1.0', description: 'Workspace file checks and independent completion results.', tools: publicJudgeTools },
  { name: 'catalog', version: '1.0', description: 'Service and named tool discovery metadata.', tools: publicCatalogTools },
]);

function clone(value: any) {
  return structuredClone(value);
}


function normalizeCatalogOptions(options: any) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return { includeInternal: false };
  return { includeInternal: options.includeInternal === true };
}

function deduplicateNamedTools(tools: any) {
  const byName = new Map();
  for (const tool of tools) byName.set(tool.name, tool);
  return [...byName.values()];
}

function toolsForService(service: any, options: any) {
  const { includeInternal } = normalizeCatalogOptions(options);
  const tools = includeInternal || !['execution', 'workspace'].includes(service.name)
    ? service.tools
    : [];
  return clone(tools);
}

export function listServices(options: any = {}) {
  const { includeInternal } = normalizeCatalogOptions(options);
  return clone(SERVICE_DEFINITIONS.map(({ name, version, description, tools }: any) => ({
    name,
    version,
    description,
    tool_count: includeInternal
      ? tools.length
      : deduplicateNamedTools(['execution', 'workspace'].includes(name) ? [] : tools).length,
  })));
}

export function getServiceMetadata(name: any, options: any = {}) {
  const service = SERVICE_DEFINITIONS.find((candidate: any) => candidate.name === name);
  return service ? { ...clone(service), tools: toolsForService(service, options) } : null;
}

export function listTools(service: any = null, options: any = {}) {
  const selected = service === null
    ? SERVICE_DEFINITIONS.flatMap((definition: any) => definition.tools)
    : SERVICE_DEFINITIONS.find((definition: any) => definition.name === service)?.tools ?? [];
  const { includeInternal } = normalizeCatalogOptions(options);
  return clone(includeInternal
    ? selected
    : deduplicateNamedTools(selected.filter((tool: any) => !['execution', 'workspace'].includes(tool.service))));
}

export function serviceCatalog(options: any = {}) {
  return { services: listServices(options), tools: listTools(null, options) };
}
