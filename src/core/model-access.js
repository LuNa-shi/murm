import { createHash } from 'node:crypto';
import { mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ResponsesBudgetGateway } from '../agent/responses-budget-gateway.js';
import { assertShippedModelPair } from '../agent/model-catalog.js';

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_CONFIG' });
}

function isEmptyPiToolMessage(item, index, input) {
  if (item?.type !== 'message' || item.role !== 'assistant' || item.status !== 'completed' ||
      Object.keys(item).sort().join(',') !== 'content,id,role,status,type' ||
      typeof item.id !== 'string' || !/^msg_[a-zA-Z0-9_-]{1,60}$/.test(item.id) ||
      !Array.isArray(item.content) || item.content.length !== 1) return false;
  const [part] = item.content;
  if (part?.type !== 'output_text' || part.text !== '' || !Array.isArray(part.annotations) || part.annotations.length !== 0 ||
      Object.keys(part).sort().join(',') !== 'annotations,text,type') return false;
  const calls = new Set();
  for (let previous = index - 1; input[previous]?.type === 'function_call'; previous--) {
    const { call_id: id } = input[previous];
    if (typeof id !== 'string' || !id || calls.has(id)) return false;
    calls.add(id);
  }
  if (!calls.size) return false;
  for (let following = index + 1; input[following]?.type === 'function_call_output'; following++) {
    if (!calls.delete(input[following].call_id)) return false;
  }
  return calls.size === 0;
}

function kimiResponsesPayload(payload) {
  if (!Array.isArray(payload.input)) return payload;
  const input = payload.input.filter((item, index, items) => !isEmptyPiToolMessage(item, index, items));
  return input.length === payload.input.length ? payload : { ...payload, input };
}

function synchronousPolicy(policy) {
  if (policy === undefined) return commit => commit();
  if (!policy || typeof policy.authorize !== 'function' || typeof policy.withCommit !== 'function' ||
      [policy.authorize, policy.withCommit].some(fn => fn.constructor.name === 'AsyncFunction')) {
    throw invalid('Model access policy requires synchronous authorize and withCommit functions');
  }
  return commit => {
    let active = true;
    let calls = 0;
    let result;
    try {
      const returned = policy.withCommit(() => {
        if (!active) return undefined;
        if (++calls !== 1) throw invalid('Model policy must commit synchronously exactly once');
        result = commit();
        return result;
      });
      if (returned?.then) Promise.resolve(returned).catch(() => {});
      if (calls !== 1 || returned?.then) throw invalid('Model policy must commit synchronously exactly once');
      return result;
    } finally {
      active = false;
    }
  };
}

