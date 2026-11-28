#!/usr/bin/env node

import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseMurmCommand } from './murm-arguments.js';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  console.log(manifest.version);
} else if (args[0] === 'trace') {
  const viewerCommand = '../src/trace-viewer/command.mjs';
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
    const detail = error instanceof Error && error.message ? ` (${error.message})` : '';
    console.error(`Could not start the Trace Viewer${detail}. Run murm trace --help for supported arguments.`);
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
  if (command && 'command' in command && command.command === 'tui') {
    if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === 'dumb') {
      console.error('The TUI needs an interactive terminal on stdin and stdout. Use murm --harness H --prompt "..." for foreground or murm --harness H --mode rpc for JSONL.');
      process.exitCode = 2;
    } else {
      let code = 2;
      try {
        const { runMurmTui } = await import('./murm-tui.js');
        code = await runMurmTui(command, process.cwd());
      } catch {
        console.error('Could not load the TUI. Reinstall murm or use explicit foreground or RPC mode.');
      }
      process.exit(code);
    }
  }
  if (command && 'command' in command && command.command === 'harness') {
    const { runProjectCommand } = await import('./murm-project.js');
    process.exit(await runProjectCommand(command, process.cwd()));
  }
  if (command && 'command' in command && command.command === 'recover') {
    let exitCode = 1;
    let report: unknown;
    try {
      const { recoverRuntime } = await import('../src/core/index.js');
      const module = await import(pathToFileURL(await realpath(resolve(command.configPath))).href);
      const config = typeof module.default === 'function' ? await module.default() : module.default;
      const runtime = await recoverRuntime({ ...config, runDirectory: command.directory, cleanupOnly: true });
      const result = await runtime.close();
      report = result;
      exitCode = result.cleanup === 'complete' &&
        !result.agents.some(agent => agent.errors.some(error => error.code === 'ARTIFACT_EXPORT_LOST')) ? 0 : 1;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        && /^[A-Z][A-Z0-9_]*$/.test(error.code) ? error.code : 'RECOVERY_FAILED';
      report = { cleanup: 'pending', error: code };
    }
    // Pending cleanup can still own open sockets and renewable resources. The
    // one-shot command hands those back to the durable record on process exit.
    process.stdout.write(JSON.stringify(report, null, 2) + '\n', () => process.exit(exitCode));
  } else if (command && 'command' in command && (command.command === 'init' || command.command === 'setup' || command.command === 'doctor')) {
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
        : await (await import('./local-setup.js')).runLocalCommand(command, controller.signal, process.stderr.isTTY ? message => console.error(message) : undefined);
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
