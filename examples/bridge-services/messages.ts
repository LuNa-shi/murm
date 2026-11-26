import { createHttpJsonAdapter, createInProcessAdapter, type ServiceRegistration } from '@murm/core/services';

const key = { type: 'string', minLength: 1, maxLength: 64 };
const text = { type: 'string', minLength: 1, maxLength: 2048 };
const message = { type: 'object', properties: { key, text, author: { type: 'string' } },
  required: ['key', 'text', 'author'], additionalProperties: false };

export function createMessageService(remote?: { url: string; token: string }): ServiceRegistration {
  const manifest: ServiceRegistration['manifest'] = {
    id: 'messages', title: 'Messages', purpose: 'Pass a message to another Agent', provider_version: '1', contract_version: '2',
    endpoint: remote ? { transport: 'http-json', url: remote.url } : { transport: 'in-process' },
    capabilities: [{
      name: 'put', operation: 'put', description: 'Publish a message under a key', side_effect: 'write', idempotent: true,
      help: { when: 'Make a message available to a reader' }, errors: [{ code: 'CONFLICT', retryable: false }],
      input_schema: { type: 'object', properties: { key, text }, required: ['key', 'text'], additionalProperties: false }, output_schema: message,
    }, {
      name: 'get', operation: 'get', description: 'Read a message by key', side_effect: 'read', idempotent: true,
      help: { when: 'Read a message published by another Agent' }, errors: [],
      input_schema: { type: 'object', properties: { key }, required: ['key'], additionalProperties: false },
      output_schema: { anyOf: [message, { type: 'null' }] },
    }],
  };
  if (remote) return { manifest, adapter: createHttpJsonAdapter({ token: remote.token }) };
  const records = new Map<string, { key: string; text: string; author: string }>();
  const adapter = createInProcessAdapter({ invoke({ capability, input, caller, assertAuthorized }) {
    const { key, text } = input as { key: string; text: string };
    const previous = records.get(key);
    if (capability.operation === 'get') return previous ?? null;
    if (previous && (previous.author !== caller.agentId || previous.text !== text)) {
      throw Object.assign(new Error('A different message already uses this key'), { code: 'CONFLICT' });
    }
    assertAuthorized();
    const record = previous ?? { key, text, author: caller.agentId };
    if (!previous) records.set(key, record);
    return record;
  } });
  return { manifest, adapter };
}
