import { createInProcessAdapter, type ServiceManifest, type ServiceRequest, type JsonValue } from '@murm/core/services';

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const target = { type: 'string', minLength: 1, maxLength: 1024 };
const message = { type: 'string', minLength: 1, maxLength: 65_536 };
const targetMessage = object({ target, message }, ['target', 'message']);
const childTask = { task_name: { type: 'string', pattern: '^[a-z0-9_]{1,48}$' }, message };
const capabilities = [
  ['spawn_agent', 'Create a named child and assign its first task. The default fork_turns is all. Use none for a fresh conversation.', object({
    ...childTask, fork_turns: { enum: ['all', 'none'] },
  }, ['task_name', 'message'])],
  ['send_message', 'Send information to a team member. A plain notice leaves an idle member idle.', targetMessage],
  ['followup_task', 'Give an existing non-Root member work. It can start an idle member and uses its existing Session and files.', targetMessage],
  ['wait_agent', 'Wait in this turn for a message or new input. Defaults to 30 seconds, with a 10-second minimum and 1-hour maximum.', object({
    timeout_ms: { type: 'integer', minimum: 0, maximum: 3_600_000 },
  })],
  ['interrupt_agent', 'Interrupt a team member other than Root or yourself. The member keeps its Session and files.', object({ target }, ['target'])],
  ['list_agents', 'List visible team members and their current status. Filter by a path prefix if needed.', object({ path_prefix: target })],
] as const;

const manifest: ServiceManifest = {
  id: 'collaboration', title: 'Team collaboration', purpose: 'Delegate work and exchange results among agents in this team.',
  contract_version: '2', provider_version: '1', endpoint: { transport: 'in-process' },
  capabilities: capabilities.map(([operation, description, input_schema]) => ({
    name: operation, operation, description, input_schema,
    help: { when: description }, side_effect: operation === 'list_agents' ? 'read' : 'write', idempotent: true,
    output_schema: { type: operation === 'list_agents' ? 'array' : 'object' },
    errors: ['INVALID_CONTRACT', 'NOT_ALLOWED', 'NOT_FOUND', 'CONFLICT', 'OPERATION_UNKNOWN', 'SERVICE_UNAVAILABLE']
      .map(code => ({ code, retryable: ['OPERATION_UNKNOWN', 'SERVICE_UNAVAILABLE'].includes(code) })),
    ...(operation === 'wait_agent' ? { timeout_ms: 3_610_000 } : {}),
  })),
};

const freshChildDescription = 'Create a named child and assign its first task. Pass fork_turns none to start a fresh conversation.';
const freshChildManifest: ServiceManifest = {
  ...manifest,
  capabilities: manifest.capabilities.map(capability => capability.operation !== 'spawn_agent' ? capability : {
    ...capability,
    description: freshChildDescription,
    help: { when: freshChildDescription },
    input_schema: object({ ...childTask, fork_turns: { enum: ['none'] } }, ['task_name', 'message', 'fork_turns']),
  }),
};

export const collaborationOperations = capabilities.map(([operation]) => operation);
export function createCollaborationService(
  invoke: (request: ServiceRequest) => Promise<JsonValue>,
  exportState: () => JsonValue,
  { allowContextFork = true } = {},
) {
  return { manifest: allowContextFork ? manifest : freshChildManifest, adapter: createInProcessAdapter({ invoke, exportState }) };
}
