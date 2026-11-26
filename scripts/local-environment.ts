import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir, networkInterfaces, platform } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const localProviderImage = 'opensandbox/server:release-1.2.0';
export const localExecdImage = 'opensandbox/execd:v1.1.0';
const profileVersion = 'murm-local-linux-v1';
const requiredCapabilities = ['AUDIT_WRITE', 'MKNOD', 'NET_ADMIN', 'NET_RAW', 'SYS_ADMIN', 'SYS_MODULE', 'SYS_PTRACE', 'SYS_TIME', 'SYS_TTY_CONFIG'];
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const root = sourceRoot.endsWith('/dist/') ? fileURLToPath(new URL('../../', import.meta.url)) : sourceRoot;

export interface LocalEnvironmentConfig {
  lifecycleBaseUrl: string;
  endpointHost: string;
  advertiseHost: string;
  apiKey?: string;
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
  release(): Promise<void>;
  cleanup(): Promise<ProviderCleanup>;
}

async function run(command: string, args: string[], signal?: AbortSignal) {
  return (await execute(command, args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024, signal })).stdout.trim();
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

export async function resolveLocalEnvironment(partial: Partial<LocalEnvironmentConfig> = {}): Promise<LocalEnvironmentConfig> {
  let advertiseHost = partial.advertiseHost ?? process.env.MURM_ADVERTISE_HOST;
  if (!advertiseHost) {
    try {
      advertiseHost = JSON.parse(await run('docker', ['network', 'inspect', 'bridge']))[0]?.IPAM?.Config?.find((entry: { Gateway?: string }) => isIP(entry.Gateway ?? '') === 4)?.Gateway;
    } catch {
      // Host checks report Docker failures without preventing the other diagnostics.
    }
  }
  return {
    lifecycleBaseUrl: partial.lifecycleBaseUrl ?? process.env.OPENSANDBOX_BASE_URL ?? 'http://127.0.0.1:8080/v1',
    endpointHost: partial.endpointHost ?? '127.0.0.1',
    advertiseHost: advertiseHost ?? '172.17.0.1',
    apiKey: partial.apiKey ?? process.env.OPENSANDBOX_API_KEY,
  };
}

export async function checkLocalHost(config: LocalEnvironmentConfig): Promise<DiagnosticCheck[]> {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const checks = [
    check('host.linux', platform() === 'linux', `Host operating system ${platform()}`, 'Run setup on the same Linux host as a rootful Docker Engine.'),
    check('host.node', major > 22 || major === 22 && minor >= 19, `Node.js ${process.versions.node}`, 'Install Node.js 22.19 or newer.'),
  ];
  const localAddresses = Object.values(networkInterfaces()).flat().filter(Boolean).map(value => value!.address);
  const addressValid = isIP(config.advertiseHost) === 4 && !config.advertiseHost.startsWith('127.') && config.advertiseHost !== '0.0.0.0';
  checks.push(check('host.advertise-ipv4', addressValid && localAddresses.includes(config.advertiseHost),
    addressValid ? `Advertise IPv4 ${config.advertiseHost} ${localAddresses.includes(config.advertiseHost) ? 'belongs to this host' : 'is absent from this host'}` : 'Advertise host requires a non-loopback IPv4 address',
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
    commandCheck('host.mount-permission', 'sudo', ['-n', '-l', '/usr/bin/python3', '-I', join(sourceRoot, 'scripts/mount-agent-workspace.py'), '2', '0'.repeat(64), '67108864', '4096'], 'Noninteractive workspace mount helper permission', 'Permit this installed mount-agent-workspace.py helper and the namespace/network helper commands through noninteractive sudo.'),
    commandCheck('host.landlock', '/usr/bin/python3', ['-I', '-c', "import ctypes,platform; assert platform.machine() in ('x86_64','aarch64'); libc=ctypes.CDLL(None,use_errno=True); abi=libc.syscall(444,0,0,1); assert abi>=5, 'Landlock ABI 5 required'"], 'Landlock ABI 5 or newer', 'Use a Linux kernel with Landlock enabled and ABI 5 or newer. Setup preserves the Worker filesystem policy.'),
  ]));
  return checks;
}

