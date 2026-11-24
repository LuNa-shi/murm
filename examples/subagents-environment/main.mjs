import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@swarmenv/core';
import { ServiceRegistry } from '@swarmenv/core/services';
import { createPiOpenSandboxBackend } from '@swarmenv/core/backends/pi-opensandbox';
import { runWithReport } from './run-report.mjs';
import { createSubagentsController } from './controller.mjs';
import { parentPromptFor, childPrompt, initialGoalFor } from './prompts.mjs';

/** Text references must point at the actual delivered round snapshots. */
export function checkDelivery(output, deliveries, childCount = 2) {
  if (!Number.isSafeInteger(childCount) || childCount < 2 || childCount > 7) return null;
  let final;
  try { final = JSON.parse(output); } catch { return null; }
  if (typeof final?.summary !== 'string' || !final.summary.trim() || !Array.isArray(final.conclusions) || final.conclusions.length !== childCount + 1) return null;
  const completed = deliveries.filter(row => row.kind === 'child' && row.state === 'accepted' && row.result.outcome === 'completed');
  const keys = new Set(); const children = new Map();
  for (const conclusion of final.conclusions) {
    const result = completed.find(row => row.result.childId === conclusion.childId && row.result.eventSeq === conclusion.eventSeq)?.result;
    if (!result || typeof conclusion.quote !== 'string' || !conclusion.quote || conclusion.quote !== result.output) return null;
    const key = `${conclusion.childId}:${conclusion.eventSeq}`;
    if (keys.has(key)) return null;
    keys.add(key); children.set(conclusion.childId, (children.get(conclusion.childId) ?? 0) + 1);
  }
  if (children.size !== childCount || ![...children.values()].includes(2)) return null;
  return final;
}

export async function runSubagentsEnvironment({ backend, model = 'default', image, outputDir,
  childCount = 2, goal = initialGoalFor(childCount), supplements = [], workTimeoutMs = 120_000, closeTimeoutMs = 30_000 }, signal) {
  if (!Number.isSafeInteger(childCount) || childCount < 2 || childCount > 7 || typeof goal !== 'string' || !goal || Buffer.byteLength(goal) > 64 * 1024 || !Array.isArray(supplements) || supplements.length > 4 || supplements.some(input => typeof input !== 'string' || Buffer.byteLength(input) > 64 * 1024) ||
      !Number.isSafeInteger(workTimeoutMs) || workTimeoutMs < 1 || workTimeoutMs > 2147483647) throw new TypeError('Provide two to seven children, a text goal, at most four supplements and a finite work deadline');
  let controller; let final;
  const secrets = [backend?.sandbox?.apiKey, backend?.sandbox?.execdToken,
    ...Object.values(backend?.models ?? {}).flatMap(value => Object.values(value.upstream?.headers ?? {}))]
    .filter(value => typeof value === 'string' && value.length).flatMap(value => [value, value.replace(/^(?:Bearer|Basic)\s+/i, '')]).filter(Boolean);
  const redact = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string'
    ? secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), item) : item));
  return runWithReport({ outputDir, closeTimeoutMs,
    redact: report => redact({ ...report, routing: controller?.report() ?? null }),
    createRuntime: async () => {
      signal?.throwIfAborted();
      const common = { model, image, writable: true };
      const runtime = await createRuntime({ backend: createPiOpenSandboxBackend(backend), outputDir, services: new ServiceRegistry(), maxBots: childCount + 1, profiles: {
        parent: { ...common, prompt: parentPromptFor(childCount), services: { bot: ['spawn', 'get', 'send', 'stop'] }, spawnProfiles: ['child'] },
        child: { ...common, prompt: childPrompt, services: {} },
      } });
      return { ...runtime, close(options) {
        controller?.stop();
        const closed = runtime.close(options);
        return closed.then(async receipt => { await controller?.drain(); return receipt; });
      } };
    },
    async run(runtime) {
      const parent = await runtime.spawn({ profile: 'parent', requestId: 'parent' });
      controller = createSubagentsController(runtime, parent.id, { maxChildren: childCount });
      const waiting = new AbortController();
      const waitSignal = signal ? AbortSignal.any([signal, waiting.signal]) : waiting.signal;
      const finished = controller.waitForFinal({ timeoutMs: workTimeoutMs, signal: waitSignal,
        accept: (event, deliveries) => Boolean(final = checkDelivery(event.output, deliveries, childCount)) });
      // Attach immediately: failures can precede admission receipts.
      finished.catch(() => {});
      try {
        for (const [index, input] of [goal, ...supplements].entries()) {
          signal?.throwIfAborted();
          const entry = await controller.submitUser(input, { requestId: `user-${index}` });
          if (entry.state !== 'accepted') throw Object.assign(new Error('Parent input was not admitted; preserve its receipt'), { code: 'INPUT_UNKNOWN', requestId: entry.requestId, receipt: entry.receipt });
        }
        const event = await finished;
        return { parentId: parent.id, childCount, eventSeq: event.seq, delivery: final };
      } finally {
        // Retain the listener for Runtime close events, while preventing all new dispatch.
        controller.stop(); waiting.abort();
        // Core synchronously fences dynamic spawn before any asynchronous cleanup wait.
        void runtime.close({ timeoutMs: closeTimeoutMs }).catch(() => {});
      }
    },
  }).finally(() => controller?.dispose());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Supply the host configuration module');
  const abort = new AbortController(); const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const config = (await import(pathToFileURL(resolve(process.argv[2])).href)).default;
    const report = await runSubagentsEnvironment(config, abort.signal);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.businessFailure || report.cleanupFailure || report.reportSaveFailure ? 1 : 0;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
