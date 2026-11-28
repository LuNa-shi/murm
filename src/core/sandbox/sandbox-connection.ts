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

export function resolveSandboxConnection(input: {
  lifecycleBaseUrl?: string;
  apiKey?: string;
  endpointHost?: string;
  advertiseHost?: string;
  image?: string;
} = {}, scope?: string) {
  const environment = process.env;
  const example = (name: string) => scope ? environment[`MURM_${scope}_${name}`] || undefined : undefined;
  const configuredUrl = input.lifecycleBaseUrl ?? (environment.MURM_LIFECYCLE_URL || undefined) ??
    example('LIFECYCLE_URL') ?? (environment.OPENSANDBOX_BASE_URL || undefined);
  const lifecycleBaseUrl = configuredUrl ?? defaultLifecycleUrl;
  const apiKey = input.apiKey ?? (environment.MURM_LIFECYCLE_TOKEN || undefined) ?? example('LIFECYCLE_TOKEN') ??
    (environment.OPEN_SANDBOX_API_KEY || environment.OPENSANDBOX_API_KEY || undefined) ?? readLocalApiKey(lifecycleBaseUrl);
  return {
    lifecycleBaseUrl, apiKey,
    endpointHost: input.endpointHost ?? (environment.MURM_ENDPOINT_HOST || undefined) ?? example('ENDPOINT_HOST'),
    advertiseHost: input.advertiseHost ?? (environment.MURM_ADVERTISE_HOST || undefined) ?? example('ADVERTISE_HOST') ??
      (loopbackLifecycle(lifecycleBaseUrl) ? networkInterfaces().docker0?.find(address => address.family === 'IPv4')?.address : undefined),
    image: input.image ?? (environment.MURM_WORKER_IMAGE || undefined) ?? example('IMAGE'),
    endpointSource: input.lifecycleBaseUrl !== undefined ? 'config' : environment.MURM_LIFECYCLE_URL ? 'MURM_LIFECYCLE_URL' :
      example('LIFECYCLE_URL') ? `MURM_${scope}_LIFECYCLE_URL` : environment.OPENSANDBOX_BASE_URL ? 'OPENSANDBOX_BASE_URL' : 'default',
  };
}

export async function loadMurmConfig(filename: string): Promise<unknown> {
  const configPath = resolve(filename);
  try { process.loadEnvFile(join(dirname(configPath), '.env')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return (await import(pathToFileURL(configPath).href)).default;
}
