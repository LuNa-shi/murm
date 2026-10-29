/**
 * Capabilities owned by Runtime rather than a separately registered provider.
 * They are still described through the same profile so the Agent sees one
 * truthful directory, while ownership and authorization remain task-scoped.
 */
const objectSchema = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

const id = { type: 'string', minLength: 1 };
const revision = { type: 'integer', minimum: 1 };

export const RUNTIME_CAPABILITIES = Object.freeze([
  {
    id: 'runtime.task_complete', name: 'task_complete', operation: 'accept_task', service_id: 'runtime',
    service_title: 'SwarmEnv Runtime', service_purpose: 'Task-scoped completion and dependency actions',
    description: 'Complete the current Task after its own contract and result references are satisfied.',
    audience: ['bound', 'recovery'], side_effect: 'write', idempotent: true, runtime_owned: true,
    context: ['task', 'execution', 'fencing'],
    help: { when: 'Use after the current Task completion contract is satisfied and evidence is persisted.', ref: 'runtime://task_complete' },
    input_schema: objectSchema({ target_task_id: id, target_state_version: { type: 'integer', minimum: 0 } }, ['target_task_id']),
    output_schema: objectSchema(),
  },
  {
    id: 'runtime.task_block', name: 'task_block', operation: 'task_block', service_id: 'runtime',
    service_title: 'SwarmEnv Runtime', service_purpose: 'Task-scoped completion and dependency actions',
    description: 'Save a useful checkpoint, declare a typed dependency, release this Execution, and mark the Task BLOCKED.',
    audience: ['bound', 'recovery'], side_effect: 'write', idempotent: true, runtime_owned: true,
    context: ['task', 'execution', 'fencing'],
    help: { when: 'Use only when the current Task cannot progress without a concrete typed dependency.', ref: 'runtime://task_block' },
    input_schema: objectSchema({ reason: { type: 'string', minLength: 1 }, dependency: { type: 'object', minProperties: 1 }, checkpoint: { type: 'object' }, files: { type: 'object', additionalProperties: { type: 'string' } } }, ['reason', 'dependency']),
    output_schema: objectSchema(),
  },
  {
    id: 'runtime.execution_get', name: 'execution_get', operation: 'get_execution', service_id: 'runtime',
    service_title: 'SwarmEnv Runtime', service_purpose: 'Task-scoped Execution projection',
    description: 'Read the current Execution identity and Workspace revision.',
    audience: ['bound', 'recovery'], side_effect: 'read', idempotent: true, runtime_owned: true,
    context: ['task', 'execution', 'fencing'],
    help: { when: 'Read the current Execution before acting on its Task.', ref: 'runtime://execution_get' },
    input_schema: objectSchema({ execution_id: id }, ['execution_id']), output_schema: objectSchema(),
  },
  {
    id: 'runtime.workspace_get', name: 'workspace_get', operation: 'get_workspace', service_id: 'runtime',
    service_title: 'Task Workspace', service_purpose: 'Task-scoped Workspace materialization and revision contract',
    description: 'Read the current task-scoped Workspace and its revision contract.',
    audience: ['bound', 'recovery'], side_effect: 'read', idempotent: true, runtime_owned: true,
    context: ['task', 'execution', 'fencing'],
    help: { when: 'Read the Workspace contract before opening or changing files.', ref: 'workspace://get' },
    input_schema: objectSchema(), output_schema: objectSchema(),
  },
  {
    id: 'runtime.workspace_list_files', name: 'workspace_list_files', operation: 'list_workspace_files', service_id: 'runtime',
    service_title: 'Task Workspace', service_purpose: 'Task-scoped Workspace materialization and revision contract',
    description: 'List files inside the current task-scoped Workspace.',
    audience: ['bound', 'recovery'], side_effect: 'read', idempotent: true, runtime_owned: true,
    context: ['task', 'execution', 'fencing'],
    help: { when: 'List files before reading or writing a declared path.', ref: 'workspace://list-files' },
    input_schema: objectSchema({ path: { type: 'string' }}), output_schema: objectSchema(),
  },
  {
    id: 'runtime.workspace_read_file', name: 'workspace_read_file', operation: 'read_workspace_file', service_id: 'runtime',
    service_title: 'Task Workspace', service_purpose: 'Task-scoped Workspace materialization and revision contract',
    description: 'Read a text file from the current task-scoped Workspace.',
    audience: ['bound', 'recovery'], side_effect: 'read', idempotent: true, runtime_owned: true,
    context: ['task', 'execution', 'fencing'],
    help: { when: 'Read only a path allowed by the Workspace contract.', ref: 'workspace://read-file' },
    input_schema: objectSchema({ path: { type: 'string', minLength: 1 }, max_bytes: { type: 'integer', minimum: 1, maximum: 10_000_000 } }, ['path']), output_schema: objectSchema(),
  },
  {
    id: 'runtime.workspace_write_file', name: 'workspace_write_file', operation: 'write_workspace_file', service_id: 'runtime',
    service_title: 'Task Workspace', service_purpose: 'Task-scoped Workspace materialization and revision contract',
    description: 'Write one declared output file in the current task-scoped Workspace and save a revision.',
    audience: ['bound', 'recovery'], side_effect: 'write', idempotent: true, runtime_owned: true,
    context: ['task', 'execution', 'fencing'],
    help: { when: 'Write only declared outputs with the current Workspace revision.', ref: 'workspace://write-file' },
    input_schema: objectSchema({ path: { type: 'string', minLength: 1 }, content: { type: 'string' }, expected_revision: revision }, ['path', 'content']), output_schema: objectSchema(),
  },
  {
    id: 'runtime.workspace_diff', name: 'workspace_diff', operation: 'workspace_diff', service_id: 'runtime',
    service_title: 'Task Workspace', service_purpose: 'Task-scoped Workspace materialization and revision contract',
    description: 'Compare two revisions in the current task-scoped Workspace.',
    audience: ['bound', 'recovery'], side_effect: 'read', idempotent: true, runtime_owned: true,
    context: ['task', 'execution', 'fencing'],
    help: { when: 'Inspect the auditable file changes between revisions.', ref: 'workspace://diff' },
    input_schema: objectSchema({ from_revision: revision, to_revision: revision }), output_schema: objectSchema(),
  },
]);

export function runtimeCapabilityList() {
  return structuredClone(RUNTIME_CAPABILITIES);
}

