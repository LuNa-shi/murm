import { ServiceRegistry, snapshotServiceRegistry } from '../../src/core/services.js';
import { createCoreBridge } from '../../src/core/bridge.js';

export function notesManifest(id = 'notes') {
  const key = { type: 'string', minLength: 1, maxLength: 12 };
  const record = { type: 'object', properties: { key, text: { type: 'string' }, author: { type: 'string' } }, required: ['key', 'text', 'author'], additionalProperties: false };
  return { id, title: 'Notes', purpose: 'Fixed notes exchange', provider_version: '1', contract_version: '2', endpoint: { transport: 'in-process' }, capabilities: [
    { name: 'put', operation: 'put', description: 'Store a note', side_effect: 'write', idempotent: true, help: { when: 'Publish a fixed note' }, errors: [{ code: 'CONFLICT', retryable: false }], input_schema: { type: 'object', properties: { key, text: { type: 'string', minLength: 1, maxLength: 32 } }, required: ['key', 'text'], additionalProperties: false }, output_schema: record },
    { name: 'get', operation: 'get', description: 'Read a note', side_effect: 'read', idempotent: true, help: { when: 'Read a published note' }, errors: [], input_schema: { type: 'object', properties: { key }, required: ['key'], additionalProperties: false }, output_schema: { anyOf: [record, { type: 'null' }] } },
  ] };
}
export async function setup(t, adapter, options = {}) {
  const services = new ServiceRegistry();
  services.registerService({ manifest: options.manifest ?? notesManifest(), adapter });
  const agent = { profile: 'writer', status: 'idle', services: { notes: ['put', 'get'] }, bindings: { notes: 'notes-account', other: 'must-not-leak' } };
  const bridge = await createCoreBridge({ runtimeId: 'run-one', configuration: { host: '127.0.0.1', publicUrl: 'http://127.0.0.1:{port}' }, getAgent: id => id === 'agent-one' ? agent : null, registrations: snapshotServiceRegistry(services), ...options.bridge });
  t.after(() => bridge.close());
  const credentials = bridge.credentialsForAgent('agent-one');
  const headers = { authorization: `Bearer ${credentials.secretEnvironment.MURM_BRIDGE_TOKEN}` };
  const call = async (operation, payload = {}, extra = {}) => {
    const response = await fetch(bridge.publicUrl + '/call', { method: 'POST', headers, body: JSON.stringify({ service_id: 'notes', operation, operation_id: 'fixed-request', payload, ...extra }) });
    return { status: response.status, ...await response.json() };
  };
  return { agent, bridge, call, credentials };
}


export function createNotesService() {
  const entries = new Map();
  const calls = [];
  let writes = 0;
  return { entries, calls, get writes() { return writes; }, adapter: { invoke({ capability, input, caller, envelope }) {
    calls.push({ operation: capability.operation, caller: structuredClone(caller), operation_id: envelope.operation_id });
    if (capability.operation === 'get') return entries.get(input.key) ?? null;
    const previous = entries.get(input.key);
    if (previous && (previous.author !== caller.agentId || previous.text !== input.text)) {
      const error = new Error('Fixed note conflicts'); error.code = 'CONFLICT'; throw error;
    }
    if (!previous) { entries.set(input.key, { ...input, author: caller.agentId }); writes++; }
    return entries.get(input.key);
  } } };
}
