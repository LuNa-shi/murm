import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentInfo } from './types.js';
import type { ServiceInvocationRecord, ServiceRegistration } from './services.js';

interface BridgeAgent {
  status: AgentInfo['status'];
  unavailable?: boolean;
  profile: string;
  services: Readonly<Record<string, readonly string[]>>;
  bindings?: Readonly<Record<string, string>>;
  accessVersion?: number;
  accessGeneration?(serviceId: string, operation: string): number;
}

function allows(grants: BridgeAgent['services'] | undefined, service: string, operation: string) {
  return grants !== undefined && Object.hasOwn(grants, service) && Array.isArray(grants[service]) && grants[service].includes(operation);
}

export function permittedServiceManifests(registrations: ReadonlyMap<string, ServiceRegistration>, grants: BridgeAgent['services']) {
  return [...registrations.values()].flatMap(({ manifest }) => {
    const capabilities = manifest.capabilities.filter(capability => allows(grants, manifest.id, capability.operation));
    return capabilities.length ? [{ ...manifest, capabilities }] : [];
  });
}

interface BridgeBody {
  operation: string;
  operation_id: string;
  service_id: string;
  payload?: unknown;
}

interface BridgeOptions {
  runtimeId: string;
  configuration: { host: string; publicUrl: string };
  getAgent(id: string | undefined): BridgeAgent | undefined;
  registrations: Map<string, ServiceRegistration>;
  serviceTimeoutMs?: number;
  onOwned?: (owner: { close(): Promise<void> }) => void;
  recordService?: (record: ServiceInvocationRecord) => void;
  traceService?: (record: Record<string, unknown>) => void;
}