export async function createCoreModelAccess({ runtimeId, outputDir, config, getBot, modelAccessPolicy, modelTrace, onOwned }) {
  if (typeof runtimeId !== 'string' || !runtimeId || typeof outputDir !== 'string' || !outputDir ||
      typeof getBot !== 'function' || !config?.models || !Object.keys(config.models).length) {
    throw invalid('Model access requires Runtime identity, output directory, models and Bot authority');
  }
  const withLifecycleWrite = synchronousPolicy(modelAccessPolicy);
  const gatewayConfig = structuredClone(config.modelGateway);
  if (!gatewayConfig || typeof gatewayConfig.host !== 'string' || !gatewayConfig.host ||
      typeof gatewayConfig.advertiseHost !== 'string' || !/^[a-zA-Z0-9.:-]+$/.test(gatewayConfig.advertiseHost) ||
      ['0.0.0.0', '::'].includes(gatewayConfig.advertiseHost)) {
    throw invalid('Model gateway requires a listening host and a concrete advertised host');
  }
  const aliases = new Map();
  for (const [alias, model] of Object.entries(structuredClone(config.models))) {
    if (!alias || !model?.upstream) throw invalid('Each model alias requires a configured upstream');
    const catalogResource = await assertShippedModelPair(model).catch(error => { throw invalid(error.message); });
    aliases.set(alias, { model, catalogResource: Object.freeze(catalogResource) });
  }
  const directory = join(outputDir, 'model-access');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  let closed = false;
  let closePromise;
  const tokens = new Map();
  const closeFailures = new Map();
  const ledgerPaths = () => [...aliases].flatMap(([alias, entry]) => entry.ledgerPath ? [{ alias, path: entry.ledgerPath }] : []);
  const pendingCleanup = () => [...aliases].flatMap(([alias, entry]) => entry.gateway || entry.db ? [{
    kind: 'model', id: `${runtimeId}:${alias}`, action: 'close',
    ...(closeFailures.has(alias) ? { error: closeFailures.get(alias) } : {}),
  }] : []);
  const liveBot = (botId, alias) => {
    const bot = getBot(botId);
    return !closed && bot && !bot.unavailable && ['starting', 'idle', 'running'].includes(bot.status) &&
      bot.model === alias && typeof bot.profile === 'string' && bot.profile ? bot : null;
  };
  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    tokens.clear();
    closePromise = Promise.allSettled([...aliases].map(async ([alias, entry]) => {
      try {
        if (entry.gateway) {
          await entry.gateway.stop();
          entry.gateway = undefined;
        }
        if (entry.db) {
          entry.db.close();
          entry.db = undefined;
        }
        closeFailures.delete(alias);
      } catch (error) {
        closeFailures.set(alias, { code: 'MODEL_CLOSE_FAILED', message: 'Model listener or ledger closure has not been confirmed', retryable: true });
        throw error;
      }
    })).then(results => {
      if (results.some(result => result.status === 'rejected')) {
        throw Object.assign(new Error('Runtime model resources could not all be closed'), { code: 'MODEL_CLOSE_FAILED', retryable: true });
      }
    }).finally(() => { closePromise = undefined; });
    return closePromise;
  };
  onOwned?.({ close, pendingCleanup, ledgerPaths });
  try {
    for (const [alias, entry] of aliases) {
      const filename = `${createHash('sha256').update(alias).digest('hex')}.sqlite`;
      const path = join(directory, filename);
      entry.db = new DatabaseSync(path);
      entry.ledgerPath = path;
      await chmod(path, 0o600);
      entry.gateway = new ResponsesBudgetGateway({ db: entry.db,
        upstream: { ...entry.model.upstream, model: entry.model.model }, timeBounds: gatewayConfig,
        ...(entry.model.provider === 'kimi_proxy' && entry.model.model === 'k3' ? { transformPayload: kimiResponsesPayload } : {}),
        beginTrace: modelTrace ? request => modelTrace.begin({ ...request, modelAlias: alias, provider: entry.model.provider }) : undefined,
        withLifecycleWrite,
        validateBot: ({ runtimeId: callerRuntimeId, botId }) => {
          if (callerRuntimeId !== runtimeId) return null;
          const bot = liveBot(botId, alias);
          if (!bot || bot.status === 'starting') return null;
          if (!modelAccessPolicy) return { phase: 'work', deadline: Date.now() + entry.gateway.policy.requestTimeoutMs };
          const permit = modelAccessPolicy.authorize(Object.freeze({ runtimeId, botId, profile: bot.profile, model: alias }));
          if (permit?.then) {
            Promise.resolve(permit).catch(() => {});
            return null;
          }
          if (!permit || !['selection', 'work', 'closeout'].includes(permit.phase) ||
              !Number.isFinite(permit.deadlineAt) || permit.deadlineAt <= Date.now()) return null;
          const lease = permit.lease;
          if (lease !== undefined && (!lease || typeof lease.key !== 'string' || !lease.key || !Number.isSafeInteger(lease.version) ||
              lease.version < 0 || !Number.isFinite(lease.expiresAt) || lease.expiresAt <= Date.now())) return null;
          return { phase: permit.phase, deadline: permit.deadlineAt, ...(lease ? { lease: { ...lease } } : {}) };
        } });
      const listening = await entry.gateway.start({ host: gatewayConfig.host });
      const hostname = gatewayConfig.advertiseHost.includes(':') ? `[${gatewayConfig.advertiseHost}]` : gatewayConfig.advertiseHost;
      entry.baseUrl = `http://${hostname}:${listening.port}/v1`;
    }
  } catch (error) {
    if (!onOwned) await close().catch(() => {});
    if (!error.code) error.code = 'INVALID_CONFIG';
    throw error;
  }
  return {
    credentialsForBot(botId, alias) {
      const entry = aliases.get(alias);
      if (!entry || !liveBot(botId, alias) || tokens.has(botId)) {
        throw Object.assign(new Error('Model credentials require a fresh live Bot and its configured model'),
          { code: 'NOT_ALLOWED', runtimeId, botId });
      }
      const token = entry.gateway.issueToken({ runtimeId, botId });
      tokens.set(botId, { token, gateway: entry.gateway });
      const prefix = `PI_${entry.model.provider.toUpperCase().replaceAll('-', '_')}`;
      return { environment: { [`${prefix}_BASE_URL`]: entry.baseUrl }, secretEnvironment: { [`${prefix}_API_KEY`]: token },
        baseUrl: entry.baseUrl, catalogResource: entry.catalogResource };
    },
    revokeBot(botId) {
      const binding = tokens.get(botId);
      if (binding) binding.gateway.revokeToken(binding.token);
      tokens.set(botId, null);
    },
    close,
    pendingCleanup,
    ledgerPaths,
  };
}
