import { fileURLToPath } from 'node:url';
import {
  checkLocalHost, checkLocalProvider, ensureLocalProvider, resolveSubagentsEnvironment,
  type DiagnosticCheck,
} from './local-environment.js';
import { runLocalSmoke } from './local-setup-smoke.js';
import { loadLocalProjectConfig } from './local-setup-template.js';
import { prepareWorkerImage } from './local-setup-worker.js';
import { createOpenSandboxBackend } from '../src/core/backends/opensandbox.js';
import type { LocalCommand } from './murm-arguments.js';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
type ProjectConfig = Awaited<ReturnType<typeof loadLocalProjectConfig>>;
type Provider = Awaited<ReturnType<typeof ensureLocalProvider>>;
type Smoke = Awaited<ReturnType<typeof runLocalSmoke>>;
type Timing = { id: string; elapsedMs: number; cached?: boolean };
type Model = { configuration: 'complete' | 'missing' | 'invalid'; verification: 'not-verified' };

function modelState(config: ProjectConfig): Model {
  const aliases = new Set([config.rootModel ?? config.model ?? 'default', config.childModel ?? config.model ?? 'default']);
  const routes = [...aliases].map(alias => config.backend.models?.[alias]);
  let configuration: Model['configuration'] = routes.some(route => !route) ? 'invalid' : 'complete';
  for (const route of routes) {
    const upstream = route?.upstream?.url;
    if (!upstream) {
      if (configuration !== 'invalid') configuration = 'missing';
      continue;
    }
    try {
      const parsed = new URL(upstream);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.pathname.endsWith('/v1/responses')) configuration = 'invalid';
    } catch {
      configuration = 'invalid';
    }
  }
  return { configuration, verification: 'not-verified' };
}

function checkProjectBackend(config: ProjectConfig): DiagnosticCheck {
  if (config.backend.executor === 'codex') return {
    id: 'config.executor', ok: false, detail: 'Configured doctor currently supports Pi projects.',
    remedy: 'Use murm doctor for host checks and the installed Subagents example to run with Codex.',
  };
  try {
    // The real backend validates every infrastructure field without allocating.
    // Missing model endpoints are reported separately while preparing the host.
    createOpenSandboxBackend({
      ...config.backend,
      models: Object.fromEntries(Object.entries(config.backend.models).map(([alias, route]) => [alias, {
        ...route, upstream: { ...route.upstream, url: 'http://127.0.0.1/v1/responses' },
      }])),
    });
    return { id: 'config.backend', ok: true, detail: 'The editable backend configuration satisfies the Core startup contract.' };
  } catch {
    return { id: 'config.backend', ok: false, detail: 'The editable backend configuration violates the Core startup contract.',
      remedy: 'Check Bridge and Gateway addresses, sandbox settings, model aliases and explicit disk quotas in config.js.' };
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
    model?: Model;
    checks: DiagnosticCheck[];
    timings: Timing[];
    elapsedMs: number;
    interrupted: boolean;
    worker?: NonNullable<Awaited<ReturnType<typeof prepareWorkerImage>>['image']> & { source: 'cache' | 'build' | 'pull' };
    provider?: { id: string; created: boolean; images: Provider['images'] };
    providerCleanup?: Awaited<ReturnType<Provider['cleanup']>>;
    smoke?: Smoke;
  } = {
    command: command.command, ok: false, infrastructure: 'failed',
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
    const config = command.command === 'doctor' && command.configPath
      ? await loadLocalProjectConfig(command.configPath) : undefined;
    if (config) {
      report.model = modelState(config);
      checks.push(checkProjectBackend(config));
    }
    if (report.model?.configuration === 'invalid') checks.push({
      id: 'config.models', ok: false, detail: 'An active model alias or Responses endpoint is invalid.',
      remedy: 'Configure every Root and Child model alias with an HTTP(S) endpoint ending in /v1/responses, without embedded credentials.',
    });
    if (checks.some(check => !check.ok)) return report;
    const environment = await resolveSubagentsEnvironment({
      ...config?.backend.sandbox,
      advertiseHost: config?.backend.modelGateway.advertiseHost,
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
      report.smoke = await timed('smoke', () => runLocalSmoke({ ...environment, image: worker.image!.id, backend: config?.backend, signal }));
      if (!report.smoke.ok) {
        report.infrastructure = 'failed';
        return report;
      }
      report.infrastructure = 'ready';
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
        if (report.ok || report.smoke?.cleanup === 'pending') await provider.retain();
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
