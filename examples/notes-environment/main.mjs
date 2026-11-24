import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@swarmenv/core';
import { ServiceRegistry, createInProcessAdapter } from '@swarmenv/core/services';
import { createPiOpenSandboxBackend } from '@swarmenv/core/backends/pi-opensandbox';
import { runInput } from './run-input.mjs';
import { runWithReport } from './run-report.mjs';

const key = 'core-service-boundary';
export const fixedFact = Object.freeze({
  baseline: 'fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e',
  source: 'src/agent/services-bridge.js',
  finding: 'Bridge identity and flat Task/Execution authorization have separate responsibilities.',
});

const textField = { type: 'string', minLength: 1, maxLength: 2048 };
const keyField = { type: 'string', minLength: 1, maxLength: 64 };
const note = { type: 'object', properties: { key: keyField, text: textField, author: { type: 'string' } },
  required: ['key', 'text', 'author'], additionalProperties: false };
const notesManifest = {
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
  const records = new Map();
  const reads = [];
  const services = new ServiceRegistry();
  const adapter = createInProcessAdapter({ invoke({ capability, input, caller }) {
    const previous = records.get(input.key);
    if (capability.operation === 'get') {
      reads.push({ botId: caller.botId, key: input.key, found: Boolean(previous) });
      return previous ?? null;
    }
    if (previous && (previous.author !== caller.botId || previous.text !== input.text)) {
      throw Object.assign(new Error('A different note already uses this key'), { code: 'CONFLICT' });
    }
    if (previous) return previous;
    const current = { key: input.key, text: input.text, author: caller.botId };
    records.set(input.key, current);
    return current;
  } });
  services.registerService({ manifest: notesManifest, adapter });
  return { services, records, reads };
}

export function reviewText(fact) {
  return `# Source review\n\nBaseline: ${fact.baseline}\nSource: ${fact.source}\nFinding: ${fact.finding}\n`;
}

function reportRedactor(backend) {
  const secrets = [backend?.sandbox?.apiKey, backend?.sandbox?.execdToken,
    ...Object.values(backend?.models ?? {}).flatMap(model => Object.values(model.upstream?.headers ?? {}))]
    .filter(value => typeof value === 'string' && value.length)
    .flatMap(value => [value, value.replace(/^(?:Bearer|Basic)\s+/i, '')]).filter(Boolean)
    .sort((left, right) => right.length - left.length);
  return value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string'
    ? secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), item) : item));
}

const inputText = Object.freeze({
  put: 'Read review-input.json and note-request.json in this work directory. Use Bash and `swarm notes put --input note-request.json --request-id notes-put` to publish the seeded request. Its text field contains the exact review-input.json string.',
  get: `Use Bash and \`swarm notes get --key ${key} --request-id notes-get\`. Compare the note text with review-input.json. If they match, write review.md with a heading '# Source review', one blank line, then 'Baseline: ', 'Source: ' and 'Finding: ' followed by their exact values, one line each, ending with a newline.`,
  follow: 'Use Bash to read the existing review.md from the previous turn and copy it unchanged to followup.md.',
});

