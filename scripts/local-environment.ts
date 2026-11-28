import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createConnection, isIP } from 'node:net';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { OpenSandboxSdk } from '../src/core/sandbox/opensandbox-sdk.js';
import { localApiKeyPath, loopbackLifecycle, resolveSandboxConnection } from '../src/core/sandbox/sandbox-connection.js';

const execute = promisify(execFile);
export const localProviderImage = 'opensandbox/server:release-1.2.1@sha256:07f9b39adb8cadf68357dd1b86367068210e960fc4cb50e11b75176387557ea7';
export const localExecdImage = 'opensandbox/execd:release-1.2.1@sha256:6b12d17844ac7167271488302c71934e47f76abb9ddab19ec8529bd1c1c56b23';
export const localEgressImage = 'opensandbox/egress:release-1.2.1@sha256:84b98d3b5989a87389c977f6433f8cd3c7998d03aa15aaae41ebcb15b7eb8000';
const profileVersion = 'murm-local-linux-sdk-v3';
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const root = sourceRoot.endsWith('/dist/') ? fileURLToPath(new URL('../../', import.meta.url)) : sourceRoot;

export interface LocalEnvironmentConfig {
  endpoint?: string;
  lifecycleBaseUrl: string;
  publicUrl?: string;
  egressMode?: 'dns+nft';
  useServerProxy?: boolean;
  endpointHost?: string;
  advertiseHost?: string;
  apiKey?: string;
  image?: string;
}

export interface DiagnosticCheck {
  id: string;
  ok: boolean;
  detail: string;
  remedy?: string;
}

export interface ProviderCleanup {
  status: 'complete' | 'pending';
  id: string;
  retained?: boolean;
}

export interface LocalProviderHandle {
  config: LocalEnvironmentConfig;
  created: boolean;
  id: string;
  images: { server: string; execd: string; egress: string };
  retain(): Promise<void>;
  cleanup(): Promise<ProviderCleanup>;
}

async function run(command: string, args: string[], signal?: AbortSignal) {
  return (await execute(command, args, { encoding: 'utf8', timeout: command === 'docker' && args[0] === 'pull' ? 900_000 : 20_000, maxBuffer: 1024 * 1024, signal })).stdout.trim();
}

function check(id: string, ok: boolean, detail: string, remedy?: string): DiagnosticCheck {
  return { id, ok, detail, ...(!ok && remedy ? { remedy } : {}) };
}

export async function resolveLocalEnvironment(partial: Partial<LocalEnvironmentConfig> = {}, scope?: string) {
  const environment = resolveSandboxConnection(partial, scope);
  return { ...environment, mode: environment.endpointSource === 'default' ? 'local' as const : 'existing' as const };
}

export function resolveSubagentsEnvironment(config: Partial<LocalEnvironmentConfig> = {}) {
  return resolveLocalEnvironment(config, 'SUBAGENTS');
}

export function checkLinuxHost(): DiagnosticCheck[] {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return [
    check('host.linux', platform() === 'linux', `Host operating system ${platform()}`, 'Run this command on Linux.'),
    check('host.node', major > 22 || major === 22 && minor >= 19, `Node.js ${process.versions.node}`, 'Install Node.js 22.19 or newer.'),
  ];
}

async function dockerInstallRemedy(): Promise<string> {
  const release = await readFile('/etc/os-release', 'utf8').catch(() => '');
  const id = /^ID="?([a-z0-9_-]+)/m.exec(release)?.[1];
  const like = /^ID_LIKE="?([^"\n]+)/m.exec(release)?.[1].split(' ') ?? [];
  const install = [id, ...like].find(entry => ['ubuntu', 'debian', 'fedora', 'arch', 'opensuse'].includes(entry ?? ''));
  const commands: Record<string, string> = {
    ubuntu: 'sudo apt-get update && sudo apt-get install -y docker.io',
    debian: 'sudo apt-get update && sudo apt-get install -y docker.io',
    fedora: 'sudo dnf install -y moby-engine',
    arch: 'sudo pacman -S docker',
    opensuse: 'sudo zypper install docker',
  };
  return (install ? `Run:\n  ${commands[install]} && sudo systemctl enable --now docker.service\n` :
    'Install Docker Engine for this distribution from https://docs.docker.com/engine/install/\n') +
    'Confirm docker info works as your login user, then rerun the same murm setup command.';
}

