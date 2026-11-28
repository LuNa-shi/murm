import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
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

function readLocalApiKey(url: string): string | undefined {
  const local = loopbackLifecycle(url);
  if (!local) return;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(localApiKeyPath(local), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 256) return;
    return readFileSync(descriptor, 'utf8').trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

interface ConnectionInput {
  lifecycleBaseUrl?: string;
  apiKey?: string;
  endpointHost?: string;
  advertiseHost?: string;
  image?: string;
}

export function resolveSandboxConnectionWithSources(input: ConnectionInput = {}, scope?: string) {
  const environment = process.env;
  function setting(value: string | undefined, name: string, suffix: string) {
    const scopedName = scope ? `MURM_${scope}_${suffix}` : undefined;
    if (value != null) return { value, source: 'config' };
    if (environment[name]) return { value: environment[name], source: name };
    if (scopedName && environment[scopedName]) return { value: environment[scopedName], source: scopedName };
    return { value: undefined, source: undefined };
  }
  const lifecycle = setting(input.lifecycleBaseUrl, 'MURM_LIFECYCLE_URL', 'LIFECYCLE_URL');
  const lifecycleBaseUrl = lifecycle.value ?? (environment.OPENSANDBOX_BASE_URL || undefined) ?? defaultLifecycleUrl;
  const endpointSource = lifecycle.source ?? (environment.OPENSANDBOX_BASE_URL ? 'OPENSANDBOX_BASE_URL' : 'default');
  const apiKey = setting(input.apiKey, 'MURM_LIFECYCLE_TOKEN', 'LIFECYCLE_TOKEN').value ??
    (environment.OPEN_SANDBOX_API_KEY || environment.OPENSANDBOX_API_KEY || undefined) ?? readLocalApiKey(lifecycleBaseUrl);
  const endpoint = setting(input.endpointHost, 'MURM_ENDPOINT_HOST', 'ENDPOINT_HOST');
  const callback = setting(input.advertiseHost, 'MURM_ADVERTISE_HOST', 'ADVERTISE_HOST');
  const worker = setting(input.image, 'MURM_WORKER_IMAGE', 'IMAGE');
  const advertiseHost = callback.value ??
    (loopbackLifecycle(lifecycleBaseUrl) ? networkInterfaces().docker0?.find(address => address.family === 'IPv4')?.address : undefined);
  return {
    lifecycleBaseUrl, apiKey, endpointHost: endpoint.value, advertiseHost, image: worker.value, endpointSource,
    sources: {
      lifecycleBaseUrl: endpointSource,
      endpointHost: endpoint.source,
      advertiseHost: callback.source ?? (advertiseHost === undefined ? undefined : 'docker0'),
      image: worker.source,
    },
  };
}

export function resolveSandboxConnection(input: ConnectionInput = {}, scope?: string) {
  const { sources: _sources, ...connection } = resolveSandboxConnectionWithSources(input, scope);
  return connection;
}

export async function loadMurmConfig(filename: string): Promise<unknown> {
  const configPath = resolve(filename);
  try { process.loadEnvFile(join(dirname(configPath), '.env')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return (await import(pathToFileURL(configPath).href)).default;
}
