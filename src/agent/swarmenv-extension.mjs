import { buildCapabilityProfile, profileToolNames, AGENT_ROLES } from './capability-profile.js';

function text(value) {
  const encoded = JSON.stringify(value);
  return encoded.length > 64 * 1024 ? `${encoded.slice(0, 64 * 1024)}\n[bridge result truncated]` : encoded;
}

function bridgeConfig() {
  const url = process.env.SWARMENV_BRIDGE_URL;
  const token = process.env.SWARMENV_BRIDGE_TOKEN;
  if (!url || !token) throw new Error('SwarmEnv bridge configuration is missing');
  return { url, token };
}

async function bridgeFetch(path, { method = 'GET', body, signal } = {}) {
  const { url, token } = bridgeConfig();
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload?.error?.message ?? `SwarmEnv bridge request failed (${response.status})`);
    error.code = payload?.error?.code ?? 'BRIDGE_ERROR';
    error.details = payload?.error?.details;
    throw error;
  }
  return payload;
}

export async function loadCapabilityProfile({ signal, role = process.env.SWARMENV_AGENT_ROLE ?? AGENT_ROLES.BOUND } = {}) {
  const payload = await bridgeFetch('/profile', { signal });
  const profile = payload.profile ?? payload.result;
  if (!profile || profile.role !== role) throw new Error(`bridge returned an unexpected ${role} capability profile`);
  return profile;
}

async function callBridge(operation, payload, signal) {
  const response = await bridgeFetch('/call', {
    method: 'POST',
    body: { operation, payload },
    signal,
  });
  return { content: [{ type: 'text', text: text(response.result) }], details: response.result };
}

function registerTool(pi, profile, capability) {
  const help = capability.help;
  const guidance = [
    help?.when ?? help?.usage ?? help?.summary,
    help?.ref ? `Help: ${help.ref}` : null,
  ].filter(Boolean);
  pi.registerTool({
    name: `swarmenv_${capability.name}`,
    label: `SwarmEnv ${capability.name}`,
    description: capability.description || `Call ${capability.service_title ?? capability.service_id} capability ${capability.name}`,
    promptSnippet: `${capability.service_title ?? capability.service_id}: ${capability.description || capability.name}`,
    promptGuidelines: guidance,
    parameters: capability.input_schema ?? { type: 'object', additionalProperties: true },
    ...(capability.output_schema ? { outputSchema: capability.output_schema } : {}),
    annotations: {
      readOnlyHint: capability.side_effect === false,
      destructiveHint: capability.side_effect === 'destructive',
      idempotentHint: capability.idempotent === true,
      openWorldHint: false,
    },
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal) {
      return callBridge(capability.operation, params ?? {}, signal);
    },
  });
  return `swarmenv_${capability.name}`;
}

/**
 * Pi waits for an asynchronous extension factory. The profile is fetched once
 * before startup, so the registered named tools and the initial prompt see the
 * same deterministic Registry snapshot. Tests and local doubles may pass a
 * profile directly without starting a Bridge.
 */
export default async function swarmenvExtension(pi, { profile = null, profileLoader = null, role = process.env.SWARMENV_AGENT_ROLE ?? AGENT_ROLES.BOUND, registry = null, tools = null } = {}) {
  const resolved = profile
    ?? (profileLoader ? await profileLoader({ role }) : null)
    ?? (process.env.SWARMENV_BRIDGE_URL && process.env.SWARMENV_BRIDGE_TOKEN
      ? await loadCapabilityProfile({ role })
      : buildCapabilityProfile({ role, registry, tools }));
  if (!resolved || resolved.role !== role) throw new TypeError(`capability profile role must be ${role}`);
  const registeredTools = resolved.capabilities.map((capability) => registerTool(pi, resolved, capability));
  return { profile: resolved, tool_names: registeredTools, profile_hash: resolved.profile_hash };
}

export { profileToolNames };
