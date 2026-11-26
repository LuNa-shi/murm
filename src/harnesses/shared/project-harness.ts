import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureProject, isInside, projectError, resolveProjectDirectory } from './project-input.js';
import { saveReport } from './run-report.js';

export type HarnessInput = Readonly<{ cwd: string; prompt: string }>;
type InitialProject = Awaited<ReturnType<typeof captureProject>>;
export type HarnessJson = null | boolean | number | string | readonly HarnessJson[] | { readonly [key: string]: HarnessJson };
type HarnessStatusInfo = Readonly<{ agents?: HarnessJson; business?: HarnessJson }>;
type HarnessInputHandler = (input: HarnessJson, request: Readonly<{ requestId: string; signal: AbortSignal }>) =>
  Promise<HarnessJson> | HarnessJson;
type Cleanup = { status: 'complete' | 'pending'; receipt?: HarnessJson; pending?: HarnessJson; retained?: HarnessJson };

export interface ProjectHarnessResult {
  outcome: 'completed' | 'failed' | 'cancelled';
  reason: string;
  result?: HarnessJson;
  acceptance?: HarnessJson;
  artifacts: readonly HarnessJson[];
  export?: { status: 'complete' | 'failed' | 'pending'; receipt?: HarnessJson };
  cleanup: Cleanup;
}

export interface ProjectHarnessContext {
  readonly input: HarnessInput;
  readonly initial: InitialProject;
  readonly configuration: unknown;
  readonly runId: string;
  readonly outputDir: string;
  readonly signal: AbortSignal;
  markRunning(): void;
  updateStatus(status: HarnessStatusInfo): void;
  emit(event: HarnessJson): void;
  registerInput(handler: HarnessInputHandler): void;
}

export interface ProjectHarness {
  readonly apiVersion: 1;
  readonly id: string;
  readonly input?: true;
  run(context: ProjectHarnessContext): Promise<ProjectHarnessResult>;
}

function moduleSpecifier(directory: string, specifier: string) {
  if (isAbsolute(specifier) || specifier.startsWith('./') || specifier.startsWith('../')) {
    if (!['.mjs', '.js'].includes(extname(specifier))) {
      throw projectError('INVALID_HARNESS_MODULE', 'Local Harness modules must be built .mjs or .js files');
    }
    return pathToFileURL(resolve(directory, specifier)).href;
  }
  if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(specifier) || specifier === '.' || specifier === '..' ||
      specifier.startsWith('node:')) {
    throw projectError('INVALID_HARNESS_MODULE', 'Expected a local ESM file or an installed package name');
  }
  return specifier;
}

export async function loadProjectHarness(directory: string, specifier: string, builtins: Readonly<Record<string, string>> = {}) {
  const builtin = Object.hasOwn(builtins, specifier) ? builtins[specifier] : undefined;
  const target = builtin ?? moduleSpecifier(directory, specifier);
  const parentURL = pathToFileURL(join(directory, '.murm-harness-resolver.mjs')).href;
  let module: { default?: Partial<ProjectHarness> };
  try {
    // Anchor package lookup at the launching project, keeping Node's ESM import conditions.
    const hook = target.startsWith('file:') ? null : registerHooks({
      resolve(name, context, nextResolve) {
        if (name !== target || context.parentURL !== import.meta.url) return nextResolve(name, context);
        return nextResolve(name, { ...context, parentURL });
      },
    });
    try {
      module = await import(target);
    } finally {
      hook?.deregister();
    }
  } catch {
    throw projectError('HARNESS_MODULE_LOAD_FAILED', `Could not load Harness ${JSON.stringify(specifier)}`);
  }
  const definition = module.default;
  if (!definition || typeof definition !== 'object' || definition.apiVersion !== 1 ||
      typeof definition.id !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{0,127}$/.test(definition.id) ||
      typeof definition.run !== 'function' || (definition.input !== undefined && definition.input !== true)) {
    throw projectError('INVALID_HARNESS_MODULE', 'Harness default export requires apiVersion 1, a stable id and run(context)');
  }
  return definition as ProjectHarness;
}

type Phase = 'idle' | 'starting' | 'running' | 'stopping' | 'finished';
type StopReason = 'requested' | 'input-ended' | 'input-failed' | 'output-failed' | 'SIGINT' | 'SIGTERM';
type Failure = { code: string; message: string };
type StartupOptions = {
  launchDirectory: string;
  configPath?: string;
  outputRoot?: string;
  stopTimeoutMs?: number;
};
type RunResult = Omit<ProjectHarnessResult, 'reason'> & {
  runId: string;
  harness: { id: string; apiVersion: 1 };
  cwd: string;
  initial: Omit<InitialProject, 'files'> | null;
  prompt: { path: string | null; sha256: string };
  reason: string;
  stopReason: StopReason | null;
  failure: Failure | null;
  reportSaveFailure: Failure | null;
  reportPath?: string;
};

