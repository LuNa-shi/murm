import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { invokeService } from './services.js';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';

const WAIT_TIMEOUT_MS = 60_000;

function reply(response, status, body) {
  if (response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function invalid(message) {
  throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, message);
}

export async function createCoreBridge({ runtimeId, configuration, getBot, registrations, serviceTimeoutMs = 30_000, onOwned, recordService, traceService }) {
  if (typeof runtimeId !== 'string' || !runtimeId || typeof getBot !== 'function' || !(registrations instanceof Map)) {
    invalid('Bridge requires runtime identity, Bot lookup and Service registrations');
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
  const tokens = new Map();
  const botTokens = new Map();
  let closing = false;
  let closePromise;
  const active = new Map();
  const server = createServer(async (request, response) => {
    let body;
    let controller;
    let instrumented = false;
    let trace;
    let traceOutput;
    let traceError;
    const authorization = request.headers.authorization;
    const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
    const botId = tokens.get(token);
    const live = () => {
      const bot = getBot(botId);
      if (closing || !botId || tokens.get(token) !== botId || !bot || bot.unavailable || !['idle', 'running'].includes(bot.status)) {
        throw new SwarmEnvError('NOT_ALLOWED', 'Bridge caller is unavailable');
      }
      return bot;
    };
    try {
      // Health also supports starting Bots while the backend is assembling.
      const bot = botId && getBot(botId);
      if (closing || !bot || bot.unavailable || ['exited', 'closing', 'closed'].includes(bot.status)) throw new SwarmEnvError('NOT_ALLOWED', 'Bridge caller is unavailable');
      if (request.method === 'GET' && request.url === '/health') {
        request.resume(); reply(response, 200, { ok: true, runtimeId, botId }); return;
      }
      if (request.method !== 'POST' || request.url !== '/call') {
        request.resume(); reply(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Bridge route does not exist' } }); return;
      }
      const chunks = [];
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
      const allows = (service, operation) => Object.hasOwn(current.services ?? {}, service) &&
        Array.isArray(current.services[service]) && current.services[service].includes(operation);
      const visible = [...registrations.values()].flatMap(({ manifest }) => {
        const capabilities = manifest.capabilities.filter(capability => allows(manifest.id, capability.operation));
        return capabilities.length ? [{ ...manifest, capabilities }] : [];
      });
      if (body.operation === 'list_services' && body.service_id === undefined) {
        reply(response, 200, { ok: true, result: { services: visible } }); return;
      }
      if (body.operation === 'get_service_metadata' && body.service_id === undefined) {
        const manifest = visible.find(item => item.id === body.payload?.service);
        if (!manifest) throw new SwarmEnvError('NOT_ALLOWED', 'Service is unavailable to this Profile');
        reply(response, 200, { ok: true, result: manifest }); return;
      }
      trace = { runtimeId, caller: { runtimeId, botId, profile: current.profile,
        ...(Object.hasOwn(current.bindings ?? {}, body.service_id) ? { binding: current.bindings[body.service_id] } : {}) },
        service: body.service_id, operation: body.operation, operation_id: body.operation_id,
        input: Object.hasOwn(body, 'payload') ? body.payload : {}, startedAt: new Date().toISOString() };
      traceService?.({ ...trace, phase: 'started' });
      const registration = registrations.get(body.service_id);
      if (!registration || !allows(body.service_id, body.operation)) throw new SwarmEnvError('NOT_ALLOWED', 'Profile does not authorize this Service operation');
      const binding = Object.hasOwn(current.bindings ?? {}, body.service_id) && typeof current.bindings[body.service_id] === 'string'
        ? current.bindings[body.service_id] : undefined;
      const caller = { runtimeId, botId, profile: current.profile, ...(binding === undefined ? {} : { binding }) };
      response.once('close', () => {
        if (!response.writableFinished) {
          controller?.abort();
          recordService?.({ runtimeId, botId, profile: current.profile, serviceId: body.service_id,
          operation: body.operation, operationId: body.operation_id, state: 'response', outcome: 'unknown' });
        }
      });
      controller = new AbortController();
      active.set(controller, botId);
      instrumented = true;
      const result = await invokeService(registration, { operation: body.operation, input: Object.hasOwn(body, 'payload') ? body.payload : {},
        envelope: { operation_id: body.operation_id }, caller, signal: controller.signal, recordService,
        assertAuthorized: () => {
          const latest=live();
          if(latest.profile!==caller.profile || !latest.services?.[body.service_id]?.includes(body.operation)) throw new SwarmEnvError('NOT_ALLOWED','Service caller authority was revoked');
        } }, serviceTimeoutMs);
      traceOutput = result;
      reply(response, 200, { ok: true, result });
    } catch (error) {
      traceError = { code: error.code ?? 'SERVICE_UNAVAILABLE', message: error.message,
        details: error.details ?? {}, retryable: error.retryable ?? false };
      request.resume();
      const code = error.code ?? 'SERVICE_UNAVAILABLE';
      const authenticated = botId && getBot(botId);
      if (!instrumented && authenticated && typeof body?.operation_id === 'string' && body.operation_id.length <= 256 &&
          typeof body.service_id === 'string' && body.service_id.length <= 128 && typeof body.operation === 'string' && body.operation.length <= 128) {
        recordService?.({ runtimeId, botId, profile: authenticated.profile, serviceId: body.service_id,
          operation: body.operation, operationId: body.operation_id, state: 'validation', outcome: 'not_executed',
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
    botTokens.clear();
    closePromise = new Promise((resolve, reject) => {
      server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
      server.closeAllConnections();
    }).catch(error => { closePromise = undefined; throw error; });
    return closePromise;
  }
  onOwned?.({ close });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!onOwned) void close().catch(() => {});
      reject(new SwarmEnvError(ERROR_CODES.SERVICE_TIMEOUT, 'Bridge listener startup timed out'));
    }, WAIT_TIMEOUT_MS);
    const onError = error => { clearTimeout(timer); reject(error); };
    server.once('error', onError);
    server.listen(0, configuration.host, () => {
      clearTimeout(timer);
      server.removeListener('error', onError);
      resolve();
    });
  });
  const publicUrl = configuration.publicUrl.replaceAll('{port}', String(server.address().port)).replace(/\/$/, '');
  return {
    publicUrl,
    credentialsForBot(botId) {
      const bot = getBot(botId);
      if (closing || !bot || bot.unavailable || ['exited', 'closing', 'closed'].includes(bot.status)) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bridge credentials require a live Bot');
      }
      let token = botTokens.get(botId);
      if (!token) {
        token = randomBytes(32).toString('hex');
        botTokens.set(botId, token);
        tokens.set(token, botId);
      }
      return { environment: { SWARMENV_BRIDGE_URL: publicUrl, SWARMENV_BRIDGE_CONTRACT_VERSION: '2' },
        secretEnvironment: { SWARMENV_BRIDGE_TOKEN: token } };
    },
    revokeBot(botId, { abortActive = false } = {}) {
      const token = botTokens.get(botId);
      tokens.delete(token);
      botTokens.delete(botId);
      if (abortActive) {
        for (const [controller, callerId] of active) {
          if (callerId === botId) controller.abort();
        }
      }
    },
    close,
  };
}
