import { createHttpJsonAdapter, createInProcessAdapter, type ServiceRegistration } from '@murm/core';

const key = { type: 'string', minLength: 1, maxLength: 64 };
const text = { type: 'string', minLength: 1, maxLength: 2048 };
const message = { type: 'object', properties: { key, text, author: { type: 'string' } },
  required: ['key', 'text', 'author'], additionalProperties: false };

type Call = { operation: string; operationId: string; agentId: string };

export function createMessageService(remote?: { url: string; token: string }, observed?: (call: Call) => void): ServiceRegistration {
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
  if (remote) return { manifest, adapter: createHttpJsonAdapter({
    token: remote.token,
    async fetchImpl(url, init) {
      const response = await fetch(url, init);
      if (!observed || !response.ok || !response.body) return response;
      const reader = response.clone().body!.getReader();
      const decoder = new TextDecoder();
      let length = 0;
      let json = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 16 * 1024) return response;
          json += decoder.decode(value, { stream: true });
        }
        const { ok, result } = JSON.parse(json + decoder.decode());
        const { input, envelope, caller } = JSON.parse(String(init?.body));
        const operation = String(url).split('/').at(-1)!;
        if (ok === true && result?.key === input.key && typeof result.text === 'string' &&
            result.text.length > 0 && result.text.length <= 2048 && typeof result.author === 'string' &&
            Object.keys(result).length === 3 &&
            (operation === 'get' || (result.text === input.text && result.author === caller.agentId))) {
          observed({ operation, operationId: envelope.operation_id, agentId: caller.agentId });
        }
      } catch { /* The HTTP adapter reports malformed or interrupted transport. */ }
      finally { void reader.cancel().catch(() => {}); }
      return response;
    },
  }) };
  const records = new Map<string, { key: string; text: string; author: string }>();
  const adapter = createInProcessAdapter({ invoke({ capability, input, caller, envelope, assertAuthorized }) {
    const { key, text } = input as { key: string; text: string };
    const previous = records.get(key);
    const report = () => observed?.({ operation: capability.operation, operationId: envelope.operation_id, agentId: caller.agentId });
    if (capability.operation === 'get') {
      if (previous) report();
      return previous ?? null;
    }
    if (previous && (previous.author !== caller.agentId || previous.text !== text)) {
      throw Object.assign(new Error('A different message already uses this key'), { code: 'CONFLICT' });
    }
    assertAuthorized();
    const record = previous ?? { key, text, author: caller.agentId };
    if (!previous) records.set(key, record);
    report();
    return record;
  } });
  return { manifest, adapter };
}
