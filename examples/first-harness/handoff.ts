import { createInProcessAdapter, type ServiceRegistration } from '@luna-shi/murm';

const record = {
  type: 'object', properties: {
    reference: { type: 'string', pattern: '^[a-f0-9]{12}$', examples: ['0123456789ab'] },
    question: { type: 'string', minLength: 1, maxLength: 140, examples: ['Which channel should receive the release?'] },
  },
  required: ['reference', 'question'], additionalProperties: false,
};
const empty = { type: 'object', additionalProperties: false };

export function createHandoff() {
  let note: { reference: string; question: string; author: string; requestId: string } | undefined;
  let read: { reader: string; requestId: string } | undefined;
  const registration: ServiceRegistration = {
    manifest: {
      id: 'handoff', title: 'Release handoff', purpose: 'Publish a reference and a user question for the next Agent.',
      contract_version: '2', provider_version: '1', endpoint: { transport: 'in-process' },
      capabilities: [
        {
          name: 'publish', operation: 'publish', description: 'Save the release reference and ask the user for a channel.',
          help: { when: 'After reading release-data.txt.' },
          side_effect: 'write', idempotent: true, input_schema: record, output_schema: record,
          errors: [{ code: 'CONFLICT', retryable: false }],
        },
        {
          name: 'take', operation: 'take', description: 'Fetch the reference and question together.',
          help: { when: 'After the Harness gives you the user’s answer.' },
          side_effect: 'read', idempotent: true, input_schema: empty, output_schema: record,
          errors: [{ code: 'NO_HANDOFF', retryable: false }],
        },
      ],
    },
    adapter: createInProcessAdapter({
      invoke({ capability, input, caller, envelope, assertAuthorized }) {
        assertAuthorized();
        if (capability.operation === 'publish') {
          const { reference, question } = input as { reference: string; question: string };
          if (note && (note.reference !== reference || note.question !== question || note.author !== caller.agentId)) {
            throw Object.assign(new Error('Handoff already published'), { code: 'CONFLICT' });
          }
          note ??= { reference, question, author: caller.agentId, requestId: envelope.operation_id };
        } else {
          if (!note) throw Object.assign(new Error('Wait for the publisher turn'), { code: 'NO_HANDOFF' });
          read ??= { reader: caller.agentId, requestId: envelope.operation_id };
        }
        return { reference: note.reference, question: note.question };
      },
    }),
  };
  return { registration, evidence: () => ({ note, read }) };
}
