import assert from 'node:assert/strict';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute } from './notes-installed-package.js';

export const useNativeTerminal = process.env.MURM_PROJECT_TUI_TEST === '1';

export async function runInstalledHarnessTerminal(installation: { directory: string; env: NodeJS.ProcessEnv }, options: {
  harness: string; cwd: string; prompt: string; configPath: string; outputDir: string; timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  observationText?: string;
  taskFeedback?: { text: string; release: string };
  peerControl?: string;
}) {
  const env = { ...installation.env, ...options.env };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  env.PATH = join(installation.directory, 'node_modules', '.bin') + delimiter + env.PATH;
  env.XDG_CONFIG_HOME = join(dirname(options.outputDir), 'terminal-config');
  env.MURM_TUI_TEST_TRANSCRIPT = options.outputDir + '.terminal.raw';
  await mkdir(dirname(options.outputDir), { recursive: true, mode: 0o700 });
  const args = [fileURLToPath(new URL('./murm-tui-harness.py', import.meta.url)), options.harness,
    options.cwd, options.configPath, options.outputDir, options.prompt, options.observationText ?? '"runtimeState":',
    String(Math.floor(options.timeoutMs / 1000))];
  if (options.taskFeedback) args.push('--task-feedback', options.taskFeedback.text, '--release', options.taskFeedback.release);
  if (options.peerControl) args.push('--peer-control', options.peerControl);
  await execute('python3', args, { cwd: installation.directory, env, timeout: options.timeoutMs, maxBuffer: 1024 * 1024 });
  const [runId, ...others] = await readdir(options.outputDir);
  assert.ok(runId);
  assert.equal(others.length, 0);
  const reportPath = join(options.outputDir, runId, 'project-run.json');
  const result = JSON.parse(await readFile(reportPath, 'utf8'));
  return { result: { ...result, reportPath }, status: options.peerControl ? 1 : 0, observation: { businessObserved: true, terminal: true } };
}
