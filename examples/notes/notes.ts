import { createInProcessAdapter, ServiceRegistry } from '@luna-shi/murm';

const textField: any = { type: 'string', minLength: 1, maxLength: 2048 };
const keyField: any = { type: 'string', minLength: 1, maxLength: 64 };
const note: any = { type: 'object', properties: { key: keyField, text: textField, author: { type: 'string' } },
  required: ['key', 'text', 'author'], additionalProperties: false };
const notesManifest: any = {
  id: 'notes', title: 'Notes', purpose: 'Share a fixed source observation', provider_version: '1', contract_version: '2',
  endpoint: { transport: 'in-process' },
  capabilities: [{
    name: 'put', operation: 'put', description: 'Publish a source observation', side_effect: 'write', idempotent: true,
    help: { when: 'Pass the original source observation to a reader' }, errors: [{ code: 'CONFLICT', retryable: false }],
    input_schema: { type: 'object', properties: { key: keyField, text: textField }, required: ['key', 'text'], additionalProperties: false },
    output_schema: note,
  }, {
    name: 'get', operation: 'get', description: 'Read a published observation', side_effect: 'read', idempotent: true,
    help: { when: 'Compare a handed-off observation with its original' }, errors: [],
    input_schema: { type: 'object', properties: { key: keyField }, required: ['key'], additionalProperties: false },
    output_schema: { anyOf: [note, { type: 'null' }] },
  }],
};

export function createNotes() {
  const records: any = new Map();
  const reads: any[] = [];
  const services: any = new ServiceRegistry();
  const adapter = createInProcessAdapter({ invoke({ capability, input, caller }: any) {
    const previous = records.get(input.key);
    if (capability.operation === 'get') {
      reads.push({ agentId: caller.agentId, key: input.key, found: Boolean(previous) });
      return previous ?? null;
    }
    if (previous && (previous.author !== caller.agentId || previous.text !== input.text)) {
      throw Object.assign(new Error('A different note already uses this key'), { code: 'CONFLICT' });
    }
    if (previous) return previous;
    const current: any = { key: input.key, text: input.text, author: caller.agentId };
    records.set(input.key, current);
    return current;
  } });
  services.registerService({ manifest: notesManifest, adapter });
  return { services, records, reads };
}
