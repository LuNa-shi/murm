#!/usr/bin/env node

import { parseMurmCommand } from './murm-arguments.js';

let command;
try {
  command = parseMurmCommand(process.argv.slice(2));
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 2;
}
if (command && 'help' in command) console.log(command.help);
if (command && !('help' in command)) {
  const controller = new AbortController();
  let signalCode: number | undefined;
  const interrupt = (signal: NodeJS.Signals) => {
    signalCode ??= signal === 'SIGINT' ? 130 : 143;
    controller.abort();
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    const { runLocalCommand } = await import('./local-setup.js');
    const report = await runLocalCommand(command, controller.signal);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = signalCode ?? (report.ok ? 0 : 1);
  } catch {
    console.error(JSON.stringify({ ok: false, error: 'The local setup command could not start. Rebuild or reinstall the murm package.' }));
    process.exitCode = signalCode ?? 1;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
