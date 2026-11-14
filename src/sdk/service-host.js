import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ERROR_CODES, SwarmEnvError, asSwarmEnvError } from '../errors.js';
import { createServiceManifest, manifestSnapshot, SERVICE_ROLES } from './service-manifest.js';
import { validateEnvelope } from '../protocol/envelope.js';

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

function json(value) {
  return JSON.stringify(value ?? null);
}

function send(response, status, body, headers = {}) {
  const content = json(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(content),
    ...headers,
  });
  response.end(content);
}

function statusForError(error) {
  switch (error?.code) {
    case ERROR_CODES.SERVICE_CAPABILITY_NOT_ALLOWED: return 403;
    case ERROR_CODES.NOT_ALLOWED: return 403;
    case ERROR_CODES.SERVICE_NOT_FOUND:
    case ERROR_CODES.SERVICE_CAPABILITY_NOT_FOUND: return 404;
    case ERROR_CODES.CONFLICT:
    case ERROR_CODES.STALE_VERSION:
    case ERROR_CODES.FENCED: return 409;
    case ERROR_CODES.SERVICE_TIMEOUT: return 504;
    case ERROR_CODES.SERVICE_UNAVAILABLE: return 503;
    case ERROR_CODES.SERVICE_NOT_READY: return 503;
    case ERROR_CODES.SERVICE_MANIFEST_INVALID:
    case ERROR_CODES.INVALID_CONTRACT: return 400;
    default: return 500;
  }
}

function errorBody(error) {
  const normalized = asSwarmEnvError(error, ERROR_CODES.SERVICE_UNAVAILABLE);
  return {
    code: normalized.code,
    message: normalized.message,
    details: normalized.details,
    retryable: normalized.retryable,
  };
}

async function readJson(request, maxBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'service request body is too large', { max_bytes: maxBytes });
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (error) {
    throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'service request body must be valid JSON', undefined, { cause: error });
  }
}

