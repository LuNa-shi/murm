import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function runScaleMASExample(config: any, signal: any) {
  const { createPiOpenSandboxBackend } = await import('@swarmenv/core/backends/pi-opensandbox');
  if (config.fate !== undefined) {
    const selected = config.backend.models[config.model ?? 'default'];
    const supportedModel = (selected?.provider === 'kimi_proxy' && selected.model === 'k3') ||
      (selected?.provider === 'gpt_proxy' && selected.model === 'gpt-6.1-sol');
    if (!supportedModel) {
      throw Object.assign(new Error('The FATE example supports kimi_proxy/k3 and gpt_proxy/gpt-6.1-sol'), { code: 'FATE_MODEL_INVALID' });
    }
    const { runFateScaleMAS } = await import('./fate-run.js');
    return runFateScaleMAS({ ...config, backend: createPiOpenSandboxBackend({
      ...config.backend, modelGateway: { ...config.backend.modelGateway, maxOutputTokens: null },
    }) }, signal);
  }
  const { runScaleMAS } = await import('../../src/environments/scalemas/index.js');
  return runScaleMAS({ ...config, backend: createPiOpenSandboxBackend(config.backend) }, signal);
}

const failed = (report: any) => report.businessFailure || report.cleanupFailure || report.reportSaveFailure ||
  report.scoreFailure || report.checkpoint?.state === 'failed';

async function runMatrix(config: any, signal: AbortSignal) {
  if (!config.fate || typeof config.fate !== 'object' || typeof config.runId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,55}$/.test(config.runId)) {
    throw Object.assign(new Error(), { code: 'SCALEMAS_ARGUMENTS_INVALID' });
  }
  const groups = [];
  for (const mode of ['shared', 'private', 'none'] as const) {
    signal.throwIfAborted();
    const report = await runScaleMASExample({ ...config, runId: `${config.runId}-${mode}`, fate: { ...config.fate, mode } }, signal);
    groups.push({ mode, runtimeId: report.runtimeId, reportPath: report.reportPath, bundlePath: report.bundlePath,
      teamSuccess: report.scoring?.teamSuccess ?? null, failure: Boolean(failed(report)) });
    if (report.cleanupFailure) break;
  }
  return groups;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const usage = 'node main.js <config.mjs>\nnode main.js --result <run-directory> --runtime-id <expected-id>\nnode main.js --fate-prepare <project-root> <lean-root> [FATE-M|FATE-H]\nnode main.js --fate-matrix <config.mjs>\nnode main.js --fate-rescore <project-root> <lean-root> <frozen-bundle.json>';
  const args = process.argv.slice(2);
  const lifetime: any = new AbortController();
  const stop = () => lifetime.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (args.length === 1 && args[0] === '--help') {
      process.stdout.write(`${usage}\nThe fixed peer pool stops on completion, Ctrl+C or SIGTERM. Result inspection reads saved receipts.\n`);
    } else if (args.length === 4 && args[0] === '--result' && args[1] && !args[1].startsWith('--') &&
        args[2] === '--runtime-id' && args[3] && !args[3].startsWith('--')) {
      const { readEnvironmentResult } = await import('../../src/environments/shared/read-result.js');
      const result = await readEnvironmentResult({ runDirectory: args[1], runtimeId: args[3] });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = result.environment.state === 'read' && result.core.state === 'read' ? 0 : 1;
    } else if (args[0] === '--fate-prepare' && (args.length === 3 ||
        (args.length === 4 && (args[3] === 'FATE-M' || args[3] === 'FATE-H')))) {
      const { prepareFate } = await import('./fate-run.js');
      const prepared = await prepareFate({ projectRoot: args[1], leanRoot: args[2], benchmark: args[3] === 'FATE-H' ? 'FATE-H' : 'FATE-M' });
      process.stdout.write(`${JSON.stringify(prepared)}\n`);
    } else if (args.length === 4 && args[0] === '--fate-rescore') {
      const { rescoreFate } = await import('./fate-run.js');
      const scores = await rescoreFate({ projectRoot: args[1], leanRoot: args[2] }, args[3]);
      process.stdout.write(`${JSON.stringify(scores)}\n`);
      process.exitCode = scores.candidates.some(candidate => ['timeout', 'checker_error', 'aborted'].includes(candidate.status)) ? 1 : 0;
    } else if (args.length === 2 && args[0] === '--fate-matrix') {
      const configuration = (await import(pathToFileURL(resolve(args[1])).href)).default;
      const groups = await runMatrix(configuration, lifetime.signal);
      process.stdout.write(`${JSON.stringify(groups)}\n`);
      process.exitCode = groups.length === 3 && groups.every(group => !group.failure) ? 0 : 1;
    } else {
      if (args.length !== 1 || !args[0] || args[0].startsWith('--')) throw Object.assign(new Error(), { code: 'SCALEMAS_ARGUMENTS_INVALID' });
      const config = (await import(pathToFileURL(resolve(args[0])).href)).default;
      const report = await runScaleMASExample(config, lifetime.signal);
      process.stdout.write(`${JSON.stringify(report)}\n`);
      process.exitCode = failed(report) ? 1 : 0;
    }
  } catch (error: any) {
    const invalid = ['SCALEMAS_ARGUMENTS_INVALID', 'INVALID_RESULT_ARGUMENTS'].includes(error?.code);
    process.stderr.write(`${JSON.stringify({ code: invalid ? 'SCALEMAS_ARGUMENTS_INVALID' : 'SCALEMAS_START_FAILED', ...(invalid ? { usage } : {}) })}\n`);
    process.exitCode = invalid ? 2 : 1;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
