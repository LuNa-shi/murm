import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@murm/core';
import { ServiceRegistry, createInProcessAdapter } from '@murm/core/services';
import { createOpenSandboxBackend } from '@murm/core/backends/opensandbox';
import { runInput } from './run-input.js';
import { runWithReport } from './run-report.js';

const key = 'core-service-boundary';
export const fixedFact = Object.freeze({
  baseline: 'fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e',
  source: 'src/agent/services-bridge.js',
  finding: 'Bridge identity and TaskPool Task/Execution authorization have separate responsibilities.',
});

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

export function reviewText(fact: any) {
  return `# Source review\n\nBaseline: ${fact.baseline}\nSource: ${fact.source}\nFinding: ${fact.finding}\n`;
}

function reportRedactor(backend: any) {
  const secrets = [backend?.sandbox?.apiKey, backend?.sandbox?.execdToken,
    ...Object.values((backend?.models ?? {} as Record<string, any>)).flatMap((model: any) => Object.values((model.upstream?.headers ?? {} as Record<string, any>)))]
    .filter((value: any) => typeof value === 'string' && value.length)
    .flatMap((value: any) => [value, value.replace(/^(?:Bearer|Basic)\s+/i, '')]).filter(Boolean)
    .sort((left: any, right: any) => right.length - left.length);
  return (value: any) => JSON.parse(JSON.stringify(value, (_key: any, item: any) => typeof item === 'string'
    ? secrets.reduce((text: any, secret: any) => text.replaceAll(secret, '[redacted]'), item) : item));
}

const inputText = Object.freeze({
  put: 'Read review-input.json and note-request.json in this work directory. Use Bash and `swarm notes put --input note-request.json --request-id notes-put` to publish the seeded request. Its text field contains the exact review-input.json string.',
  get: `Use Bash and \`swarm notes get --key ${key} --request-id notes-get\`. Compare the note text with review-input.json. If they match, write review.md with a heading '# Source review', one blank line, then 'Baseline: ', 'Source: ' and 'Finding: ' followed by their exact values, one line each, ending with a newline.`,
  follow: 'Use Bash to read the existing review.md from the previous turn and copy it unchanged to followup.md.',
});