export class ServiceHost {
  constructor({ manifest, handler, readiness = null, token = null, principals = null, host = '127.0.0.1', advertiseHost = null, publicUrl = null, requireRole = true, trusted = false, maxBodyBytes = DEFAULT_MAX_BODY_BYTES, logger = null } = {}) {
    if (!manifest) throw new TypeError('ServiceHost requires a Service Manifest');
    if (typeof handler !== 'function') throw new TypeError('ServiceHost requires a handler');
    if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) throw new TypeError('maxBodyBytes must be a positive integer');
    this.manifest = createServiceManifest(manifest, { allowOpenObjects: trusted === true });
    this.handler = handler;
    this.readiness = readiness;
    this.token = token;
    if (principals !== null && (!Array.isArray(principals) || principals.some(principal =>
      typeof principal?.token !== 'string' || !principal.token || typeof principal.actor_ref !== 'string' || !principal.actor_ref ||
      !SERVICE_ROLES.includes(principal.role) || (principal.operations !== undefined &&
        (!Array.isArray(principal.operations) || principal.operations.some(operation => typeof operation !== 'string' || !operation)))) ||
      new Set(principals.map(principal => principal.token)).size !== principals.length)) {
      throw new TypeError('Service principals require unique tokens, actor identities, valid roles and optional operation lists');
    }
    this.principals = principals?.map(({ token: credential, actor_ref, role, operations }) => ({
      hash: createHash('sha256').update(`Bearer ${credential}`).digest(), actor_ref, role, operations: operations ? new Set(operations) : null,
    })) ?? null;
    this.host = host;
    this.advertiseHost = advertiseHost ?? (host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host);
    this.publicUrl = publicUrl;
    this.requireRole = requireRole;
    this.maxBodyBytes = maxBodyBytes;
    this.logger = logger;
    this.server = null;
    this.address = null;
  }

  async start({ port = 0 } = {}) {
    if (this.server) return this.environment();
    this.server = createServer((request, response) => { void this.#handle(request, response); });
    this.server.listen(port, this.host);
    await once(this.server, 'listening');
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('service host did not receive an address');
    this.address = address;
    // A host started on port 0 must advertise the bound endpoint in the
    // manifest it serves. Keeping `:0` in the manifest makes a Registry unable
    // to verify that it reached this provider and can route future calls to it.
    if (this.manifest.endpoint.transport === 'http-json') {
      const endpoint = new URL(this.manifest.endpoint.url);
      if (endpoint.port === '0') {
        endpoint.port = String(address.port);
        const replacementUrl = this.publicUrl ?? endpoint.toString();
        this.manifest = createServiceManifest({
          ...this.manifest,
          endpoint: { transport: 'http-json', url: replacementUrl },
        }, { allowOpenObjects: true });
      }
    }
    return this.environment();
  }

  environment() {
    if (!this.address) throw new Error('ServiceHost has not started');
    return {
      service_id: this.manifest.service_id,
      url: this.publicUrl ?? `http://${this.advertiseHost}:${this.address.port}`,
      token: this.token,
    };
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.address = null;
    server.close();
    await once(server, 'close').catch(() => undefined);
  }

  async #handle(request, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    try {
      if (request.method === 'GET' && url.pathname === (this.manifest.health?.path ?? '/healthz')) {
        send(response, 200, { ok: true, service_id: this.manifest.service_id, manifest_hash: this.manifest.manifest_hash });
        return;
      }
      if (request.method === 'GET' && url.pathname === (this.manifest.readiness?.path ?? '/readyz')) {
        const result = this.readiness ? await this.readiness({ manifest: this.manifest }) : true;
        const ready = result === true || result?.ok === true;
        if (!ready) throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, `service is not ready: ${this.manifest.service_id}`, { service_id: this.manifest.service_id, readiness: result ?? null }, { retryable: true });
        send(response, 200, { ok: true, service_id: this.manifest.service_id });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/manifest') {
        send(response, 200, { ok: true, result: manifestSnapshot(this.manifest) });
        return;
      }
      const capability = this.manifest.capabilities.find((candidate) => candidate.path === url.pathname && candidate.method === request.method);
      if (!capability) {
        send(response, 404, { ok: false, error: { code: ERROR_CODES.SERVICE_CAPABILITY_NOT_FOUND, message: `unknown service route: ${request.method} ${url.pathname}` } });
        return;
      }
      const credential = request.headers.authorization ?? '';
      const credentialHash = this.principals ? createHash('sha256').update(credential).digest() : null;
      const principal = this.principals && this.principals.find(candidate =>
        timingSafeEqual(candidate.hash, credentialHash));
      if ((this.principals && !principal) || (this.principals === null && this.token && credential !== `Bearer ${this.token}`)) {
        send(response, 401, { ok: false, error: { code: ERROR_CODES.SERVICE_CAPABILITY_NOT_ALLOWED, message: 'service authorization is required', retryable: false } });
        return;
      }
      const body = await readJson(request, this.maxBodyBytes);
      if (!body || typeof body !== 'object' || Array.isArray(body) || !body.envelope) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'service request requires envelope and input');
      validateEnvelope(body.envelope);
      const input = body.input ?? {};
      const role = body.role ?? null;
      if (principal && (body.envelope.actor_ref !== principal.actor_ref || role !== principal.role ||
          (principal.operations && !principal.operations.has(capability.operation)))) {
        throw new SwarmEnvError(ERROR_CODES.SERVICE_CAPABILITY_NOT_ALLOWED, 'Service credential does not authorize this actor, role or operation');
      }
      if (this.requireRole && role === null) {
        throw new SwarmEnvError(ERROR_CODES.SERVICE_CAPABILITY_NOT_ALLOWED, 'service invocation requires an Agent role', { service_id: this.manifest.service_id, capability: capability.name });
      }
      if (role !== null && !SERVICE_ROLES.includes(role)) {
        throw new SwarmEnvError(ERROR_CODES.SERVICE_CAPABILITY_NOT_ALLOWED, `unsupported Agent role: ${role}`, { service_id: this.manifest.service_id, capability: capability.name, role, supported: SERVICE_ROLES });
      }
      const actorRole = /^agent:(bound|recovery)$/.exec(body.envelope.actor_ref ?? '')?.[1] ?? null;
      if (actorRole && actorRole !== role) {
        throw new SwarmEnvError(ERROR_CODES.SERVICE_CAPABILITY_NOT_ALLOWED, 'service role does not match the Agent envelope', { service_id: this.manifest.service_id, capability: capability.name, role, actor_role: actorRole });
      }
      if (role !== null && !capability.audience.includes(role)) {
        throw new SwarmEnvError(ERROR_CODES.SERVICE_CAPABILITY_NOT_ALLOWED, `capability ${capability.name} is not available to role ${role}`, { service_id: this.manifest.service_id, capability: capability.name, role });
      }
      if (capability.requires_binding === true && (!body.envelope.task_id || !body.envelope.execution_id)) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, `capability ${capability.name} requires a bound Task and Execution`, { service_id: this.manifest.service_id, capability: capability.name, requires: ['task', 'execution'] });
      }
      const result = await this.handler({ manifest: this.manifest, capability, input, envelope: body.envelope, role, request });
      this.logger?.({ event: 'service.host.complete', service_id: this.manifest.service_id, capability: capability.name, ok: true });
      send(response, 200, { ok: true, result });
    } catch (error) {
      const normalized = asSwarmEnvError(error, ERROR_CODES.SERVICE_UNAVAILABLE);
      this.logger?.({ event: 'service.host.complete', service_id: this.manifest.service_id, ok: false, code: normalized.code });
      if (!response.writableEnded) send(response, statusForError(normalized), { ok: false, error: errorBody(normalized) });
    }
  }
}

export function createServiceHost(options = {}) {
  return new ServiceHost(options);
}
