import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir, networkInterfaces, platform } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { localApiKeyPath, loopbackLifecycle, resolveSandboxConnection } from '../src/core/sandbox-connection.js';

const execute = promisify(execFile);
export const localProviderImage = 'opensandbox/server:release-1.2.0@sha256:25bebdcf1cf7724eb923faecbdbbf82d4038c6ab35c736151574726d14006f30';
export const localExecdImage = 'opensandbox/execd:v1.1.0@sha256:6cf7dba2f21f0b536e100563d841ac58a9f31c2b0a081b7ac76796a24d6f47e2';
const profileVersion = 'murm-local-linux-api-v2';
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const root = sourceRoot.endsWith('/dist/') ? fileURLToPath(new URL('../../', import.meta.url)) : sourceRoot;

export interface LocalEnvironmentConfig {
  lifecycleBaseUrl: string;
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
  images: { server: string; execd: string };
  retain(): Promise<void>;
  cleanup(): Promise<ProviderCleanup>;
}

async function run(command: string, args: string[], signal?: AbortSignal) {
  return (await execute(command, args, { encoding: 'utf8', timeout: command === 'docker' && args[0] === 'pull' ? 900_000 : 20_000, maxBuffer: 1024 * 1024, signal })).stdout.trim();
}

function check(id: string, ok: boolean, detail: string, remedy?: string): DiagnosticCheck {
  return { id, ok, detail, ...(!ok && remedy ? { remedy } : {}) };
}

async function commandCheck(id: string, command: string, args: string[], detail: string, remedy: string) {
  try {
    await run(command, args);
    return check(id, true, detail);
  } catch {
    return check(id, false, `${detail} could not be confirmed`, remedy);
  }
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
  return (install ? `${commands[install]} && sudo systemctl enable --now docker. ` :
    'Install Docker Engine for this distribution from https://docs.docker.com/engine/install/. ') +
    'Use an authorized Docker context, then rerun murm setup --mode local with the same configuration, or configure an existing OpenSandbox endpoint.';
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
      'Run docker context show and docker info. Start the selected engine or use a context with an accessible local Unix socket, then rerun the same murm setup command. For a remote service use murm setup --mode existing.';
    return { diagnostic: check('host.docker-engine', false, 'Could not access a Linux Docker Engine through the selected local Unix Docker context.', remedy) };
  }
}

