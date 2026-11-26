import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkLocalHost, checkLocalProvider, ensureLocalProvider, resolveLocalEnvironment,
  type DiagnosticCheck,
} from './local-environment.js';
import { runLocalSmoke } from './local-setup-smoke.js';
import { loadLocalProjectConfig, prepareSubagentsProject } from './local-setup-template.js';
import { prepareWorkerImage } from './local-setup-worker.js';
import type { LocalCommand } from './murm-arguments.js';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
type ProjectConfig = Awaited<ReturnType<typeof loadLocalProjectConfig>>;
type Provider = Awaited<ReturnType<typeof ensureLocalProvider>>;
type Smoke = Awaited<ReturnType<typeof runLocalSmoke>>;
type Timing = { id: string; elapsedMs: number; cached?: boolean };
type Model = { configuration: 'complete' | 'missing' | 'invalid'; verification: 'not-verified' };

function modelState(config?: ProjectConfig): Model {
  const route = config?.backend.models[config.model ?? 'default'];
  const upstream = config ? route?.upstream.url : process.env.MURM_SUBAGENTS_MODEL_URL;
  let configuration: Model['configuration'] = 'missing';
  if (upstream) {
    try {
      const parsed = new URL(upstream);
      configuration = ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? 'complete' : 'invalid';
    } catch {
      configuration = 'invalid';
    }
  }
  return { configuration, verification: 'not-verified' };
}

async function configExists(path: string) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function bootstrapTimings() {
  const value = process.env.MURM_SETUP_BOOTSTRAP;
  delete process.env.MURM_SETUP_BOOTSTRAP;
  if (value) {
    try {
      return JSON.parse(value) as { startedAt: number; timings: Timing[] };
    } catch {
      // An installed command does not require checkout preparation metadata.
    }
  }
  return { startedAt: Date.now(), timings: [] as Timing[] };
}

