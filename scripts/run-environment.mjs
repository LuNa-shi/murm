#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const usage = 'node scripts/run-environment.mjs --config <host-module.mjs>';
const args = process.argv.slice(2);
const lifetime = new AbortController();
const stop = () => lifetime.abort();
const inputFailed = () => lifetime.abort(Object.assign(new Error('HOST_INPUT_FAILED'), { code: 'HOST_INPUT_FAILED' }));
process.stdin.on('error', inputFailed);
process.once('SIGINT', stop); process.once('SIGTERM', stop);
// Own stdout through the final write callback, including asynchronous pipe errors.
let outputFailure;
const outputFailed = () => {
  outputFailure ??= Object.assign(new Error('HOST_OUTPUT_FAILED'), { code: 'HOST_OUTPUT_FAILED' });
  lifetime.abort(outputFailure);
};
const diagnosticFailed = () => {};
process.stdout.on('error', outputFailed);
process.stderr.on('error', diagnosticFailed);
const writeOutput = async value => {
  if (outputFailure) throw outputFailure;
  await new Promise((resolve, reject) => {
    try { process.stdout.write(value, error => {
      if (error) outputFailed();
      if (outputFailure) reject(outputFailure); else resolve();
    }); } catch { outputFailed(); reject(outputFailure); }
  });
};
try {
  if (args.length === 1 && args[0] === '--help') {
    await writeOutput(`${usage}\nConfiguration default export selects mode, options and finite timeoutMs. Read JSON-line status, kickoff, input, wait or stop commands from stdin.\n`);
  } else {
    if (args.length !== 2 || args[0] !== '--config' || !args[1] || args[1].startsWith('--')) throw Object.assign(new Error(), { code: 'HOST_ARGUMENTS_INVALID' });
    const { default: configuration } = await import(pathToFileURL(resolve(args[1])).href);
    const { runForegroundEnvironment } = await import('../src/environments/shared/foreground-host.js');
    const { runForegroundCommands } = await import('../src/environments/shared/foreground-commands.js');
    const { summarizeCleanupReceipt } = await import('../src/environments/shared/read-result.js');
    const report = await runForegroundEnvironment({ ...configuration, signal: lifetime.signal }, host => runForegroundCommands(host));
    const code = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : error ? 'HOST_RUN_FAILED' : null;
    await writeOutput(`${JSON.stringify({ type: 'result', runtimeId: report.runtimeId, reportPath: report.reportPath ?? null,
      businessFailureCode: code(report.businessFailure),
      cleanupFailureCode: code(report.cleanupFailure), reportSaveFailureCode: code(report.reportSaveFailure),
      ...summarizeCleanupReceipt(report.cleanup) })}\n`);
    process.exitCode = report.businessFailure || report.cleanupFailure || report.reportSaveFailure ? 1 : 0;
  }
} catch (error) {
  const invalid = error?.code === 'HOST_ARGUMENTS_INVALID';
  await new Promise(resolve => { try { process.stderr.write(`${JSON.stringify({ code: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'HOST_START_FAILED', ...(invalid ? { usage } : {}) })}\n`, resolve); } catch { resolve(); } });
  process.exitCode = invalid ? 2 : 1;
} finally {
  process.stdin.pause(); process.stdin.unref?.();
  process.stdin.removeListener('error', inputFailed);
  process.stdout.removeListener('error', outputFailed);
  process.stderr.removeListener('error', diagnosticFailed);
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
}