interface BridgeFailure extends Error {
  code?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { invokeService } from './services.js';
import { ERROR_CODES, MurmError } from '../errors.js';

const WAIT_TIMEOUT_MS = 60_000;

function reply(response: ServerResponse, status: number, body: unknown) {
  if (response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function invalid(message: string): never {
  throw new MurmError(ERROR_CODES.INVALID_CONTRACT, message);
}

export async function createCoreBridge({ runtimeId, configuration, getAgent, registrations, serviceTimeoutMs = 30_000, onOwned, recordService, traceService }: BridgeOptions) {
  if (typeof runtimeId !== 'string' || !runtimeId || typeof getAgent !== 'function' || !(registrations instanceof Map)) {
    invalid('Bridge requires runtime identity, Agent lookup and Service registrations');
  }
  if (!configuration || typeof configuration.host !== 'string' || !configuration.host ||
      typeof configuration.publicUrl !== 'string' || !configuration.publicUrl.includes('{port}')) {
    invalid('Bridge requires host and publicUrl containing {port}');
  }
  let advertised;
  try { advertised = new URL(configuration.publicUrl.replaceAll('{port}', '1')); } catch { invalid('Bridge publicUrl must be a valid HTTP URL'); }
  if (!['http:', 'https:'].includes(advertised.protocol) || advertised.username || advertised.password ||
      advertised.pathname !== '/' || advertised.search || advertised.hash || ['0.0.0.0', '[::]'].includes(advertised.hostname)) {
    invalid('Bridge publicUrl must be a concrete HTTP(S) origin without credentials');
  }
  const tokens = new Map<string | null | undefined, string>();
  const agentTokens = new Map<string, string>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const active = new Map<AbortController, { agentId: string; serviceId: string; operation: string }>();
  const serviceWork = new Map<string, Set<Promise<void>>>();
  const uncertainWrites = new Set<string>();

  function trackCompletion(id: string, completion: Promise<void>) {
    let pending = serviceWork.get(id);
    if (!pending) serviceWork.set(id, pending = new Set());
    pending.add(completion);
    void completion.then(() => {
      pending.delete(completion);
      if (pending.size === 0) serviceWork.delete(id);
    });
  }
  const visibleServices = (grants: BridgeAgent['services']) => permittedServiceManifests(registrations, grants);
  const server = createServer(async (request, response) => {
    const attemptId = randomUUID();
    let accessVersion: number | undefined;
    let remoteWrite = false;
    const recordAttempt = (record: ServiceInvocationRecord) => {
      if (remoteWrite && record.state === 'settled' && record.outcome === 'unknown') uncertainWrites.add(record.serviceId);
      recordService?.({ ...record, attemptId, ...(accessVersion === undefined ? {} : { accessVersion }) });
    };
    let body: BridgeBody | undefined;
    let controller: AbortController | undefined;
    let instrumented = false;
    let trace;
    let traceOutput;
    let traceError;
    const authorization = request.headers.authorization;
    const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
    const agentId = tokens.get(token);
    const live = () => {
      const agent = getAgent(agentId);
      if (closing || !agentId || tokens.get(token) !== agentId || !agent || agent.unavailable || !['idle', 'running'].includes(agent.status)) {
        throw new MurmError('NOT_ALLOWED', 'Bridge caller is unavailable');
      }
      return agent;
    };
    try {
      // Health also supports starting Agents while the backend is assembling.
      const agent = agentId && getAgent(agentId);
      if (closing || !agent || agent.unavailable || ['exited', 'closing', 'closed'].includes(agent.status)) throw new MurmError('NOT_ALLOWED', 'Bridge caller is unavailable');
      if (request.method === 'GET' && request.url === '/health') {
        request.resume(); reply(response, 200, { ok: true, runtimeId, agentId }); return;
      }
      if (request.method !== 'POST' || request.url !== '/call') {
        request.resume(); reply(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Bridge route does not exist' } }); return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) invalid('Bridge request exceeds 2 MiB');
        chunks.push(chunk);
      }
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { invalid('Bridge request must be JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.operation !== 'string' ||
          typeof body.operation_id !== 'string' || !body.operation_id || body.operation_id.length > 256) invalid('Bridge request requires operation and operation_id');
      const current = live();
      if (body.operation === 'list_services' && body.service_id === undefined) {
        reply(response, 200, { ok: true, result: { services: visibleServices(current.services) } }); return;
      }
      if (body.operation === 'get_service_metadata' && body.service_id === undefined) {
        const service = (body.payload as { service?: string } | null | undefined)?.service;
        const manifest = visibleServices(current.services).find(item => item.id === service);
        // Record discovery on its own stage. A denied manifest lookup has no
        // adapter invocation and must never be treated as a dispatch denial.
        if (!manifest && typeof service === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(service)) {
          trace = { runtimeId, attemptId, accessVersion: current.accessVersion,
            caller: { runtimeId, agentId, profile: current.profile }, service,
            operation: body.operation, operation_id: body.operation_id, input: {}, startedAt: new Date().toISOString() };
          traceService?.({ ...trace, phase: 'started' });
        }
        if (!manifest) throw new MurmError('NOT_ALLOWED', 'Service is unavailable to this Profile');
        reply(response, 200, { ok: true, result: manifest }); return;
      }
      accessVersion = current.accessVersion;
      const generation = current.accessGeneration?.(body.service_id, body.operation);
      trace = { runtimeId, attemptId, ...(accessVersion === undefined ? {} : { accessVersion }), caller: { runtimeId, agentId, profile: current.profile,
        ...(Object.hasOwn(current.bindings ?? {}, body.service_id) ? { binding: current.bindings![body.service_id] } : {}) },
        service: body.service_id, operation: body.operation, operation_id: body.operation_id,
        input: Object.hasOwn(body, 'payload') ? body.payload : {}, startedAt: new Date().toISOString() };
      traceService?.({ ...trace, phase: 'started' });
      const registration = registrations.get(body.service_id);
      if (!registration || !allows(current.services, body.service_id, body.operation)) throw new MurmError('NOT_ALLOWED', 'Profile does not authorize this Service operation');
      remoteWrite = registration.manifest.endpoint.transport === 'http-json' &&
        registration.manifest.capabilities.some(item => item.operation === body!.operation && item.side_effect === 'write');
      const binding = Object.hasOwn(current.bindings ?? {}, body.service_id) && typeof current.bindings![body.service_id] === 'string'
        ? current.bindings![body.service_id] : undefined;
      const caller = { runtimeId, agentId: agentId!, profile: current.profile, ...(binding === undefined ? {} : { binding }) };
      response.once('close', () => {
        if (!response.writableFinished) {
          controller?.abort();
          recordAttempt({ runtimeId, agentId: agentId!, profile: current.profile, serviceId: body!.service_id,
          operation: body!.operation, operationId: body!.operation_id, state: 'response', outcome: 'unknown' });
        }
      });
      controller = new AbortController();
      active.set(controller, { agentId: caller.agentId, serviceId: body.service_id, operation: body.operation });
      instrumented = true;
      const invocation = invokeService(registration, { operation: body.operation, input: Object.hasOwn(body, 'payload') ? body.payload : {},
        envelope: { operation_id: body.operation_id }, caller, signal: controller.signal, recordService: recordAttempt,
        trackCompletion: completion => trackCompletion(registration.manifest.id, completion),
        assertAuthorized: () => {
          const latest=live();
          if (latest.profile !== caller.profile || !allows(latest.services, body!.service_id, body!.operation)
            || latest.accessGeneration?.(body!.service_id, body!.operation) !== generation) {
            throw new MurmError('NOT_ALLOWED', 'Service caller authority was revoked');
          }
        } }, serviceTimeoutMs);
      trackCompletion(registration.manifest.id, invocation.then(() => {}, () => {}));
      const result = await invocation;
      traceOutput = result;
      reply(response, 200, { ok: true, result });
    } catch (caught) {
      const error = caught as BridgeFailure;
      traceError = { code: error.code ?? 'SERVICE_UNAVAILABLE', message: error.message,
        details: error.details ?? {}, retryable: error.retryable ?? false };
      request.resume();
      const code = error.code ?? 'SERVICE_UNAVAILABLE';
      const authenticated = agentId && getAgent(agentId);
      if (!instrumented && authenticated && typeof body?.operation_id === 'string' && body.operation_id.length <= 256 &&
          typeof body.service_id === 'string' && body.service_id.length <= 128 && typeof body.operation === 'string' && body.operation.length <= 128) {
        recordAttempt({ runtimeId, agentId: agentId!, profile: authenticated.profile, serviceId: body!.service_id,
          operation: body!.operation, operationId: body!.operation_id, state: 'validation', outcome: 'not_executed',
          error: { code: ['NOT_ALLOWED', 'NOT_FOUND', 'INVALID_CONTRACT'].includes(code) ? code : 'SERVICE_UNAVAILABLE', retryable: false } });
      }
      const status = code === 'NOT_ALLOWED' ? 403 : code === 'NOT_FOUND' ? 404 : code === 'SERVICE_TIMEOUT' ? 504 :
        ['INVALID_CONTRACT', 'SERVICE_INPUT_INVALID'].includes(code) ? 400 : code === 'CONFLICT' ? 409 : 503;
      reply(response, status, { ok: false, error: { code, message: error.message, retryable: error.retryable ?? false,
        details: { ...error.details, ...(body?.operation_id ? { operation_id: body.operation_id, operation: body.operation, service_id: body.service_id } : {}) } } });
    } finally {
      if (controller) active.delete(controller);
      if (trace) traceService?.({ ...trace, phase: 'settled', endedAt: new Date().toISOString(),
        ...(traceError ? { error: traceError } : { output: traceOutput }) });
    }
  });
  server.requestTimeout = WAIT_TIMEOUT_MS;
  server.headersTimeout = Math.min(10_000, WAIT_TIMEOUT_MS);
  // Invocation deadlines are owned by the registered capability, including long waits.
  server.timeout = 0;
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    for (const controller of active.keys()) controller.abort();
    tokens.clear();
    agentTokens.clear();
    closePromise = new Promise<void>((resolve, reject) => {
      server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
      server.closeAllConnections();
    }).catch(error => { closePromise = undefined; throw error; });
    return closePromise;
  }
  onOwned?.({ close });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!onOwned) void close().catch(() => {});
      reject(new MurmError(ERROR_CODES.SERVICE_TIMEOUT, 'Bridge listener startup timed out'));
    }, WAIT_TIMEOUT_MS);
    const onError = (error: Error) => { clearTimeout(timer); reject(error); };
    server.once('error', onError);
    server.listen(0, configuration.host, () => {
      clearTimeout(timer);
      server.removeListener('error', onError);
      resolve();
    });
  });
  const publicUrl = configuration.publicUrl.replaceAll('{port}', String((server.address() as AddressInfo).port)).replace(/\/$/, '');
  function cancelAgentCalls(agentId: string) {
    for (const [controller, call] of active) {
      if (call.agentId === agentId) controller.abort();
    }
  }
  return {
    publicUrl,
    cancelAgentCalls,
    cancelAccess(agentId: string, serviceId: string, operations: ReadonlySet<string>) {
      for (const [controller, call] of active) {
        if (call.agentId === agentId && call.serviceId === serviceId && operations.has(call.operation)) controller.abort();
      }
    },
    async drainService(id: string) { await Promise.all(serviceWork.get(id) ?? []); },
    hasUncertainWrites: (id: string) => uncertainWrites.has(id),
    visibleServices,
    credentialsForAgent(agentId: string) {
      const agent = getAgent(agentId);
      if (closing || !agent || agent.unavailable || ['exited', 'closing', 'closed'].includes(agent.status)) {
        throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Bridge credentials require a live Agent');
      }
      let token = agentTokens.get(agentId);
      if (!token) {
        token = randomBytes(32).toString('hex');
        agentTokens.set(agentId, token);
        tokens.set(token, agentId);
      }
      return { environment: { MURM_BRIDGE_URL: publicUrl, MURM_BRIDGE_CONTRACT_VERSION: '2' },
        secretEnvironment: { MURM_BRIDGE_TOKEN: token } };
    },
    revokeAgent(agentId: string, { abortActive = false } = {}) {
      const token = agentTokens.get(agentId);
      tokens.delete(token);
      agentTokens.delete(agentId);
      if (abortActive) cancelAgentCalls(agentId);
    },
    close,
  };
}
