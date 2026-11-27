import type { AgentInfo, ErrorInfo, PendingCleanup } from './types.js';
import type { createModelTrace } from './model-trace.js';
import type { ResolvedOpenSandboxBackendConfig } from './opensandbox-backend.js';

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
  config: ResolvedOpenSandboxBackendConfig;
  getAgent(id: string): ModelAgent | undefined;
  modelTrace?: ReturnType<typeof createModelTrace>;
  onOwned?: (owner: ModelOwner) => void;
}

interface ModelAlias {
  model: ResolvedOpenSandboxBackendConfig['models'][string];
  catalogResource?: Readonly<{ path: string; sha256: string }>;
  catalogContent?: string;
  ledgerPath?: string;
  db?: DatabaseSync;
  gateway?: ResponsesBudgetGateway;
  baseUrl?: string;
  capabilities?: ModelConfig['capabilities'];
  capabilitySource?: 'shipped-catalog' | 'configured' | 'compatibility-default';
  effectiveMaxOutputTokens?: number | null;
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
import { assertModelEndpoint, resolveModelTransport, ResponsesBudgetGateway } from '../agent/responses-budget-gateway.js';
import { modelClientProtocol, validateModelCapabilities } from './model-transport.js';
import type { ModelConfig } from './backend-config.js';

function invalid(message: string) {
  return Object.assign(new Error(message), { code: 'INVALID_CONFIG' });
}

export function snapshotModel(model: ModelConfig, executor: string): ModelConfig {
  if (typeof model?.provider !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(model.provider) ||
      typeof model?.model !== 'string' || !/^[a-zA-Z0-9._:/-]{1,128}$/.test(model.model) || model.model.includes('..')) {
    throw invalid('Each model needs valid provider and model identifiers');
  }
  try {
    const transport = resolveModelTransport(model.protocol);
    const clientProtocol = modelClientProtocol(model.protocol);
    if (executor === 'codex' && clientProtocol !== 'responses') {
      throw invalid('Codex requires the Responses model protocol');
    }
    if (executor === 'pi' && clientProtocol !== 'responses' && clientProtocol !== 'chat-completions') {
      throw invalid('Pi requires the Responses or Chat Completions client protocol');
    }
    const clientPath = clientProtocol === 'responses' ? '/v1/responses' : '/v1/chat/completions';
    if ((executor === 'codex' || executor === 'pi') && transport && transport.path !== clientPath) {
      throw invalid('Model transport path must match the selected executor client protocol');
    }
    if (!model.upstream?.headers || typeof model.upstream.headers !== 'object' || Array.isArray(model.upstream.headers) ||
        Object.values(model.upstream.headers).some(value => typeof value !== 'string')) {
      throw invalid('Model upstream headers must be strings');
    }
    if (typeof model.upstream.url !== 'string') throw invalid('Model upstream needs a URL');
    const url = assertModelEndpoint(model.upstream.url, transport);
    validateModelCapabilities(model.capabilities);
    if (executor === 'codex' && model.capabilities?.tools === false) {
      throw invalid('The Codex executor requires a model with tool support');
    }
    return Object.freeze({ provider: model.provider, model: model.model,
      ...(model.protocol === undefined ? {} : { protocol: typeof model.protocol === 'string' ? model.protocol : transport }),
      ...(model.capabilities === undefined ? {} : { capabilities: Object.freeze({ ...model.capabilities }) }),
      upstream: Object.freeze({ url: url.href, headers: Object.freeze({ ...model.upstream.headers }) }),
    });
  } catch (error) {
    const message = error instanceof Error && !(error instanceof TypeError && (error as NodeJS.ErrnoException).code === 'ERR_INVALID_URL')
      ? error.message : 'Model upstream URL is invalid';
    throw invalid(message);
  }
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

export async function createCoreModelAccess({ runtimeId, outputDir, config, getAgent, modelTrace, onOwned }: ModelOptions) {
  if (typeof runtimeId !== 'string' || !runtimeId || typeof outputDir !== 'string' || !outputDir ||
      typeof getAgent !== 'function' || !config?.models || !Object.keys(config.models).length) {
    throw invalid('Model access requires Runtime identity, output directory, models and Agent authority');
  }
  const { driver } = config;
  const gatewayConfig = structuredClone(config.modelGateway);
  if (!gatewayConfig || typeof gatewayConfig.host !== 'string' || !gatewayConfig.host ||
      typeof gatewayConfig.advertiseHost !== 'string' || !/^[a-zA-Z0-9.:-]+$/.test(gatewayConfig.advertiseHost) ||
      ['0.0.0.0', '::'].includes(gatewayConfig.advertiseHost)) {
    throw invalid('Model gateway requires a listening host and a concrete advertised host');
  }
  const aliases = new Map<string, ModelAlias>();
  for (const [alias, candidate] of Object.entries(config.models)) {
    if (!alias) throw invalid('Each model alias requires a configured upstream');
    const model = snapshotModel(candidate, driver.kind);
    const selection = await driver.modelCatalogResource?.(model).catch(error => { throw invalid(error.message); });
    const catalogResource = selection ? Object.freeze({ path: selection.path, sha256: selection.sha256 }) : undefined;
    aliases.set(alias, { model, catalogResource, ...(selection?.content !== undefined ? { catalogContent: selection.content } : {}),
      capabilities: selection?.capabilities ?? model.capabilities,
      capabilitySource: selection?.capabilitySource ?? (model.capabilities ? 'configured' : undefined) });
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
      const transport = resolveModelTransport(entry.model.protocol);
      const gatewayOptions = { db: entry.db, executor: driver.kind,
        transport, capabilities: entry.model.capabilities,
        upstream: { ...entry.model.upstream, model: entry.model.model }, timeBounds: gatewayConfig,
        ...(entry.model.provider === 'kimi_proxy' && entry.model.model === 'k3' ? { transformPayload: kimiResponsesPayload } : {}),
        beginTrace: modelTrace ? (request: Record<string, unknown>) => modelTrace.begin({
          ...request, modelAlias: alias, provider: entry.model.provider, protocol: transport?.id ?? 'responses',
        }) : undefined,
        validateAgent: ({ runtimeId: callerRuntimeId, agentId }: { runtimeId: string; agentId: string }) => {
          if (callerRuntimeId !== runtimeId) return null;
          const agent = liveAgent(agentId, alias);
          if (!agent || agent.status === 'starting') return null;
          return { deadline: Date.now() + entry.gateway!.policy.requestTimeoutMs };
        } };
      entry.gateway = new ResponsesBudgetGateway(gatewayOptions);
      entry.effectiveMaxOutputTokens = entry.gateway.policy.maxOutputTokens;
      const listening = await entry.gateway.start({ host: gatewayConfig.host });
      const hostname = gatewayConfig.advertiseHost.includes(':') ? `[${gatewayConfig.advertiseHost}]` : gatewayConfig.advertiseHost;
      entry.baseUrl = `${(gatewayConfig.publicUrl ?? `http://${hostname}:{port}`)
        .replaceAll('{port}', String(listening.port)).replace(/\/$/, '')}/v1`;
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
      catalogContent?: string;
    } {
      const entry = aliases.get(alias);
      if (!entry || !liveAgent(agentId, alias) || tokens.has(agentId)) {
        throw Object.assign(new Error('Model credentials require a fresh live Agent and its configured model'),
          { code: 'NOT_ALLOWED', runtimeId, agentId });
      }
      const token = entry.gateway!.issueToken({ runtimeId, agentId });
      tokens.set(agentId, { token, gateway: entry.gateway! });
      return {
        ...driver.credentials(entry.model, entry.baseUrl!, token),
        baseUrl: entry.baseUrl!,
        catalogResource: entry.catalogResource,
        ...(entry.catalogContent !== undefined ? { catalogContent: entry.catalogContent } : {}),
      };
    },
    revokeAgent(agentId: string) {
      const binding = tokens.get(agentId);
      if (binding) binding.gateway.revokeToken(binding.token);
      tokens.set(agentId, null);
    },
    close,
    pendingCleanup,
    ledgerPaths,
    describe: () => Object.fromEntries([...aliases].map(([alias, entry]) => [alias, {
      ...(entry.capabilities ? { capabilities: { ...entry.capabilities }, capabilitySource: entry.capabilitySource } : {}),
      effectiveMaxOutputTokens: entry.effectiveMaxOutputTokens,
    }])),
  };
}
