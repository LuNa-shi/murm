import type { BeforeCompactDecision, BeforeCompactRequest } from '../session-types.js';
import type { AgentEvent, ErrorInfo, InputMode, InterruptReceipt, Profile, SpawnOptions, SendOptions } from '../types.js';
import type { SessionFork } from '../../../scripts/core-session-fork.js';
import type { createCoreBridge } from '../bridge.js';
import { renderStartupPrompt } from '../startup-prompt.js';
import { snapshotModel, type createCoreModelAccess } from '../model/model-access.js';
import { resolveFilePolicy, type ResolvedFilePolicy } from '../file-policy.js';
import { isSessionQuery } from '../../protocol/session-queries.js';

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
  sessionReads?: Map<string, { fingerprint: string; command: string; result: Promise<unknown> }>;
  decisions?: Set<string>;
  workerStartDispatched?: boolean;
  polling?: Promise<void>;
  submissions?: Map<string, InputSubmission>;
  executionStopped?: boolean;
}

type WorkerRecord = { worker_sequence: number; worker_at?: string; [key: string]: any } & (
  | { type: 'message_end'; message: {
      role: string;
      content?: { type: string; text: string }[];
      stopReason?: string;
      errorMessage?: string;
    } }
  | { type: 'worker_error'; message: string }
  | { type: 'worker_exit'; code?: string | number; signal?: string }
  | { type: 'agent_start' | 'agent_settled'; aborted?: boolean }
  | { type: 'message_start' | 'message_update' | 'core_before_compact' | 'core_before_compact_result' | 'core_context_disposition' | 'core_session_event' | 'core_session_ready' | 'compaction_start' | 'compaction_end' | 'queue_update' | 'thinking_level_changed' | 'summarization_retry_scheduled' | 'summarization_retry_attempt_start' | 'summarization_retry_finished' | 'auto_compaction_start' | 'auto_compaction_end' | 'auto_retry_start' | 'auto_retry_end'; [key: string]: any }
  | { type: 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end';
      toolCallId: string; toolName?: string; args?: unknown; result?: unknown; partialResult?: unknown; isError?: boolean }
);

interface WorkerReply {
  records?: WorkerRecord[];
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
  } | undefined;
  /** Resolve after confirmed deletion or absence. Throw while the deletion outcome is uncertain. */
  stopExecution(agentId: string): Promise<unknown>;
}

interface BackendOptions {
  runtimeId: string;
  outputDir: string;
  bridge: Awaited<ReturnType<typeof createCoreBridge>>;
  modelAccess: Awaited<ReturnType<typeof createCoreModelAccess>>;
  registerPrivateValues?: (values: readonly unknown[]) => void;
  providers?: readonly OpenSandboxProvider[];
}

