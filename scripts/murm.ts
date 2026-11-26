#!/usr/bin/env node

import { parseMurmCommand } from './murm-arguments.js';

const args = process.argv.slice(2);
if (args[0] === 'trace') {
  const viewerCommand = '@murm/trace-viewer/command';
  try {
    const { runTraceCommand } = await import(viewerCommand) as {
      runTraceCommand(args: string[]): Promise<{ close(): void } | null>;
    };
    const viewer = await runTraceCommand(args.slice(1));
    if (viewer) {
      process.once('SIGINT', viewer.close);
      process.once('SIGTERM', viewer.close);
    }
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND';
    console.error(missing
      ? 'Install the optional @murm/trace-viewer package to run murm trace.'
      : 'Could not start the Trace Viewer. Run murm trace --help for supported arguments.');
    process.exitCode = 1;
  }
} else {
  let command;
  try {
    command = parseMurmCommand(args);
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
}
