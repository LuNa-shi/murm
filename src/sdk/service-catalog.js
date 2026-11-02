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
    description: 'List the highest-priority claimable Tasks in a root Task tree.',
    scope: 'public-read', side_effect: false,
    parameters: { type: 'object', properties: { root_id: { type: 'string' }, states: { type: 'array', items: { type: 'string' } }, task_type: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, available_only: { type: 'boolean' } }, additionalProperties: false },
  },
  {
    name: 'task_create_child', service: 'task', operation: 'create_child_task', version: '1.0',
    description: 'Create a bounded direct child Task for a genuinely separate responsibility.',
    scope: 'execution-write', side_effect: true,
    parameters: { type: 'object', required: ['child_creation_key', 'task_type', 'goal', 'expected_output', 'acceptance_conditions'], properties: { child_creation_key: { type: 'string' }, task_type: { type: 'string' }, goal: { type: 'string' }, expected_output: { type: 'string' }, acceptance_conditions: { type: 'object' }, priority: { type: 'integer', minimum: 0 } }, additionalProperties: true },
  },
  {
    name: 'task_create_branch_group', service: 'task', operation: 'create_branch_group', version: '1.0',
    description: 'Create a versioned group of alternative ordinary Tasks. Branch membership expresses alternatives; it does not create an implicit wait, ownership, or execution dependency, and the creating Task may continue useful work.',
    scope: 'execution-write', side_effect: true,
    parameters: { type: 'object', required: ['parent_task_id', 'branch_tasks'], properties: { parent_task_id: { type: 'string' }, branch_tasks: { type: 'array', items: { type: 'object' } }, group_key: { type: 'string' }, expected_structural_version: { type: 'integer', minimum: 0 } }, additionalProperties: true },
  },
  {
    name: 'task_add_required_subtask', service: 'task', operation: 'add_required_subtask', version: '1.0',
    description: 'Add an ordinary Task as a jointly required subtask. Required subtasks may become ready concurrently; only an explicit execution dependency blocks work, and provenance remains audit information.',
    scope: 'execution-write', side_effect: true,
    parameters: { type: 'object', required: ['owner_task_id'], properties: { owner_task_id: { type: 'string' }, subtask_task_id: { type: 'string' }, subtask: { type: 'object' }, expected_structural_version: { type: 'integer', minimum: 0 } }, additionalProperties: true },
  },
  {
    name: 'task_get_structure', service: 'task', operation: 'get_task_structure', version: '1.0',
    description: 'Inspect a Task structure in one view: alternative branches, jointly required subtasks, explicit execution dependencies, creation provenance, completion status, unresolved work, and structural version.',
    scope: 'task-read', side_effect: false,
    parameters: { type: 'object', properties: { task_id: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'task_propose_structure_change', service: 'task', operation: 'propose_structure_change', version: '1.0',
    description: 'Propose an auditable, version-checked Task structure change based on new evidence. Structural membership, explicit execution dependencies, and creation provenance stay distinct; active work is preserved.',
    scope: 'execution-write', side_effect: true,
    parameters: { type: 'object', required: ['task_id', 'change'], properties: { task_id: { type: 'string' }, expected_structural_version: { type: 'integer', minimum: 0 }, change: { type: 'object' }, change_key: { type: 'string' } }, additionalProperties: true },
  },
  {
    name: 'task_explain_readiness', service: 'task', operation: 'explain_task_readiness', version: '1.0',
    description: 'Explain why a Task is READY, BLOCKED, or SATISFIED, including missing contract evidence and explicit dependencies; branch alternatives and required subtasks are not generic waits.',
    scope: 'task-read', side_effect: false,
    parameters: { type: 'object', properties: { task_id: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'task_create_rework', service: 'task', operation: 'create_rework_task', version: '1.0',
    description: 'Create a new rework Task linked to a prior deliverable, feedback, Materials, and Workspace lineage. Rework reuses prior evidence through explicit provenance and does not silently reopen the old Execution.',
    scope: 'execution-write', side_effect: true,
    parameters: { type: 'object', required: ['prior_task_id'], properties: { prior_task_id: { type: 'string' }, instruction: { type: 'string' }, feedback: {}, input_material_refs: { type: 'array', items: { type: 'string' } }, workspace_source_execution_id: { type: 'string' }, workspace_revision: { type: 'integer', minimum: 1 } }, additionalProperties: true },
  },
  {
    name: 'task_accept', service: 'task', operation: 'accept_task', version: '1.0',
    description: 'Complete a Task whose own completion contract is satisfied. A parent review is required only when the target contract explicitly sets parent_review=true; otherwise the current Task owner may accept its own work after reading the evidence.',
    scope: 'execution-write', side_effect: true,
    parameters: { type: 'object', required: ['target_task_id'], properties: { target_task_id: { type: 'string' }, target_state_version: { type: 'integer', minimum: 0 } }, additionalProperties: false },
  },
  {
    name: 'task_request_rework', service: 'task', operation: 'request_rework', version: '1.0',
    description: 'Send a child Task back for focused rework with a durable steer Material. The child must be WAITING for parent_review; leave OPEN or RUNNING children with their worker.',
    scope: 'execution-write', side_effect: true,
    parameters: { type: 'object', required: ['target_task_id', 'instruction'], properties: { target_task_id: { type: 'string' }, instruction: { type: 'string' }, scope: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'execution_get', service: 'execution', operation: 'get_execution', version: '1.0',
    description: 'Read the current Execution lease, Workspace revision and checkpoint.',
    scope: 'execution-read', side_effect: false,
    parameters: { type: 'object', properties: { execution_id: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'execution_heartbeat', service: 'execution', operation: 'heartbeat', version: '1.0',
    description: 'Extend the current Execution lease.',
    scope: 'execution-write', side_effect: true,
    parameters: { type: 'object', properties: { lease_expires_at: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'execution_wait', service: 'execution', operation: 'request_wait', version: '1.0',
    description: 'Save a checkpoint and release the active Execution for a durable Task dependency wait. Use child_task_terminal, a non-empty children_all_terminal set, parent_review, or timer. Candidate submission is synchronous and returns its CheckResult; do not wait for a candidate.',
    scope: 'execution-write', side_effect: true,
    parameters: { type: 'object', required: ['wait_condition'], properties: { wait_condition: { type: 'object', properties: { type: { type: 'string' }, child_task_id: { type: 'string' }, check_request_key: { type: 'string' }, candidate_material_id: { type: 'string' }, deadline: { type: 'string' } }, additionalProperties: true }, checkpoint: { type: 'object' }, files: { type: 'object', additionalProperties: { type: 'string' } }, wait_deadline: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'execution_block', service: 'execution', operation: 'block_execution', version: '1.0',
    description: 'Save a checkpoint, end the current Execution, release its Core, and mark the Task BLOCKED for a concrete external dependency. Use this instead of leaving a live Execution in WAITING.',
    scope: 'execution-write', side_effect: true,
    parameters: { type: 'object', required: ['reason', 'dependency'], properties: { reason: { type: 'string' }, dependency: { type: 'object', properties: { dependency_kind: { type: 'string', enum: ['TASK', 'MATERIAL', 'CHECK_RESULT'] }, prerequisite_task_id: { type: 'string' }, material_id: { type: 'string' }, check_result_id: { type: 'string' }, requirement: { type: 'object' } }, additionalProperties: false }, checkpoint: { type: 'object' }, files: { type: 'object', additionalProperties: { type: 'string' } } }, additionalProperties: false },
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
    description: 'Record which bounded shared Material IDs this Execution used for a route, task, candidate, or integration action.',
    scope: 'execution-write', side_effect: true,
    parameters: {
      type: 'object',
      required: ['material_ids', 'action'],
      properties: {
        material_ids: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1 } },
        action: { type: 'string', enum: ['route', 'task', 'candidate', 'integration'] },
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
    name: 'judge_submit_candidate', service: 'judge', operation: 'submit_candidate', version: '1.0',
    description: 'Submit a candidate Material for the Task completion checker. The returned CheckResult separates source-level PASS/FAIL from checker infrastructure_failure and unassessed outcomes; a checker that never starts is not a proof failure.',
    scope: 'execution-write', side_effect: true,
    parameters: { type: 'object', required: ['candidate_material_id'], properties: { candidate_material_id: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'judge_get_check_result', service: 'judge', operation: 'get_check_result', version: '1.0',
    description: 'Read a Judge CheckResult, checker process status, result class, retryability, and diagnostic feedback.',
    scope: 'execution-read', side_effect: false,
    parameters: { type: 'object', required: ['check_result_id'], properties: { check_result_id: { type: 'string' } }, additionalProperties: false },
  },
]);

// The legacy catalog above remains available to internal adapters while the
// Agent-facing projection is deliberately small.  Runtime lease/liveness
// operations and the old structural Task vocabulary are not callable tools in
// a normal bound Agent profile.  The target operations use a stable semantic
// name even when an adapter temporarily maps them to an older implementation.
const publicTaskTools = [
  {
    name: 'task_status', service: 'task', operation: 'task_status', version: '1.0',
    description: 'Read the authoritative Mission, Task counts, claimable work, and observation timestamp.',
    scope: 'task-read', side_effect: false,
    parameters: { type: 'object', required: ['mission_id'], properties: { mission_id: { type: 'string' }, states: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer', minimum: 1, maximum: 500 } }, additionalProperties: false },
  },
  {
    name: 'task_register', service: 'task', operation: 'task_register', version: '1.0',
    description: 'Register one independent Task with a goal, output, acceptance condition, and collaboration reason.',
    scope: 'task-write', side_effect: true,
    parameters: { type: 'object', required: ['mission_id', 'goal', 'expected_output', 'acceptance_conditions'], properties: { mission_id: { type: 'string' }, task_id: { type: 'string' }, summary: { type: 'string' }, goal: { type: 'string' }, task_type: { type: 'string' }, task_instructions: { type: 'string' }, expected_output: { type: 'string' }, acceptance_conditions: { oneOf: [{ type: 'array' }, { type: 'object' }] }, collaboration_reason: { type: 'string' }, responsibility_key: { type: 'string' }, spawned_from: { type: 'string' }, depends_on: { type: 'array', items: { type: 'string' } }, timebox_ms: { type: 'integer', minimum: 1 } }, additionalProperties: false },
  },
  {
    name: 'task_take', service: 'task', operation: 'task_take', version: '1.0',
    description: 'Take an existing Mission or ordinary Task using the caller identity and Core lane.',
    scope: 'task-write', side_effect: true,
    parameters: { type: 'object', required: ['task_id'], properties: { task_id: { type: 'string' }, claim_key: { type: 'string' }, core_id: { type: 'string' }, workspace_mode: { type: 'string', enum: ['resume', 'clean'] }, workspace_revision: { type: 'integer', minimum: 1 }, workspace_source_execution_id: { type: 'string' }, workspace_source_ref: { type: 'string' }, input_material_refs: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
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
        completion_contract: { type: 'object' },
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
    name: 'task_complete', service: 'task', operation: 'task_complete', version: '1.0',
    description: 'Complete the current Task when its own contract and required Material or Judge evidence are satisfied.',
    scope: 'task-write', side_effect: true,
    parameters: { type: 'object', properties: { material_ids: { type: 'array', items: { type: 'string' } }, check_result_id: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'task_handoff', service: 'task', operation: 'task_handoff', version: '1.0',
    description: 'Publish and link Handoff Material, then return unfinished work to the Mission queue.',
    scope: 'task-write', side_effect: true,
    parameters: { type: 'object', required: ['handoff_material_id'], properties: { handoff_material_id: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'task_block', service: 'task', operation: 'task_block', version: '1.0',
    description: 'Publish and link Handoff Material, record a typed dependency, and stop unfinished work as BLOCKED.',
    scope: 'task-write', side_effect: true,
    parameters: { type: 'object', required: ['blocker', 'dependency', 'handoff_material_id'], properties: { blocker: { type: 'object' }, dependency: { type: 'object', description: 'A real prerequisite Task; this first version does not block on Material or CheckResult.' }, handoff_material_id: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'task_close', service: 'task', operation: 'task_close', version: '1.0',
    description: 'Accept a linked Response Material from another Task and close its producer.',
    scope: 'task-write', side_effect: true,
    parameters: { type: 'object', required: ['producer_task_id', 'material_id'], properties: { producer_task_id: { type: 'string' }, material_id: { type: 'string' } }, additionalProperties: false },
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
const publicJudgeTools = TOOL_DEFINITIONS.filter((tool) => tool.service === 'judge');
const publicCatalogTools = TOOL_DEFINITIONS.filter((tool) => tool.service === 'catalog');

// These definitions remain available to internal Runtime/Task Service callers,
// but they are not part of the Agent-facing fallback projection. Runtime owns
// the Execution lease/liveness controls; modern Mission Tasks use the semantic
// entries above and the Registry-backed profile.
const LEGACY_AGENT_OPERATIONS = new Set([
  'abort', 'accept_task', 'apply_check_result', 'block_execution',
  'claim', 'list_claimable_tasks', 'select_task',
  'create_rework_task', 'fence_execution', 'heartbeat', 'request_rework',
  'request_wait', 'resume_execution', 'start_execution', 'stop_execution',
  'wake', 'wake_execution',
]);

const LEGACY_AGENT_TOOL_NAMES = new Set([
  'execution_wait', 'task_accept', 'task_create_rework', 'task_request_rework',
  'service_call', 'swarmenv_call',
]);

const SERVICE_DEFINITIONS = Object.freeze([
  {
    name: 'task',
    version: '1.0',
    description: 'Task goals, Mission-scoped Material links, semantic completion, explicit dependencies, and canonical task_take.',
    tools: [...TOOL_DEFINITIONS.filter((tool) => tool.service === 'task'), ...publicTaskTools, ...publicWorkspaceTools],
  },
  { name: 'execution', version: '1.0', description: 'Internal Execution lease, heartbeat, wait, and lifecycle metadata.', tools: TOOL_DEFINITIONS.filter((tool) => tool.service === 'execution') },
  { name: 'workspace', version: '1.0', description: 'Runtime-owned Workspace materialization, revisions, and checkpoint lineage.', tools: TOOL_DEFINITIONS.filter((tool) => tool.service === 'workspace') },
  {
    name: 'context',
    version: '1.0',
    description: 'Shared immutable Materials with producer provenance and semantic collaboration roles.',
    tools: [...TOOL_DEFINITIONS.filter((tool) => tool.service === 'context'), ...publicContextTools],
  },
  { name: 'judge', version: '1.0', description: 'Candidate submission and independent completion checks.', tools: publicJudgeTools },
  { name: 'catalog', version: '1.0', description: 'Service and named tool discovery metadata.', tools: publicCatalogTools },
]);

function clone(value) {
  return structuredClone(value);
}

export function isLegacyAgentSurface(tool, { runtimeOwned = false } = {}) {
  if (!tool || typeof tool !== 'object') return false;
  const operation = tool.operation ?? null;
  const name = tool.name ?? tool.tool_name ?? tool.toolName ?? null;
  if (runtimeOwned && operation === 'accept_task') return false;
  return LEGACY_AGENT_OPERATIONS.has(operation) || LEGACY_AGENT_TOOL_NAMES.has(name);
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

/** Internal adapters can inspect the full pre-#100 catalog explicitly. */
export function listLegacyTools(service = null) {
  return listTools(service, { includeInternal: true });
}

export function serviceCatalog(options = {}) {
  return { services: listServices(options), tools: listTools(null, options) };
}