interface AllocationRecord {
  state: string;
  providerId: string;
  resourceKey: string;
  timeoutSeconds?: number;
  sandboxId?: string;
  observation?: string;
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
import { createWorkerEventPoll } from '../worker-event-poll.js';
import { resolveSandboxConnection } from './sandbox-connection.js';
import { validId } from '../config.js';
import { adaptSandboxProvider, checkLocalWorkspaceQuota, createApiOpenSandboxProvider, createLocalOpenSandboxProvider, type OpenSandboxProvider } from './opensandbox-provider.js';

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

function httpUrl(value: string, label: string) {
  let url;
  try { url = new URL(value); } catch { throw invalid(`${label} must be an HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalid(`${label} must be an HTTP(S) URL without embedded credentials`);
  return url;
}

function sandboxExpiry(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const instant = Date.parse(value);
  const day = value.slice(0, 10);
  const calendar = Date.parse(day);
  if (!Number.isFinite(instant) || !Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 10) !== day) return null;
  return new Date(instant).toISOString();
}

export function createSandbox(config: SandboxConfig | SandboxProviderConfig): Sandbox {
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
      Object.keys(config).some(key => !['kind', 'lifecycleBaseUrl', 'apiKey', 'execdToken', 'endpointHost', 'useServerProxy',
        'resourceLimits', 'commandTimeoutMs', 'timeoutSeconds', 'isolation'].includes(key))) {
    throw invalid('createSandbox requires an OpenSandbox configuration with only Sandbox settings');
  }
  const { kind: _kind, isolation, ...sandbox } = config;
  const url = httpUrl(sandbox.lifecycleBaseUrl, 'sandbox.lifecycleBaseUrl');
  if (url.search || url.hash) throw invalid('sandbox.lifecycleBaseUrl cannot contain a query or fragment');
  if (isolation?.network !== undefined && isolation.network !== 'api' && isolation.network !== 'local-docker') {
    throw invalid('Unsupported OpenSandbox isolation policy');
  }
  if (sandbox.resourceLimits !== undefined) {
    const { cpu, memory } = sandbox.resourceLimits;
    if (typeof cpu !== 'string' || !/^\d+(?:\.\d+)?m?$/.test(cpu) || !(Number.parseFloat(cpu) > 0) || !Number.isFinite(Number.parseFloat(cpu)) ||
        typeof memory !== 'string' || !/^[1-9]\d*(?:[kmgt](?:i|b)?|b)?$/i.test(memory)) {
      throw invalid('OpenSandbox resource limits require positive CPU and memory quantities, for example 500m and 512Mi');
    }
  }
  const disk = isolation?.disk;
  const strict = isolation?.network === 'local-docker' || disk?.inodes !== undefined;
  let effective: SandboxSettings['isolation'] = { network: 'api' };
  if (strict) {
    if (isolation?.network === 'api' || !disk || !Number.isSafeInteger(disk.bytes) || !Number.isSafeInteger(disk.inodes)) {
      throw invalid('Strict local Docker isolation requires explicit disk byte and inode limits');
    }
    const quota = { bytes: disk.bytes, inodes: disk.inodes! };
    try { checkLocalWorkspaceQuota(quota); }
    catch (error) { throw invalid((error as Error).message); }
    effective = { network: 'local-docker', disk: quota };
  } else if (disk !== undefined) {
    throw invalid('The OpenSandbox API policy cannot enforce a workspace disk limit. Select a Provider that implements the requested storage policy.');
  }
  const connection = resolveSandboxConnection(sandbox);
  sandboxes.set(handle, freeze(structuredClone({
    sandbox: { ...sandbox, lifecycleBaseUrl: connection.lifecycleBaseUrl, apiKey: connection.apiKey,
      endpointHost: connection.endpointHost, timeoutSeconds }, isolation: effective,
  })));
  return handle;
}

export function claimOpenSandboxBackend(handle: Sandbox, options: Pick<CreateRuntimeOptions, 'models' | 'executor' | 'connection' | 'filePolicy'>): ResolvedOpenSandboxBackendConfig {
  const settings = sandboxes.get(handle);
  if (!settings) throw invalid('A createSandbox handle is required');
  const { executor, models, connection } = options;
  const driver = selectExecutorDriver(executor);
  const workerHost = connection?.advertiseHost ?? resolveSandboxConnection().advertiseHost ?? '172.17.0.1';
  const urlHost = workerHost.includes(':') ? `[${workerHost}]` : workerHost;
  const publicUrl = connection?.bridge?.publicUrl ?? `http://${urlHost}:{port}`;
  const gateway = connection?.modelGateway;
  const advertiseHost = gateway?.advertiseHost ?? workerHost;
  const publicGateway = gateway?.publicUrl;
  for (const [template, label] of [[publicUrl, 'connection.bridge.publicUrl'], [publicGateway ?? `http://${advertiseHost.includes(':') ? `[${advertiseHost}]` : advertiseHost}:{port}`, 'connection.modelGateway.publicUrl']]) {
    if (!template.includes('{port}')) throw invalid(`${label} must contain {port}`);
    const url = httpUrl(template.replaceAll('{port}', '12345'), label);
    if (url.search || url.hash || ['0.0.0.0', '[::]'].includes(url.hostname)) throw invalid(`${label} requires a reachable origin`);
    if (settings.isolation.network === 'local-docker' &&
        (isIP(url.hostname) !== 4 || url.hostname.startsWith('127.'))) {
      throw invalid('Strict local Docker destinations require concrete non-loopback IPv4 addresses');
    }
  }
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
    bridge: { host: connection?.bridge?.host ?? '0.0.0.0', publicUrl },
    modelGateway: { requestTimeoutMs: gateway?.requestTimeoutMs, host: gateway?.host ?? '0.0.0.0', advertiseHost, publicUrl: publicGateway, maxOutputTokens: outputPolicy, maxRequests: requestLimit },
  }));
  return Object.freeze({ ...settings, ...snapshot, models: routes, driver, filePolicy: resolveFilePolicy(options.filePolicy) });
}