interface ProviderInfo {
  Id: string;
  Image: string;
  Config: { Image: string; Cmd?: string[]; Labels?: Record<string, string> };
  State: { Running: boolean };
  HostConfig: { NetworkMode: string; Binds?: string[] };
}

function lifecycleUrl(config: LocalEnvironmentConfig): URL | undefined {
  try {
    const url = new URL(config.lifecycleBaseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !/^\/v1\/?$/.test(url.pathname)) return;
    return url;
  } catch {
    return;
  }
}

async function inspectProvider(config: LocalEnvironmentConfig): Promise<ProviderInfo | undefined> {
  const url = lifecycleUrl(config);
  if (!url) return;
  const rows: ProviderInfo[] = JSON.parse(await run('docker', ['ps', '--no-trunc', '--format', '{{.ID}}']).then(async ids => ids ? run('docker', ['inspect', ...ids.split('\n')]) : '[]'));
  for (const row of rows) {
    if (!row.State.Running || row.HostConfig.NetworkMode !== 'host' || row.Config.Image !== localProviderImage) continue;
    const args = row.Config.Cmd ?? [];
    const position = args.indexOf('--config');
    const configPath = args[position + 1];
    if (position < 0 || !configPath?.startsWith('/')) continue;
    try {
      const profile = JSON.parse(await run('docker', ['exec', row.Id, 'python', '-c',
        "import json,sys\ntry:\n import tomllib\nexcept ImportError:\n import tomli as tomllib\nc=tomllib.load(open(sys.argv[1],'rb'))\nfields={'server':['host','port'],'runtime':['type','execd_image'],'docker':['network_mode','no_new_privileges','drop_capabilities'],'ingress':['mode']}\nprint(json.dumps({section:{k:c.get(section,{}).get(k) for k in keys} for section,keys in fields.items()}))", configPath]));
      if (profile.server.host === '127.0.0.1' && Number(profile.server.port) === Number(url.port || 80) && profile.runtime.type === 'docker' && profile.runtime.execd_image === localExecdImage && profile.docker.network_mode === 'bridge' && profile.docker.no_new_privileges === true && requiredCapabilities.every(capability => profile.docker.drop_capabilities?.includes(capability)) && profile.ingress.mode === 'direct') return row;
    } catch {
      // Another container may disappear while inspecting the running provider set.
    }
  }
}

