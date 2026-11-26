import { parseArgs } from 'node:util';

export const setupUsage = 'Usage: murm setup';
export const initUsage = 'Usage: murm init --template subagents --dir <directory>';
export const doctorUsage = 'Usage: murm doctor [--config <config.js>] [--smoke]';
export const murmUsage = [
  'Usage: murm                         Start an interactive session in the current project',
  setupUsage, initUsage, doctorUsage,
  'Usage: murm trace --root <runs-dir> [--port 8787] (requires @murm/trace-viewer)',
].join('\n');

export type LocalCommand =
  | { command: 'setup' }
  | { command: 'doctor'; configPath?: string; smoke: boolean };

type MurmCommand = LocalCommand | { command: 'init'; directory: string } | { command: 'interactive' };

export function parseMurmCommand(args: string[]): MurmCommand | { help: string } {
  const [command, ...options] = args;
  if (command === undefined) return { command: 'interactive' };
  if (command === '--help' && options.length === 0) return { help: murmUsage };
  const usages = { setup: setupUsage, init: initUsage, doctor: doctorUsage };
  const usage = Object.hasOwn(usages, command) ? usages[command as keyof typeof usages] : murmUsage;
  if (options.length === 1 && options[0] === '--help' && usage !== murmUsage) return { help: usage };
  try {
    if (command === 'setup' && options.length === 0) return { command };
    if (command === 'init') {
      const { values } = parseArgs({
        args: options, options: { template: { type: 'string' }, dir: { type: 'string' } },
      });
      if (values.template === 'subagents' && values.dir) return { command, directory: values.dir };
    }
    if (command === 'doctor') {
      const { values } = parseArgs({
        args: options, options: { config: { type: 'string' }, smoke: { type: 'boolean' } },
      });
      if (values.config !== '') return { command, configPath: values.config, smoke: values.smoke === true };
    }
  } catch {
    // Argument errors can contain untrusted input. Print only the command usage.
  }
  throw new Error(usage);
}
