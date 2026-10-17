const OPERATIONS = [
  'get_task', 'get_execution', 'read_materials', 'publish_material',
  'submit_candidate', 'heartbeat', 'create_child_task', 'request_wait',
];

function text(value) {
  const encoded = JSON.stringify(value);
  return encoded.length > 64 * 1024 ? `${encoded.slice(0, 64 * 1024)}\n[bridge result truncated]` : encoded;
}

export default function swarmenvExtension(pi) {
  pi.registerTool({
    name: 'swarmenv_call',
    label: 'SwarmEnv Service Call',
    description: 'Call the public SwarmEnv Services SDK for the current Task and Execution. Use this to read the task, read shared Materials, publish Materials, submit proof candidates, heartbeat, create child Tasks, or request a durable wait.',
    promptSnippet: 'Use the public SwarmEnv Services SDK bridge',
    promptGuidelines: [
      'Use swarmenv_call for every Task, Execution, Material, and candidate lifecycle operation.',
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
      const url = process.env.SWARMENV_BRIDGE_URL;
      const token = process.env.SWARMENV_BRIDGE_TOKEN;
      if (!url || !token) throw new Error('SwarmEnv bridge configuration is missing');
      const response = await fetch(`${url}/call`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ operation: params.operation, payload: params.payload }),
        signal,
      });
      const body = await response.json();
      if (!response.ok || !body.ok) {
        return { content: [{ type: 'text', text: text(body) }], details: body, isError: true };
      }
      return { content: [{ type: 'text', text: text(body.result) }], details: body.result };
    },
  });
}