export async function resolveLocalDocker() {
  const context = JSON.parse(await run('docker', ['context', 'inspect']))[0];
  const host = process.env.DOCKER_CONTEXT ? context?.Endpoints?.docker?.Host :
    process.env.DOCKER_HOST ?? context?.Endpoints?.docker?.Host;
  const socket = typeof host === 'string' && host.startsWith('unix://') ? await realpath(host.slice(7)) : undefined;
  if (!socket) throw new Error('Local setup needs a Unix Docker socket. Use --mode existing for an OpenSandbox running on another host.');
  const info = JSON.parse(await run('docker', ['info', '--format', '{{json .}}']));
  if (info.OSType !== 'linux') throw new Error('Local setup needs a Linux Docker Engine.');
  const bridge = JSON.parse(await run('docker', ['network', 'inspect', 'bridge']).catch(() => '[]'))[0];
  const advertiseHost: string | undefined = bridge?.IPAM?.Config?.find((entry: { Gateway?: string }) => isIP(entry.Gateway ?? '') === 4)?.Gateway;
  return { socket, advertiseHost, rootless: info.SecurityOptions?.some((value: string) => value.includes('rootless')) === true };
}

export async function checkLocalDocker() {
  try {
    const docker = await resolveLocalDocker();
    return { docker, diagnostic: check('host.docker-engine', true, `Linux Docker Engine (${docker.rootless ? 'rootless' : 'rootful'})`) };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT' &&
      (error as NodeJS.ErrnoException).syscall === 'spawn docker';
    const remedy = missing ? await dockerInstallRemedy() :
      'Run docker context show and docker info. Start the selected engine or use an authorized local Docker context. For a socket permission error, ask the host administrator to grant access and sign in again after any group change. Then rerun the same murm setup command.';
    return { diagnostic: check('host.docker-engine', false, 'Could not access a Linux Docker Engine through the selected local Unix Docker context.', remedy) };
  }
}

interface ProviderInfo {
  Id: string;
  Image: string;
  Config: { Image: string; Cmd?: string[]; Env?: string[]; Labels?: Record<string, string> };
  State: { Running: boolean };
  HostConfig: { NetworkMode: string; Binds?: string[] };
}

function lifecycleUrl(config: LocalEnvironmentConfig) {
  return loopbackLifecycle(config.lifecycleBaseUrl);
}

async function inspectProvider(config: LocalEnvironmentConfig): Promise<ProviderInfo | undefined> {
  const url = lifecycleUrl(config);
  if (!url) return;
  const rows: ProviderInfo[] = JSON.parse(await run('docker', ['inspect', `murm-opensandbox-${url.port || 80}`]).catch(() => '[]'));
  return rows.find(row => row.State.Running && row.Config.Labels?.['org.murm.setup.profile'] === profileVersion);
}

async function providerHealthy(config: LocalEnvironmentConfig, authenticated: boolean): Promise<boolean> {
  try {
    const url = new URL(config.lifecycleBaseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) return false;
    url.pathname = `${url.pathname.replace(/\/$/, '')}/sandboxes`;
    url.search = 'page=1&pageSize=1';
    if (!authenticated) {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      await response.body?.cancel();
      return response.status === 401 || response.status === 403;
    }
    const sdk = new OpenSandboxSdk({
      lifecycleBaseUrl: config.lifecycleBaseUrl, apiKey: config.apiKey, useServerProxy: config.useServerProxy ?? false,
      fetchImpl: (input, init) => fetch(input, { ...init, redirect: 'error',
        signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(5000)]) }),
    });
    try {
      const result = await sdk.sandboxes.listSandboxes({ page: 1, pageSize: 1 });
      return Array.isArray(result.items);
    } finally {
      await sdk.close();
    }
  } catch {
    return false;
  }
}

