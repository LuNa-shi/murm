#!/usr/bin/env node

import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ContextService } from '../../services/material/context-service.js';
import { JudgeService } from '../../services/judge/judge-service.js';
import { LeanChecker } from '../../services/judge/lean-adapter.js';
import { TaskService } from '../../services/task/task-service.js';
import { createServiceHost } from './service-host.js';
import { builtInServiceManifest, createBuiltinServiceRegistry } from '../../services/builtin-registry.js';
import { ERROR_CODES, MurmError } from '../../errors.js';

const SERVICE_IDS = new Set(['task', 'context', 'judge', 'catalog']);
const serviceId = process.env.MURM_SERVICE_ID ?? '';
if (!SERVICE_IDS.has(serviceId)) throw new Error(`MURM_SERVICE_ID must be one of ${[...SERVICE_IDS].join(', ')}`);

const host = process.env.MURM_SERVICE_HOST ?? '0.0.0.0';
const port = Number(process.env.MURM_SERVICE_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('MURM_SERVICE_PORT must be an integer from 1 to 65535');
const advertiseHost = process.env.MURM_SERVICE_ADVERTISE_HOST
  ?? (host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host);
const endpointUrl = process.env.MURM_SERVICE_PUBLIC_URL ?? `http://${advertiseHost}:${port}`;
const catalogEndpoints = Object.fromEntries(['task', 'context', 'judge', 'catalog']
  .map((id: any) => [id, process.env[`MURM_${id.toUpperCase()}_SERVICE_URL`]
    ? { url: process.env[`MURM_${id.toUpperCase()}_SERVICE_URL`], token: process.env[`MURM_${id.toUpperCase()}_SERVICE_TOKEN`] ?? null }
    : undefined])
  .filter(([, endpoint]: any) => endpoint));

const isolated = process.env.MURM_SERVICE_ISOLATED === 'true';
// Invocation requires an actor-bound credential selected by the host operator.
const principals = process.env.MURM_SERVICE_PRINCIPALS ? JSON.parse(process.env.MURM_SERVICE_PRINCIPALS) : [];
if (!Array.isArray(principals)) throw new TypeError('MURM_SERVICE_PRINCIPALS must be a JSON array');
const databasePath = isolated && serviceId === 'catalog'
  ? null
  : resolve(process.env.MURM_SERVICE_DATABASE ?? `./data/${serviceId}.sqlite`);
let database: any = null;
if (databasePath) {
  await mkdir(dirname(databasePath), { recursive: true });
  database = new DatabaseSync(databasePath);
}
async function loadJudgeFixtureManifest() {
  const configured = process.env.MURM_JUDGE_FIXTURE_MANIFEST;
  if (!configured) return null;
  const raw = configured.trim();
  if (raw.startsWith('{')) return JSON.parse(raw);
  return JSON.parse(await readFile(resolve(raw), 'utf8'));
}
const judgeFixtureManifest = await loadJudgeFixtureManifest();
let contextService: any = null;
let taskService: any = null;
let judgeService: any = null;
if (isolated) {
  if (serviceId === 'task') taskService = new TaskService(database);
  if (serviceId === 'context') contextService = new ContextService(database);
  if (serviceId === 'judge') judgeService = new JudgeService(database, {
    fixtureManifest: judgeFixtureManifest,
    checker: new LeanChecker({ workRoot: resolve(process.env.MURM_JUDGE_WORK_ROOT ?? `./data/${serviceId}-judge-work`), command: process.env.MURM_LEAN_COMMAND ?? 'lake' }),
  });
} else {
  contextService = new ContextService(database);
  taskService = new TaskService(database, { contextService });
  contextService.taskService = taskService;
  judgeService = new JudgeService(database, {
    fixtureManifest: judgeFixtureManifest,
    checker: new LeanChecker({
      workRoot: resolve(process.env.MURM_JUDGE_WORK_ROOT ?? `./data/${serviceId}-judge-work`),
      command: process.env.MURM_LEAN_COMMAND ?? 'lake',
    }),
  });
}
const catalogRegistry = createBuiltinServiceRegistry({ taskService, contextService, judgeService, serviceEndpoints: catalogEndpoints });
if (process.env.MURM_CATALOG_MANIFESTS) {
  const manifests = JSON.parse(process.env.MURM_CATALOG_MANIFESTS);
  if (!Array.isArray(manifests)) throw new Error('MURM_CATALOG_MANIFESTS must be a JSON array');
  for (const manifest of manifests) catalogRegistry.registerService({ manifest, adapter: { invoke: async () => ({}) } });
}

const manifest = builtInServiceManifest(serviceId, {
  endpoint: { transport: 'http-json', url: endpointUrl },
});

function dispatch(capability: any, input: any, envelope: any, role: any = null) {
  if (serviceId === 'catalog') {
    const allowed = (candidate: any) => role === null || candidate.audience.includes(role);
    if (capability.operation === 'list_services') return { services: catalogRegistry.listServices().filter((service: any) => catalogRegistry.getServiceMetadata(service.service_id).capabilities.some(allowed)) };
    if (capability.operation === 'get_service_metadata') {
      const metadata = catalogRegistry.getServiceMetadata(input?.service ?? null);
      return { ...metadata, capabilities: metadata.capabilities.filter(allowed) };
    }
    if (capability.operation === 'list_tools') return { tools: catalogRegistry.listTools(input?.service ?? null).filter(allowed) };
  }
  if (capability.operation === 'task_take' &&
      [input?.owner_ref, input?.ownerRef, input?.actor_ref].some((value: any) => value !== undefined && value !== envelope.actor_ref)) {
    throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Service credentials cannot assign another Task owner');
  }
  if ((input?.actor_ref !== undefined && input.actor_ref !== envelope.actor_ref) ||
      (input?.actorRef !== undefined && input.actorRef !== envelope.actor_ref)) {
    throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Service credentials cannot delegate the authenticated actor');
  }
  const service = serviceId === 'task' ? taskService : serviceId === 'context' ? contextService : judgeService;
  if (!service) throw new Error(`isolated ${serviceId} Service is not available in this process`);
  if (serviceId === 'context' && typeof contextService.taskService?.materialScope !== 'function') {
    throw new MurmError(ERROR_CODES.SERVICE_NOT_READY, 'Context requires an authenticated Mission authority and lifecycle commit boundary');
  }
  if (serviceId === 'judge' && !judgeService.taskService) {
    throw new MurmError(ERROR_CODES.SERVICE_NOT_READY, 'Judge requires local Task lifecycle authority and a trusted Workspace source');
  }
  if (serviceId === 'task') {
    const agent = taskService.getAgent(envelope.actor_ref);
    if (agent) {
      const requestedMission = input.mission_id ?? input.missionId;
      const taskId = input.task_id ?? input.taskId ?? envelope.task_id;
      if ((requestedMission !== undefined && requestedMission !== agent.mission_id) ||
          (taskId && taskService.getTask(taskId)?.mission_id !== agent.mission_id)) {
        throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Service request does not belong to the Agent Mission');
      }
      if (['task_list', 'task_status', 'mission_get'].includes(capability.operation)) input = { ...input, mission_id: agent.mission_id };
      if (envelope.execution_id && taskService.getExecution(envelope.execution_id)?.owner_ref !== agent.agent_id) {
        throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Service request does not belong to the Agent Execution');
      }
    }
  }
  return service.dispatch(capability.operation, input, envelope);
}

const serviceHost = createServiceHost({
  manifest,
  handler: ({ capability, input, envelope, role }: any) => dispatch(capability, input, envelope, role),
  readiness: async () => serviceId === 'context' ? typeof contextService.taskService?.materialScope === 'function'
    : serviceId === 'judge' ? Boolean(judgeService.taskService) : true,
  principals,
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
  manifest_hash: manifest!.manifest_hash,
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
