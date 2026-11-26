import { parseArgs } from 'node:util';

export const setupUsage = 'Usage: murm setup --template subagents --dir <directory>';
export const doctorUsage = 'Usage: murm doctor --config <config.js> [--smoke]';
export const murmUsage = `${setupUsage}\n${doctorUsage}`;

export type LocalCommand =
  | { command: 'setup'; directory: string }
  | { command: 'doctor'; configPath: string; smoke: boolean };

export function parseMurmCommand(args: string[]): LocalCommand | { help: string } {
  const [command, ...options] = args;
  if (command === undefined || (command === '--help' && options.length === 0)) return { help: murmUsage };
  const usage = command === 'setup' ? setupUsage : command === 'doctor' ? doctorUsage : murmUsage;
  if (options.length === 1 && options[0] === '--help' && usage !== murmUsage) return { help: usage };
  try {
    if (command === 'setup') {
      const { values } = parseArgs({
        args: options, options: { template: { type: 'string' }, dir: { type: 'string' } },
      });
      if (values.template === 'subagents' && values.dir) return { command, directory: values.dir };
    }
    if (command === 'doctor') {
      const { values } = parseArgs({
        args: options, options: { config: { type: 'string' }, smoke: { type: 'boolean' } },
      });
      if (values.config) return { command, configPath: values.config, smoke: values.smoke === true };
    }
  } catch {
    // Argument errors can contain untrusted input. Print only the command usage.
  }
  throw new Error(usage);
}
