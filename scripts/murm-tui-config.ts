import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { loadMurmConfig } from '../src/core/sandbox/sandbox-connection.js';
import { selectExecutorDriver } from '../src/core/sandbox/executor-driver.js';
import type { SandboxConfig } from '../src/core/backend-config.js';
import { modelClientProtocol } from '../src/core/model/model-transport.js';
import { builtinConfiguration, builtins } from './murm-harnesses.js';
import { checkProjectRuntime, modelState, runLocalCommand } from './local-setup.js';
import type { LocalProjectConfig } from './local-setup-template.js';

type Builtin = keyof typeof builtins;
type Budget = { key: string; fallback?: number; max: number };
const timerMax = 2_147_483_647;
const runtimeBudgets = [
  { key: 'workTimeoutMs', fallback: 120_000, max: timerMax },
  { key: 'closeTimeoutMs', fallback: 30_000, max: timerMax },
];
const budgets: Record<Builtin, readonly Budget[]> = {
  subagents: [...runtimeBudgets, { key: 'questionTimeoutMs', fallback: 60_000, max: 120_000 }],
  taskpool: runtimeBudgets,
  peermesh: [{ key: 'durationMs', fallback: 120_000, max: 86_400_000 }],
  substrate: [...runtimeBudgets, { key: 'turnTimeoutMs', fallback: 30_000, max: timerMax }],
  'lead-worker': [runtimeBudgets[0], { key: 'closeTimeoutMs', fallback: 30_000, max: 60_000 },
    { key: 'turnTimeoutMs', fallback: 30_000, max: timerMax }],
  notes: [{ key: 'turnTimeoutMs', fallback: 30_000, max: timerMax }, runtimeBudgets[1]],
  messages: [{ key: 'workTimeoutMs', fallback: 60_000, max: timerMax },
    { key: 'cleanupTimeoutMs', fallback: 30_000, max: timerMax }],
};

function builtin(name: string): name is Builtin {
  return Object.hasOwn(builtins, name);
}

export function terminalObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const preferencesPath = () => resolve(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'murm', 'launcher.json');
type ConfigurationChoice = { path?: string; source: string };
type Preference = { version: 1; harness: string; configPath: string };

async function readPreference(path: string): Promise<Preference | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    const file = await handle.stat();
    if (!file.isFile() || file.size > 8192 || (file.mode & 0o077) !== 0 ||
        (process.getuid && file.uid !== process.getuid())) throw new Error('Launcher preferences must be an owner-only file');
    const data = Buffer.alloc(8193);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead > 8192) throw new Error('Launcher preferences exceed 8 KiB');
    const pref = terminalObject(JSON.parse(data.subarray(0, bytesRead).toString('utf8')));
    if (pref.version !== 1 || typeof pref.harness !== 'string' || typeof pref.configPath !== 'string' ||
        !isAbsolute(pref.configPath) || Object.keys(pref).length !== 3) {
      throw new Error('Invalid launcher preferences. Select a trusted configuration or forget the saved preference.');
    }
    return pref as Preference;
  } finally { await handle.close(); }
}

export class LauncherConfiguration {
  workspace: string;
  readonly preferencePath = preferencesPath();
  readonly budgetOverrides = new Map<string, number>();
  readonly isBuiltin: boolean;
  source = 'environment';
  path?: string;
  preference?: Preference;
  preferenceError?: string;
  legacyCandidate?: string;
  error?: string;
  configuration?: Record<string, unknown>;
  diagnostics?: Awaited<ReturnType<typeof runLocalCommand>>;
  private choice?: ConfigurationChoice;

  constructor(readonly harness: string, readonly specifier: string, readonly launchDirectory: string, cwd?: string, path?: string, choice?: ConfigurationChoice) {
    this.workspace = resolve(launchDirectory, cwd ?? '.');
    this.isBuiltin = builtin(specifier);
    this.choice = choice ?? (path ? { path: resolve(launchDirectory, path), source: '--config' } : undefined);
  }

  selectedChoice() { return this.choice; }

  async setWorkspace(path: string) {
    const directory = resolve(this.launchDirectory, path.trim() || '.');
    if (!await stat(directory).then(file => file.isDirectory(), () => false)) throw new Error('Choose an existing directory.');
    this.workspace = directory;
    await this.refresh();
  }

  async refresh() {
    this.diagnostics = undefined;
    this.preference = undefined;
    this.preferenceError = undefined;
    this.configuration = undefined;
    this.error = undefined;
    try { this.preference = await readPreference(this.preferencePath); }
    catch { this.preferenceError = 'Cannot use launcher preferences. Select a trusted configuration or forget the preference.'; }
    const remembered = this.preference?.harness === this.harness ? this.preference : undefined;
    this.path = this.choice ? this.choice.path : remembered?.configPath;
    this.source = this.choice?.source ?? (remembered ? 'remembered' : this.isBuiltin ? 'environment' : 'Harness defaults');
    this.legacyCandidate = undefined;
    if (this.specifier === 'subagents') {
      const project = join(this.workspace, 'config.js');
      if (await stat(join(this.workspace, '.murm', 'installed.json')).then(file => file.isFile(), () => false) &&
          await stat(project).then(file => file.isFile(), () => false)) this.legacyCandidate = project;
    }
    if (!this.choice && this.preferenceError) {
      this.error = this.preferenceError;
      return;
    }
    try {
      if (this.path && !['.mjs', '.js'].includes(extname(this.path))) {
        this.error = 'Choose an explicit trusted .mjs or ESM .js module.';
        return;
      }
      const value = this.path ? await loadMurmConfig(this.path, { reloadScopedEnvironment: true })
        : builtin(this.specifier) ? await builtinConfiguration(this.specifier) : undefined;
      if (value === undefined && !this.path && !this.isBuiltin) return;
      if (value === null || Array.isArray(value) || typeof value !== 'object' ||
          ['cwd', 'prompt', 'input', 'workload'].some(field => Object.hasOwn(value, field))) {
        this.error = 'The configuration must export an object without cwd, prompt, input or workload fields.';
        return;
      }
      this.configuration = { ...value, ...Object.fromEntries(this.budgetOverrides) };
      if (this.isBuiltin) this.validateRuntime();
    } catch (error) {
      const requirements = /^Set ([A-Z0-9_]+(?: or [A-Z0-9_]+)*) /.exec(error instanceof Error ? error.message : '');
      this.error = !this.path && requirements ? 'Set ' + requirements[1] : this.path
        ? 'Could not load the trusted module. Check its path, exported configuration and adjacent .env.'
        : 'Set the model endpoint and Sandbox connection environment, or select a trusted configuration.';
    }
  }