export async function runLocalCommand(command: LocalCommand, signal: AbortSignal) {
  const { startedAt, timings } = bootstrapTimings();
  const checks: DiagnosticCheck[] = [];
  const report: {
    command: LocalCommand['command'];
    ok: boolean;
    infrastructure: 'failed' | 'preflight-passed' | 'ready';
    model: Model;
    checks: DiagnosticCheck[];
    timings: Timing[];
    elapsedMs: number;
    interrupted: boolean;
    worker?: NonNullable<Awaited<ReturnType<typeof prepareWorkerImage>>['image']> & { source: 'cache' | 'build' | 'pull' };
    provider?: { id: string; created: boolean; images: Provider['images'] };
    providerCleanup?: Awaited<ReturnType<Provider['cleanup']>>;
    smoke?: Smoke;
    project?: Awaited<ReturnType<typeof prepareSubagentsProject>>;
  } = {
    command: command.command, ok: false, infrastructure: 'failed',
    model: { configuration: 'missing', verification: 'not-verified' },
    checks, timings, elapsedMs: 0, interrupted: false,
  };
  async function timed<T>(id: string, action: () => Promise<T>) {
    signal.throwIfAborted();
    const start = performance.now();
    try {
      return await action();
    } finally {
      timings.push({ id, elapsedMs: Math.round(performance.now() - start) });
    }
  }

  let provider: Provider | undefined;
  let stage = 'config';
  try {
    const configPath = command.command === 'doctor' ? resolve(command.configPath) : join(resolve(command.directory), 'config.js');
    const config = command.command === 'doctor' || await configExists(configPath) ? await loadLocalProjectConfig(configPath) : undefined;
    report.model = modelState(config);
    const environment = await resolveLocalEnvironment({
      lifecycleBaseUrl: config?.backend.sandbox.lifecycleBaseUrl ?? process.env.MURM_SUBAGENTS_LIFECYCLE_URL,
      endpointHost: config?.backend.sandbox.endpointHost ?? process.env.MURM_SUBAGENTS_ENDPOINT_HOST,
      advertiseHost: config?.backend.modelGateway.advertiseHost ?? process.env.MURM_SUBAGENTS_ADVERTISE_HOST,
      apiKey: config?.backend.sandbox.apiKey ?? process.env.MURM_SUBAGENTS_LIFECYCLE_TOKEN,
    });
    stage = 'host';
    checks.push(...await timed('host', () => checkLocalHost(environment)));
    if (checks.some(check => !check.ok)) return report;

    stage = 'worker';
    const worker = await timed('worker', () => prepareWorkerImage({
      packageRoot, requestedImage: config?.image ?? process.env.MURM_SUBAGENTS_IMAGE,
      install: command.command === 'setup', signal,
    }));
    checks.push(...worker.checks);
    if (worker.image) report.worker = { ...worker.image, source: worker.source };

    stage = 'provider';
    if (command.command === 'setup' && worker.image) {
      provider = await timed('provider-start', () => ensureLocalProvider(environment, { signal }));
      report.provider = { id: provider.id, created: provider.created, images: provider.images };
    }
    checks.push(...await timed('provider', () => checkLocalProvider(environment)));
    if (!worker.image || checks.some(check => !check.ok)) return report;
    report.infrastructure = 'preflight-passed';

    if (command.command === 'setup' || command.smoke) {
      stage = 'smoke';
      report.smoke = await timed('smoke', () => runLocalSmoke({ ...environment, image: worker.image!.id, signal }));
      if (!report.smoke.ok) {
        report.infrastructure = 'failed';
        return report;
      }
      report.infrastructure = 'ready';
    }
    if (command.command === 'setup') {
      stage = 'project';
      report.project = await timed('project', () => prepareSubagentsProject({
        directory: resolve(command.directory), image: worker.image!.id,
        lifecycleBaseUrl: environment.lifecycleBaseUrl, endpointHost: environment.endpointHost,
        advertiseHost: environment.advertiseHost, signal,
      }));
      report.model = modelState(await loadLocalProjectConfig(report.project.configPath));
    }
    signal.throwIfAborted();
    report.ok = true;
  } catch (error) {
    // Configuration imports and provider/npm errors can contain credentials.
    const failure: Record<string, [string, string]> = {
      config: ['Could not load the project configuration.', 'Check the trusted config.js and adjacent .env file.'],
      host: ['Could not complete the host capability checks.', 'Check Docker, host namespace tools and noninteractive helper permissions.'],
      worker: ['Could not prepare the compatible Worker image.', 'Check local Docker and the configured Worker image.'],
      provider: ['Could not prepare or verify a compatible OpenSandbox provider.', 'Run murm doctor and check the configured local OpenSandbox service.'],
      smoke: ['Could not complete the infrastructure probe.', 'Check the local OpenSandbox service, Worker image and host network.'],
      project: ['Could not initialize the Subagents project.', 'Check target directory permissions and npm cache or registry access, then rerun setup.'],
    };
    const [detail, remedy] = failure[stage];
    if (!signal.aborted) checks.push({ id: stage, ok: false, detail, remedy });
    // A provider deployment can fail before returning its ownership handle.
    if (stage === 'provider' && error && typeof error === 'object' && 'cleanup' in error && error.cleanup && typeof error.cleanup === 'object' &&
        'id' in error.cleanup && typeof error.cleanup.id === 'string' && 'status' in error.cleanup &&
        (error.cleanup.status === 'complete' || error.cleanup.status === 'pending')) {
      report.providerCleanup = { id: error.cleanup.id, status: error.cleanup.status };
    }
  } finally {
    report.interrupted = signal.aborted;
    if (report.interrupted) {
      report.ok = false;
      checks.push({ id: 'interrupted', ok: false, detail: 'The operation was interrupted.', remedy: 'Rerun after resolving any pending cleanup.' });
    }
    if (provider) {
      try {
        if (report.ok || report.smoke?.cleanup === 'pending') await provider.release();
        else report.providerCleanup = await provider.cleanup();
      } catch {
        report.providerCleanup = { id: provider.id, status: 'pending' };
        report.ok = false;
      }
    }
    report.elapsedMs = Date.now() - startedAt;
  }
  return report;
}