export async function checkLocalProvider(config: LocalEnvironmentConfig, { requireAuth = true } = {}): Promise<DiagnosticCheck[]> {
  const [healthy, denied] = await Promise.all([providerHealthy(config, true), requireAuth ? providerHealthy(config, false) : true]);
  return [
    check('provider.health', healthy, healthy ? 'OpenSandbox lifecycle listing is reachable with the configured credentials.' : 'OpenSandbox lifecycle listing failed.',
      'Check the endpoint, TLS trust, and lifecycle API key.'),
    ...(requireAuth ? [check('provider.authentication', denied && !!config.apiKey,
      denied && config.apiKey ? 'Lifecycle rejects requests without the configured API key.' : 'Lifecycle authentication could not be confirmed.',
      'Configure a lifecycle API key on OpenSandbox and pass it through trusted murm configuration.')] : []),
  ];
}

async function withProviderLock<T>(config: LocalEnvironmentConfig, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const url = lifecycleUrl(config);
  if (!url) throw Object.assign(new Error('Local loopback OpenSandbox /v1 URL required'), { code: 'PROVIDER_CONFIGURATION_INVALID' });
  signal?.throwIfAborted();
  const directory = join(homedir(), '.cache/murm/opensandbox');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const child = spawn('flock', ['--exclusive', '--timeout', '180', join(directory, `port-${url.port || 80}.lock`),
    process.execPath, '-e', 'console.log("locked"); process.stdin.resume()'],
  { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  const cancel = () => child.kill('SIGTERM');
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    await new Promise<void>((resolveLock, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(Object.assign(new Error('Provider lock could not be acquired'), { code: 'PROVIDER_BUSY' })));
      child.stdout.once('data', () => resolveLock());
    });
    signal?.removeEventListener('abort', cancel);
    signal?.throwIfAborted();
    return await action();
  } finally {
    signal?.removeEventListener('abort', cancel);
    child.stdin.end();
  }
}

export async function ensureLocalProvider(config: LocalEnvironmentConfig, { signal }: { signal?: AbortSignal } = {}): Promise<LocalProviderHandle> {
  return withProviderLock(config, async () => {
    const handle = await ensureLocalProviderLocked(config, { signal });
    return { ...handle,
      retain: () => withProviderLock(config, handle.retain),
      cleanup: () => withProviderLock(config, handle.cleanup),
    };
  }, signal);
}

function localPortInUse(url: URL) {
  return new Promise<boolean>(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(url.port || 80), timeout: 1000 });
    const finish = (occupied: boolean) => { socket.destroy(); resolve(occupied); };
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(true));
    socket.once('error', error => finish((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED'));
  });
}

async function prepareProviderImage(image: string, code: string, signal?: AbortSignal) {
  try {
    await run('docker', ['image', 'inspect', image], signal);
  } catch {
    signal?.throwIfAborted();
    console.error(`murm setup: pulling ${image}`);
    try {
      await run('docker', ['pull', image], signal);
    } catch {
      signal?.throwIfAborted();
      throw Object.assign(new Error('Docker could not pull the pinned OpenSandbox image'), { code });
    }
  }
}