  private validateRuntime() {
    const config = this.configuration as unknown as LocalProjectConfig;
    if (!config.sandbox || !config.models || typeof config.image !== 'string' || !config.image) {
      this.error = 'This Harness requires sandbox, models and a Worker image.';
      return;
    }
    try {
      const driver = selectExecutorDriver(config.executor);
      const model = modelState(config, driver.kind);
      if (model.configuration !== 'complete') this.error = 'Model configuration is ' + model.configuration + '. Check the active aliases and protocol endpoints.';
    } catch {
      this.error = 'The selected executor is not configured.';
    }
    const runtime = checkProjectRuntime(config, config.sandbox as SandboxConfig);
    if (!runtime.ok && !this.error) this.error = runtime.detail;
    const invalid = this.budgetFields().find(({ value, max }) => value !== undefined &&
      (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max));
    if (invalid && !this.error) this.error = invalid.key + ' must be between 1 and ' + invalid.max + ' ms.';
  }

  select(path: string) {
    this.choice = path.trim() ? { path: resolve(this.launchDirectory, path.trim()), source: 'selected for this launch' } :
      { source: this.isBuiltin ? 'environment (selected)' : 'Harness defaults (selected)' };
    this.budgetOverrides.clear();
    return this.refresh();
  }

  async remember() {
    if (!this.path || !this.configuration || this.error) throw new Error('Select a valid trusted configuration first.');
    await mkdir(dirname(this.preferencePath), { recursive: true, mode: 0o700 });
    const preference = { version: 1, harness: this.harness, configPath: this.path } as const;
    const temporary = this.preferencePath + '.' + randomUUID();
    try {
      await writeFile(temporary, JSON.stringify(preference) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.preferencePath);
      this.preference = preference;
      this.preferenceError = undefined;
    } finally { await rm(temporary, { force: true }); }
  }

  async forget() {
    if (await lstat(this.preferencePath).then(() => true, error => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    })) await rm(this.preferencePath);
    await this.refresh();
  }

  budgetFields() {
    if (!builtin(this.specifier)) return [];
    return budgets[this.specifier].map(field => ({ ...field, value: this.configuration?.[field.key] ?? field.fallback }));
  }

  setBudget(field: Budget, value: string) {
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > field.max) {
      throw new Error('Enter a value between 1 and ' + field.max + ' ms.');
    }
    this.budgetOverrides.set(field.key, Number(value));
    return this.refresh();
  }

  async diagnose(prepare: boolean, signal: AbortSignal, progress: (message: string) => void) {
    if (this.path && !this.configuration) throw new Error('Fix the selected configuration before using setup or doctor.');
    const command = prepare ? { command: 'setup' as const } : { command: 'doctor' as const, smoke: false };
    const report = await runLocalCommand(command, signal, progress, this.configuration as unknown as LocalProjectConfig);
    if (prepare && report.ok && !this.path) await this.refresh();
    this.diagnostics = report;
  }

  details() {
    const configuration = this.configuration ?? {};
    const sandbox = terminalObject(configuration.sandbox);
    let endpoint = 'unknown';
    const configuredEndpoint = sandbox.lifecycleBaseUrl ?? sandbox.endpoint;
    if (typeof configuredEndpoint === 'string') {
      try { endpoint = new URL(configuredEndpoint).origin; } catch { /* The configuration check reports the invalid endpoint. */ }
    }
    const executor = configuration.executor;
    let driver = 'unknown';
    if (this.isBuiltin) {
      try {
        const selected = selectExecutorDriver(executor as LocalProjectConfig['executor']);
        driver = selected.kind + ' ' + selected.version;
      } catch { /* The configuration check reports the invalid executor. */ }
    }
    return {
      executor: driver, worker: configuration.image ?? 'unknown', sandbox: endpoint,
      models: Object.entries(terminalObject(configuration.models)).map(([alias, route]) => {
        const model = terminalObject(route);
        return { alias, provider: model.provider, model: model.model,
          protocol: modelClientProtocol(model.protocol as Parameters<typeof modelClientProtocol>[0]) };
      }),
      modelUpstreamVerification: 'not-verified',
      capacity: configuration.capacity ?? configuration.maxAgents ?? configuration.peerCount ?? configuration.helperCount ?? configuration.poolSize ?? 'unknown',
      budgetsMs: Object.fromEntries(this.budgetFields().map(field => [field.key, field.value ?? 'unknown'])),
    };
  }
}
