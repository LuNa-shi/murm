import { listTools } from '../sdk/service-catalog.js';

const OPERATIONS = [
  'list_services', 'get_service_metadata', 'list_tools', 'list_tasks', 'get_task', 'get_execution',
  'claim', 'claim_next', 'create_child_task', 'accept_task', 'request_rework', 'get_check_result',
  'get_workspace', 'list_workspace_revisions', 'list_workspace_files', 'read_workspace_file', 'write_workspace_file', 'workspace_diff', 'list_executions',
  'read_materials', 'publish_material', 'submit_candidate', 'heartbeat', 'request_wait',
];

function text(value) {
  const encoded = JSON.stringify(value);
  return encoded.length > 64 * 1024 ? `${encoded.slice(0, 64 * 1024)}\n[bridge result truncated]` : encoded;
}

async function callBridge(operation, payload, signal) {
  const url = process.env.SWARMENV_BRIDGE_URL;
  const token = process.env.SWARMENV_BRIDGE_TOKEN;
  if (!url || !token) throw new Error('SwarmEnv bridge configuration is missing');
  const response = await fetch(`${url}/call`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ operation, payload }),
    signal,
  });
  const body = await response.json();
  if (!response.ok || !body.ok) {
    return { content: [{ type: 'text', text: text(body) }], details: body, isError: true };
  }
  return { content: [{ type: 'text', text: text(body.result) }], details: body.result };
}

function registerTool(pi, { name, operation, description, parameters, promptGuidelines = [] }) {
  pi.registerTool({
    name: `swarmenv_${name}`,
    label: `SwarmEnv ${name}`,
    description,
    promptSnippet: 'Use the public SwarmEnv Service tool for this operation',
    promptGuidelines,
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal) {
      return callBridge(operation, params ?? {}, signal);
    },
  });
}

export default function swarmenvExtension(pi) {
  for (const tool of listTools()) registerTool(pi, tool);

  // Keep the transport-level call during the migration so older Pi sessions
  // can finish, while new sessions receive one discoverable tool per Service
  // operation above.
  pi.registerTool({
    name: 'swarmenv_call',
    label: 'SwarmEnv Service Call (compatibility)',
    description: 'Compatibility transport for the public SwarmEnv Service operations. Prefer the named Service tools.',
    promptSnippet: 'Prefer named SwarmEnv Service tools; use this only for compatibility.',
    promptGuidelines: [
      'Use named Service tools for normal work and swarmenv_call only when a named tool is unavailable.',
      'Never claim a proof is complete from a file or from your own text; submit the candidate and let the Judge decide.',
    ],
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: OPERATIONS },
        payload: { type: 'object', additionalProperties: true },
      },
      required: ['operation', 'payload'],
      additionalProperties: false,
    },
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal) {
      return callBridge(params.operation, params.payload, signal);
    },
  });
}
