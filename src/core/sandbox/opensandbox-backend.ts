import type { AllocationLedger, AllocationRecord as LedgerAllocation } from '../allocation-ledger.js';
import type { OpenSandboxManager } from './opensandbox-manager.js';
import type { BeforeCompactDecision, BeforeCompactRequest } from '../session-types.js';
import type { AgentEvent, ErrorInfo, InputMode, InterruptReceipt, Profile, SpawnOptions, SendOptions } from '../types.js';
import type { SessionFork } from '../../../scripts/core-session-fork.js';
import type { createCoreBridge } from '../bridge.js';
import { renderStartupPrompt } from '../startup-prompt.js';
import { snapshotModel, type createCoreModelAccess } from '../model/model-access.js';
import { resolveFilePolicy, type ResolvedFilePolicy } from '../file-policy.js';

export type BackendEvent = {
  [Kind in AgentEvent['type']]: Omit<Extract<AgentEvent, { type: Kind }>, 'agentId'>
}[AgentEvent['type']];

export type BackendInputReceipt =
  | { status: 'unknown'; reason: string }
  | { status: 'not-accepted'; reason: 'idle' }
  | { status: 'accepted'; disposition: 'started' | 'queued' | 'handled' };

interface InputSubmission {
  input: string;
  mode: InputMode;
  wakeIfIdle: boolean;
  first: boolean;
  receipt?: Exclude<BackendInputReceipt, { status: 'unknown' }>;
  work?: Promise<BackendInputReceipt>;
}

type SharedWorkspace = Extract<NonNullable<SpawnOptions['workspace']>, { id: string }>;
interface WorkspaceOwners {
  provider: OpenSandboxProvider;
  owners: Set<string>;
  ready: Promise<void>;
  retiring?: Promise<unknown>;
  captureWork?: Promise<unknown>;
}
import type { WorkerFileReplace, WorkerFileSnapshot } from '../file-controls.js';
import type { FileReplaceOptions, FileSnapshotOptions } from '../types.js';

interface BackendAgent {
  workspace?: SharedWorkspace;
  id: string;
  provider: OpenSandboxProvider;
  manager: SandboxManager;
  onEvent(event: BackendEvent): void;
  onExecutionStart?: () => void;
  beforeCompact?: { timeoutMs: number; handler(request: Omit<BeforeCompactRequest, 'agentId' | 'profile' | 'signal'>): Promise<BeforeCompactDecision> };
  onTrace?: (record: Readonly<Record<string, unknown>>) => void;
  cursor: number;
  output: string;
  error: ErrorInfo | null;
  outcome?: 'completed' | 'failed' | 'aborted';
  stopping: boolean;
  exited: boolean;
  eventPoll: ReturnType<typeof createWorkerEventPoll>;
  nativeExecuting: boolean;
  pendingInputs: number;
  historyLost?: boolean;
  started?: boolean;
  executionEpoch?: number;
  sessionReady?: boolean;
  loadedResources?: readonly unknown[];
  activeMessageId?: string;
  sessionCommands?: Map<string, { fingerprint: string; command: string }>;
  decisions?: Set<string>;
  workerStartDispatched?: boolean;
  polling?: Promise<void>;
  submissions?: Map<string, InputSubmission>;
  executionStopped?: boolean;
  lease?: { expiresAt: string | null; dueAt: number; work?: Promise<void> };
  retaining?: 'archive-session' | 'collect-artifacts';
  retainAtRisk?: boolean;
  retainUntil?: string;
  deleting?: boolean;
  workerIdentity?: { workerInstanceId: string; streamEpoch: string };
  recovery?: () => Promise<void>;
  uncertain?: boolean;
}

type WorkerRecord = { worker_sequence: number; worker_at?: string; [key: string]: any } & (
  | { type: 'message_end'; message: {
      role: string;
      content?: { type: string; text: string }[];
      stopReason?: string;
      errorMessage?: string;
    } }
  | { type: 'controller_probe'; traceId: string }
  | { type: 'worker_error'; message: string }
  | { type: 'worker_exit'; code?: string | number; signal?: string }
  | { type: 'agent_start' | 'agent_settled'; aborted?: boolean }
  | { type: 'message_start' | 'message_update' | 'core_before_compact' | 'core_before_compact_result' | 'core_context_disposition' | 'core_session_event' | 'core_session_ready' | 'compaction_start' | 'compaction_end' | 'queue_update' | 'thinking_level_changed' | 'summarization_retry_scheduled' | 'summarization_retry_attempt_start' | 'summarization_retry_finished' | 'auto_compaction_start' | 'auto_compaction_end' | 'auto_retry_start' | 'auto_retry_end'; [key: string]: any }
  | { type: 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end';
      toolCallId: string; toolName?: string; args?: unknown; result?: unknown; partialResult?: unknown; isError?: boolean }
);

interface WorkerReply {
  records?: WorkerRecord[];
  state?: string;
  response?: {
    id?: string;
    command?: string;
    success?: boolean;
    error?: string;
    code?: string;
    data?: { disposition?: 'started' | 'queued' | 'handled'; discardedInputHashes?: string[]; [key: string]: any };
  };
  status?: string;
}

type ExecutorStartup =
  | { kind: 'codex'; version: string; authMode: 'api-key'; threadId: string }
  | { kind: string; version: string; protocol: string; capabilities: ExecutorCapabilities };

export interface SandboxManager {
  agentRpc(agentId: string, input: Record<string, unknown>, options: {
    timeoutMs: number; since?: number; transportTimeoutMs?: number; signal?: AbortSignal;
  }): Promise<WorkerReply>;
  coreFileOperation(agentId: string, action: 'snapshot', input: FileSnapshotOptions): Promise<WorkerFileSnapshot>;
  coreFileOperation(agentId: string, action: 'replace', input: FileReplaceOptions): Promise<WorkerFileReplace>;
  coreFileOperation(agentId: string, action: 'pause' | 'resume', input: { requestId: string }): Promise<{ paused: boolean; requestId: string }>;
  coreSessionSnapshot(agentId: string): Promise<SessionFork>;
  collectCoreSession(agentId: string): AsyncIterable<import('../artifact-collection.js').ArtifactRecord>;
  ensureExecution(options: Record<string, unknown>): Promise<{ sandbox_id: string }>;
  agentVersions(options: { executionId: string; executor?: string; externalExecutor?: boolean }): Promise<{ piVersion?: string; [key: string]: unknown }>;
  startAgent(options: Record<string, unknown>): Promise<{
    backend?: ExecutorStartup;
    isolation?: { cpu: number; memoryBytes: number; managementAuthentication: boolean };
  } | undefined>;
  /** Return true only when confirmed stopped. Return false for no running executor before start dispatch.
   * Throw or return false for an unconfirmed stop after start dispatch, retaining the resource for retry. */
  stopAgent(agentId: string, signal: string, options: { preserveWorker: boolean }): Promise<boolean>;
  collectCoreFiles(agentId: string, specification: NonNullable<Profile['collect']>): AsyncIterable<import('../artifact-collection.js').ArtifactRecord>;
  coreResource(agentId: string): {
    resourceKey: string;
    sandboxId?: string;
    creation: 'created' | 'pending' | 'absent';
    executionStopped: boolean;
    expiresAt?: string | null;
  } | undefined;
  /** Resolve after confirmed deletion or absence. Throw while the deletion outcome is uncertain. */
  stopExecution(agentId: string): Promise<unknown>;
  renewExecution?(resourceKey: string, minimumExpiresAtMs: number): Promise<{ sandboxId: string; expiresAt: string }>;
  close?(): Promise<void>;
}

interface BackendOptions {
  runtimeId: string;
  outputDir: string;
  bridge: Awaited<ReturnType<typeof createCoreBridge>>;
  modelAccess: Awaited<ReturnType<typeof createCoreModelAccess>>;
  registerPrivateValues?: (values: readonly unknown[]) => void;
  providers?: readonly OpenSandboxProvider[];
  durability?: { ledger: AllocationLedger; retainForMs: number; renewConcurrency: number };
}

interface AllocationRecord {
  state: string;
  providerId: string;
  resourceKey: string;
  timeoutSeconds?: number;
  sandboxId?: string;
  observation?: string;
  rejection?: boolean;
  expiresAt?: string | null;
}

interface BackendSpawnOptions {
  agentId: string;
  profile: Profile;
  options?: SpawnOptions;
  signal?: AbortSignal;
  onEvent(event: BackendEvent): void;
  onExecutionStart?: () => void;
  beforeCompact?: { timeoutMs: number; handler(request: Omit<BeforeCompactRequest, 'agentId' | 'profile' | 'signal'>): Promise<BeforeCompactDecision> };
  onTrace?: (record: Readonly<Record<string, unknown>>) => void;
  recordAllocation(record: AllocationRecord): void;
}

