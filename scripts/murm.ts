#!/usr/bin/env node

import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseMurmCommand } from './murm-arguments.js';

const args = process.argv.slice(2);
if (args[0] === 'trace') {
  const viewerCommand = '@luna-shi/murm-trace-viewer/command';
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
      ? 'Install the optional @luna-shi/murm-trace-viewer package to run murm trace.'
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
  if (command && 'command' in command && command.command === 'interactive') {
    const entry = resolve('main.js');
    const config = resolve('config.js');
    const files = await Promise.all([entry, config, resolve('.murm/installed.json')]
      .map(path => stat(path).then(info => info.isFile(), () => false)));
    if (!files.every(Boolean)) {
      console.error('Open a murm project directory or create one with murm init --template subagents --dir <directory>.');
      process.exitCode = 1;
    } else {
      try {
        const main = await realpath(entry);
        process.argv = [process.execPath, main, config, '--interactive'];
        await import(pathToFileURL(main).href);
      } catch {
        console.error('Could not start the interactive Subagents project. Check config.js and the project environment.');
        process.exitCode = 1;
      }
    }
  }
  if (command && 'command' in command && command.command === 'harness') {
    const { runProjectCommand } = await import('./murm-project.js');
    process.exit(await runProjectCommand(command, process.cwd()));
  }
  if (command && 'command' in command && command.command !== 'interactive') {
    const controller = new AbortController();
    let signalCode: number | undefined;
    const interrupt = (signal: NodeJS.Signals) => {
      signalCode ??= signal === 'SIGINT' ? 130 : 143;
      controller.abort();
    };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    try {
      const report = command.command === 'init'
        ? await (await import('./local-setup-template.js')).initializeSubagentsProject(command.directory, controller.signal)
        : await (await import('./local-setup.js')).runLocalCommand(command, controller.signal);
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = signalCode ?? (report.ok ? 0 : 1);
    } catch {
      console.error(JSON.stringify({ ok: false, error: 'The requested murm command could not start. Rebuild or reinstall the murm package.' }));
      process.exitCode = signalCode ?? 1;
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    }
  }
}
