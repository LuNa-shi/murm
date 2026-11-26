import type { AgentInfo, ErrorInfo, ModelAccessPolicy, PendingCleanup } from './types.js';
import type { createModelTrace } from './model-trace.js';
import type { OpenSandboxBackendConfig } from './backend-config.js';

interface ModelAgent {
  status: AgentInfo['status'];
  unavailable?: boolean;
  model: string;
  profile: string;
}

interface ModelOwner {
  close(): Promise<void>;
  pendingCleanup(): PendingCleanup[];
  ledgerPaths(): { alias: string; path: string }[];
}

interface ModelOptions {
  runtimeId: string;
  outputDir: string;
  config: OpenSandboxBackendConfig;
  getAgent(id: string): ModelAgent | undefined;
  modelAccessPolicy?: ModelAccessPolicy;
  modelTrace?: ReturnType<typeof createModelTrace>;
  onOwned?: (owner: ModelOwner) => void;
}

interface ModelAlias {
  model: OpenSandboxBackendConfig['models'][string];
  catalogResource?: Readonly<{ path: string; sha256: string }>;
  ledgerPath?: string;
  db?: DatabaseSync;
  gateway?: ResponsesBudgetGateway;
  baseUrl?: string;
}

interface ResponseInput {
  type?: unknown;
  role?: unknown;
  status?: unknown;
  id?: unknown;
  content?: unknown;
  call_id?: unknown;
}

import { createHash } from 'node:crypto';
import { mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ResponsesBudgetGateway } from '../agent/responses-budget-gateway.js';
import { assertShippedModelPair } from '../agent/model-catalog.js';

function invalid(message: string) {
  return Object.assign(new Error(message), { code: 'INVALID_CONFIG' });
}

function isEmptyPiToolMessage(item: ResponseInput, index: number, input: ResponseInput[]) {
  if (item?.type !== 'message' || item.role !== 'assistant' || item.status !== 'completed' ||
      Object.keys(item).sort().join(',') !== 'content,id,role,status,type' ||
      typeof item.id !== 'string' || !/^msg_[a-zA-Z0-9_-]{1,60}$/.test(item.id) ||
      !Array.isArray(item.content) || item.content.length !== 1) return false;
  const [part] = item.content;
  if (part?.type !== 'output_text' || part.text !== '' || !Array.isArray(part.annotations) || part.annotations.length !== 0 ||
      Object.keys(part).sort().join(',') !== 'annotations,text,type') return false;
  const calls = new Set<string>();
  for (let previous = index - 1; input[previous]?.type === 'function_call'; previous--) {
    const { call_id: id } = input[previous];
    if (typeof id !== 'string' || !id || calls.has(id)) return false;
    calls.add(id);
  }
  if (!calls.size) return false;
  for (let following = index + 1; input[following]?.type === 'function_call_output'; following++) {
    if (!calls.delete(input[following].call_id as string)) return false;
  }
  return calls.size === 0;
}

function kimiResponsesPayload(payload: { input?: unknown; [key: string]: unknown }) {
  if (!Array.isArray(payload.input)) return payload;
  const input = payload.input.filter((item, index, items) => !isEmptyPiToolMessage(item, index, items));
  return input.length === payload.input.length ? payload : { ...payload, input };
}

function synchronousPolicy(policy: ModelAccessPolicy | undefined): <T>(commit: () => T) => T {
  if (policy === undefined) return commit => commit();
  if (!policy || typeof policy.authorize !== 'function' || typeof policy.withCommit !== 'function' ||
      [policy.authorize, policy.withCommit].some(fn => fn.constructor.name === 'AsyncFunction')) {
    throw invalid('Model access policy requires synchronous authorize and withCommit functions');
  }
  return <T>(commit: () => T): T => {
    let active = true;
    let calls = 0;
    let result: T | undefined;
    try {
      const returned = policy.withCommit(() => {
        if (!active) return undefined;
        if (++calls !== 1) throw invalid('Model policy must commit synchronously exactly once');
        result = commit();
        return result;
      });
      if ((returned as { then?: unknown } | undefined)?.then) Promise.resolve(returned).catch(() => {});
      if (calls !== 1 || (returned as { then?: unknown } | undefined)?.then) throw invalid('Model policy must commit synchronously exactly once');
      return result as T;
    } finally {
      active = false;
    }
  };
}