export function failureCode(error: unknown, fallback: string) {
  const { code } = (error ?? {}) as { code?: unknown };
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : fallback;
}

async function loadConfiguration(directory: string, path: string | undefined): Promise<unknown> {
  if (!path) return undefined;
  let value: unknown;
  try {
    value = (await import(pathToFileURL(resolve(directory, path)).href)).default;
  } catch {
    throw projectError('INVALID_RUN_CONFIGURATION', 'Could not load the run configuration module');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw projectError('INVALID_RUN_CONFIGURATION', 'Run configuration must default-export an object');
  }
  for (const key of ['cwd', 'prompt', 'input', 'workload']) {
    if (Object.hasOwn(value, key)) throw projectError('INVALID_RUN_CONFIGURATION', `Run configuration cannot supply ${key}`);
  }
  return value;
}

async function prepareOutput(runId: string, options: StartupOptions, cwd: string) {
  try {
    if (options.outputRoot) {
      const path = resolve(options.launchDirectory, options.outputRoot);
      await mkdir(path, { recursive: true, mode: 0o700 });
      return await realpath(path);
    }
    const stateDirectory = resolve(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'murm', 'runs');
    if (!isInside(cwd, stateDirectory)) {
      const stateRoot = await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
        .then(() => realpath(stateDirectory)).catch(() => null);
      if (stateRoot && !isInside(cwd, join(stateRoot, runId))) return stateRoot;
    }
    for (const candidate of new Set([tmpdir(), '/var/tmp', '/tmp'])) {
      const directory = await realpath(candidate).catch(() => null);
      if (!directory || isInside(cwd, directory)) continue;
      const privateRoot = await mkdtemp(join(directory, 'murm-runs-')).catch(() => null);
      if (privateRoot) return privateRoot;
    }
  } catch {
    throw projectError('INVALID_RUN_CONFIGURATION', 'Could not prepare --output-dir');
  }
  throw projectError('INVALID_RUN_CONFIGURATION', 'No default run output directory lies outside the project. Set --output-dir explicitly.');
}

function isLaunchError(code: string | undefined) {
  return code === 'INVALID_PROJECT_DIRECTORY' || code === 'INVALID_RUN_CONFIGURATION' || code === 'INVALID_HARNESS_INPUT';
}

function emptyResult(outcome: 'failed' | 'cancelled', reason: string, enteredHarness: boolean): ProjectHarnessResult {
  return {
    outcome, reason, artifacts: [],
    cleanup: enteredHarness ? { status: 'pending', pending: ['harness-cleanup-unconfirmed'] } : { status: 'complete' },
  };
}

function validateResult(result: ProjectHarnessResult) {
  if (!result || !['completed', 'failed', 'cancelled'].includes(result.outcome) ||
      typeof result.reason !== 'string' || !result.reason || !Array.isArray(result.artifacts) ||
      !result.cleanup || !['complete', 'pending'].includes(result.cleanup.status) ||
      (result.export && !['complete', 'failed', 'pending'].includes(result.export.status))) {
    throw projectError('INVALID_HARNESS_RESULT', 'Harness must return its outcome, reason, artifacts and cleanup status');
  }
  return result;
}

