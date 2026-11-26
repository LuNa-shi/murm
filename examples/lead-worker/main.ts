import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOpenSandboxBackend } from '@murm/core/backends/opensandbox';
import { runLeadWorker } from '../../src/harnesses/lead-worker/index.js';

export function runLeadWorkerExample(config: any, signal: any) {
  const backend = createOpenSandboxBackend(config.backend);
  const secretValues = [config.backend?.sandbox?.apiKey, config.backend?.sandbox?.execdToken,
    ...Object.values((config.backend?.models ?? {} as Record<string, any>)).flatMap((model: any) => Object.values((model.upstream?.headers ?? {} as Record<string, any>)))].filter((value: any) => typeof value === 'string' && value);
  return runLeadWorker({ ...config, backend, signal, secretValues }, { goal: config.goal, supplement: config.supplement, signal });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const lifetime: any = new AbortController();
  const abort = () => lifetime.abort(); process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const config = (await import(pathToFileURL(resolve(process.argv[2] ?? 'config.mjs')).href)).default;
    const report = await runLeadWorkerExample(config, lifetime.signal); console.log(JSON.stringify(report));
    if (report.businessFailure || report.cleanupFailure || report.reportSaveFailure) process.exitCode = 1;
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