async function ensureLocalProviderLocked(config: LocalEnvironmentConfig, { signal }: { signal?: AbortSignal } = {}): Promise<LocalProviderHandle> {
  const url = lifecycleUrl(config);
  if (!url) throw Object.assign(new Error('Local loopback OpenSandbox /v1 URL required'), { code: 'PROVIDER_CONFIGURATION_INVALID' });
  signal?.throwIfAborted();
  const socket = (await resolveLocalDocker()).socket;
  const existing = await inspectProvider(config);
  if (!existing && await localPortInUse(url)) {
    throw Object.assign(new Error('The local OpenSandbox port is already occupied'), { code: 'PROVIDER_PORT_IN_USE' });
  }
  if (!config.apiKey) {
    const filename = localApiKeyPath(url);
    try { await writeFile(filename, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    config = { ...config, apiKey: resolveSandboxConnection({ lifecycleBaseUrl: config.lifecycleBaseUrl }).apiKey };
  }
  if (!config.apiKey) throw new Error('Could not load the owner-only OpenSandbox lifecycle key.');
  if (existing && await providerHealthy(config, true)) {
    await prepareProviderImage(localExecdImage, 'PROVIDER_EXECD_PULL_FAILED', signal);
    await prepareProviderImage(localEgressImage, 'PROVIDER_EGRESS_PULL_FAILED', signal);
    return reuse(existing);
  }
  if (existing) throw Object.assign(new Error('The pinned OpenSandbox provider exists but its lifecycle API is unavailable or unauthorized'), { code: 'PROVIDER_UNHEALTHY' });
  const token = randomUUID();
  const stateDir = join(homedir(), '.cache/murm/opensandbox', token);
  const name = `murm-opensandbox-${url.port || 80}`;
  const recipe = (await readFile(join(root, 'deploy/opensandbox/config.toml'), 'utf8')).replace('port = 8080',
    `port = ${Number(url.port || 80)}\napi_key = ${JSON.stringify(config.apiKey)}`);
  try {
    await mkdir(join(stateDir, 'data'), { recursive: true, mode: 0o700 });
    await writeFile(join(stateDir, 'config.toml'), recipe, { mode: 0o600, flag: 'wx' });
  } catch {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
    throw Object.assign(new Error('Could not prepare the local OpenSandbox configuration'), { code: 'PROVIDER_CONFIGURATION_WRITE_FAILED' });
  }
  let id = '';
  let created = false;
  let providerReady = false;
  const handle: LocalProviderHandle = { config, created: false, id: name, images: { server: '', execd: '', egress: '' },
    retain: async () => {
      const current: ProviderInfo = JSON.parse(await run('docker', ['inspect', name]))[0];
      if (current.Id !== id || current.Config.Labels?.['org.murm.setup.owner'] !== token) throw new Error('Provider ownership changed');
      await writeFile(join(stateDir, 'adopted'), '', { mode: 0o600 });
    },
    cleanup: async () => {
      try {
        const current: ProviderInfo = JSON.parse(await run('docker', ['inspect', name]))[0];
        if (current.Config.Labels?.['org.murm.setup.owner'] !== token) {
          await rm(stateDir, { recursive: true, force: true });
          return { status: 'complete', id: id || name };
        }
        if (await access(join(stateDir, 'adopted')).then(() => true, () => false)) return { status: 'complete', id: current.Id, retained: true };
        if (providerReady) {
          const headers: Record<string, string> = {};
          if (config.apiKey) headers['OPEN-SANDBOX-API-KEY'] = config.apiKey;
          const response = await fetch(`${config.lifecycleBaseUrl.replace(/\/$/, '')}/sandboxes?page=1&pageSize=1`,
            { headers, redirect: 'error', signal: AbortSignal.timeout(5000) });
          if (!response.ok) return { status: 'pending', id: current.Id };
          const list = await response.json() as { items?: unknown[] };
          if (!Array.isArray(list.items)) return { status: 'pending', id: current.Id };
          if (list.items.length) return { status: 'complete', id: current.Id, retained: true };
        }
        await run('docker', ['rm', '-f', current.Id]);
        const remaining = await run('docker', ['ps', '-a', '--no-trunc', '--filter', `id=${current.Id}`, '--format', '{{.ID}}']);
        if (remaining) return { status: 'pending', id: current.Id };
        await rm(stateDir, { recursive: true, force: true });
        return { status: 'complete', id: current.Id };
      } catch {
        const live = await run('docker', ['ps', '-a', '--no-trunc', '--filter', `label=org.murm.setup.owner=${token}`, '--format', '{{.ID}}']).catch(() => 'unknown');
        if (live) return { status: 'pending', id: id || name };
        await rm(stateDir, { recursive: true, force: true }).catch(() => {});
        return { status: 'complete', id: id || name };
      }
    },
  };
  try {
    await prepareProviderImage(localExecdImage, 'PROVIDER_EXECD_PULL_FAILED', signal);
    await prepareProviderImage(localEgressImage, 'PROVIDER_EGRESS_PULL_FAILED', signal);
    await prepareProviderImage(localProviderImage, 'PROVIDER_SERVER_PULL_FAILED', signal);
    try {
      id = await run('docker', ['run', '-d', '--name', name, '--network', 'host', '--restart', 'unless-stopped', '--label', `org.murm.setup.profile=${profileVersion}`, '--label', `org.murm.setup.owner=${token}`, '--label', `org.murm.setup.state=${stateDir}`, '-v', `${socket}:/var/run/docker.sock`, '-v', `${join(stateDir, 'config.toml')}:/config/config.toml:ro`, '-v', `${join(stateDir, 'data')}:/root/.opensandbox`, localProviderImage, '--config', '/config/config.toml'], signal);
      created = true;
    } catch {
      // Docker atomically reserves the name, allowing simultaneous setup calls to converge.
      const current: ProviderInfo | undefined = JSON.parse(await run('docker', ['inspect', name]).catch(() => '[]'))[0];
      if (current?.Config.Labels?.['org.murm.setup.owner'] === token) { id = current.Id; created = true; }
      else if (current?.Config.Labels?.['org.murm.setup.profile'] !== profileVersion) throw Object.assign(new Error('OpenSandbox startup failed or its service name is already occupied'), { code: 'PROVIDER_START_FAILED' });
    }
    for (let attempt = 0; attempt < 60; attempt++) {
      signal?.throwIfAborted();
      const provider = await inspectProvider(config);
      if (provider && await providerHealthy(config, true)) {
        if (created) {
          providerReady = true;
          return { ...handle, config: { ...config, egressMode: 'dns+nft' }, created: true, id, images: await imageIds(provider) };
        }
        await rm(stateDir, { recursive: true, force: true });
        return reuse(provider);
      }
      await delay(500, undefined, { signal });
    }
    throw Object.assign(new Error('OpenSandbox did not become healthy within 30 seconds'), { code: 'PROVIDER_START_TIMEOUT' });
  } catch (error) {
    const cleanup = await handle.cleanup();
    throw Object.assign(new Error(signal?.aborted ? 'OpenSandbox preparation interrupted' : 'OpenSandbox preparation failed'), { code: signal?.aborted ? 'INTERRUPTED' : (error as { code?: string }).code ?? 'PROVIDER_START_FAILED', cleanup });
  }

  async function reuse(provider: ProviderInfo): Promise<LocalProviderHandle> {
    const path = provider.Config.Labels?.['org.murm.setup.state'];
    if (provider.Config.Labels?.['org.murm.setup.profile'] === profileVersion && path?.startsWith(join(homedir(), '.cache/murm/opensandbox/'))) await writeFile(join(path, 'adopted'), '', { mode: 0o600 });
    return { config: { ...config, egressMode: 'dns+nft' }, id: provider.Id, images: await imageIds(provider), created: false, retain: async () => {
      const current = await inspectProvider(config);
      if (current?.Id !== provider.Id) throw new Error('Provider identity changed');
    }, cleanup: async () => ({ status: 'complete', id: provider.Id, retained: true }) };
  }
}

async function imageIds(provider: ProviderInfo) {
  return { server: provider.Image, execd: await run('docker', ['image', 'inspect', '--format', '{{.Id}}', localExecdImage]).catch(() => 'unavailable'),
    egress: await run('docker', ['image', 'inspect', '--format', '{{.Id}}', localEgressImage]).catch(() => 'unavailable') };
}