export async function runNotesHarness({ backend, model = 'default', image, outputDir, fact = fixedFact,
  turnTimeoutMs = 30_000, closeTimeoutMs = 30_000 }: any, signal: any) {
  const notes = createNotes();
  const redact = reportRedactor(backend);
  const completed: any[] = [];
  let original: any;
  return runWithReport({ outputDir, closeTimeoutMs,
    redact: (report: any) => {
      const stored = notes.records.get(key);
      const serviceState = stored ? [{ ...stored, text: stored.text === original ? original : '[unexpected text omitted]' }] : [];
      return redact({ ...report, serviceState, reads: notes.reads.filter((read: any) => read.key === key), turns: completed });
    },
    createRuntime: async () => {
      signal?.throwIfAborted();
      const common: any = { model, image, writable: true };
      return createRuntime({ backend: createOpenSandboxBackend(backend), services: notes.services, maxAgents: 2, outputDir,
        profiles: {
          writer: { ...common, services: { notes: ['put'] } },
          reader: { ...common, services: { notes: ['get'] },
            collect: { paths: ['review.md', 'followup.md'], includeGit: false, maxBytes: 64 * 1024, required: true } },
        },
      });
    },
    async run(runtime: any) {
      function checkCancelled() { signal?.throwIfAborted(); }
      async function turn(agent: any, requestId: any, input: any) {
        const { inputId, settled } = await runInput(runtime, agent.id, input, { requestId, timeoutMs: turnTimeoutMs, signal });
        completed.push({ agentId: agent.id, requestId, inputId, seq: settled.seq, outcome: settled.outcome });
      }
      checkCancelled();
      if (!['baseline', 'source', 'finding'].every((field: any) => typeof fact?.[field] === 'string' && fact[field])) {
        throw new TypeError('The fixed source fact requires nonempty baseline, source and finding within the Notes field limit');
      }
      original = JSON.stringify({ baseline: fact.baseline, source: fact.source, finding: fact.finding });
      if (original.length > 2048) throw new TypeError('The fixed source fact exceeds the Notes field limit');
      const files: any = { 'review-input.json': { data: original, encoding: 'utf8' } };
      const writer = await runtime.spawn({ requestId: 'writer', profile: 'writer', files: { ...files,
        'note-request.json': { data: JSON.stringify({ key, text: original }), encoding: 'utf8' } } });
      await turn(writer, 'writer-input', inputText.put);
      const sent = notes.records.get(key);
      if (sent?.author !== writer.id || sent.text !== original) throw new Error('The writer did not publish the exact source fact');
      checkCancelled();
      const reader = await runtime.spawn({ requestId: 'reader', profile: 'reader', files });
      await turn(reader, 'reader-input', inputText.get);
      if (!notes.reads.some((read: any) => read.agentId === reader.id && read.key === key && read.found)) {
        throw new Error('The reader did not retrieve the exact source fact from Notes');
      }
      await turn(reader, 'reader-followup', inputText.follow);
      checkCancelled();
      const stopped = await runtime.stop(reader.id, { timeoutMs: closeTimeoutMs });
      const filesPath = stopped.artifacts.find((path: any) => path.endsWith('/artifacts/files'));
      if (stopped.cleanup !== 'complete' || !filesPath) {
        throw Object.assign(new Error('The reader evidence has not been exported'), { code: 'REVIEW_EXPORT_PENDING',
          runtimeId: runtime.id, agentId: reader.id, cleanup: stopped.cleanup, details: stopped.errors });
      }
      const filesContent = await Promise.all(['review.md', 'followup.md'].map((path: any) => readFile(join(filesPath, path), 'utf8')));
      if (filesContent.some((content: any) => content !== reviewText(fact))) throw new Error('The archived reader files differ from the fixed source fact');
      return { writerId: writer.id, readerId: reader.id, artifacts: stopped.artifacts, verifiedFiles: ['review.md', 'followup.md'] };
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const usage = 'node main.js <config.mjs>\nnode main.js --result <run-directory> --runtime-id <expected-id>';
  const args = process.argv.slice(2);
  const controller: any = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    if (args.length === 1 && args[0] === '--help') {
      process.stdout.write(`${usage}\nThe fixed Notes handoff stops on completion, Ctrl+C or SIGTERM. Result inspection reads saved reports.\n`);
    } else if (args.length === 4 && args[0] === '--result' && args[1] && !args[1].startsWith('--') &&
        args[2] === '--runtime-id' && args[3] && !args[3].startsWith('--')) {
      const { readHarnessResult } = await import('./read-result.js');
      const result = await readHarnessResult({ runDirectory: args[1], runtimeId: args[3] });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = result.harness.state === 'read' && result.core.state === 'read' ? 0 : 1;
    } else {
      if (args.length !== 1 || !args[0] || args[0].startsWith('--')) {
        throw Object.assign(new Error(), { code: 'NOTES_ARGUMENTS_INVALID' });
      }
      const config = (await import(pathToFileURL(resolve(args[0])).href)).default;
      const report = await runNotesHarness(config, controller.signal);
      process.stdout.write(`${JSON.stringify(report)}\n`);
      process.exitCode = report.businessFailure || report.cleanupFailure || report.reportSaveFailure ? 1 : 0;
    }
  } catch (error: any) {
    const invalid = error?.code === 'NOTES_ARGUMENTS_INVALID' || error?.code === 'INVALID_RESULT_ARGUMENTS';
    process.stderr.write(`${JSON.stringify({ code: invalid ? 'NOTES_ARGUMENTS_INVALID' : 'NOTES_START_FAILED', ...(invalid ? { usage } : {}) })}\n`);
    process.exitCode = invalid ? 2 : 1;
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}
