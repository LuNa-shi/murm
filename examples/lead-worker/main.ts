import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSandbox } from '@luna-shi/murm';
import { runLeadWorker } from './harness/index.js';
import { dynamicOrders } from './dynamic-orders.js';

export async function runLeadWorkerExample(config: any, signal: any) {
  const sandbox = createSandbox(config.sandbox);
  const secretValues = [config.sandbox?.apiKey, config.sandbox?.execdToken,
    ...Object.values((config.models ?? {} as Record<string, any>)).flatMap((model: any) => Object.values((model.upstream?.headers ?? {} as Record<string, any>)))].filter((value: any) => typeof value === 'string' && value);
  const dynamic = config.dynamic ? await dynamicOrders(config.dynamic) : undefined;
  return runLeadWorker({ ...config, sandbox, signal, secretValues, dynamic }, { goal: config.goal, supplement: config.supplement, signal });
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
