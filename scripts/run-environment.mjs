#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const usage = 'node scripts/run-environment.mjs --config <host-module.mjs>';
const args = process.argv.slice(2);
const lifetime = new AbortController();
const stop = () => lifetime.abort();
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(`${usage}\nConfiguration default export selects mode, options and finite timeoutMs. Read JSON-line status, kickoff, input, wait or stop commands from stdin.\n`);
  } else {
    if (args.length !== 2 || args[0] !== '--config' || !args[1] || args[1].startsWith('--')) throw Object.assign(new Error(), { code: 'HOST_ARGUMENTS_INVALID' });
    const { default: configuration } = await import(pathToFileURL(resolve(args[1])).href);
    const { runForegroundEnvironment } = await import('../src/environments/shared/foreground-host.js');
    const { runForegroundCommands } = await import('../src/environments/shared/foreground-commands.js');
    const report = await runForegroundEnvironment({ ...configuration, signal: lifetime.signal }, host => runForegroundCommands(host));
    const code = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : error ? 'HOST_RUN_FAILED' : null;
    process.stdout.write(`${JSON.stringify({ type: 'result', runtimeId: report.runtimeId, reportPath: report.reportPath ?? null,
      businessFailureCode: code(report.businessFailure), cleanup: report.cleanup?.cleanup ?? 'unknown',
      cleanupFailureCode: code(report.cleanupFailure), reportSaveFailureCode: code(report.reportSaveFailure),
      bots: report.cleanup?.bots?.map(bot => ({ botId: bot.botId, execution: bot.execution, cleanup: bot.cleanup })) ?? null,
      pendingCount: Array.isArray(report.cleanup?.pending) ? report.cleanup.pending.length : null,
      pending: report.cleanup?.pending?.map(item => Object.fromEntries(['kind', 'id', 'botId', 'action'].filter(key => typeof item[key] === 'string').map(key => [key, item[key]]))) ?? null })}\n`);
    process.exitCode = report.businessFailure || report.cleanupFailure || report.reportSaveFailure ? 1 : 0;
  }
} catch (error) {
  const invalid = error.code === 'HOST_ARGUMENTS_INVALID';
  process.stderr.write(`${JSON.stringify({ code: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'HOST_START_FAILED', ...(invalid ? { usage } : {}) })}\n`);
  process.exitCode = invalid ? 2 : 1;
} finally {
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
}