export async function runNotesEnvironment({ backend, model = 'default', image, outputDir, fact = fixedFact,
  turnTimeoutMs = 30_000, closeTimeoutMs = 30_000 }, signal) {
  const notes = createNotes();
  const redact = reportRedactor(backend);
  const completed = [];
  let original;
  return runWithReport({ outputDir, closeTimeoutMs,
    redact: report => {
      const stored = notes.records.get(key);
      const serviceState = stored ? [{ ...stored, text: stored.text === original ? original : '[unexpected text omitted]' }] : [];
      return redact({ ...report, serviceState, reads: notes.reads.filter(read => read.key === key), turns: completed });
    },
    createRuntime: async () => {
      signal?.throwIfAborted();
      const common = { model, image, writable: true };
      return createRuntime({ backend: createPiOpenSandboxBackend(backend), services: notes.services, maxBots: 2, outputDir,
        profiles: {
          writer: { ...common, prompt: 'Share the fixed source fact verbatim through Notes.', services: { notes: ['put'] } },
          reader: { ...common, prompt: 'Verify the shared fact and save evidence in your private work directory.', services: { notes: ['get'] },
            collect: { paths: ['review.md', 'followup.md'], includeGit: false, maxBytes: 64 * 1024, required: true } },
        },
      });
    },
    async run(runtime) {
      function checkCancelled() { signal?.throwIfAborted(); }
      async function turn(bot, requestId, input) {
        const { inputId, settled } = await runInput(runtime, bot.id, input, { requestId, timeoutMs: turnTimeoutMs, signal });
        completed.push({ botId: bot.id, requestId, inputId, seq: settled.seq, outcome: settled.outcome });
      }
      checkCancelled();
      if (!['baseline', 'source', 'finding'].every(field => typeof fact?.[field] === 'string' && fact[field])) {
        throw new TypeError('The fixed source fact requires nonempty baseline, source and finding within the Notes field limit');
      }
      original = JSON.stringify({ baseline: fact.baseline, source: fact.source, finding: fact.finding });
      if (original.length > 2048) throw new TypeError('The fixed source fact exceeds the Notes field limit');
      const files = { 'review-input.json': { data: original, encoding: 'utf8' } };
      const writer = await runtime.spawn({ requestId: 'writer', profile: 'writer', files: { ...files,
        'note-request.json': { data: JSON.stringify({ key, text: original }), encoding: 'utf8' } } });
      await turn(writer, 'writer-input', inputText.put);
      const sent = notes.records.get(key);
      if (sent?.author !== writer.id || sent.text !== original) throw new Error('The writer did not publish the exact source fact');
      checkCancelled();
      const reader = await runtime.spawn({ requestId: 'reader', profile: 'reader', files });
      await turn(reader, 'reader-input', inputText.get);
      if (!notes.reads.some(read => read.botId === reader.id && read.key === key && read.found)) {
        throw new Error('The reader did not retrieve the exact source fact from Notes');
      }
      await turn(reader, 'reader-followup', inputText.follow);
      checkCancelled();
      const stopped = await runtime.stop(reader.id, { timeoutMs: closeTimeoutMs });
      const filesPath = stopped.artifacts.find(path => path.endsWith('/artifacts/files'));
      if (stopped.cleanup !== 'complete' || !filesPath) {
        throw Object.assign(new Error('The reader evidence has not been exported'), { code: 'REVIEW_EXPORT_PENDING',
          runtimeId: runtime.id, botId: reader.id, cleanup: stopped.cleanup, details: stopped.errors });
      }
      const filesContent = await Promise.all(['review.md', 'followup.md'].map(path => readFile(join(filesPath, path), 'utf8')));
      if (filesContent.some(content => content !== reviewText(fact))) throw new Error('The archived reader files differ from the fixed source fact');
      return { writerId: writer.id, readerId: reader.id, artifacts: stopped.artifacts, verifiedFiles: ['review.md', 'followup.md'] };
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const usage = 'node main.mjs <config.mjs>\nnode main.mjs --result <run-directory> --runtime-id <expected-id>';
  const args = process.argv.slice(2);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    if (args.length === 1 && args[0] === '--help') {
      process.stdout.write(`${usage}\nThe fixed Notes handoff stops on completion, Ctrl+C or SIGTERM. Result inspection reads saved reports.\n`);
    } else if (args.length === 4 && args[0] === '--result' && args[1] && !args[1].startsWith('--') &&
        args[2] === '--runtime-id' && args[3] && !args[3].startsWith('--')) {
      const { readEnvironmentResult } = await import('./read-result.mjs');
      const result = await readEnvironmentResult({ runDirectory: args[1], runtimeId: args[3] });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = result.environment.state === 'read' && result.core.state === 'read' ? 0 : 1;
    } else {
      if (args.length !== 1 || !args[0] || args[0].startsWith('--')) {
        throw Object.assign(new Error(), { code: 'NOTES_ARGUMENTS_INVALID' });
      }
      const config = (await import(pathToFileURL(resolve(args[0])).href)).default;
      const report = await runNotesEnvironment(config, controller.signal);
      process.stdout.write(`${JSON.stringify(report)}\n`);
      process.exitCode = report.businessFailure || report.cleanupFailure || report.reportSaveFailure ? 1 : 0;
    }
  } catch (error) {
    const invalid = error?.code === 'NOTES_ARGUMENTS_INVALID' || error?.code === 'INVALID_RESULT_ARGUMENTS';
    process.stderr.write(`${JSON.stringify({ code: invalid ? 'NOTES_ARGUMENTS_INVALID' : 'NOTES_START_FAILED', ...(invalid ? { usage } : {}) })}\n`);
    process.exitCode = invalid ? 2 : 1;
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}
