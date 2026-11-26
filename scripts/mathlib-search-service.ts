import { createMathlibSearchService } from '../src/services/mathlib-search/service.js';
import { createServiceHost } from '../src/sdk/service-host.js';

const host = process.env.MATHLIB_SEARCH_HOST ?? '0.0.0.0';
const port = Number(process.env.MATHLIB_SEARCH_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('MATHLIB_SEARCH_PORT must be an integer from 1 to 65535');

const advertiseHost = process.env.MATHLIB_SEARCH_ADVERTISE_HOST
  ?? (host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host);
const endpointUrl = process.env.MATHLIB_SEARCH_PUBLIC_URL ?? `http://${advertiseHost}:${port}`;
const provider = createMathlibSearchService({
  endpoint: { transport: 'http-json', url: endpointUrl },
  upstreamUrl: process.env.MATHLIB_SEARCH_UPSTREAM_URL ?? null,
  sourceRoot: process.env.MATHLIB_SEARCH_SOURCE_ROOT ?? null,
  timeoutMs: Number(process.env.MATHLIB_SEARCH_TIMEOUT_MS ?? 8_000),
  mathlibRevision: process.env.MATHLIB_REVISION ?? null,
  leanVersion: process.env.LEAN_VERSION ?? null,
});
const serviceHost = createServiceHost({
  manifest: provider.manifest,
  handler: provider.handler,
  readiness: provider.readiness,
  token: process.env.MATHLIB_SEARCH_TOKEN ?? null,
  host,
  advertiseHost,
  publicUrl: endpointUrl,
  requireRole: true,
});

await serviceHost.start({ port });
console.log(JSON.stringify({
  service_id: provider.manifest.service_id,
  endpoint: serviceHost.environment().url,
  manifest_hash: provider.manifest.manifest_hash,
}));

const stop = async () => {
  await serviceHost.stop();
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
