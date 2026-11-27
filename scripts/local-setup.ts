import { fileURLToPath } from 'node:url';
import {
  checkLinuxHost, checkLocalDocker, checkLocalProvider, checkStrictLocalHost, ensureLocalProvider, resolveLocalEnvironment,
  type DiagnosticCheck,
} from './local-environment.js';
import { runLocalSmoke } from './local-setup-smoke.js';
import { loadLocalProjectConfig } from './local-setup-template.js';
import { prepareWorkerImage } from './local-setup-worker.js';
import { selectExecutorDriver } from '../src/core/executor-driver.js';
import { DEFAULT_WORKER_IMAGE } from '../src/core/worker-image.js';
import { claimOpenSandboxBackend, createSandbox } from '../src/core/opensandbox-backend.js';
import type { SandboxConfig } from '../src/core/backend-config.js';
import type { LocalCommand } from './murm-arguments.js';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
type ProjectConfig = Awaited<ReturnType<typeof loadLocalProjectConfig>>;
type Provider = Awaited<ReturnType<typeof ensureLocalProvider>>;
type Smoke = Awaited<ReturnType<typeof runLocalSmoke>>;
type Timing = { id: string; elapsedMs: number; cached?: boolean };
type Model = { configuration: 'complete' | 'missing' | 'invalid'; verification: 'not-verified' };

