import { parseArgs } from 'node:util';

export const setupUsage = 'Usage: murm setup';
export const initUsage = 'Usage: murm init --template subagents --dir <directory>';
export const doctorUsage = 'Usage: murm doctor [--config <config.js>] [--smoke]';
const projectUsage = [
  'Usage: murm --harness <module> --prompt <text> [--cwd <directory>] [--config <module>] [--output-dir <directory>]',
  '       murm --harness <module> --mode rpc [--config <module>] [--output-dir <directory>]',
  'Built-in Harnesses: subagents, taskpool, peermesh, substrate, lead-worker, notes, messages',
  'Use a built-in name, an explicit .mjs or ESM .js file, or a package installed from the invocation directory.',
  'The project directory defaults to the invocation directory. In RPC mode send cwd and prompt in the run request.',
].join('\n');
export const murmUsage = [
  'Usage: murm                         Start an interactive session in the current project',
  projectUsage, setupUsage, initUsage, doctorUsage,
  'Usage: murm trace --root <runs-dir> [--port 8787] [--open]',
].join('\n');

export type LocalCommand =
  | { command: 'setup' }
  | { command: 'doctor'; configPath?: string; smoke: boolean };

export type ProjectCommand = {
  command: 'harness';
  harness: string;
  configPath?: string;
  outputRoot?: string;
} & ({ mode: 'foreground'; cwd?: string; prompt: string } | { mode: 'rpc' });

type MurmCommand = LocalCommand | { command: 'init'; directory: string } | { command: 'interactive' } | ProjectCommand;

export function parseMurmCommand(args: string[]): MurmCommand | { help: string } {
  const [command, ...options] = args;
  if (command === undefined) return { command: 'interactive' };
  if (command === '--help' && options.length === 0) return { help: murmUsage };
  const usages = { setup: setupUsage, init: initUsage, doctor: doctorUsage };
  const usage = Object.hasOwn(usages, command) ? usages[command as keyof typeof usages] : murmUsage;
  if (options.length === 1 && options[0] === '--help' && usage !== murmUsage) return { help: usage };
  try {
    if (command.startsWith('--')) {
      const { values } = parseArgs({ args, options: {
        harness: { type: 'string' }, prompt: { type: 'string' }, cwd: { type: 'string' },
        mode: { type: 'string' }, config: { type: 'string' }, 'output-dir': { type: 'string' },
      } });
      if (!values.harness || values.config === '' || values['output-dir'] === '') throw new Error();
      const project = { command: 'harness' as const, harness: values.harness, configPath: values.config, outputRoot: values['output-dir'] };
      if (values.mode === 'rpc' && values.prompt === undefined && values.cwd === undefined) return { ...project, mode: 'rpc' };
      if (values.mode === undefined && values.prompt?.trim() && values.cwd !== '') {
        return { ...project, mode: 'foreground', cwd: values.cwd, prompt: values.prompt };
      }
    }
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