export function createProjectHost(definition: ProjectHarness, options: StartupOptions, emit: (record: unknown) => void) {
  const harness = { id: definition.id, apiVersion: definition.apiVersion };
  const controller = new AbortController();
  const stopDeadline = Promise.withResolvers<never>();
  // stopDeadline can expire while a Harness is finishing.
  void stopDeadline.promise.catch(() => {});
  let inputHandler: HarnessInputHandler | undefined;
  let runId: string | null = null;
  let phase: Phase = 'idle';
  let information: HarnessStatusInfo = {};
  let reason: StopReason | null = null;
  let stopTimer: NodeJS.Timeout | undefined;
  let completion: Promise<{ result: RunResult; code: number }> | undefined;
  let publishing = true;

  function status() {
    return { runId, harness, phase, agents: information.agents ?? [], business: information.business ?? null, stopReason: reason };
  }

  function publish(event: HarnessJson | HarnessStatusInfo) {
    if (publishing && runId !== null) emit({ type: 'event', runId, event });
  }

  function stop(request: StopReason) {
    if (reason === null && publishing && phase !== 'finished') {
      reason = request;
      if (runId !== null) {
        phase = 'stopping';
        stopTimer = setTimeout(() => stopDeadline.reject(projectError('HARNESS_STOP_TIMEOUT',
          'Harness did not confirm cleanup before the stop deadline')), options.stopTimeoutMs ?? 30_000);
      }
      controller.abort(projectError('RUN_STOPPING', request));
    }
    return status();
  }

  async function execute(id: string, raw: HarnessInput) {
    let cwd = raw.cwd;
    let outputRoot: string | undefined;
    let promptPath: string | null = null;
    let initial: RunResult['initial'] = null;
    let enteredHarness = false;
    let failure: Failure | null = null;
    const signal = controller.signal;
    const work = async () => {
      // Resolve the directory first so an explicitly nested output can be excluded.
      cwd = await resolveProjectDirectory(raw.cwd);
      outputRoot = await prepareOutput(id, options, cwd);
      const outputDir = join(outputRoot, id);
      // Even an admitted Run cancelled before startup keeps its initial task and report.
      await mkdir(outputDir, { mode: 0o700 });
      const path = join(outputDir, 'initial-prompt.txt');
      await writeFile(path, raw.prompt, { flag: 'wx', mode: 0o600 });
      promptPath = path;
      signal.throwIfAborted();
      const configuration = await loadConfiguration(options.launchDirectory, options.configPath);
      signal.throwIfAborted();
      const captured = await captureProject(cwd, outputDir, signal);
      const { files, ...source } = captured;
      initial = source;
      signal.throwIfAborted();
      enteredHarness = true;
      return validateResult(await definition.run({
        input: Object.freeze({ cwd, prompt: raw.prompt }), initial: captured, configuration, runId: id, outputDir, signal,
        markRunning() {
          signal.throwIfAborted();
          if (phase !== 'starting') return;
          phase = 'running';
          publish({ kind: 'status', ...status() });
        },
        updateStatus(next) {
          if (!publishing) return;
          information = structuredClone(next);
          publish({ kind: 'status', ...status() });
        },
        emit: publish,
        registerInput(handler) {
          signal.throwIfAborted();
          if (definition.input !== true || typeof handler !== 'function' || inputHandler) {
            throw projectError('INVALID_HARNESS_INPUT_HANDLER', 'Harness input must be declared and registered once');
          }
          inputHandler = handler;
        },
      }));
    };
    let business: ProjectHarnessResult;
    try {
      business = await Promise.race([work(), stopDeadline.promise]);
    } catch (error) {
      const code = failureCode(error, enteredHarness ? 'HARNESS_RUN_FAILED' : 'PROJECT_CAPTURE_FAILED');
      const preflight = phase === 'starting' && (isLaunchError(code) || code === 'PROJECT_PATH_INVALID');
      const documented = isLaunchError(code) ||
        /^(PROJECT_(?:FILE_|PATH_|SOURCE_|GIT|LFS)|HARNESS_STOP_TIMEOUT|RUN_STOPPING)/.test(code);
      const message = documented && error instanceof Error ? error.message : 'Harness operation failed';
      failure = { code, message };
      business = emptyResult(reason ? 'cancelled' : 'failed', reason ?? code, enteredHarness && !preflight);
    } finally {
      clearTimeout(stopTimer);
      publishing = false;
      phase = 'finished';
    }
    const result: RunResult = {
      ...business, runId: id, harness, cwd, initial, prompt: {
        path: promptPath, sha256: createHash('sha256').update(raw.prompt).digest('hex'),
      },
      stopReason: reason, failure, reportSaveFailure: null,
    };
    let saved: RunResult;
    if (outputRoot) {
      saved = await saveReport(outputRoot, 'project-run.json', result);
    } else {
      saved = { ...result, reportSaveFailure: { code: 'OUTPUT_UNAVAILABLE', message: 'Run output directory was not prepared' } };
    }
    const code = reason === 'SIGINT' ? 130 : reason === 'SIGTERM' ? 143 :
      reason ? 1 : isLaunchError(failure?.code ?? saved.reason) ? 2 :
      saved.outcome !== 'completed' || saved.cleanup.status !== 'complete' ||
        (saved.export && saved.export.status !== 'complete') || saved.reportSaveFailure ? 1 : 0;
    return { result: saved, code };
  }

  return {
    harness, status, stop, signal: controller.signal,
    start(input: HarnessInput) {
      if (reason !== null) throw projectError('RUN_STOPPING', 'Run admission is closed');
      if (runId !== null) throw projectError('RUN_ALREADY_STARTED', 'This process has already accepted a Run');
      const id = randomUUID();
      runId = id;
      phase = 'starting';
      const accepted = { runId, phase };
      // Defer work so the admitting request can be acknowledged first.
      const begin = Promise.withResolvers<void>();
      completion = begin.promise.then(() => execute(id, input));
      setImmediate(begin.resolve);
      return { accepted, completion };
    },
    get completion() { return completion; },
    async input(payload: HarnessJson, requestId: string) {
      if (!definition.input) throw projectError('OPERATION_UNSUPPORTED', 'This Harness does not accept additional input');
      if (reason !== null || !publishing) throw projectError('RUN_STOPPING', 'Input admission is closed');
      if (phase !== 'running' || !inputHandler) throw projectError('RUN_NOT_READY', 'Harness input route is not ready');
      return inputHandler(payload, { requestId, signal: controller.signal });
    },
  };
}

export type ProjectHost = ReturnType<typeof createProjectHost>;