export async function openOpenSandboxBackend(config: ResolvedOpenSandboxBackendConfig, {
  runtimeId, outputDir, bridge, modelAccess, registerPrivateValues = () => {}, providers = [config.provider ?? (
    config.isolation.network === 'local-docker' ? createLocalOpenSandboxProvider(config) : createApiOpenSandboxProvider(config))],
}: BackendOptions) {
  const { driver } = config;
  const agents = new Map<string, BackendAgent>();
  const workspaces = new Map<string, WorkspaceOwners>();
  const targets = [...providers];
  if (!targets.length || targets.some(target => !validId(target.id)) || new Set(targets.map(target => target.id)).size !== targets.length) {
    throw invalid('OpenSandbox targets require distinct service identities');
  }
  await Promise.all(targets.map(target => target.preflight?.()));
  let closing = false;
  let nextTarget = 0;

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
            consume(agent, reply.records ?? []);
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
          agent.activeMessageId ??= randomUUID();
          agent.onEvent({ type: 'session', event: { type: 'textDelta', messageId: record.messageId ?? agent.activeMessageId,
            blockIndex: update.contentIndex ?? 0, delta: update.delta } });
        }
      }
      if (record.type === 'message_end') {
        agent.activeMessageId ??= randomUUID();
        agent.onEvent({ type: 'session', event: { type: 'messageEnd', messageId: record.messageId ?? agent.activeMessageId, message: record.message } });
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

  async function readWorkerEvents(agent: BackendAgent, signal: AbortSignal) {
    const since = agent.cursor;
    try {
      const result = await agent.manager.agentRpc(agent.id, { type: 'get_state', since },
        { timeoutMs: 2000, transportTimeoutMs: 2000, signal });
      if (signal.aborted) return false;
      consume(agent, result.records ?? []);
      return since === agent.cursor && !agent.nativeExecuting && !agent.pendingInputs && !agent.stopping;
    } catch (caught) {
      const error = caught as Error & { code: string };
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
      if (workspace && provider.capabilities && !provider.capabilities.sharedWorkspace) throw invalid('The selected Sandbox Provider does not support live shared workspaces');
      if (profile.network?.allow.length && provider.capabilities && !provider.capabilities.networkAllowlist) {
        throw invalid('The selected Sandbox Provider cannot enforce the requested network allowlist');
      }
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
      const sandbox = await manager.ensureExecution({ executionId: agentId, agentId, timeoutSeconds: config.sandbox.timeoutSeconds ?? 3600, projectQuotaRequired: provider.projectQuotaRequired ?? true, cleanupOnFailure: false,
        metadata: { runtime_id: runtimeId }, onWorkerToken: (token: string) => registerPrivateValues([token]),
        onCreateDispatch: (entry: { timeout_seconds: number }) => recordAllocation({ ...allocation, state: 'allocation-dispatched', timeoutSeconds: entry.timeout_seconds }),
        onCreated: (entry: { sandbox_id: string; expires_at?: string }) => recordAllocation({ ...allocation, state: 'allocation-observed', sandboxId: entry.sandbox_id,
          observation: Object.hasOwn(entry, 'expires_at') ? 'create-response' : 'cleanup-lookup', expiresAt: sandboxExpiry(entry.expires_at) }),
      });
      assertOpen();
      const identity = { agent_id: agentId, runtime_id: runtimeId, resource_key: agentId };
      const credentials = modelAccess.credentialsForAgent(agentId, profile.model);
      const bridgeCredentials = bridge.credentialsForAgent(agentId);
      registerPrivateValues([...Object.values(credentials.secretEnvironment), ...Object.values(bridgeCredentials.secretEnvironment)]);
      const quota = await provider.prepareSandbox({ sandboxId: sandbox.sandbox_id, agent: identity, bridgeUrl: bridge.publicUrl,
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
          requirePiSessionProtocol: options.session !== undefined || beforeCompact !== undefined,
        } : {}),
        systemPrompt: renderStartupPrompt(bridge.visibleServices(profile.services), profile.prompt, driver.kind, model.capabilities?.tools === false ? [] : (options.session ?? profile.session)?.tools),
        systemPromptPath: '/workspace/runtime/profile-prompt.txt', resources: [],
        writable: options.writable ?? profile.writable,
        files: options.files, forkSession, workspace,
        env: { ...(profile.env ?? {}), ...bridgeCredentials.environment, ...credentials.environment },
        secretEnvironment: { ...(options.secretEnv ?? {}), ...bridgeCredentials.secretEnvironment, ...credentials.secretEnvironment },
        requireCoreFileProtocol: true, projectQuota: quota, modelCatalogResource: credentials.catalogResource,
        ...(credentials.catalogContent !== undefined ? { modelCatalogContent: credentials.catalogContent } : {}),
        beforeAgentStart: assertOpen });
      if (driver.adapter) {
        const receipt = startup?.backend;
        if (!receipt || !('protocol' in receipt) || receipt.kind !== driver.kind || receipt.version !== driver.version ||
            receipt.protocol !== driver.adapter.protocol || !isDeepStrictEqual(receipt.capabilities, driver.capabilities)) {
          throw Object.assign(new Error('Sandbox Manager did not attest the selected executor version, protocol and capabilities'),
            { code: 'AGENT_STARTUP_CONTRACT' });
        }
      }
      const effective = startup?.isolation || quota ? {
        ...startup?.isolation,
        ...(quota ? { disk: { ...quota, scope: 'workspace' as const } } : {}),
      } : undefined;
      if (effective) trace(agent, { type: 'sandbox-isolation', providerId: provider.id,
        sandboxId: sandbox.sandbox_id, effective });
      agent.started = true;
      const ready = await manager.agentRpc(agentId, { type: 'get_state', id: `ready-${randomUUID()}` }, { timeoutMs: 10_000, since: 0 });
      if (ready.response?.success !== true || ready.response.command !== 'get_state') throw invalid('Executor readiness response was not confirmed');
      consume(agent, ready.records ?? []);
      assertOpen();
      if ((options.session || beforeCompact) && !agent.sessionReady) throw Object.assign(new Error('Worker does not attest session controls'), { code: 'OPERATION_UNSUPPORTED' });
      agent.polling = agent.eventPoll.run(signal => readWorkerEvents(agent, signal));
      return { ...allocation, sandboxId: sandbox.sandbox_id, versions: {
        ...versions, ...(driver.adapter ? { [`${driver.kind}Version`]: startup?.backend?.version } : {}),
      },
        providerVersion: provider.version, effective, ...(startup?.backend ? { backend: startup.backend } : {}) };
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
    async send(agentId: string, input: string, { mode, inputId, steeringMode, executionEpoch, wakeIfIdle }: { mode: InputMode; inputId: string; steeringMode?: SendOptions['steeringMode']; executionEpoch: number; wakeIfIdle: boolean }): Promise<BackendInputReceipt> {
      const agent = agents.get(agentId);
      if (!agent) throw Object.assign(new Error('Agent is unavailable'), { code: 'NOT_ALLOWED' });
      agent.submissions ??= new Map();
      let submission = agent.submissions.get(inputId);
      if (submission && (submission.input !== input || submission.mode !== mode || submission.wakeIfIdle !== wakeIfIdle)) {
        throw Object.assign(new Error('Input identity has different parameters'), { code: 'CONFLICT' });
      }
      if (!submission) {
        if (agent.stopping || agent.exited || agent.historyLost || closing) throw Object.assign(new Error('Agent is unavailable'), { code: 'NOT_ALLOWED' });
        submission = { input, mode, wakeIfIdle, first: true };
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
          consume(agent, result.records ?? []);
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
    async sessionCommand(agentId: string, command: string, payload: Record<string, unknown>, query: boolean): Promise<unknown> {
      const agent = agents.get(agentId);
      if (!agent || agent.stopping || agent.exited || agent.historyLost || closing) {
        if (query) return { status: 'unknown' };
        throw Object.assign(new Error('Session is unavailable'), { code: 'SESSION_UNAVAILABLE' });
      }
      if (!agent.sessionReady) throw Object.assign(new Error('Worker does not support session controls'), { code: 'OPERATION_UNSUPPORTED' });
      const id = payload.id as string;
      const fingerprint = JSON.stringify(payload);
      const mutation = agent.sessionCommands?.get(id);
      const read = agent.sessionReads?.get(id);
      const previous = read ?? mutation;
      if (previous && (previous.command !== command || previous.fingerprint !== fingerprint)) {
        throw Object.assign(new Error('Session operation identity conflict'), { code: 'CONFLICT' });
      }
      if (isSessionQuery(command)) {
        if (read) return read.result;
        const reads = agent.sessionReads ??= new Map();
        if (reads.size >= 64) throw Object.assign(new Error('Session read capacity reached'), { code: 'CAPACITY_EXCEEDED' });
        const result = execute().finally(() => reads.delete(id));
        reads.set(id, { fingerprint, command, result });
        return result;
      }
      if (!mutation && !query) (agent.sessionCommands ??= new Map()).set(id, { fingerprint, command });
      return execute();

      async function execute() {
        agent!.eventPoll.wake();
        let result;
        try {
          result = await agent!.manager.agentRpc(agentId, query ? { type: 'get_rpc_result', id, since: agent!.cursor } : { type: command, ...payload }, { timeoutMs: 30_000, since: agent!.cursor });
        } catch { return { status: 'unknown' }; }
        consume(agent!, result.records ?? []);
        const response = result.response;
        if (response?.id !== id || response.command !== command || response.success === undefined) return { status: 'unknown' };
        if (!response.success) throw Object.assign(new Error(response.error ?? 'Executor rejected session operation'), { code: response.code ?? 'INVALID_CONTRACT' });
        const data = response.data;
        if (!data || typeof data !== 'object') return { status: 'unknown' };
        if (command === 'core_context' && ['appended', 'pending-append', 'pending-next-turn', 'started', 'queued'].includes(data.status)) {
          return { ...data, status: 'accepted', disposition: data.status };
        }
        return command === 'core_session_get_state' ? { ...data, loadedResources: agent!.loadedResources ?? [] } : data;
      }
    },
    async interrupt(agentId: string, { interruptId, executionEpoch }: { interruptId: string; executionEpoch: number }): Promise<Omit<InterruptReceipt, 'interruptId'>> {
      const agent = agents.get(agentId);
      if (!agent || agent.stopping || agent.exited || agent.historyLost || closing) return { status: 'unknown' };
      agent.executionEpoch = executionEpoch;
      agent.eventPoll.wake();
      const result = await agent.manager.agentRpc(agentId, { type: 'core_interrupt', id: interruptId, executionEpoch },
        { timeoutMs: 30_000, since: agent.cursor });
      consume(agent, result.records ?? []);
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
      agent.stopping = true;
      agent.eventPoll.wake();
      const stopped = await agent.manager.stopAgent(agentId, 'SIGTERM', { preserveWorker: true });
      // The built-in manager returns false only before it has dispatched a Worker start.
      if (!stopped && (agent.started || (config.provider && agent.workerStartDispatched))) {
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
      if (!agent) return;
      const resource = agent.manager.coreResource(agentId);
      return resource && { ...resource, providerId: agent.provider.id };
    },
    async destroy(agentId: string) {
      const agent = agents.get(agentId);
      if (!agent) return;
      if (!agent.executionStopped) throw Object.assign(new Error('Sandbox deletion requires confirmed execution stop'), { code: 'NOT_ALLOWED' });
      agent.eventPoll.stop();
      const deletion = await agent.manager.stopExecution(agentId);
      if (config.provider && deletion === false && agent.manager.coreResource(agentId)?.creation !== 'absent') {
        throw Object.assign(new Error('Sandbox Provider did not confirm deletion'), { code: 'SERVICE_UNAVAILABLE', retryable: true });
      }
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
    },
    async close() {
      closing = true;
      if (agents.size) throw Object.assign(new Error('Backend still owns Agent resources'), { code: 'CONFLICT' });
    },
  };
}