export async function createCoreModelAccess({ runtimeId, outputDir, config, getAgent, modelAccessPolicy, modelTrace, onOwned }: ModelOptions) {
  if (typeof runtimeId !== 'string' || !runtimeId || typeof outputDir !== 'string' || !outputDir ||
      typeof getAgent !== 'function' || !config?.models || !Object.keys(config.models).length) {
    throw invalid('Model access requires Runtime identity, output directory, models and Agent authority');
  }
  const withLifecycleWrite = synchronousPolicy(modelAccessPolicy);
  const gatewayConfig = structuredClone(config.modelGateway);
  if (!gatewayConfig || typeof gatewayConfig.host !== 'string' || !gatewayConfig.host ||
      typeof gatewayConfig.advertiseHost !== 'string' || !/^[a-zA-Z0-9.:-]+$/.test(gatewayConfig.advertiseHost) ||
      ['0.0.0.0', '::'].includes(gatewayConfig.advertiseHost)) {
    throw invalid('Model gateway requires a listening host and a concrete advertised host');
  }
  const aliases = new Map<string, ModelAlias>();
  for (const [alias, model] of Object.entries(structuredClone(config.models))) {
    if (!alias || !model?.upstream) throw invalid('Each model alias requires a configured upstream');
    const catalogResource = config.executor?.kind === 'codex' ? undefined
      : await assertShippedModelPair(model).catch(error => { throw invalid(error.message); });
    aliases.set(alias, { model, catalogResource: catalogResource && Object.freeze(catalogResource) });
  }
  const directory = join(outputDir, 'model-access');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const tokens = new Map<string, { token: string; gateway: ResponsesBudgetGateway } | null>();
  const closeFailures = new Map<string, ErrorInfo>();
  const ledgerPaths = () => [...aliases].flatMap(([alias, entry]) => entry.ledgerPath ? [{ alias, path: entry.ledgerPath }] : []);
  const pendingCleanup = (): PendingCleanup[] => [...aliases].flatMap(([alias, entry]) => entry.gateway || entry.db ? [{
    kind: 'model', id: `${runtimeId}:${alias}`, action: 'close',
    ...(closeFailures.has(alias) ? { error: closeFailures.get(alias) } : {}),
  }] : []);
  const liveAgent = (agentId: string, alias: string) => {
    const agent = getAgent(agentId);
    return !closed && agent && !agent.unavailable && ['starting', 'idle', 'running'].includes(agent.status) &&
      agent.model === alias && typeof agent.profile === 'string' && agent.profile ? agent : null;
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
      const gatewayOptions = { db: entry.db, executor: config.executor?.kind ?? 'pi',
        upstream: { ...entry.model.upstream, model: entry.model.model }, timeBounds: gatewayConfig,
        ...(entry.model.provider === 'kimi_proxy' && entry.model.model === 'k3' ? { transformPayload: kimiResponsesPayload } : {}),
        beginTrace: modelTrace ? (request: Record<string, unknown>) => modelTrace.begin({ ...request, modelAlias: alias, provider: entry.model.provider }) : undefined,
        withLifecycleWrite,
        validateAgent: ({ runtimeId: callerRuntimeId, agentId }: { runtimeId: string; agentId: string }) => {
          if (callerRuntimeId !== runtimeId) return null;
          const agent = liveAgent(agentId, alias);
          if (!agent || agent.status === 'starting') return null;
          if (!modelAccessPolicy) return { phase: 'work', deadline: Date.now() + entry.gateway!.policy.requestTimeoutMs };
          const permit = modelAccessPolicy.authorize(Object.freeze({ runtimeId, agentId, profile: agent.profile, model: alias }));
          if ((permit as { then?: unknown } | null)?.then) {
            Promise.resolve(permit).catch(() => {});
            return null;
          }
          if (!permit || !['selection', 'work', 'closeout'].includes(permit.phase) ||
              !Number.isFinite(permit.deadlineAt) || permit.deadlineAt <= Date.now()) return null;
          const lease = permit.lease;
          if (lease !== undefined && (!lease || typeof lease.key !== 'string' || !lease.key || !Number.isSafeInteger(lease.version) ||
              lease.version < 0 || !Number.isFinite(lease.expiresAt) || lease.expiresAt <= Date.now())) return null;
          return { phase: permit.phase, deadline: permit.deadlineAt, ...(lease ? { lease: { ...lease } } : {}) };
        } };
      entry.gateway = new ResponsesBudgetGateway(gatewayOptions);
      const listening = await entry.gateway.start({ host: gatewayConfig.host });
      const hostname = gatewayConfig.advertiseHost.includes(':') ? `[${gatewayConfig.advertiseHost}]` : gatewayConfig.advertiseHost;
      entry.baseUrl = `http://${hostname}:${listening.port}/v1`;
    }
  } catch (caught) {
    const error = caught as Error & { code?: string };
    if (!onOwned) await close().catch(() => {});
    if (!error.code) error.code = 'INVALID_CONFIG';
    throw error;
  }
  return {
    credentialsForAgent(agentId: string, alias: string): {
      environment: Record<string, string>;
      secretEnvironment: Record<string, string>;
      baseUrl: string;
      catalogResource?: Readonly<{ path: string; sha256: string }>;
    } {
      const entry = aliases.get(alias);
      if (!entry || !liveAgent(agentId, alias) || tokens.has(agentId)) {
        throw Object.assign(new Error('Model credentials require a fresh live Agent and its configured model'),
          { code: 'NOT_ALLOWED', runtimeId, agentId });
      }
      const token = entry.gateway!.issueToken({ runtimeId, agentId });
      tokens.set(agentId, { token, gateway: entry.gateway! });
      const prefix = `PI_${entry.model.provider.toUpperCase().replaceAll('-', '_')}`;
      return { environment: config.executor?.kind === 'codex' ? {} : { [`${prefix}_BASE_URL`]: entry.baseUrl! },
        secretEnvironment: config.executor?.kind === 'codex' ? { OPENAI_API_KEY: token } : { [`${prefix}_API_KEY`]: token },
        baseUrl: entry.baseUrl!, catalogResource: entry.catalogResource };
    },
    revokeAgent(agentId: string) {
      const binding = tokens.get(agentId);
      if (binding) binding.gateway.revokeToken(binding.token);
      tokens.set(agentId, null);
    },
    close,
    pendingCleanup,
    ledgerPaths,
  };
}