import type { CreateRuntimeOptions } from '../types.js';
import type { ExecutorCapabilities, OpenSandboxBackendConfig, Sandbox, SandboxConfig, SandboxProviderConfig } from '../backend-config.js';
import { selectExecutorDriver, type ExecutorDriver } from './executor-driver.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { createWorkerEventPoll } from '../worker-event-poll.js';
import { loopbackLifecycle, normalizeRuntimePublicUrl, resolveSandboxConnection } from './sandbox-connection.js';
import { validId } from '../config.js';
import { adaptSandboxProvider, createApiOpenSandboxProvider, type OpenSandboxProvider } from './opensandbox-provider.js';

export type ResolvedOpenSandboxBackendConfig = Omit<OpenSandboxBackendConfig, 'executor'> & {
  readonly driver: Readonly<ExecutorDriver>;
  readonly filePolicy: ResolvedFilePolicy;
};

type SandboxSettings = Pick<OpenSandboxBackendConfig, 'sandbox' | 'isolation' | 'provider'>;
const sandboxes = new WeakMap<Sandbox, SandboxSettings>();

function invalid(message: string) {
  return Object.assign(new Error(message), { code: 'INVALID_CONTRACT' });
}

function freeze<T extends object>(value: T): Readonly<T> {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}

async function callbackPolicyTarget(destination: string) {
  const url = new URL(destination);
  if (isIP(url.hostname) === 4) return destination;
  const addresses = await lookup(url.hostname, { family: 4, all: true }).catch(() => []);
  const unique = [...new Set(addresses.map(({ address }) => address))];
  if (unique.length !== 1 || unique[0].startsWith('127.') || unique[0] === '0.0.0.0') {
    throw invalid('A DNS Runtime callback requires one stable non-loopback IPv4 address for the OpenSandbox network policy');
  }
  url.hostname = unique[0];
  return url.href;
}

function networkAllowlist(destinations: readonly string[]) {
  const egress = new Map<string, { action: 'allow'; target: string; ports: number[] }>();
  for (const destination of destinations) {
    const { hostname, port, protocol } = new URL(destination);
    if (isIP(hostname) !== 4 || hostname.startsWith('127.')) {
      throw invalid('OpenSandbox dns+nft requires a non-loopback IPv4 Runtime callback and IPv4 allowlist targets for exact ports');
    }
    const tcpPort = port ? Number(port) : protocol === 'https:' ? 443 : 80;
    egress.set(`${hostname}:${tcpPort}`, { action: 'allow', target: hostname, ports: [tcpPort] });
  }
  return { defaultAction: 'deny' as const, egress: [...egress.values()] };
}

function sandboxExpiry(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const instant = Date.parse(value);
  const day = value.slice(0, 10);
  const calendar = Date.parse(day);
  if (!Number.isFinite(instant) || !Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 10) !== day) return null;
  return new Date(instant).toISOString();
}

export function createSandbox(config: SandboxConfig | SandboxProviderConfig = {}): Sandbox {
  if (!config || typeof config !== 'object') throw invalid('createSandbox requires Sandbox settings');
  const timeoutSeconds = config.timeoutSeconds === undefined ? 3600 : config.timeoutSeconds;
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 60) {
    throw invalid('sandbox.timeoutSeconds must be a safe integer of at least 60');
  }
  const handle = Object.freeze({}) as Sandbox;
  if ('provider' in config) {
    const { provider } = config;
    if (Object.keys(config).some(key => !['provider', 'timeoutSeconds'].includes(key)) ||
        !validId(provider?.id) || typeof provider.version !== 'string' || !provider.version ||
        !provider.capabilities || typeof provider.preflight !== 'function' || typeof provider.openManager !== 'function' ||
        typeof provider.prepareSandbox !== 'function' || (provider.capabilities.sharedWorkspace &&
          (typeof provider.createSharedWorkspace !== 'function' || typeof provider.deleteSharedWorkspace !== 'function'))) {
      throw invalid('Sandbox Provider requires a stable identity, capabilities and the lifecycle operations');
    }
    sandboxes.set(handle, Object.freeze({ provider: adaptSandboxProvider(provider),
      sandbox: Object.freeze({ timeoutSeconds }), isolation: Object.freeze({ network: 'provider' as const }) }));
    return handle;
  }
  if ((config.kind !== undefined && config.kind !== 'opensandbox') ||
      Object.keys(config).some(key => !['kind', 'endpoint', 'lifecycleBaseUrl', 'apiKey', 'execdToken', 'endpointHost', 'useServerProxy', 'egressMode',
        'resourceLimits', 'resourceRequests', 'commandTimeoutMs', 'timeoutSeconds', 'isolation'].includes(key))) {
    throw invalid('createSandbox requires an OpenSandbox configuration with only Sandbox settings');
  }
  const { kind: _kind, isolation, ...sandbox } = config;
  if (isolation !== undefined && (!isolation || typeof isolation !== 'object' ||
      Object.keys(isolation).some(key => key !== 'network' && key !== 'disk'))) throw invalid('Unknown OpenSandbox isolation field');
  if (isolation?.disk?.inodes !== undefined) {
    throw invalid('OpenSandbox cannot enforce the legacy Workspace inode quota. Remove the request or use a trusted Provider that enforces it.');
  }
  if (isolation?.disk !== undefined) {
    throw invalid('OpenSandbox cannot enforce the legacy exact Workspace byte quota. File transfer budgets and volume capacity have different scopes.');
  }
  if (isolation?.network === 'local-docker') {
    throw invalid('local-docker was removed. Configure OpenSandbox egress dns+nft for Profile network policies and remove isolation.network.');
  }
  if (isolation?.network !== undefined && isolation.network !== 'api') throw invalid('Unknown OpenSandbox isolation policy');
  if (sandbox.egressMode !== undefined && sandbox.egressMode !== 'dns+nft') throw invalid('Only dns+nft supports the requested IP and port allowlist');
  for (const [name, quantities] of Object.entries({ resourceLimits: sandbox.resourceLimits, resourceRequests: sandbox.resourceRequests })) {
    if (quantities === undefined) continue;
    const { cpu, memory } = quantities ?? {};
    if (typeof cpu !== 'string' || !/^(?:\d+(?:\.\d+)?|\d+m)$/.test(cpu) || !(Number.parseFloat(cpu) > 0) || !Number.isFinite(Number.parseFloat(cpu)) ||
        typeof memory !== 'string' || !/^[1-9]\d*(?:[kmgt](?:i|b)?|b)?$/i.test(memory)) {
      throw invalid(`OpenSandbox ${name} require positive CPU and memory quantities, for example 500m and 512Mi`);
    }
  }
  const { lifecycleBaseUrl: _alias, endpoint: _endpoint, endpointHost: _endpointHost, ...settings } = sandbox;
  const { lifecycleBaseUrl, apiKey, publicUrl, advertiseHost, useServerProxy, egressMode } = resolveSandboxConnection(sandbox);
  sandboxes.set(handle, freeze(structuredClone({
    sandbox: { ...settings, lifecycleBaseUrl, apiKey, publicUrl, advertiseHost, useServerProxy, egressMode, timeoutSeconds },
    isolation: { network: 'api' } as const,
  })));
  return handle;
}

