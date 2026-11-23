import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
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

export async function createCoreBridge({ runtimeId, configuration, getBot, registrations }) {
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
  const server = createServer((request, response) => {
    request.resume();
    const authorization = request.headers.authorization;
    const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
    const botId = tokens.get(token);
    const bot = botId && getBot(botId);
    if (closing || !bot || ['exited', 'closing', 'closed'].includes(bot.status)) {
      reply(response, 403, { ok: false, error: { code: ERROR_CODES.NOT_ALLOWED, message: 'Bridge caller is unavailable' } });
      return;
    }
    if (request.method === 'GET' && request.url === '/health') {
      reply(response, 200, { ok: true, runtimeId, botId });
      return;
    }
    if (request.method === 'POST' && request.url === '/call') {
      reply(response, 503, { ok: false, error: { code: ERROR_CODES.SERVICE_UNAVAILABLE, message: 'Core Service dispatch requires the Service v2 integration' } });
      return;
    }
    reply(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Bridge route does not exist' } });
  });
  server.requestTimeout = WAIT_TIMEOUT_MS;
  server.headersTimeout = Math.min(10_000, WAIT_TIMEOUT_MS);
  server.timeout = WAIT_TIMEOUT_MS;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      server.closeAllConnections();
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
      if (closing || !bot || ['exited', 'closing', 'closed'].includes(bot.status)) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Bridge credentials require a live Bot');
      }
      let token = botTokens.get(botId);
      if (!token) {
        token = randomBytes(32).toString('hex');
        botTokens.set(botId, token);
        tokens.set(token, botId);
      }
      return { environment: { SWARMENV_BRIDGE_URL: publicUrl }, secretEnvironment: { SWARMENV_BRIDGE_TOKEN: token } };
    },
    revokeBot(botId) {
      const token = botTokens.get(botId);
      tokens.delete(token);
      botTokens.delete(botId);
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      tokens.clear();
      botTokens.clear();
      closePromise = new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      return closePromise;
    },
  };
}
