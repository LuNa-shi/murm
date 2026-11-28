import { parseArgs } from 'node:util';

export const setupUsage = [
  'Usage: murm setup [--mode existing|local] [--endpoint <url>] [--public-url <url>] [--config <module>]',
  'Without --mode, reuse a configured or saved connection, or prepare local OpenSandbox when no connection is configured.',
  'Existing mode saves the authenticated connection. Run murm doctor --smoke to verify Worker and Runtime callbacks.',
].join('\n');
export const initUsage = 'Usage: murm init --template subagents --dir <directory>';
const recoverUsage = 'Usage: murm recover --run-dir <directory> --config <module>';
export const doctorUsage = 'Usage: murm doctor [--config <module>] [--smoke]';
const projectUsage = [
  'Usage: murm --harness <module> --prompt <text> [--cwd <directory>] [--config <module>] [--output-dir <directory>] [--lifetime task|interactive] [--interaction none|questions]',
  '       murm --harness <module> --mode rpc [--config <module>] [--output-dir <directory>] [--lifetime task|interactive] [--interaction none|questions]',
  'Built-in Harnesses: subagents, taskpool, peermesh, substrate, lead-worker, notes, messages',
  'Use a built-in name, an explicit .mjs or ESM .js file, or a package installed from the invocation directory.',
  'An explicit interactive lifetime or questions in foreground mode uses JSONL for subsequent commands.',
  'The project directory defaults to the invocation directory. In RPC mode send cwd and prompt in the run request.',
].join('\n');
export const murmUsage = [
  'Usage: murm                         Open the foreground TUI (interactive terminal required)',
  '       murm --mode tui [--harness <module>] [--cwd <directory>] [--config <module>] [--prompt <draft>] [--output-dir <directory>]',
  'TUI exit codes: 0 completed or exited before starting; 1 failed, cancelled or cleanup unconfirmed; 2 startup or terminal error; 130 SIGINT; 143 SIGTERM.',
  'Usage: murm --version',
  projectUsage, setupUsage, initUsage, doctorUsage, recoverUsage,
  'Usage: murm trace --root <runs-dir> [--port 8787] [--open]',
].join('\n');

export type LocalCommand =
  | { command: 'setup'; mode?: 'existing' | 'local'; endpoint?: string; publicUrl?: string; configPath?: string }
  | { command: 'doctor'; configPath?: string; smoke: boolean };

type HarnessOptions = {
  configPath?: string;
  outputRoot?: string;
  lifetime?: 'task' | 'interactive';
  interaction?: 'none' | 'questions';
};
export type ProjectCommand = HarnessOptions & { command: 'harness'; harness: string }
  & ({ mode: 'foreground'; cwd?: string; prompt: string } | { mode: 'rpc' });
export type TuiCommand = HarnessOptions & { command: 'tui'; harness: string; cwd?: string; prompt?: string };

type MurmCommand = LocalCommand | { command: 'init'; directory: string } | TuiCommand | ProjectCommand | { command: 'recover'; directory: string; configPath: string };

export function parseMurmCommand(args: string[]): MurmCommand | { help: string } {
  const [command, ...options] = args;
  if (command === undefined) return { command: 'tui', harness: 'subagents' };
  if (command === '--help' && options.length === 0) return { help: murmUsage };
  const usages = { setup: setupUsage, init: initUsage, doctor: doctorUsage, recover: recoverUsage };
  const usage = Object.hasOwn(usages, command) ? usages[command as keyof typeof usages] : murmUsage;
  if (options.length === 1 && options[0] === '--help' && usage !== murmUsage) return { help: usage };
  try {
    if (command.startsWith('--')) {
      const { values } = parseArgs({ args, options: {
        harness: { type: 'string' }, prompt: { type: 'string' }, cwd: { type: 'string' },
        mode: { type: 'string' }, config: { type: 'string' }, 'output-dir': { type: 'string' },
        lifetime: { type: 'string' }, interaction: { type: 'string' },
      } });
      if (values.harness === '' || values.cwd === '' || values.config === '' || values['output-dir'] === '') throw new Error();
      const { lifetime, interaction } = values;
      if ((lifetime !== undefined && lifetime !== 'task' && lifetime !== 'interactive') ||
          (interaction !== undefined && interaction !== 'none' && interaction !== 'questions')) throw new Error();
      const settings: HarnessOptions = { configPath: values.config,
        outputRoot: values['output-dir'],
        lifetime, interaction };
      if (values.mode === 'tui' || (values.mode === undefined && values.prompt === undefined)) {
        return { ...settings, command: 'tui', harness: values.harness ?? 'subagents', cwd: values.cwd, prompt: values.prompt };
      }
      if (!values.harness) throw new Error();
      const project = { ...settings, command: 'harness' as const, harness: values.harness };
      if (values.mode === 'rpc' && values.prompt === undefined && values.cwd === undefined) return { ...project, mode: 'rpc' };
      if (values.mode === undefined && values.prompt?.trim() && values.cwd !== '') {
        return { ...project, mode: 'foreground', cwd: values.cwd, prompt: values.prompt };
      }
    }
    if (command === 'setup') {
      const { values } = parseArgs({ args: options, options: { mode: { type: 'string' }, endpoint: { type: 'string' }, 'public-url': { type: 'string' }, config: { type: 'string' } } });
      if (values.config !== '' && values.endpoint !== '' && values['public-url'] !== '' && (values.mode === undefined || values.mode === 'existing' || values.mode === 'local')) {
        return { command, mode: values.mode, endpoint: values.endpoint, publicUrl: values['public-url'], configPath: values.config };
      }
    }
    if (command === 'init') {
      const { values } = parseArgs({
        args: options, options: { template: { type: 'string' }, dir: { type: 'string' } },
      });
      if (values.template === 'subagents' && values.dir) return { command, directory: values.dir };
    }
    if (command === 'recover') {
      const { values } = parseArgs({ args: options, options: { 'run-dir': { type: 'string' }, config: { type: 'string' } } });
      if (values['run-dir'] && values.config) return { command, directory: values['run-dir'], configPath: values.config };
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