async function providerHealthy(config: LocalEnvironmentConfig): Promise<boolean> {
  try {
    const headers: Record<string, string> = {};
    if (config.apiKey) headers['OPEN-SANDBOX-API-KEY'] = config.apiKey;
    const response = await fetch(`${config.lifecycleBaseUrl.replace(/\/$/, '')}/sandboxes?page=1&pageSize=1`, { headers, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return false;
    const result = await response.json() as { items?: unknown[] };
    return Array.isArray(result.items);
  } catch {
    return false;
  }
}

export async function checkLocalProvider(config: LocalEnvironmentConfig): Promise<DiagnosticCheck[]> {
  if (!lifecycleUrl(config)) return [check('provider.configuration', false, 'Provider URL requires a local loopback HTTP /v1 endpoint', 'Set lifecycleBaseUrl to http://127.0.0.1:<port>/v1 for the supported same-host OpenSandbox profile.')];
  const provider = await inspectProvider(config).catch(() => undefined);
  const healthy = await providerHealthy(config);
  const execd = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', localExecdImage]).catch(() => '');
  return [
    check('provider.profile', !!provider, provider ? `OpenSandbox ${localProviderImage} image ${provider.Image}, Execd ${localExecdImage}, container ${provider.Id}` : 'No running Docker provider matches the pinned local profile', 'Run murm setup to start the pinned OpenSandbox profile, or configure the existing provider with that profile.'),
    check('provider.health', healthy, healthy ? 'OpenSandbox lifecycle listing is reachable and authorized' : 'OpenSandbox lifecycle listing failed', 'Check the local endpoint, provider process and lifecycle API key. Run doctor --smoke for the complete Worker and Gateway check.'),
    check('provider.execd-image', !!execd, execd ? `Execd ${localExecdImage} image ${execd}` : 'Pinned Execd image is absent', 'Run murm setup to fetch the pinned Execd image.'),
  ];
}

export async function ensureLocalProvider(config: LocalEnvironmentConfig, { signal }: { signal?: AbortSignal } = {}): Promise<LocalProviderHandle> {
  const url = lifecycleUrl(config);
  if (!url) throw Object.assign(new Error('Local loopback OpenSandbox /v1 URL required'), { code: 'PROVIDER_CONFIGURATION_INVALID' });
  signal?.throwIfAborted();
  const existing = await inspectProvider(config);
  if (existing && await providerHealthy(config)) {
    await run('docker', ['image', 'inspect', localExecdImage], signal).catch(async () => { await run('docker', ['pull', localExecdImage], signal); });
    return reuse(existing);
  }
  if (existing) throw Object.assign(new Error('The pinned OpenSandbox provider exists but its lifecycle API is unavailable or unauthorized'), { code: 'PROVIDER_UNHEALTHY' });
  if (await providerHealthy(config)) throw Object.assign(new Error('The existing endpoint does not match the pinned OpenSandbox profile'), { code: 'PROVIDER_PROFILE_MISMATCH' });
  const token = randomUUID();
  const stateDir = join(homedir(), '.cache/murm/opensandbox', token);
  const name = `murm-opensandbox-${url.port || 80}`;
  const recipe = (await readFile(join(root, 'services/opensandbox-local/config.toml'), 'utf8')).replace('port = 8080', `port = ${Number(url.port || 80)}`);
  try {
    await mkdir(join(stateDir, 'data'), { recursive: true, mode: 0o700 });
    await writeFile(join(stateDir, 'config.toml'), recipe, { mode: 0o600, flag: 'wx' });
  } catch {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
    throw Object.assign(new Error('Could not prepare the local OpenSandbox configuration'), { code: 'PROVIDER_CONFIGURATION_WRITE_FAILED' });
  }
  let id = '';
  let created = false;
  const handle: LocalProviderHandle = { config, created: false, id: name, images: { server: '', execd: '' },
    release: async () => {},
    cleanup: async () => {
      try {
        const current: ProviderInfo = JSON.parse(await run('docker', ['inspect', name]))[0];
        if (current.Config.Labels?.['org.murm.setup.owner'] !== token) {
          await rm(stateDir, { recursive: true, force: true });
          return { status: 'complete', id: id || name };
        }
        if (await access(join(stateDir, 'adopted')).then(() => true, () => false)) return { status: 'complete', id: current.Id, retained: true };
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
    try {
      id = await run('docker', ['run', '-d', '--name', name, '--network', 'host', '--restart', 'unless-stopped', '--label', `org.murm.setup.profile=${profileVersion}`, '--label', `org.murm.setup.owner=${token}`, '--label', `org.murm.setup.state=${stateDir}`, '-e', 'OPENSANDBOX_INSECURE_SERVER=YES', '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', `${join(stateDir, 'config.toml')}:/config/config.toml:ro`, '-v', `${join(stateDir, 'data')}:/root/.opensandbox`, localProviderImage, '--config', '/config/config.toml'], signal);
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
      if (provider && await providerHealthy(config)) {
        if (created) return { ...handle, created: true, id, images: await imageIds(provider) };
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
    return { config, id: provider.Id, images: await imageIds(provider), created: false, release: async () => {}, cleanup: async () => ({ status: 'complete', id: provider.Id, retained: true }) };
  }
}

async function imageIds(provider: ProviderInfo) {
  return { server: provider.Image, execd: await run('docker', ['image', 'inspect', '--format', '{{.Id}}', localExecdImage]).catch(() => 'unavailable') };
}
