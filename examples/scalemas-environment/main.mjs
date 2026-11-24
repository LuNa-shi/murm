import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function runScaleMASExample(config, signal) {
  const { createPiOpenSandboxBackend } = await import('@swarmenv/core/backends/pi-opensandbox');
  const { runScaleMAS } = await import('../../src/environments/scalemas/index.js');
  return runScaleMAS({ ...config, backend: createPiOpenSandboxBackend(config.backend) }, signal);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const usage = 'node main.mjs <config.mjs>\nnode main.mjs --result <run-directory> --runtime-id <expected-id>';
  const args = process.argv.slice(2);
  const lifetime = new AbortController();
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
    } else {
      if (args.length !== 1 || !args[0] || args[0].startsWith('--')) throw Object.assign(new Error(), { code: 'SCALEMAS_ARGUMENTS_INVALID' });
      const config = (await import(pathToFileURL(resolve(args[0])).href)).default;
      const report = await runScaleMASExample(config, lifetime.signal);
      process.stdout.write(`${JSON.stringify(report)}\n`);
      process.exitCode = report.businessFailure || report.cleanupFailure || report.reportSaveFailure ? 1 : 0;
    }
  } catch (error) {
    const invalid = ['SCALEMAS_ARGUMENTS_INVALID', 'INVALID_RESULT_ARGUMENTS'].includes(error?.code);
    process.stderr.write(`${JSON.stringify({ code: invalid ? 'SCALEMAS_ARGUMENTS_INVALID' : 'SCALEMAS_START_FAILED', ...(invalid ? { usage } : {}) })}\n`);
    process.exitCode = invalid ? 2 : 1;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
