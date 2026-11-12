#!/usr/bin/env node

import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ContextService } from '../src/context/context-service.js';
import { JudgeService } from '../src/judge/judge-service.js';
import { LeanChecker } from '../src/judge/lean-adapter.js';
import { TaskService } from '../src/task/task-service.js';
import { createServiceHost } from '../src/sdk/service-host.js';
import { builtInServiceManifest, createBuiltinServiceRegistry } from '../src/sdk/builtin-registry.js';
import { createHttpDomainProxy } from '../src/sdk/http-domain-proxy.js';

const SERVICE_IDS = new Set(['task', 'context', 'judge', 'catalog']);
const serviceId = process.env.SWARMENV_SERVICE_ID ?? '';
if (!SERVICE_IDS.has(serviceId)) throw new Error(`SWARMENV_SERVICE_ID must be one of ${[...SERVICE_IDS].join(', ')}`);

const host = process.env.SWARMENV_SERVICE_HOST ?? '0.0.0.0';
const port = Number(process.env.SWARMENV_SERVICE_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('SWARMENV_SERVICE_PORT must be an integer from 1 to 65535');
const advertiseHost = process.env.SWARMENV_SERVICE_ADVERTISE_HOST
  ?? (host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host);
const endpointUrl = process.env.SWARMENV_SERVICE_PUBLIC_URL ?? `http://${advertiseHost}:${port}`;
const catalogEndpoints = Object.fromEntries(['task', 'context', 'judge', 'catalog']
  .map((id) => [id, process.env[`SWARMENV_${id.toUpperCase()}_SERVICE_URL`]
    ? { url: process.env[`SWARMENV_${id.toUpperCase()}_SERVICE_URL`], token: process.env[`SWARMENV_${id.toUpperCase()}_SERVICE_TOKEN`] ?? null }
    : undefined])
  .filter(([, endpoint]) => endpoint));

const isolated = process.env.SWARMENV_SERVICE_ISOLATED === 'true';
const databasePath = isolated && serviceId === 'catalog'
  ? null
  : resolve(process.env.SWARMENV_SERVICE_DATABASE ?? `./data/${serviceId}.sqlite`);
let database = null;
if (databasePath) {
  await mkdir(dirname(databasePath), { recursive: true });
  database = new DatabaseSync(databasePath);
}
const endpointProxy = (id) => catalogEndpoints[id]
  ? createHttpDomainProxy({ serviceId: id, url: catalogEndpoints[id].url, token: catalogEndpoints[id].token, actorRef: `service:${serviceId}` })
  : null;

async function loadJudgeFixtureManifest() {
  const configured = process.env.SWARMENV_JUDGE_FIXTURE_MANIFEST;
  if (!configured) return null;
  const raw = configured.trim();
  if (raw.startsWith('{')) return JSON.parse(raw);
  return JSON.parse(await readFile(resolve(raw), 'utf8'));
}
const judgeFixtureManifest = await loadJudgeFixtureManifest();
let contextService = null;
let taskService = null;
let judgeService = null;
if (isolated) {
  if (serviceId === 'task') taskService = new TaskService(database, { contextService: endpointProxy('context') });
  if (serviceId === 'context') contextService = new ContextService(database, { taskService: endpointProxy('task') });
  if (serviceId === 'judge') judgeService = new JudgeService(database, {
    fixtureManifest: judgeFixtureManifest,
    checker: new LeanChecker({ workRoot: resolve(process.env.SWARMENV_JUDGE_WORK_ROOT ?? `./data/${serviceId}-judge-work`), command: process.env.SWARMENV_LEAN_COMMAND ?? 'lake' }),
  });
} else {
  // Compatibility composition for local-first fixtures. Production isolated
  // deployments set SWARMENV_SERVICE_ISOLATED=true and use HTTP proxies above.
  contextService = new ContextService(database);
  taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  judgeService = new JudgeService(database, {
    fixtureManifest: judgeFixtureManifest,
    checker: new LeanChecker({
      workRoot: resolve(process.env.SWARMENV_JUDGE_WORK_ROOT ?? `./data/${serviceId}-judge-work`),
      command: process.env.SWARMENV_LEAN_COMMAND ?? 'lake',
    }),
  });
}
const catalogRegistry = createBuiltinServiceRegistry({ taskService, contextService, judgeService, serviceEndpoints: catalogEndpoints });
if (process.env.SWARMENV_CATALOG_MANIFESTS) {
  const manifests = JSON.parse(process.env.SWARMENV_CATALOG_MANIFESTS);
  if (!Array.isArray(manifests)) throw new Error('SWARMENV_CATALOG_MANIFESTS must be a JSON array');
  for (const manifest of manifests) catalogRegistry.registerService({ manifest, adapter: { invoke: async () => ({}) } });
}

const manifest = builtInServiceManifest(serviceId, {
  endpoint: { transport: 'http-json', url: endpointUrl },
});

function dispatch(capability, input, envelope, role = null) {
  if (serviceId === 'catalog') {
    const allowed = (candidate) => role === null || candidate.audience.includes(role);
    if (capability.operation === 'list_services') return { services: catalogRegistry.listServices().filter((service) => catalogRegistry.getServiceMetadata(service.service_id).capabilities.some(allowed)) };
    if (capability.operation === 'get_service_metadata') {
      const metadata = catalogRegistry.getServiceMetadata(input?.service ?? null);
      return { ...metadata, capabilities: metadata.capabilities.filter(allowed) };
    }
    if (capability.operation === 'list_tools') return { tools: catalogRegistry.listTools(input?.service ?? null).filter(allowed) };
  }
  const service = serviceId === 'task' ? taskService : serviceId === 'context' ? contextService : judgeService;
  if (!service) throw new Error(`isolated ${serviceId} Service is not available in this process`);
  return service.dispatch(capability.operation, input, envelope);
}

const serviceHost = createServiceHost({
  manifest,
  handler: ({ capability, input, envelope, role }) => dispatch(capability, input, envelope, role),
  readiness: async () => true,
  token: process.env.SWARMENV_SERVICE_TOKEN ?? null,
  host,
  advertiseHost,
  publicUrl: endpointUrl,
  requireRole: true,
  trusted: true,
});

await serviceHost.start({ port });
console.log(JSON.stringify({
  service_id: serviceId,
  endpoint: serviceHost.environment().url,
  manifest_hash: manifest.manifest_hash,
  database_path: databasePath,
}));

const stop = async () => {
  await serviceHost.stop();
  for (const service of [judgeService, contextService, taskService]) {
    try { service?.close?.(); } catch { /* process is exiting */ }
  }
  try { database?.close(); } catch { /* process is exiting */ }
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