export function claimOpenSandboxBackend(handle: Sandbox, options: Pick<CreateRuntimeOptions, 'models' | 'executor' | 'connection' | 'filePolicy'>): ResolvedOpenSandboxBackendConfig {
  const settings = sandboxes.get(handle);
  if (!settings) throw invalid('A createSandbox handle is required');
  const { executor, models, connection } = options;
  const driver = selectExecutorDriver(executor);
  const gateway = connection?.modelGateway;
  const legacyUrls = [connection?.bridge?.publicUrl, gateway?.publicUrl].filter((url): url is string => url !== undefined);
  const explicitUrls = [connection?.publicUrl, ...legacyUrls].filter((url): url is string => url !== undefined);
  const candidates = new Set(explicitUrls.map(normalizeRuntimePublicUrl));
  if (candidates.size > 1) throw invalid('Bridge and Model Gateway must use the same connection.publicUrl');
  const hosts = new Set([connection?.bindHost, connection?.bridge?.host, gateway?.host].filter(host => host !== undefined));
  if (hosts.size > 1) throw invalid('Bridge and Model Gateway must use the same connection.bindHost');
  const port = connection?.bindPort ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw invalid('connection.bindPort must be from 0 through 65535');
  const advertiseHost = connection?.advertiseHost ?? gateway?.advertiseHost ?? settings.sandbox.advertiseHost ??
    ((settings.sandbox.lifecycleBaseUrl && loopbackLifecycle(settings.sandbox.lifecycleBaseUrl)) || settings.provider ? '172.17.0.1' : undefined);
  const savedPublicUrl = settings.sandbox.publicUrl;
  const advertised = [...candidates][0] ?? savedPublicUrl;
  if (!advertised && !advertiseHost) throw invalid('For an existing remote OpenSandbox, set connection.publicUrl to the Runtime address reachable from the Sandbox');
  const workerHost = advertiseHost ?? new URL(advertised!).hostname.replace(/^\[|\]$/g, '');
  if (!/^[a-zA-Z0-9.:-]+$/.test(workerHost) || ['localhost', '0.0.0.0', '::'].includes(workerHost) && !advertised) {
    throw invalid('connection.advertiseHost requires a Sandbox-reachable host');
  }
  const urlHost = workerHost.includes(':') ? `[${workerHost}]` : workerHost;
  const publicUrl = advertised ?? `http://${urlHost}:{port}`;
  const host = [...hosts][0] ?? '0.0.0.0';
  const requestLimit = gateway?.maxRequests;
  if (requestLimit !== undefined && (!Number.isSafeInteger(requestLimit) || requestLimit < 1)) {
    throw invalid('modelGateway.maxRequests must be a positive safe integer');
  }
  const outputPolicy = gateway?.maxOutputTokens === undefined ? driver.defaultMaxOutputTokens : gateway.maxOutputTokens;
  if (outputPolicy !== undefined && outputPolicy !== null && (!Number.isSafeInteger(outputPolicy) || outputPolicy < 16)) {
    throw invalid('modelGateway.maxOutputTokens must be null or a safe integer of at least 16');
  }
  if (!models || !Object.keys(models).length) throw invalid('At least one model alias is required');
  const routes = Object.freeze(Object.fromEntries(Object.entries(models).map(([alias, model]) => {
    const settings = snapshotModel(model, driver.kind);
    const protocol = typeof settings.protocol === 'object' ? settings.protocol.id : settings.protocol ?? 'responses';
    if (driver.adapter && !driver.adapter.modelProtocols.includes(protocol)) {
      throw invalid(`Executor ${driver.kind} does not support model protocol ${protocol}`);
    }
    return [alias, settings];
  })));
  const snapshot = freeze(structuredClone({
    callback: { host, port, publicUrl },
    bridge: { host, publicUrl },
    modelGateway: { requestTimeoutMs: gateway?.requestTimeoutMs, host, advertiseHost: workerHost, publicUrl, maxOutputTokens: outputPolicy, maxRequests: requestLimit },
  }));
  return Object.freeze({ ...settings, ...snapshot, models: routes, driver, filePolicy: resolveFilePolicy(options.filePolicy) });
}

