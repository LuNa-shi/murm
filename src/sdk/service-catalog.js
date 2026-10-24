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
    name: 'task_get', service: 'task', operation: 'get_task', version: '1.0',
    description: 'Read the current Task specification and state.',
    scope: 'task-read', side_effect: false,
    parameters: { type: 'object', properties: { task_id: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'task_scheduler_status', service: 'task', operation: 'scheduler_status', version: '1.0',
    description: 'Read current core capacity, active and waiting executions, and claimable Tasks for adaptive decomposition.',
    scope: 'public-read', side_effect: false,
    parameters: { type: 'object', properties: { root_id: { type: 'string' }, task_id: { type: 'string' }, execution_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
  },
  {
    name: 'task_list_executions', service: 'task', operation: 'list_executions', version: '1.0',
    description: 'List prior and active Executions for a Task so a worker can choose a Workspace lineage.',
    scope: 'task-read', side_effect: false,
    parameters: { type: 'object', properties: { task_id: { type: 'string' }, include_terminal: { type: 'boolean' } }, additionalProperties: false },
  },
  {
    name: 'task_claim', service: 'task', operation: 'claim', version: '1.0',
    description: 'Claim one explicitly selected Task and create its Execution.',
    scope: 'task-claim', side_effect: true,
    parameters: { type: 'object', required: ['task_id', 'claim_key'], properties: { task_id: { type: 'string' }, claim_key: { type: 'string' }, owner_ref: { type: 'string' }, workspace_mode: { type: 'string', enum: ['resume', 'clean'] }, workspace_revision: { type: 'integer', minimum: 1 }, workspace_source_execution_id: { type: 'string' }, workspace_source_ref: { type: 'string' } }, additionalProperties: false },
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
    parameters: { type: 'object', required: ['owner_task_id'], properties: { owner_task_id: { type: 'string' }, group_id: { type: 'string', description: 'Optional stable group ID; use the same ID as required_subtask_groups in the owner completion contract.' }, subtask_task_id: { type: 'string' }, subtask: { type: 'object' }, expected_structural_version: { type: 'integer', minimum: 0 } }, additionalProperties: true },
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

const SERVICE_DEFINITIONS = Object.freeze([
  { name: 'task', version: '1.0', description: 'Task goals, completion contracts, alternative branches, jointly required subtasks, explicit dependencies, provenance, structure discovery, rework, and explicit claim.', tools: TOOL_DEFINITIONS.filter((tool) => tool.service === 'task') },
  { name: 'execution', version: '1.0', description: 'Lease, heartbeat, wait and execution responsibility lifecycle.', tools: TOOL_DEFINITIONS.filter((tool) => tool.service === 'execution') },
  { name: 'workspace', version: '1.0', description: 'Workspace materialization, revisions and checkpoint lineage.', tools: TOOL_DEFINITIONS.filter((tool) => tool.service === 'workspace') },
  { name: 'context', version: '1.0', description: 'Shared immutable Materials and their provenance.', tools: TOOL_DEFINITIONS.filter((tool) => tool.service === 'context') },
  { name: 'judge', version: '1.0', description: 'Candidate submission and independent completion checks.', tools: TOOL_DEFINITIONS.filter((tool) => tool.service === 'judge') },
  { name: 'catalog', version: '1.0', description: 'Service and named tool discovery metadata.', tools: TOOL_DEFINITIONS.filter((tool) => tool.service === 'catalog') },
]);

function clone(value) {
  return structuredClone(value);
}

export function listServices() {
  return clone(SERVICE_DEFINITIONS.map(({ name, version, description, tools }) => ({ name, version, description, tool_count: tools.length })));
}

export function getServiceMetadata(name) {
  const service = SERVICE_DEFINITIONS.find((candidate) => candidate.name === name);
  return service ? clone(service) : null;
}

export function listTools(service = null) {
  const tools = service === null
    ? TOOL_DEFINITIONS
    : TOOL_DEFINITIONS.filter((tool) => tool.service === service);
  return clone(tools);
}

export function serviceCatalog() {
  return { services: listServices(), tools: listTools() };
}
