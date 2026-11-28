import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const defaultLifecycleUrl = 'http://127.0.0.1:8080/v1';

export function loopbackLifecycle(url: string): URL | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname) &&
        /^\/v1\/?$/.test(parsed.pathname) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash) return parsed;
  } catch {
    // The caller reports invalid URLs at its public entry point.
  }
}

export function localApiKeyPath(url: URL): string {
  return join(homedir(), '.cache', 'murm', 'opensandbox', `port-${url.port || 80}.key`);
}

function readPrivateFile(path: string, maxBytes: number): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) return;
    return readFileSync(descriptor, 'utf8').trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

interface ConnectionInput {
  endpoint?: string;
  lifecycleBaseUrl?: string;
  apiKey?: string;
  endpointHost?: string;
  advertiseHost?: string;
  publicUrl?: string;
  image?: string;
  useServerProxy?: boolean;
  egressMode?: 'dns+nft';
}

const connectionPath = () => join(homedir(), '.config', 'murm', 'opensandbox.json');

function connectionError(message: string) {
  return Object.assign(new Error(message), { code: 'INVALID_CONTRACT' });
}

function lifecycleUrl(value: string, field: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw connectionError(`${field} requires an absolute HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw connectionError(`${field} requires an HTTP(S) URL without credentials, query, or fragment`);
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/v1') ? path : `${path}/v1`;
  return url.href;
}

export function normalizeRuntimePublicUrl(value: string): string {
  if (typeof value !== 'string' || value.includes('{port}')) throw connectionError('Replace legacy {port} templates with connection.publicUrl and connection.bindPort, or omit the URL for local discovery');
  let url: URL;
  try { url = new URL(value); }
  catch { throw connectionError('connection.publicUrl requires an absolute HTTP(S) address'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      ['0.0.0.0', '[::]'].includes(url.hostname)) {
    throw connectionError('connection.publicUrl requires a reachable HTTP(S) address without credentials, query, or fragment');
  }
  return url.href.replace(/\/+$/, '');
}

function loadSavedConnection(): ConnectionInput {
  const contents = readPrivateFile(connectionPath(), 32_768);
  if (!contents) return {};
  let value: unknown;
  try { value = JSON.parse(contents); }
  catch { throw connectionError('Saved OpenSandbox connection is invalid. Run murm setup with an explicit endpoint to replace it.'); }
  if (!value || typeof value !== 'object' || !('endpoint' in value) || typeof value.endpoint !== 'string') {
    throw connectionError('Saved OpenSandbox connection is missing its endpoint');
  }
  const saved: ConnectionInput = { endpoint: value.endpoint };
  for (const field of ['apiKey', 'publicUrl', 'advertiseHost', 'image'] as const) {
    if (!(field in value)) continue;
    const setting = (value as Record<string, unknown>)[field];
    if (typeof setting !== 'string') throw connectionError(`Saved connection has an invalid ${field}`);
    saved[field] = setting;
  }
  if ('useServerProxy' in value) {
    if (typeof value.useServerProxy !== 'boolean') throw connectionError('Saved server proxy setting is invalid');
    saved.useServerProxy = value.useServerProxy;
  }
  if ('egressMode' in value) {
    if (value.egressMode !== 'dns+nft') throw connectionError('Saved egress mode is invalid');
    saved.egressMode = value.egressMode;
  }
  return saved;
}

export function resolveSandboxConnection(input: ConnectionInput = {}, scope?: string, { useSaved = true } = {}) {
  const environment = process.env;
  const example = (name: string) => scope ? environment[`MURM_${scope}_${name}`] || undefined : undefined;
  const explicit = input.endpoint === undefined ? undefined : lifecycleUrl(input.endpoint, 'endpoint');
  const alias = input.lifecycleBaseUrl === undefined ? undefined : lifecycleUrl(input.lifecycleBaseUrl, 'lifecycleBaseUrl');
  if (explicit && alias && explicit !== alias) throw connectionError('endpoint and lifecycleBaseUrl must refer to the same Lifecycle API');
  const saved = useSaved ? loadSavedConnection() : {};
  const savedUrl = saved.endpoint === undefined ? undefined : lifecycleUrl(saved.endpoint, 'Saved endpoint');
  const candidates: readonly (readonly [string, string | undefined])[] = [
    ['config', explicit ?? alias],
    ['OPEN_SANDBOX_ENDPOINT', environment.OPEN_SANDBOX_ENDPOINT],
    ['MURM_LIFECYCLE_URL', environment.MURM_LIFECYCLE_URL],
    [`MURM_${scope}_LIFECYCLE_URL`, example('LIFECYCLE_URL')],
    ['OPENSANDBOX_BASE_URL', environment.OPENSANDBOX_BASE_URL],
    ['saved', savedUrl],
    ['default', defaultLifecycleUrl],
  ];
  const [endpointSource, endpoint] = candidates.find(([, value]) => value !== undefined && value !== '')!;
  const lifecycleBaseUrl = lifecycleUrl(endpoint!, 'Endpoint');
  const local = loopbackLifecycle(lifecycleBaseUrl);
  const stored = savedUrl === lifecycleBaseUrl ? saved : {};
  const endpointHost = input.endpointHost ?? (environment.MURM_ENDPOINT_HOST || undefined) ?? example('ENDPOINT_HOST');
  if (endpointHost !== undefined) throw connectionError('endpointHost was removed. Configure OpenSandbox to publish a reachable endpoint.');
  const publicUrl = input.publicUrl ?? (environment.MURM_RUNTIME_PUBLIC_URL || undefined) ?? stored.publicUrl;
  return {
    lifecycleBaseUrl,
    apiKey: input.apiKey ?? (environment.OPEN_SANDBOX_API_KEY || environment.MURM_LIFECYCLE_TOKEN || example('LIFECYCLE_TOKEN') ||
      environment.OPENSANDBOX_API_KEY || undefined) ?? stored.apiKey ?? (local && readPrivateFile(localApiKeyPath(local), 256)),
    advertiseHost: input.advertiseHost ?? (environment.MURM_ADVERTISE_HOST || undefined) ?? example('ADVERTISE_HOST') ??
      stored.advertiseHost ?? (local ? networkInterfaces().docker0?.find(address => address.family === 'IPv4')?.address : undefined),
    publicUrl: publicUrl === undefined ? undefined : normalizeRuntimePublicUrl(publicUrl),
    image: input.image ?? (environment.MURM_WORKER_IMAGE || undefined) ?? example('IMAGE') ?? stored.image,
    useServerProxy: input.useServerProxy ?? stored.useServerProxy,
    egressMode: input.egressMode ?? stored.egressMode,
    endpointHost: undefined,
    endpointSource,
  };
}

export async function saveSandboxConnection(input: ConnectionInput & { lifecycleBaseUrl: string }) {
  const path = connectionPath();
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) {
    throw connectionError('OpenSandbox configuration directory must be owned by the current user and writable only by its owner');
  }
  const temporary = join(directory, `.opensandbox-${randomUUID()}.tmp`);
  const { lifecycleBaseUrl, apiKey, publicUrl, advertiseHost, image, useServerProxy, egressMode } = input;
  try {
    await writeFile(temporary, JSON.stringify({
      endpoint: lifecycleBaseUrl, apiKey, publicUrl, advertiseHost, image, useServerProxy, egressMode,
    }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function loadMurmConfig(filename: string): Promise<unknown> {
  const configPath = resolve(filename);
  try { process.loadEnvFile(join(dirname(configPath), '.env')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return (await import(pathToFileURL(configPath).href)).default;
}