export async function checkStrictLocalHost(config: LocalEnvironmentConfig): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];
  if (platform() !== 'linux') return checks;
  const advertised = config.advertiseHost ?? '';
  const addressValid = isIP(advertised) === 4 && !advertised.startsWith('127.') && advertised !== '0.0.0.0';
  let hostOwnsAddress = addressValid && Object.values(networkInterfaces()).flat().some(value => value?.address === config.advertiseHost);
  if (addressValid && !hostOwnsAddress && platform() === 'linux') {
    // An idle Docker bridge can be down until the first Sandbox joins it.
    const interfaces: { addr_info: { local: string }[] }[] = await run('ip', ['-j', '-4', 'address', 'show'])
      .then(value => JSON.parse(value)).catch(() => []);
    hostOwnsAddress = interfaces.some(device => device.addr_info?.some(info => info.local === config.advertiseHost));
  }
  checks.push(check('host.advertise-ipv4', hostOwnsAddress,
    addressValid ? `Advertise IPv4 ${config.advertiseHost} ${hostOwnsAddress ? 'belongs to this host' : 'is absent from this host'}` : 'Advertise host requires a non-loopback IPv4 address',
    'Set advertiseHost to the local Docker bridge gateway or another host interface reachable by Sandbox containers.'));
  if (platform() !== 'linux') return checks;
  let dockerLocal = false;
  try {
    const context = JSON.parse(await run('docker', ['context', 'inspect']))[0];
    const dockerHost = process.env.DOCKER_HOST ?? context?.Endpoints?.docker?.Host;
    const socketPath = typeof dockerHost === 'string' && dockerHost.startsWith('unix://') ? dockerHost.slice(7) : '';
    const socket = socketPath ? await realpath(socketPath).catch(() => '') : '';
    dockerLocal = socket === '/run/docker.sock' || socket === '/var/run/docker.sock';
    checks.push(check('host.docker-local', dockerLocal, dockerLocal ? 'Docker uses the local system Unix socket' : 'Docker endpoint is outside the supported local system socket',
      'Select the local rootful Docker context using /var/run/docker.sock and unset remote DOCKER_HOST overrides.'));
    const info = JSON.parse(await run('docker', ['info', '--format', '{{json .}}']));
    const rootful = info.OSType === 'linux' && !info.SecurityOptions?.some((value: string) => value.includes('rootless')) && !/docker desktop/i.test(info.OperatingSystem ?? '');
    checks.push(check('host.docker-engine', rootful, rootful ? `Linux rootful Docker ${info.ServerVersion}` : 'Docker Engine does not match the supported Linux rootful profile',
      'Use a rootful Linux Docker Engine on this host with namespace isolation enabled.'));
    // A same-host daemon must expose a process in this host's /proc namespace.
    if (dockerLocal && Number.isInteger(info.NCPU)) {
      const processId = Number(await readFile('/run/docker.pid', 'utf8').catch(() => '0'));
      const command = processId > 1 ? await readFile(`/proc/${processId}/comm`, 'utf8').catch(() => '') : '';
      checks.push(check('host.docker-same-host', command.trim() === 'dockerd', 'Local dockerd process visibility',
        'Run murm directly on the Docker host, with /run/docker.pid and dockerd visible in /proc.'));
    }
  } catch {
    checks.push(check('host.docker-engine', false, 'Docker Engine access could not be confirmed', 'Install and start local rootful Docker, and allow this user to access its Unix socket.'));
  }
  checks.push(...await Promise.all([
    commandCheck('host.namespaces', 'sudo', ['-n', '/usr/bin/unshare', '--mount', '--net', '--', '/usr/bin/true'], 'Mount and network namespace creation', 'Allow noninteractive privileged namespace operations and enable mount/network namespace support.'),
    commandCheck('host.nftables', 'sudo', ['-n', '/usr/sbin/nft', '-j', 'list', 'tables'], 'nftables and privileged network access', 'Install nftables and allow the host network helper to use sudo without prompting.'),
    commandCheck('host.mount-tools', '/usr/bin/python3', ['-I', '-c', "import os; paths=['/usr/bin/nsenter','/usr/bin/mount','/usr/bin/umount','/usr/bin/stat','/usr/bin/mktemp','/usr/bin/touch','/usr/bin/rm','/usr/bin/rmdir','/usr/bin/flock']; assert all(os.access(p,os.X_OK) for p in paths); assert all(os.path.exists('/proc/self/ns/'+n) for n in ['mnt','net'])"], 'Namespace, mount and setup lock executables', 'Install Python 3, util-linux and coreutils on the Linux host.'),
    commandCheck('host.mount-permission', 'sudo', ['-n', '-l', '/usr/bin/python3', '-I', join(root, 'dist/scripts/mount-agent-workspace.py'), '2', '0'.repeat(64), '67108864', '4096'], 'Noninteractive workspace mount helper permission', 'Select the API policy, or contact the administrator of the explicit strict local deployment.'),
    commandCheck('host.landlock', '/usr/bin/python3', ['-I', '-c', "import ctypes,platform; assert platform.machine() in ('x86_64','aarch64'); libc=ctypes.CDLL(None,use_errno=True); abi=libc.syscall(444,0,0,1); assert abi>=5, 'Landlock ABI 5 required'"], 'Landlock ABI 5 or newer', 'Use a Linux kernel with Landlock enabled and ABI 5 or newer. Setup preserves the Worker filesystem policy.'),
  ]));
  return checks;
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
    const headers: Record<string, string> = authenticated && config.apiKey ? { 'OPEN-SANDBOX-API-KEY': config.apiKey } : {};
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!authenticated) {
      await response.body?.cancel();
      return response.status === 401 || response.status === 403;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    const result = await response.json() as { items?: unknown[] };
    return Array.isArray(result.items);
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

async function ensureLocalProviderLocked(config: LocalEnvironmentConfig, { signal }: { signal?: AbortSignal } = {}): Promise<LocalProviderHandle> {
  const url = lifecycleUrl(config);
  if (!url) throw Object.assign(new Error('Local loopback OpenSandbox /v1 URL required'), { code: 'PROVIDER_CONFIGURATION_INVALID' });
  signal?.throwIfAborted();
  const socket = (await resolveLocalDocker()).socket;
  if (!config.apiKey) {
    const filename = localApiKeyPath(url);
    try { await writeFile(filename, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    config = { ...config, apiKey: resolveSandboxConnection({ lifecycleBaseUrl: config.lifecycleBaseUrl }).apiKey };
  }
  if (!config.apiKey) throw new Error('Could not load the owner-only OpenSandbox lifecycle key.');
  const existing = await inspectProvider(config);
  if (existing && await providerHealthy(config, true)) {
    await run('docker', ['image', 'inspect', localExecdImage], signal).catch(async () => { await run('docker', ['pull', localExecdImage], signal); });
    return reuse(existing);
  }
  if (existing) throw Object.assign(new Error('The pinned OpenSandbox provider exists but its lifecycle API is unavailable or unauthorized'), { code: 'PROVIDER_UNHEALTHY' });
  if (await providerHealthy(config, true)) throw Object.assign(new Error('The existing endpoint does not match the pinned OpenSandbox profile'), { code: 'PROVIDER_PROFILE_MISMATCH' });
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
  const handle: LocalProviderHandle = { config, created: false, id: name, images: { server: '', execd: '' },
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
    await run('docker', ['image', 'inspect', localExecdImage], signal).catch(async () => { await run('docker', ['pull', localExecdImage], signal); });
    await run('docker', ['image', 'inspect', localProviderImage], signal).catch(async () => { await run('docker', ['pull', localProviderImage], signal); });
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
          return { ...handle, created: true, id, images: await imageIds(provider) };
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
    return { config, id: provider.Id, images: await imageIds(provider), created: false, retain: async () => {
      const current = await inspectProvider(config);
      if (current?.Id !== provider.Id) throw new Error('Provider identity changed');
    }, cleanup: async () => ({ status: 'complete', id: provider.Id, retained: true }) };
  }
}

async function imageIds(provider: ProviderInfo) {
  return { server: provider.Image, execd: await run('docker', ['image', 'inspect', '--format', '{{.Id}}', localExecdImage]).catch(() => 'unavailable') };
}