export async function openOpenSandboxBackend(config: ResolvedOpenSandboxBackendConfig, {
  runtimeId, outputDir, bridge, modelAccess, registerPrivateValues = () => {}, durability, providers = [config.provider ?? createApiOpenSandboxProvider(config)],
}: BackendOptions) {
  const { driver } = config;
  const ledger = durability?.ledger;
  const controllerEpoch = ledger?.run.controllerEpoch;
  const agents = new Map<string, BackendAgent>();
  const workspaces = new Map<string, WorkspaceOwners>();
  const targets = [...providers];
  if (!targets.length || targets.some(target => !validId(target.id)) || new Set(targets.map(target => target.id)).size !== targets.length) {
    throw invalid('OpenSandbox targets require distinct service identities');
  }
  await Promise.all(targets.map(target => target.preflight?.()));
  let closing = false;
  let nextTarget = 0;
  const lifetimeMs = (config.sandbox.timeoutSeconds ?? 3600) * 1000;
  const renewalLeadMs = Math.min(300_000, Math.max(20_000, Math.floor(lifetimeMs / 3)));
  const retentionMs = Math.min(300_000, durability?.retainForMs ?? 300_000);
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  const periodicRenewals = new Set<Promise<void>>();
  const renewConcurrency = durability?.renewConcurrency ?? 1;
  let eventReads = 0;

  function scheduleLeases() {
    clearTimeout(leaseTimer);
    if (closing || periodicRenewals.size >= renewConcurrency) return;
    let next = Infinity;
    for (const agent of agents.values()) {
      if (agent.lease && !agent.lease.work && !agent.deleting && agent.manager.renewExecution && shouldRenew(agent)) {
        next = Math.min(next, agent.lease.dueAt);
      }
    }
    if (next !== Infinity) {
      leaseTimer = setTimeout(() => {
        const now = Date.now();
        for (const due of agents.values()) {
          if (periodicRenewals.size >= renewConcurrency) break;
          if (!due.lease || due.lease.dueAt > now || due.lease.work || due.deleting ||
              !due.manager.renewExecution || !shouldRenew(due)) continue;
          const requested = due.retainUntil ? Math.min(now + lifetimeMs, Date.parse(due.retainUntil)) : now + lifetimeMs;
          const work = renewLease(due, requested);
          if (!work) continue;
          periodicRenewals.add(work);
          void work.finally(() => {
            periodicRenewals.delete(work);
            scheduleLeases();
          });
        }
        scheduleLeases();
      }, Math.min(2_147_483_647, Math.max(1, next - Date.now()))).unref();
    }
  }

  function shouldRenew(agent: BackendAgent) {
    if (!agent.retainUntil) return true;
    const deadline = Date.parse(agent.retainUntil);
    return deadline > Date.now() && (!agent.lease?.expiresAt || Date.parse(agent.lease.expiresAt) < deadline);
  }

  function renewLease(agent: BackendAgent, minimum: number) {
    const { lease, manager } = agent;
    if (!lease || !manager.renewExecution || agent.deleting) return;
    if (lease.work) return lease.work;
    lease.work = Promise.resolve().then(async () => {
      try {
        const requestedExpiresAt = new Date(minimum).toISOString();
        ledger?.lease(agent.id, { requestedExpiresAt });
        const observation = await manager.renewExecution!(agent.id, minimum);
        const expiresAt = sandboxExpiry(observation.expiresAt);
        if (!expiresAt) throw new Error('OpenSandbox expiry could not be confirmed');
        ledger?.lease(agent.id, { requestedExpiresAt, confirmedExpiresAt: expiresAt });
        lease.expiresAt = expiresAt;
        lease.dueAt = Math.max(Date.now() + 5_000, Date.parse(expiresAt) - renewalLeadMs - (ledger ? Math.random() * 2000 : 0));
        trace(agent, { type: 'sandbox-lease', state: 'observed', sandboxId: observation.sandboxId, expiresAt });
      } catch (error) {
        if (ledger && !(error as { allocationLedger?: boolean }).allocationLedger) {
          try { ledger.lease(agent.id, { requestedExpiresAt: new Date(minimum).toISOString(), confirmedExpiresAt: sandboxExpiry(manager.coreResource(agent.id)?.expiresAt) ?? lease.expiresAt, error: 'unconfirmed' }); }
          catch (writeError) { freezeUnconfirmed(agent, writeError); }
        } else if (ledger) freezeUnconfirmed(agent, error);
        lease.expiresAt = sandboxExpiry(manager.coreResource(agent.id)?.expiresAt) ?? lease.expiresAt;
        lease.dueAt = Date.now() + 5_000;
        trace(agent, { type: 'sandbox-lease', state: 'unconfirmed', expiresAt: lease.expiresAt });
      }
    }).finally(() => {
      lease.work = undefined;
      scheduleLeases();
    });
    return lease.work;
  }

  function trace(agent: BackendAgent, record: Readonly<Record<string, unknown>>) {
    // Trace persistence is observational and cannot fail an Agent's execution.
    try { agent.onTrace?.(record); } catch {}
  }

  function consume(agent: BackendAgent, records: WorkerRecord[]) {
    if (agent.historyLost) return;
    for (const record of records) {
      const sequence = record.worker_sequence;
      if (Number.isSafeInteger(sequence) && sequence <= agent.cursor) continue;
      if (!Number.isSafeInteger(sequence) || sequence !== agent.cursor + 1) {
        agent.historyLost = true;
        agent.eventPoll.stop();
        trace(agent, { type: 'trace-gap', schemaVersion: 1, expectedWorkerSequence: agent.cursor + 1, observedWorkerSequence: sequence });
        agent.onEvent({ type: 'error', error: { code: 'SERVICE_UNAVAILABLE', message: 'Worker event history has a gap', retryable: false }, fatal: true });
        return;
      }
      agent.cursor = sequence;
      if (record.type === 'controller_probe') agent.onEvent({ type: 'workerProbe', requestId: record.traceId });
      if (record.type === 'core_session_ready') {
        if (!isDeepStrictEqual(record.capabilities, driver.capabilities.session) || record.version !== driver.version) {
          agent.onEvent({ type: 'error', error: { code: 'EXECUTOR_CAPABILITY_MISMATCH', message: 'Guest session bridge does not match selected capabilities', retryable: false }, fatal: true });
        } else {
          agent.sessionReady = true;
          agent.loadedResources = Array.isArray(record.resources) ? record.resources : [];
          trace(agent, { type: 'session-resources', executor: driver.kind, version: record.version, resources: agent.loadedResources });
        }
      }
      if (record.type === 'core_before_compact') {
        agent.decisions ??= new Set();
        if (!agent.decisions.has(record.compactionId)) {
          agent.decisions.add(record.compactionId);
          const request = { compactionId: record.compactionId, executionEpoch: record.executionEpoch,
            sessionId: record.sessionId, reason: record.reason, successfulAutoCompactions: record.successfulAutoCompactions };
          void (async () => {
            const decision = agent.stopping || closing ? 'stop' : await agent.beforeCompact?.handler(request) ?? 'allow';
            if (agent.stopping || agent.exited || closing || request.executionEpoch !== (agent.executionEpoch ?? 0)) return;
            const reply = await agent.manager.agentRpc(agent.id, { type: 'core_before_compact_decision', id: `decision-${record.compactionId}`,
              compactionId: record.compactionId, executionEpoch: record.executionEpoch, decision }, { timeoutMs: 10000, since: agent.cursor });
            await observeSessionReply(agent, reply.records ?? []);
            if (decision === 'stop') agent.onEvent({ type: 'session', event: { type: 'policyStop', reason: 'before_compact_stop', compactionId: record.compactionId } });
          })().catch(() => { if (!agent.stopping && !agent.exited && !closing && request.executionEpoch === (agent.executionEpoch ?? 0)) agent.onEvent({ type: 'session', event: { type: 'policyStop', reason: 'compaction_control_unconfirmed', compactionId: record.compactionId } }); });
        }
      }
      if (record.type === 'message_start') {
        agent.activeMessageId = record.messageId ?? randomUUID();
        agent.onEvent({ type: 'session', event: { type: 'messageStart', messageId: agent.activeMessageId, role: record.message?.role } });
      }
      if (record.type === 'message_update') {
        const update = record.assistantMessageEvent;
        if (update?.type === 'text_delta' && typeof update.delta === 'string') {
          agent.activeMessageId ??= record.messageId ?? randomUUID();
          agent.onEvent({ type: 'session', event: { type: 'textDelta', messageId: agent.activeMessageId,
            blockIndex: update.contentIndex ?? 0, delta: update.delta } });
        }
      }
      if (record.type === 'message_end') {
        agent.activeMessageId ??= record.messageId ?? randomUUID();
        agent.onEvent({ type: 'session', event: { type: 'messageEnd', messageId: agent.activeMessageId, message: record.message } });
        agent.activeMessageId = undefined;
      }
      if (['tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'compaction_start', 'compaction_end',
          'auto_compaction_start', 'auto_compaction_end', 'auto_retry_start', 'auto_retry_end', 'queue_update', 'thinking_level_changed', 'summarization_retry_scheduled', 'summarization_retry_attempt_start', 'summarization_retry_finished', 'core_session_event', 'core_context_disposition', 'core_before_compact_result'].includes(record.type)) {
        const { worker_sequence, worker_at, ...native } = record;
        const event = record.type === 'core_session_event' ? record.event : native;
        agent.onEvent({ type: 'session', event });
        trace(agent, { type: 'session-event', event });
        if (record.type === 'core_before_compact_result' && (record.decision === 'stop' || ['timeout', 'failed', 'cancelled'].includes(record.status))) {
          agent.onEvent({ type: 'session', event: { type: 'policyStop', reason: record.reason ?? record.status, compactionId: record.compactionId } });
        }
      }
      if (record.type === 'agent_start') {
        agent.nativeExecuting = true;
        agent.onExecutionStart?.();
        agent.output = '';
        agent.error = null;
        agent.outcome = 'completed';
      }
      if (['agent_start', 'agent_settled', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(record.type)) {
        const { worker_sequence, worker_at, ...event } = record;
        trace(agent, { type: 'native', schemaVersion: 1, workerSequence: worker_sequence,
          ...(worker_at ? { workerAt: worker_at } : {}), eventType: record.type, event,
          ...(record.type === 'agent_settled' ? { outcome: record.aborted ? 'aborted' : agent.outcome ?? 'completed' } : {}) });
      }
      if (record.type === 'message_end' && record.message?.role === 'assistant') {
        const message = record.message;
        agent.output = (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('');
        agent.error = message.stopReason === 'error' || message.stopReason === 'aborted'
          ? { code: 'MODEL_ERROR', message: message.errorMessage ?? message.stopReason, retryable: false } : null;
        agent.outcome = message.stopReason === 'aborted' ? 'aborted' : agent.error ? 'failed' : 'completed';
        if (agent.output) agent.onEvent({ type: 'output', text: agent.output });
      }
      if (record.type === 'agent_settled') {
        agent.nativeExecuting = false;
        const outcome = record.aborted ? 'aborted' : agent.outcome ?? 'completed';
        agent.onEvent({ type: 'settled', outcome, output: agent.output, ...(agent.error ? { error: agent.error } : {}) });
      }
      if (record.type === 'worker_exit') {
        agent.exited = true;
        agent.eventPoll.stop();
        agent.onEvent({ type: 'exit', reason: `${driver.name} exited (${record.code ?? record.signal ?? 'unknown'})`, expected: agent.stopping });
      }
      if (record.type === 'worker_error') agent.onEvent({ type: 'error', error: { code: 'PROCESS_EXITED', message: record.message, retryable: false }, fatal: true });
    }
  }

  function freezeUnconfirmed(agent: BackendAgent, error: unknown) {
    if (agent.historyLost) return;
    agent.historyLost = true;
    agent.eventPoll.stop();
    try { ledger?.transition(agent.id, 'unknown'); } catch {}
    const code = (error as { code?: string })?.code;
    agent.onEvent({ type: 'error', error: { code: code === 'EVENT_GAP' ? code : 'OPERATION_UNKNOWN',
      message: 'Durable Worker control or event continuity could not be confirmed', retryable: false }, fatal: true });
  }

  function useWorkerRecords(agent: BackendAgent, records: WorkerRecord[]) {
    if (!agent.workerIdentity) consume(agent, records);
  }

  function startPolling(agent: BackendAgent) {
    if (agent.workerIdentity) agent.eventPoll.useLongPoll();
    agent.polling = agent.eventPoll.run(signal => readWorkerEvents(agent, signal));
  }

  async function readEventPage(agent: BackendAgent, waitMs: number, signal?: AbortSignal) {
    const identity = agent.workerIdentity!;
    eventReads++;
    const page = await (agent.manager as OpenSandboxManager).readWorkerEvents(agent.id, {
      ...identity, afterSequence: agent.cursor, waitMs, maxRecords: 128, maxBytes: 512_000, signal,
    }).finally(() => { eventReads--; });
    if (signal?.aborted) return false;
    let nativeExecuting: boolean | undefined;
    let sessionResources: unknown[] | undefined;
    const unseen = page.records.filter(record => record.worker_sequence > agent.cursor);
    for (const record of unseen) {
      if (record.type === 'agent_start') nativeExecuting = true;
      if (record.type === 'agent_settled' || record.type === 'worker_exit') nativeExecuting = false;
      if (record.type === 'core_session_ready' && record.version === driver.version &&
          isDeepStrictEqual(record.capabilities, driver.capabilities.session)) {
        sessionResources = Array.isArray(record.resources) ? record.resources : [];
      }
    }
    if (ledger && unseen.length) ledger.commitEvents(agent.id, { ...identity, nativeExecuting, sessionResources,
      events: unseen.map(record => ({ sequence: record.worker_sequence, event: record })) });
    consume(agent, unseen as WorkerRecord[]);
    return page.hasMore;
  }

  async function observeSessionReply(agent: BackendAgent, records: WorkerRecord[]) {
    if (!agent.workerIdentity) { consume(agent, records); return; }
    const sequence = records.at(-1)?.worker_sequence ?? 0;
    for (let page = 0; page < 32 && agent.cursor < sequence; page++) {
      if (!await readEventPage(agent, 0)) break;
    }
    if (agent.cursor < sequence) throw Object.assign(new Error('Session reply event continuity was not confirmed'), { code: 'OPERATION_UNKNOWN' });
  }

  async function readWorkerEvents(agent: BackendAgent, signal: AbortSignal) {
    const since = agent.cursor;
    try {
      if (agent.workerIdentity) {
        const hasMore = await readEventPage(agent, 20_000, signal);
        return !hasMore && since === agent.cursor;
      }
      const result = await agent.manager.agentRpc(agent.id, { type: 'get_state', since },
        { timeoutMs: 2000, transportTimeoutMs: 2000, signal });
      if (signal.aborted) return false;
      consume(agent, result.records ?? []);
      return since === agent.cursor && !agent.nativeExecuting && !agent.pendingInputs && !agent.stopping;
    } catch (caught) {
      const error = caught as Error & { code: string };
      if (!signal.aborted && (error.code === 'EVENT_GAP' || (error as { allocationLedger?: boolean }).allocationLedger)) {
        freezeUnconfirmed(agent, error);
      }
      if (agent.workerIdentity && !signal.aborted) throw error;
      if (!signal.aborted && !agent.stopping) {
        agent.onEvent({ type: 'error', error: { code: error.code ?? 'SERVICE_UNAVAILABLE', message: 'Worker event polling failed', retryable: true }, fatal: false });
      }
      return false;
    }
  }

  function fileOperation(agentId: string, action: 'snapshot', input: FileSnapshotOptions): Promise<WorkerFileSnapshot>;
  function fileOperation(agentId: string, action: 'replace', input: FileReplaceOptions): Promise<WorkerFileReplace>;
  function fileOperation(agentId: string, action: 'snapshot' | 'replace', input: FileSnapshotOptions | FileReplaceOptions) {
    const agent = agents.get(agentId);
    if (!agent || agent.stopping || agent.exited || agent.historyLost || closing) {
      throw Object.assign(new Error('Core Agent is unavailable for file control'), { code: 'NOT_ALLOWED' });
    }
    return action === 'snapshot' ? agent.manager.coreFileOperation(agentId, action, input as FileSnapshotOptions)
      : agent.manager.coreFileOperation(agentId, action, input as FileReplaceOptions);
  }

  return {
    sessionCapabilities(agentId: string) {
      return agents.get(agentId)?.sessionReady ? driver.capabilities.session : undefined;
    },
    async spawn({ agentId, profile, options = {} as SpawnOptions, signal, onEvent, onExecutionStart, onTrace, recordAllocation, beforeCompact }: BackendSpawnOptions) {
      if (closing || signal?.aborted) throw Object.assign(new Error('Backend is closing'), { code: 'NOT_ALLOWED' });
      if (options.forkFrom !== undefined && !driver.capabilities.contextFork) throw Object.assign(new Error('Backend does not support Context Fork'), { code: 'NOT_ALLOWED' });
      let forkSession;
      if (options.forkFrom !== undefined) {
        const source = agents.get(options.forkFrom);
        if (!source || source.stopping || source.exited || source.historyLost) throw Object.assign(new Error('Context Fork source is unavailable'), { code: 'NOT_ALLOWED' });
        forkSession = await source.manager.coreSessionSnapshot(source.id);
        if (source.stopping || source.exited || source.historyLost || signal?.aborted || closing) throw Object.assign(new Error('Context Fork source stopped during capture'), { code: 'NOT_ALLOWED' });
      }
      const workspace = options.workspace;
      let entry = workspace && workspaces.get(workspace.id);
      if (entry?.retiring) {
        await entry.retiring;
        entry = workspaces.get(workspace!.id);
      }
      if (closing || signal?.aborted) throw Object.assign(new Error('Backend is closing'), { code: 'NOT_ALLOWED' });
      const provider = entry?.provider ?? targets[nextTarget];
      if (!entry) nextTarget = (nextTarget + 1) % targets.length;
      if (workspace && provider.capabilities && !provider.capabilities.sharedWorkspace) {
        throw invalid('Live shared workspaces require a trusted Provider with sharedWorkspace support; use files or Services for explicit handoff');
      }
      if (profile.network !== undefined && provider.capabilities && !provider.capabilities.networkAllowlist) {
        throw invalid('The selected Sandbox Provider cannot enforce the requested network allowlist');
      }
      const networkPolicy = provider.id === 'opensandbox' && !config.provider && profile.network
        ? networkAllowlist([await callbackPolicyTarget(bridge.publicUrl), ...profile.network.allow]) : undefined;
      await provider.beforeAllocation?.();
      if (closing || signal?.aborted) throw Object.assign(new Error('Backend is closing'), { code: 'NOT_ALLOWED' });
      const manager = provider.openManager(profile.image);
      const agent: BackendAgent = { id: agentId, provider, manager, onEvent, onExecutionStart, onTrace, cursor: 0, output: '', error: null,
        beforeCompact, stopping: false, exited: false, eventPoll: createWorkerEventPoll(), nativeExecuting: false, pendingInputs: 0 };
      agents.set(agentId, agent);
      if (workspace) {
        if (!entry) {
          entry = { provider, owners: new Set(), ready: provider.createSharedWorkspace(runtimeId, workspace.id) };
          workspaces.set(workspace.id, entry);
        }
        agent.workspace = workspace;
        entry.owners.add(agentId);
        await entry.ready;
        await entry.captureWork;
      }
      const assertOpen = () => {
        if (closing || agent.stopping || signal?.aborted) throw Object.assign(new Error('Agent startup is closing'), { code: 'NOT_ALLOWED' });
      };
      assertOpen();
      const allocation = { providerId: provider.id, resourceKey: agentId };
      const sandbox = await manager.ensureExecution({ executionId: agentId, agentId, timeoutSeconds: config.sandbox.timeoutSeconds ?? 3600, projectQuotaRequired: false, cleanupOnFailure: false, networkPolicy,
        metadata: { runtime_id: runtimeId }, controllerEpoch,
        ...(ledger ? { executionGeneration: 1, onControlCredentials: (privateState: Record<string, unknown>) => ledger.checkpoint(agentId, { privateState }) } : {}),
        onWorkerToken: (token: string) => registerPrivateValues([token]),
        onCreateRejected: () => recordAllocation({ ...allocation, state: 'allocation-rejected', rejection: true }),
        onCreateDispatch: (entry: { timeout_seconds: number }) => recordAllocation({ ...allocation, state: 'allocation-dispatched', timeoutSeconds: entry.timeout_seconds }),
        onCreated: (entry: { sandbox_id: string; expires_at?: string }) => {
          const expiresAt = sandboxExpiry(entry.expires_at);
          agent.lease = { expiresAt, dueAt: expiresAt ? Date.parse(expiresAt) - renewalLeadMs : Date.now() + 5_000 };
          scheduleLeases();
          return recordAllocation({ ...allocation, state: 'allocation-observed', sandboxId: entry.sandbox_id,
            observation: Object.hasOwn(entry, 'expires_at') ? 'create-response' : 'cleanup-lookup', expiresAt });
        },
      });
      assertOpen();
      const identity = { agent_id: agentId, runtime_id: runtimeId, resource_key: agentId };
      const credentials = modelAccess.credentialsForAgent(agentId, profile.model);
      const bridgeCredentials = bridge.credentialsForAgent(agentId);
      registerPrivateValues([...Object.values(credentials.secretEnvironment), ...Object.values(bridgeCredentials.secretEnvironment)]);
      ledger?.checkpoint(agentId, { privateState: { modelToken: credentials.token, bridgeToken: bridgeCredentials.secretEnvironment.MURM_BRIDGE_TOKEN } });
      await provider.prepareSandbox({ sandboxId: sandbox.sandbox_id, agent: identity, bridgeUrl: bridge.publicUrl,
        modelUrl: credentials.baseUrl, additionalEndpoints: profile.network?.allow ?? [], workspace, assertOpen });
      const versions = await manager.agentVersions({ executionId: agentId, executor: driver.kind, externalExecutor: Boolean(driver.adapter) });
      const actualVersion = versions[`${driver.kind}Version`];
      if (!driver.adapter && actualVersion !== driver.version) {
        throw invalid(`Worker has ${driver.kind} ${actualVersion ?? 'unknown'}; selected ${driver.version} within ${driver.compatibleVersions.join(', ')}`);
      }
      assertOpen();
      const model = config.models[profile.model];
      agent.workerStartDispatched = true;
      const startup = await manager.startAgent({ executionId: agentId,
        ...driver.start({ model, baseUrl: credentials.baseUrl, forkSession: Boolean(forkSession) }),
        filePolicy: config.filePolicy,
        controllerSpoolDirectory: outputDir,
        signal,
        executorVersion: driver.version,
        ...(driver.kind === 'pi' ? {
          piSession: { configuration: options.session ?? profile.session ?? {},
            ...(beforeCompact ? { beforeCompact: { timeoutMs: beforeCompact.timeoutMs } } : {}) },
          requirePiSessionProtocol: options.session !== undefined || profile.session !== undefined || beforeCompact !== undefined,
        } : {}),
        systemPrompt: renderStartupPrompt(bridge.visibleServices(profile.services), profile.prompt, driver.kind, model.capabilities?.tools === false ? [] : (options.session ?? profile.session)?.tools),
        systemPromptPath: '/workspace/runtime/profile-prompt.txt', resources: [],
        writable: options.writable ?? profile.writable,
        files: options.files, forkSession, workspace,
        env: { ...(profile.env ?? {}), ...bridgeCredentials.environment, ...credentials.environment },
        secretEnvironment: { ...(options.secretEnv ?? {}), ...bridgeCredentials.secretEnvironment, ...credentials.secretEnvironment },
        requireCoreFileProtocol: true,
        beforeAgentStart: (identity: Record<string, unknown>) => {
          assertOpen();
          if (!ledger) return;
          if (!identity.workerInstanceId || !identity.streamEpoch || identity.controllerEpoch !== controllerEpoch ||
              identity.eventProtocol !== 'murm-events-v1' || identity.controlProtocol !== 'murm-control-v1') {
            throw invalid('Durable Runtime requires a Worker with event and controller recovery support');
          }
          ledger.checkpoint(agentId, { privateState: { workerIdentity: identity } });
          ledger.starting(agentId);
        },
        modelCatalogResource: credentials.catalogResource,
        ...(credentials.catalogContent !== undefined ? { modelCatalogContent: credentials.catalogContent } : {}) });
      if (driver.adapter) {
        const receipt = startup?.backend;
        if (!receipt || !('protocol' in receipt) || receipt.kind !== driver.kind || receipt.version !== driver.version ||
            receipt.protocol !== driver.adapter.protocol || !isDeepStrictEqual(receipt.capabilities, driver.capabilities)) {
          throw Object.assign(new Error('Sandbox Manager did not attest the selected executor version, protocol and capabilities'),
            { code: 'AGENT_STARTUP_CONTRACT' });
        }
      }
      const effective = startup?.isolation;
      if (effective) trace(agent, { type: 'sandbox-isolation', providerId: provider.id,
        sandboxId: sandbox.sandbox_id, effective });
      agent.started = true;
      const readiness = { type: 'get_state', id: `ready-${randomUUID()}` };
      let ready = await manager.agentRpc(agentId, readiness, { timeoutMs: 10_000, since: 0, signal });
      if (ready.state === 'pending') {
        assertOpen();
        ready = await manager.agentRpc(agentId, readiness, { timeoutMs: 40_000, since: 0, signal });
      }
      if (ready.response?.success !== true || ready.response.command !== 'get_state') throw invalid('Executor readiness response was not confirmed');
      const worker = (manager as OpenSandboxManager).workerControl?.(agentId);
      if (worker?.eventProtocol === 'murm-events-v1' && worker.workerInstanceId && worker.streamEpoch) {
        agent.workerIdentity = { workerInstanceId: worker.workerInstanceId, streamEpoch: worker.streamEpoch };
        ledger?.ready(agentId, agent.workerIdentity);
      }
      await observeSessionReply(agent, ready.records ?? []);
      assertOpen();
      if ((options.session || profile.session || beforeCompact) && !agent.sessionReady) throw Object.assign(new Error('Worker does not attest session controls'), { code: 'OPERATION_UNSUPPORTED' });
      startPolling(agent);
      return { ...allocation, sandboxId: sandbox.sandbox_id, versions: {
        ...versions, ...(driver.adapter ? { [`${driver.kind}Version`]: startup?.backend?.version } : {}),
      },
        providerVersion: provider.version, effective, ...(startup?.backend ? { backend: startup.backend } : {}) };
    },
    async recover(record: LedgerAllocation, handlers: Pick<BackendSpawnOptions, 'onEvent' | 'onExecutionStart' | 'onTrace' | 'beforeCompact'>) {
      if (!ledger || controllerEpoch === undefined) throw invalid('Runtime recovery requires an allocation ledger');
      const provider = targets[0];
      await provider.beforeAllocation?.();
      const manager = provider.openManager(record.image) as OpenSandboxManager & SandboxManager;
      const agent: BackendAgent = { id: record.agentId, provider, manager, ...handlers, cursor: record.afterSequence,
        output: '', error: null, stopping: false, exited: false, nativeExecuting: false, pendingInputs: 0, eventPoll: createWorkerEventPoll(),
        executionEpoch: Number(record.publicState?.executionEpoch ?? 0) };
      agents.set(agent.id, agent);
      const identity = { runtimeId, agentId: record.agentId, resourceKey: record.resourceKey, generation: record.executionGeneration };
      const stored = record.privateState ?? {};
      const workerIdentity = stored.workerIdentity as { workerInstanceId: string; streamEpoch: string; controllerEpoch: number } | undefined;
      const reconnect = async () => {
        let row = ledger.get(record.resourceKey);
        if (row.state === 'intent') {
          ledger.rejectCreation(row.resourceKey, 'create-dispatch was never committed');
          return;
        }
        const found = await manager.discoverExecution(identity);
        for (const sandboxId of found) {
          if (sandboxId !== row.sandboxId) ledger.observeResource(row.resourceKey, { sandboxId });
        }
        row = ledger.get(row.resourceKey);
        if (!row.sandboxId || ledger.resources(row.resourceKey).length !== 1) {
          throw Object.assign(new Error('Recovered Sandbox identity is unknown or has duplicates'), { code: 'OPERATION_UNKNOWN' });
        }
        const sandboxId = row.sandboxId;
        let attached;
        try {
          attached = await manager.recoverExecution({
            ...identity, sandboxId, workerToken: stored.workerToken, execdToken: stored.execdToken,
            workerInstanceId: workerIdentity?.workerInstanceId, streamEpoch: workerIdentity?.streamEpoch,
            controllerEpoch, filePolicy: config.filePolicy, controllerSpoolDirectory: outputDir, executionStopped: row.stopConfirmed,
          });
        } catch (error) {
          const details = (error as { details?: { status?: number; stage?: string } }).details;
          if (details?.stage !== 'verify recovered Sandbox' || details.status !== 404) throw error;
          if (row.workerInstanceId) ledger.checkpoint(row.resourceKey, { publicState: { exportSourceAbsent: true } });
          ledger.recordDeletion(row.resourceKey, sandboxId, 'Original authenticated Lifecycle GET returned 404');
          if (!row.stopConfirmed && workerIdentity) throw error;
          if (!row.stopConfirmed) ledger.recordStop(row.resourceKey, sandboxId, 'Worker start was never dispatched');
          return;
        }
        const expiresAt = sandboxExpiry(attached.expiresAt);
        ledger.observePresence(row.resourceKey, sandboxId, expiresAt);
        if (workerIdentity) {
          const observedEpoch = attached.observedControllerEpoch;
          const proposedEpoch = row.privateState?.proposedEpoch;
          const prior = Number(proposedEpoch ?? workerIdentity.controllerEpoch);
          const expectedEpoch = observedEpoch === controllerEpoch && proposedEpoch === controllerEpoch
            ? Number(row.privateState?.proposedExpectedEpoch) : observedEpoch;
          if (!Number.isSafeInteger(expectedEpoch) || observedEpoch > prior || expectedEpoch >= controllerEpoch) {
            throw Object.assign(new Error('Worker controller epoch has conflicting ownership'), { code: 'OPERATION_UNKNOWN' });
          }
          ledger.checkpoint(row.resourceKey, { privateState: { proposedEpoch: controllerEpoch, proposedExpectedEpoch: expectedEpoch } });
          await manager.takeover(row.resourceKey, { requestId: `takeover-${controllerEpoch}`,
            workerInstanceId: workerIdentity.workerInstanceId, expectedEpoch, nextEpoch: controllerEpoch });
          agent.workerIdentity = workerIdentity;
          agent.started = Boolean(row.workerInstanceId && attached.executorStarted);
          agent.workerStartDispatched = true;
          agent.executionStopped = attached.executionStopped;
          if (Array.isArray(stored.sessionResources)) {
            agent.sessionReady = true;
            agent.loadedResources = stored.sessionResources;
          }
        }
        if (row.state === 'ready' && agent.started && !agent.executionStopped && ledger.run.state === 'open') {
          let drained = false;
          for (let pages = 0; pages < 32; pages++) {
            if (!await readEventPage(agent, 0)) {
              drained = true;
              break;
            }
          }
          if (!drained) throw Object.assign(new Error('Worker event backlog exceeded the recovery window'), { code: 'EVENT_GAP' });
        }
        agent.lease = { expiresAt, dueAt: expiresAt ? Date.parse(expiresAt) - renewalLeadMs : Date.now() };
        agent.recovery = undefined;
        agent.uncertain = false;
        if (row.retention) {
          agent.retaining = row.retention.reason as BackendAgent['retaining'];
          agent.retainUntil = row.retention.deadline;
        }
        scheduleLeases();
      };
      agent.recovery = reconnect;
      try { await reconnect(); }
      catch (error) {
        agent.uncertain = true;
        if ((error as { code?: string }).code === 'EVENT_GAP') freezeUnconfirmed(agent, error);
        ledger.retry(record.resourceKey, (error as { code?: string }).code ?? 'SERVICE_UNAVAILABLE', new Date(Date.now() + 5000).toISOString());
      }
      const state = ledger.get(record.resourceKey).state;
      const terminal = state === 'deleted' || state === 'rejected';
      if (terminal) {
        agents.delete(agent.id);
        await manager.close();
      }
      return { available: !agent.uncertain && state === 'ready' && Boolean(agent.workerIdentity) && agent.started === true && !agent.executionStopped,
        executionStopped: terminal || agent.executionStopped === true, terminal };
    },
    resume(agentId: string) {
      const agent = agents.get(agentId)!;
      if (!agent.workerIdentity || agent.uncertain) throw invalid('Worker recovery has not been confirmed');
      ledger?.ready(agentId, agent.workerIdentity);
      startPolling(agent);
    },
    async snapshotFiles(agentId: string, input: FileSnapshotOptions) {
      const agent = agents.get(agentId);
      if (!agent?.workspace) return fileOperation(agentId, 'snapshot', input);
      const workspace = workspaces.get(agent.workspace.id)!;
      const before = workspace.captureWork ?? Promise.resolve();
      const work = before.then(async () => {
        const owners = [...workspace.owners].map(id => agents.get(id));
        if (owners.some(owner => !owner?.started || owner.stopping || owner.exited)) throw Object.assign(new Error('Shared workspace owners are changing'), { code: 'WORKSPACE_BUSY' });
        const fence = randomUUID();
        const paused: BackendAgent[] = [];
        try {
          const results = await Promise.allSettled(owners.map(async owner => {
            paused.push(owner!);
            const reply = await owner!.manager.coreFileOperation(owner!.id, 'pause', { requestId: fence });
            if (reply?.paused !== true || reply.requestId !== fence) throw new Error('Shared writer fence was not confirmed');
          }));
          if (results.some(result => result.status === 'rejected')) {
            throw Object.assign(new Error('Shared workspace writers could not all be paused'), { code: 'WORKSPACE_BUSY' });
          }
          return await fileOperation(agentId, 'snapshot', input);
        } finally {
          await Promise.all(paused.map(owner => owner.manager.coreFileOperation(owner.id, 'resume', { requestId: fence }).catch(() => undefined)));
        }
      });
      workspace.captureWork = work.catch(() => undefined);
      return work;
    },
    replaceFiles(agentId: string, input: FileReplaceOptions) {
      if (agents.get(agentId)?.workspace) throw Object.assign(new Error('File replacement requires a private workDir'), { code: 'NOT_ALLOWED' });
      return fileOperation(agentId, 'replace', input);
    },
    async send(agentId: string, input: string, { mode, inputId, steeringMode, executionEpoch, wakeIfIdle, queryOnly }: { mode: InputMode; inputId: string; steeringMode?: SendOptions['steeringMode']; executionEpoch: number; wakeIfIdle: boolean; queryOnly?: boolean }): Promise<BackendInputReceipt> {
      const agent = agents.get(agentId);
      if (!agent) throw Object.assign(new Error('Agent is unavailable'), { code: 'NOT_ALLOWED' });
      agent.submissions ??= new Map();
      let submission = agent.submissions.get(inputId);
      if (submission && (submission.input !== input || submission.mode !== mode || submission.wakeIfIdle !== wakeIfIdle)) {
        throw Object.assign(new Error('Input identity has different parameters'), { code: 'CONFLICT' });
      }
      if (!submission) {
        if (agent.stopping || agent.exited || agent.historyLost || closing) throw Object.assign(new Error('Agent is unavailable'), { code: 'NOT_ALLOWED' });
        submission = { input, mode, wakeIfIdle, first: !queryOnly };
        agent.submissions.set(inputId, submission);
      }
      if (submission!.receipt) return submission!.receipt;
      if (!submission.work) {
        const dispatch = submission.first;
        const command = wakeIfIdle ? 'prompt' : mode === 'steer' ? 'steer' : 'follow_up';
        submission.first = false;
        agent.pendingInputs++;
        agent.eventPoll.wake();
        submission.work = (async (): Promise<BackendInputReceipt> => {
          let result;
          try {
            // A prior attempt, including a failed socket, can only be queried.
            // Never transparently resubmit an uncertain prompt to the executor.
            result = await agent.manager.agentRpc(agentId, dispatch
              ? { type: command, id: inputId, message: input,
                ...(wakeIfIdle ? { streamingBehavior: mode } : { onlyWhileActive: true }),
                ...(executionEpoch ? { executionEpoch } : {}),
                ...(steeringMode === undefined ? {} : { steeringMode }) }
              : { type: 'get_rpc_result', id: inputId, since: agent.cursor }, { timeoutMs: 30000, since: agent.cursor });
          } catch {
            // Transport status codes also cover Worker-side failures after
            // writing stdin. Only a correlated executor response proves rejection.
            return { status: 'unknown', reason: 'worker-transport' };
          }
          useWorkerRecords(agent, result.records ?? []);
          if (result.response?.id !== inputId || result.response?.command !== command) return {
            status: 'unknown', reason: result.status === 'pending' ? 'worker-pending' : 'worker-uncorrelated-reply',
          };
          if (!wakeIfIdle && result.response.success === false && result.response.code === 'NO_ACTIVE_EXECUTION') {
            submission!.receipt = { status: 'not-accepted', reason: 'idle' };
            return submission!.receipt;
          }
          if (result.response?.success !== true) {
            if (result.response?.success === false) throw Object.assign(new Error(result.response.error ?? 'Executor rejected input'), {
              code: result.response.code === 'NOT_ALLOWED' ? 'NOT_ALLOWED' : 'INVALID_CONTRACT', inputRejected: true,
            });
            return { status: 'unknown', reason: 'worker-prompt-status-missing' };
          }
          const disposition = result.response.data?.disposition;
          if (!(wakeIfIdle ? ['started', 'queued', 'handled'] : ['queued', 'handled']).includes(disposition!)) return { status: 'unknown', reason: 'worker-disposition-missing' };
          submission!.receipt = { status: 'accepted', disposition: disposition! };
          return submission!.receipt;
        })().finally(() => {
          agent.pendingInputs--;
          submission!.work = undefined;
        });
      }
      return submission.work;
    },
    diagnostics() { return { eventReads, renewing: periodicRenewals.size }; },
    async probeWorkerEvent(agentId: string, id: string, timeoutMs: number) {
      const agent = agents.get(agentId);
      if (!agent?.workerIdentity || agent.historyLost || agent.stopping || closing) {
        throw Object.assign(new Error('Worker event probe requires a live cursor stream'), { code: 'NOT_ALLOWED' });
      }
      const reply = await agent.manager.agentRpc(agentId, { type: 'core_event_probe', id }, { timeoutMs });
      if (reply.response?.command !== 'core_event_probe' || reply.response.id !== id || reply.response.success !== true) {
        throw Object.assign(new Error('Worker event probe admission could not be confirmed'), { code: 'OPERATION_UNKNOWN' });
      }
    },
    async sessionCommand(agentId: string, command: string, payload: Record<string, unknown>, query: boolean): Promise<unknown> {
      const agent = agents.get(agentId);
      if (!agent || agent.stopping || agent.exited || agent.historyLost || closing) {
        if (query) return { status: 'unknown' };
        throw Object.assign(new Error('Session is unavailable'), { code: 'SESSION_UNAVAILABLE' });
      }
      if (!agent.sessionReady) throw Object.assign(new Error('Worker does not support session controls'), { code: 'OPERATION_UNSUPPORTED' });
      agent.sessionCommands ??= new Map();
      const id = payload.id as string;
      const previous = agent.sessionCommands.get(id);
      const fingerprint = JSON.stringify(payload);
      if (previous && (previous.command !== command || (!query && previous.fingerprint !== fingerprint))) throw Object.assign(new Error('Session operation identity conflict'), { code: 'CONFLICT' });
      if (!previous && !query) agent.sessionCommands.set(id, { fingerprint, command });
      agent.eventPoll.wake();
      let result;
      try {
        result = await agent.manager.agentRpc(agentId, query ? { type: 'get_rpc_result', id, since: agent.cursor } : { type: command, ...payload }, { timeoutMs: 30000, since: agent.cursor });
        await observeSessionReply(agent, result.records ?? []);
      } catch { return { status: 'unknown' }; }
      const response = result.response;
      if (response?.id !== id || response.command !== command || response.success === undefined) return { status: 'unknown' };
      if (!response.success) throw Object.assign(new Error(response.error ?? 'Executor rejected session operation'), { code: response.code ?? 'INVALID_CONTRACT' });
      const data = response.data;
      if (!data || typeof data !== 'object') return { status: 'unknown' };
      if (command === 'core_context' && ['appended', 'pending-append', 'pending-next-turn', 'started', 'queued'].includes(data.status)) {
        return { ...data, status: 'accepted', disposition: data.status };
      }
      return command === 'core_session_get_state' ? { ...data, loadedResources: agent.loadedResources ?? [] } : data;
    },
    async interrupt(agentId: string, { interruptId, executionEpoch }: { interruptId: string; executionEpoch: number }): Promise<Omit<InterruptReceipt, 'interruptId'>> {
      const agent = agents.get(agentId);
      if (!agent || agent.stopping || agent.exited || agent.historyLost || closing) return { status: 'unknown' };
      agent.executionEpoch = executionEpoch;
      agent.eventPoll.wake();
      const result = await agent.manager.agentRpc(agentId, { type: 'core_interrupt', id: interruptId, executionEpoch },
        { timeoutMs: 30_000, since: agent.cursor });
      useWorkerRecords(agent, result.records ?? []);
      const confirmed = !agent.historyLost && !agent.exited && !agent.stopping && result.response?.id === interruptId &&
        result.response.command === 'core_interrupt' && result.response.success === true;
      if (!confirmed) return { status: 'unknown' };
      const hashes = result.response?.data?.discardedInputHashes;
      return { status: 'interrupted',
        ...(Array.isArray(hashes) && hashes.length && hashes.every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
          ? { discardedInputHashes: hashes } : {}) };
    },
    async stopExecution(agentId: string) {
      const agent = agents.get(agentId);
      if (!agent) return { collectable: false };
      if (agent.recovery) await agent.recovery();
      agent.stopping = true;
      agent.eventPoll.wake();
      const stopped = await agent.manager.stopAgent(agentId, 'SIGTERM', { preserveWorker: true });
      // The built-in manager returns false only before it has dispatched a Worker start.
      if (!stopped && (agent.started || (Boolean(config.provider || ledger) && agent.workerStartDispatched))) {
        throw Object.assign(new Error('Sandbox Provider did not confirm execution stop'), { code: 'SERVICE_UNAVAILABLE', retryable: true });
      }
      agent.executionStopped = true;
      agent.eventPoll.stop();
      await agent.polling;
      if (stopped && agent.started && !agent.exited) {
        agent.exited = true;
        agent.onEvent({ type: 'exit', reason: 'Worker confirmed executor stopped', expected: true });
      }
      // Rejected startup may leave only a partial workDir. An unadmitted
      // Agent has no output to collect, even after the Worker confirms stop.
      return { collectable: stopped && agent.started === true };
    },
    async *collectSession(agentId: string) {
      const agent = agents.get(agentId);
      if (!agent?.executionStopped) throw Object.assign(new Error('Session archive requires confirmed execution stop'), { code: 'NOT_ALLOWED' });
      yield* agent.manager.collectCoreSession(agentId);
    },
    async *collect(agentId: string, specification: NonNullable<Profile['collect']>) {
      const agent = agents.get(agentId);
      if (!agent?.executionStopped) throw Object.assign(new Error('Artifact collection requires confirmed execution stop'), { code: 'NOT_ALLOWED' });
      try { yield* agent.manager.collectCoreFiles(agentId, specification); }
      catch (caught) {
    const error = caught as Error & { code: string };
        const rejected = ['INVALID_CONTRACT', 'NOT_ALLOWED', 'CONFLICT'].includes(error.code);
        throw Object.assign(new Error(rejected ? error.message : 'Worker artifact export could not be confirmed'), {
          code: 'ARTIFACT_EXPORT_FAILED', retryable: !rejected,
        });
      }
    },
    resource(agentId: string) {
      const agent = agents.get(agentId);
      const durableResource = ledger?.healthy ? ledger.get(agentId) : undefined;
      if (!agent && !durableResource) return;
      const resource = agent?.manager.coreResource(agentId) ?? (durableResource && {
        resourceKey: durableResource.resourceKey, sandboxId: durableResource.sandboxId,
        creation: durableResource.managementAbsent ? 'absent' as const : durableResource.sandboxId ? 'created' as const : 'pending' as const,
        executionStopped: durableResource.stopConfirmed, expiresAt: durableResource.expiresAt ?? null,
      });
      return resource && {
        ...resource, providerId: agent?.provider.id ?? durableResource?.providerId,
        ...(agent?.lease ? { expiresAt: agent.lease.expiresAt } : {}),
        ...(agent?.retaining ? { retention: {
          reason: agent.retaining,
          status: agent.retainAtRisk || !agent.lease?.expiresAt || Date.parse(agent.lease.expiresAt) <= Date.now()
            ? 'retain-at-risk' as const : 'retained' as const,
          autoRenewing: !closing && Boolean(agent.lease && agent.manager.renewExecution) && shouldRenew(agent),
          ...(agent.retainUntil ? { deadline: agent.retainUntil, owner: runtimeId } : {}),
        } } : {}),
      };
    },
    retain(agentId: string, reason: NonNullable<BackendAgent['retaining']>, deadline?: string) {
      const agent = agents.get(agentId);
      if (!agent) return;
      agent.retaining = reason;
      agent.retainUntil = deadline;
      scheduleLeases();
    },
    async finishRetention() {
      closing = true;
      clearTimeout(leaseTimer);
      for (const agent of agents.values()) {
        if (!agent.retaining) continue;
        const deadline = agent.retainUntil ? Date.parse(agent.retainUntil) : Date.now() + retentionMs;
        await agent.lease?.work;
        if (deadline > Date.now() && (!agent.lease?.expiresAt || Date.parse(agent.lease.expiresAt) < deadline)) {
          await renewLease(agent, deadline);
        }
        agent.retainAtRisk = !agent.lease?.expiresAt || Date.parse(agent.lease.expiresAt) < deadline;
        trace(agent, { type: 'sandbox-retention', state: agent.retainAtRisk ? 'retain-at-risk' : 'retained',
          reason: agent.retaining, expiresAt: agent.lease?.expiresAt ?? null });
      }
    },
    async destroy(agentId: string) {
      const agent = agents.get(agentId);
      if (!agent) return;
      if (!agent.executionStopped) throw Object.assign(new Error('Sandbox deletion requires confirmed execution stop'), { code: 'NOT_ALLOWED' });
      agent.eventPoll.stop();
      agent.retaining = undefined;
      agent.deleting = true;
      await agent.lease?.work;
      const deletion = await agent.manager.stopExecution(agentId);
      if (deletion === false && agent.manager.coreResource(agentId)?.creation !== 'absent') {
        throw Object.assign(new Error('Sandbox Provider did not confirm deletion'), { code: 'SERVICE_UNAVAILABLE', retryable: true });
      }
      await agent.manager.close?.();
      await agent.polling;
      if (agent.workspace) {
        const workspaceId = agent.workspace.id;
        const entry = workspaces.get(workspaceId)!;
        entry.owners.delete(agentId);
        if (!entry.owners.size) {
          entry.retiring = entry.provider.deleteSharedWorkspace(runtimeId, workspaceId).then(() => workspaces.delete(workspaceId));
          try { await entry.retiring; } catch (error) { entry.retiring = undefined; throw error; }
        }
      }
      agents.delete(agentId);
      scheduleLeases();
    },
    async detach() {
      closing = true;
      clearTimeout(leaseTimer);
      await Promise.allSettled(periodicRenewals);
      for (const agent of agents.values()) agent.eventPoll.stop();
      await Promise.allSettled([...agents.values()].map(async agent => {
        await agent.polling;
        await agent.manager.close?.();
      }));
    },
    async close() {
      closing = true;
      clearTimeout(leaseTimer);
      if (agents.size) throw Object.assign(new Error('Backend still owns Agent resources'), { code: 'CONFLICT' });
    },
  };
}