function modelState(config: ProjectConfig): Model {
  if (config.models === undefined) return { configuration: 'missing', verification: 'not-verified' };
  const aliases = new Set([config.rootModel ?? config.model ?? 'default', config.childModel ?? config.model ?? 'default']);
  const routes = [...aliases].map(alias => config.models?.[alias]);
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

function checkProjectRuntime(config: ProjectConfig, sandbox: SandboxConfig): DiagnosticCheck {
  try {
    // The real backend validates every infrastructure field without allocating.
    // Missing model endpoints are reported separately while preparing the host.
    claimOpenSandboxBackend(createSandbox(sandbox), {
      executor: config.executor, connection: config.connection,
      models: Object.fromEntries(Object.entries(config.models ?? { default: { provider: 'openai', model: 'gpt-5.4', upstream: { headers: {} } } }).map(([alias, route]) => [alias, {
        ...route, upstream: { ...route.upstream, url: 'http://127.0.0.1/v1/responses' },
      }])),
    });
    return { id: 'config.runtime', ok: true, detail: 'The editable Sandbox and Runtime configuration satisfies the Core startup contract.' };
  } catch {
    if (sandbox.isolation?.disk && sandbox.isolation.network !== 'local-docker' &&
        sandbox.isolation.disk.inodes === undefined) {
      return { id: 'config.runtime', ok: false, detail: 'The OpenSandbox API policy cannot enforce a workspace disk limit.',
        remedy: 'Use a compatible Provider, or on the same Docker host configure strict local isolation with byte and inode limits.' };
    }
    return { id: 'config.runtime', ok: false, detail: 'The editable Sandbox and Runtime configuration violates the Core startup contract.',
      remedy: 'Check endpoint URLs, Bridge and Gateway addresses, resource quantities and the selected isolation policy.' };
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
    mode?: 'existing' | 'local';
    lifecycleSource?: string;
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
  let rootlessDocker = false;
  let stage = 'config';
  try {
    const config = command.configPath
      ? await loadLocalProjectConfig(command.configPath) : undefined;
    if (config) report.model = modelState(config);
    if (report.model?.configuration === 'invalid') checks.push({
      id: 'config.models', ok: false, detail: 'An active model alias or Responses endpoint is invalid.',
      remedy: 'Configure every Root and Child model alias with an HTTP(S) endpoint ending in /v1/responses, without embedded credentials.',
    });
    if (checks.some(check => !check.ok)) return report;
    let executor;
    try { executor = selectExecutorDriver(config?.executor ?? process.env.MURM_EXECUTOR).kind; }
    catch {
      checks.push({ id: 'config.executor', ok: false, detail: 'Select executor pi or codex.' });
      return report;
    }
    const environment = await resolveLocalEnvironment({
      ...config?.sandbox, image: config?.image,
      advertiseHost: config?.connection?.advertiseHost ?? config?.connection?.modelGateway?.advertiseHost,
    });
    if (config) {
      const { lifecycleBaseUrl, apiKey, endpointHost } = environment;
      checks.push(checkProjectRuntime(config, { ...config.sandbox, lifecycleBaseUrl, apiKey, endpointHost }));
    }
    if (checks.some(check => !check.ok)) return report;
    const mode = (command.command === 'setup' ? command.mode : undefined) ?? environment.mode;
    report.mode = mode;
    report.lifecycleSource = environment.endpointSource;
    const strict = config?.sandbox?.isolation?.network === 'local-docker' || config?.sandbox?.isolation?.disk?.inodes !== undefined;
    stage = 'host';
    checks.push(...checkLinuxHost());
    if (checks.some(check => !check.ok)) return report;
    const install = command.command === 'setup';
    const smoke = install || command.smoke;
    let advertiseHost = environment.advertiseHost;
    if (mode === 'local' && smoke) {
      const docker = await timed('host', checkLocalDocker);
      checks.push(docker.diagnostic);
      if (!docker.docker) return report;
      rootlessDocker = docker.docker.rootless;
      advertiseHost ??= docker.docker.advertiseHost;
    }
    if (strict) {
      if (!/^(http:\/\/(127\.0\.0\.1|localhost))([:/]|$)/.test(environment.lifecycleBaseUrl)) {
        checks.push({ id: 'provider.strict', ok: false, detail: 'The selected strict policy requires the Controller and Docker on the same host.',
          remedy: 'Use local setup for this policy, or select compatible Provider capabilities for the existing service.' });
        return report;
      }
      checks.push(...await timed('strict-host', () => checkStrictLocalHost({ ...environment, advertiseHost })));
      if (checks.some(check => !check.ok)) return report;
    }
    stage = 'provider';
    if (install && mode === 'local') {
      provider = await timed('provider-start', () => ensureLocalProvider(environment, { signal }));
      report.provider = { id: provider.id, created: provider.created, images: provider.images };
    }
    const active = provider?.config ?? environment;
    checks.push(...await timed('provider', () => checkLocalProvider(active, { requireAuth: !strict || mode === 'local' })));
    if (checks.some(check => !check.ok)) return report;

    let image = environment.image ?? DEFAULT_WORKER_IMAGE;
    if (mode === 'local' && smoke) {
      stage = 'worker';
      const worker = await timed('worker', () => prepareWorkerImage({
        packageRoot, requestedImage: environment.image, executor, install, signal,
      }));
      checks.push(...worker.checks);
      if (!worker.image || checks.some(check => !check.ok)) return report;
      report.worker = { ...worker.image, source: worker.source };
      image = worker.image.id;
    }
    report.infrastructure = 'preflight-passed';
    if (smoke) {
      stage = 'smoke';
      report.smoke = await timed('smoke', () => runLocalSmoke({
        ...active, image, sandbox: config?.sandbox, connection: config?.connection,
        advertiseHost, executor, signal,
      }));
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
      host: ['Could not complete the host capability checks.', 'Check the installation diagnostics for the selected setup mode.'],
      worker: ['Could not prepare the compatible Worker image.', 'Check local Docker and the configured Worker image.'],
      provider: ['Could not prepare or verify a compatible OpenSandbox provider.', 'Run murm doctor to check lifecycle authentication. Ensure the requested endpoint or local port is available.'],
      smoke: ['Could not complete the infrastructure probe.', 'Check the local OpenSandbox service, Worker image and host network.'],
    };
    let [detail, remedy] = failure[stage];
    if (stage === 'provider' && (error as { code?: string })?.code === 'PROVIDER_PORT_IN_USE') {
      detail = 'The local Lifecycle port is already occupied.';
      remedy = 'Set MURM_LIFECYCLE_URL to a free loopback port and rerun local setup, or use existing mode for a service you operate.';
    } else if (stage === 'provider' && rootlessDocker) {
      remedy = 'Verify that the selected rootless Docker context can start containers and expose the Lifecycle address. Check delegated CPU and memory controllers before retrying.';
    }
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
