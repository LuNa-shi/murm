import type { AgentEvent, ErrorInfo, FileSnapshot, InputMode, InterruptReceipt, Profile, SpawnOptions, SendOptions } from './types.js';
import type { SessionFork } from '../../scripts/core-session-fork.js';
import type { createCoreBridge } from './bridge.js';
import { renderStartupPrompt } from './startup-prompt.js';
import type { createCoreModelAccess } from './model-access.js';

export type BackendEvent = {
  [Kind in AgentEvent['type']]: Omit<Extract<AgentEvent, { type: Kind }>, 'agentId' | 'seq'>
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
  owners: Set<string>;
  ready: Promise<void>;
  retiring?: Promise<unknown>;
  captureWork?: Promise<unknown>;
}
type SnapshotOptions = Parameters<import('./types.js').Runtime['files']['snapshot']>[1];

interface BackendAgent {
  workspace?: SharedWorkspace;
  id: string;
  manager: SandboxManager;
  onEvent(event: BackendEvent): void;
  onExecutionStart?: () => void;
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
  polling?: Promise<void>;
  submissions?: Map<string, InputSubmission>;
  executionStopped?: boolean;
}

type WorkerRecord = { worker_sequence: number } & (
  | { type: 'message_end'; message: {
      role: string;
      content?: { type: string; text: string }[];
      stopReason?: string;
      errorMessage?: string;
    } }
  | { type: 'worker_error'; message: string }
  | { type: 'worker_exit'; code?: string | number; signal?: string }
  | { type: 'agent_start' | 'agent_settled'; aborted?: boolean }
);

interface WorkerReply {
  records?: WorkerRecord[];
  response?: {
    id?: string;
    command?: string;
    success?: boolean;
    error?: string;
    code?: string;
    data?: { disposition?: 'started' | 'queued' | 'handled'; discardedInputHashes?: string[] };
  };
  status?: string;
}

interface SandboxManager {
  agentRpc(agentId: string, input: Record<string, unknown>, options: {
    timeoutMs: number; since?: number; transportTimeoutMs?: number; signal?: AbortSignal;
  }): Promise<WorkerReply>;
  coreFileOperation(agentId: string, action: 'snapshot', input: SnapshotOptions): Promise<Omit<FileSnapshot, 'agentId'>>;
  coreFileOperation(agentId: string, action: 'prepare' | 'grant' | 'install' | 'confirm', input: unknown): Promise<{ version: number; digest: string; writable?: boolean }>;
  coreFileOperation(agentId: string, action: 'pause' | 'resume', input: { requestId: string }): Promise<{ paused: boolean; requestId: string }>;
  coreSessionSnapshot(agentId: string): Promise<SessionFork>;
  collectCoreSession(agentId: string): AsyncIterable<import('./artifact-collection.js').ArtifactRecord>;
  ensureExecution(options: Record<string, unknown>): Promise<{ sandbox_id: string }>;
  agentVersions(options: { executionId: string; executor?: 'pi' | 'codex' }): Promise<{ piVersion?: string; [key: string]: unknown }>;
  startAgent(options: Record<string, unknown>): Promise<{ backend?: { kind: 'codex'; version: string; authMode: 'api-key'; threadId: string } } | undefined>;
  stopAgent(agentId: string, signal: string, options: { preserveWorker: boolean }): Promise<boolean>;
  collectCoreFiles(agentId: string, specification: NonNullable<Profile['collect']>): AsyncIterable<import('./artifact-collection.js').ArtifactRecord>;
  coreResource(agentId: string): {
    resourceKey: string;
    sandboxId?: string;
    creation: 'created' | 'pending' | 'absent';
    executionStopped: boolean;
  } | undefined;
  stopExecution(agentId: string): Promise<unknown>;
}

interface SandboxManagerConstructor {
  new (options: OpenSandboxBackendConfig['sandbox'] & { image: string }): SandboxManager;
}

interface AgentNetwork {
  isolate(options: {
    sandboxId: string;
    agent: { agent_id: string; runtime_id: string; resource_key: string };
    bridgeUrl: string;
    modelUrl: string;
    additionalEndpoints: readonly string[];
  }): Promise<void>;
}

interface BackendOptions {
  runtimeId: string;
  outputDir: string;
  bridge: Awaited<ReturnType<typeof createCoreBridge>>;
  modelAccess: Awaited<ReturnType<typeof createCoreModelAccess>>;
  registerPrivateValues?: (values: readonly unknown[]) => void;
}

interface AllocationRecord {
  state: string;
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
  recordAllocation(record: AllocationRecord): void;
}

import type { Backend } from './types.js';
import type { OpenSandboxBackendConfig } from './backend-config.js';
import { selectExecutorDriver, type ExecutorDriver } from './executor-driver.js';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { createWorkerEventPoll } from './worker-event-poll.js';
import { OpenSandboxManager } from '../runtime/opensandbox-manager.js';
import { DockerAgentNetwork } from '../runtime/docker-agent-network.js';
import { DockerAgentDisk } from '../runtime/docker-agent-disk.js';

export type ResolvedOpenSandboxBackendConfig = Omit<OpenSandboxBackendConfig, 'executor'> & { readonly driver: Readonly<ExecutorDriver> };

const handles = new WeakMap<Backend, { config: ResolvedOpenSandboxBackendConfig; claimed: boolean }>();

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

export function createOpenSandboxBackend(config: OpenSandboxBackendConfig): Backend {
  const driver = selectExecutorDriver(config?.executor);
  if (config?.isolation?.network !== 'local-docker') throw invalid('OpenSandbox requires local-docker isolation');
  httpUrl(config.sandbox?.lifecycleBaseUrl, 'sandbox.lifecycleBaseUrl');
  const timeoutSeconds = config.sandbox.timeoutSeconds === undefined ? 3600 : config.sandbox.timeoutSeconds;
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 60) throw invalid('sandbox.timeoutSeconds must be a safe integer of at least 60');
  if (typeof config.bridge?.host !== 'string' || !config.bridge.publicUrl?.includes('{port}')) throw invalid('Bridge host and publicUrl with {port} are required');
  httpUrl(config.bridge.publicUrl.replaceAll('{port}', '12345'), 'bridge.publicUrl');
  if (typeof config.modelGateway?.host !== 'string' || typeof config.modelGateway.advertiseHost !== 'string') throw invalid('Model gateway host and advertiseHost are required');
  const outputPolicy = config.modelGateway.maxOutputTokens === undefined
    ? driver.defaultMaxOutputTokens : config.modelGateway.maxOutputTokens;
  if (outputPolicy !== undefined && outputPolicy !== null && (!Number.isSafeInteger(outputPolicy) || outputPolicy < 16)) {
    throw invalid('modelGateway.maxOutputTokens must be null or a safe integer of at least 16');
  }
  const selectionReasoningEffort = config.modelGateway.selectionReasoningEffort;
  if (selectionReasoningEffort !== undefined && selectionReasoningEffort !== 'low') {
    throw invalid('modelGateway.selectionReasoningEffort must be low when configured');
  }
  if (!Number.isSafeInteger(config.isolation.disk?.bytes) || !Number.isSafeInteger(config.isolation.disk?.inodes)) throw invalid('Explicit disk byte and inode limits are required');
  try { new DockerAgentDisk(config.isolation.disk); } catch (caught) {
    const error = caught as Error & { code: string }; throw invalid(error.message); }
  const bridgeOrigin = httpUrl(config.bridge.publicUrl.replaceAll('{port}', '12345'), 'Bridge origin');
  for (const host of [bridgeOrigin.hostname, config.modelGateway.advertiseHost]) {
    if (isIP(host) !== 4 || host.startsWith('127.') || host === '0.0.0.0') throw invalid('Sandbox destinations require concrete non-loopback IPv4 addresses');
  }
  if (!config.models || !Object.keys(config.models).length) throw invalid('At least one model alias is required');
  for (const model of Object.values(config.models)) {
    if (typeof model.provider !== 'string' || typeof model.model !== 'string') throw invalid('Each model needs provider and model');
    const url = httpUrl(model.upstream?.url, 'model upstream');
    if (!url.pathname.endsWith('/v1/responses')) throw invalid('Model upstream must use /v1/responses');
    if (!model.upstream.headers || typeof model.upstream.headers !== 'object') throw invalid('Model upstream headers are required');
  }
  const handle = Object.freeze({}) as Backend;
  const { executor, ...settings } = config;
  const snapshot = freeze(structuredClone({ ...settings, modelGateway: { ...settings.modelGateway, maxOutputTokens: outputPolicy } }));
  handles.set(handle, { config: Object.freeze({ ...snapshot, driver }), claimed: false });
  return handle;
}

export function getOpenSandboxBackendCapabilities(handle: Backend) {
  const entry = handles.get(handle);
  if (!entry) throw invalid('An OpenSandbox backend handle is required');
  return entry.config.driver.capabilities;
}

export function claimOpenSandboxBackend(handle: Backend) {
  const entry = handles.get(handle);
  if (!entry || entry.claimed) throw invalid('A fresh OpenSandbox backend handle is required');
  entry.claimed = true;
  return entry.config;
}

export async function openOpenSandboxBackend(config: ResolvedOpenSandboxBackendConfig, { runtimeId, bridge, modelAccess, registerPrivateValues = () => {} }: BackendOptions) {
  const { driver } = config;
  const agents = new Map<string, BackendAgent>();
  const workspaces = new Map<string, WorkspaceOwners>();
  let closing = false;
  const network = new DockerAgentNetwork() as unknown as AgentNetwork;
  const disk = new DockerAgentDisk(config.isolation.disk);

  function consume(agent: BackendAgent, records: WorkerRecord[]) {
    if (agent.historyLost) return;
    for (const record of records) {
      const sequence = record.worker_sequence;
      if (Number.isSafeInteger(sequence) && sequence <= agent.cursor) continue;
      if (!Number.isSafeInteger(sequence) || sequence !== agent.cursor + 1) {
        agent.historyLost = true;
        agent.eventPoll.stop();
        agent.onEvent({ type: 'error', error: { code: 'SERVICE_UNAVAILABLE', message: 'Worker event history has a gap', retryable: false }, fatal: true });
        return;
      }
      agent.cursor = sequence;
      if (record.type === 'agent_start') {
        agent.nativeExecuting = true;
        agent.onExecutionStart?.();
        agent.output = '';
        agent.error = null;
        agent.outcome = 'completed';
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

  function fileOperation(agentId: string, action: 'snapshot', input: SnapshotOptions): Promise<Omit<FileSnapshot, 'agentId'>>;
  function fileOperation(agentId: string, action: 'prepare' | 'grant' | 'install' | 'confirm', input: unknown): Promise<{ version: number; digest: string; writable?: boolean }>;
  function fileOperation(agentId: string, action: 'snapshot' | 'prepare' | 'grant' | 'install' | 'confirm', input: unknown) {
    const agent = agents.get(agentId);
    if (!agent || agent.stopping || agent.exited || agent.historyLost || closing) {
      throw Object.assign(new Error('Core Agent is unavailable for file control'), { code: 'NOT_ALLOWED' });
    }
    return action === 'snapshot' ? agent.manager.coreFileOperation(agentId, action, input as SnapshotOptions)
      : agent.manager.coreFileOperation(agentId, action, input);
  }

  return {
    async spawn({ agentId, profile, options = {} as SpawnOptions, signal, onEvent, onExecutionStart, recordAllocation }: BackendSpawnOptions) {
      if (closing || signal?.aborted) throw Object.assign(new Error('Backend is closing'), { code: 'NOT_ALLOWED' });
      if (options.forkFrom !== undefined && !driver.capabilities.contextFork) throw Object.assign(new Error('Backend does not support Context Fork'), { code: 'NOT_ALLOWED' });
      let forkSession;
      if (options.forkFrom !== undefined) {
        const source = agents.get(options.forkFrom);
        if (!source || source.stopping || source.exited || source.historyLost) throw Object.assign(new Error('Context Fork source is unavailable'), { code: 'NOT_ALLOWED' });
        forkSession = await source.manager.coreSessionSnapshot(source.id);
        if (source.stopping || source.exited || source.historyLost || signal?.aborted || closing) throw Object.assign(new Error('Context Fork source stopped during capture'), { code: 'NOT_ALLOWED' });
      }
      const manager = new (OpenSandboxManager as unknown as SandboxManagerConstructor)({ ...config.sandbox, image: profile.image });
      const agent: BackendAgent = { id: agentId, manager, onEvent, onExecutionStart, cursor: 0, output: '', error: null,
        stopping: false, exited: false, eventPoll: createWorkerEventPoll(), nativeExecuting: false, pendingInputs: 0 };
      agents.set(agentId, agent);
      const workspace = options.workspace?.mode !== 'frozen-copy' ? options.workspace : undefined;
      if (workspace) {
        let entry = workspaces.get(workspace.id);
        if (entry?.retiring) { await entry.retiring; entry = workspaces.get(workspace.id); }
        if (!entry) {
          entry = { owners: new Set(), ready: disk.sharedWorkspace('create', { runtimeId, workspaceId: workspace.id }) };
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
      const sandbox = await manager.ensureExecution({ executionId: agentId, agentId, timeoutSeconds: config.sandbox.timeoutSeconds ?? 3600, projectQuotaRequired: true, cleanupOnFailure: false,
        metadata: { runtime_id: runtimeId }, onWorkerToken: (token: string) => registerPrivateValues([token]),
        onCreateDispatch: (entry: { timeout_seconds: number }) => recordAllocation({ state: 'allocation-dispatched', timeoutSeconds: entry.timeout_seconds }),
        onCreated: (entry: { sandbox_id: string; expires_at?: string }) => recordAllocation({ state: 'allocation-observed', sandboxId: entry.sandbox_id,
          observation: Object.hasOwn(entry, 'expires_at') ? 'create-response' : 'cleanup-lookup', expiresAt: sandboxExpiry(entry.expires_at) }),
      });
      assertOpen();
      const identity = { agent_id: agentId, runtime_id: runtimeId, resource_key: agentId };
      const credentials = modelAccess.credentialsForAgent(agentId, profile.model);
      const bridgeCredentials = bridge.credentialsForAgent(agentId);
      registerPrivateValues([...Object.values(credentials.secretEnvironment), ...Object.values(bridgeCredentials.secretEnvironment)]);
      await network.isolate({ sandboxId: sandbox.sandbox_id, agent: identity, bridgeUrl: bridge.publicUrl, modelUrl: credentials.baseUrl, additionalEndpoints: profile.network?.allow ?? [] });
      assertOpen();
      const quota = await disk.isolate({ sandboxId: sandbox.sandbox_id, agent: identity });
      if (workspace) await disk.sharedWorkspace('attach', { runtimeId, workspaceId: workspace.id, mode: workspace.mode,
        sandboxId: sandbox.sandbox_id, agent: identity });
      const versions = await manager.agentVersions({ executionId: agentId, executor: driver.kind });
      if (versions[`${driver.kind}Version`] !== driver.version) throw invalid(`Backend requires ${driver.kind} ${driver.version}`);
      assertOpen();
      const model = config.models[profile.model];
      const startup = await manager.startAgent({ executionId: agentId,
        ...driver.start({ model, baseUrl: credentials.baseUrl, forkSession: Boolean(forkSession) }),
        systemPrompt: renderStartupPrompt(bridge.visibleServices(profile.services), profile.prompt, driver.kind),
        systemPromptPath: '/workspace/runtime/profile-prompt.txt', resources: [],
        writable: options.writable ?? profile.writable,
        files: options.files, forkSession, workspace,
        env: { ...(profile.env ?? {}), ...bridgeCredentials.environment, ...credentials.environment },
        secretEnvironment: { ...(options.secretEnv ?? {}), ...bridgeCredentials.secretEnvironment, ...credentials.secretEnvironment },
        projectQuota: quota, modelCatalogResource: credentials.catalogResource, beforeAgentStart: assertOpen });
      agent.started = true;
      const ready = await manager.agentRpc(agentId, { type: 'get_state', id: `ready-${randomUUID()}` }, { timeoutMs: 10_000, since: 0 });
      if (ready.response?.success !== true || ready.response.command !== 'get_state') throw invalid('Executor readiness response was not confirmed');
      consume(agent, ready.records ?? []);
      assertOpen();
      agent.polling = agent.eventPoll.run(signal => readWorkerEvents(agent, signal));
      return { sandboxId: sandbox.sandbox_id, versions, ...(startup?.backend ? { backend: startup.backend } : {}) };
    },
    async snapshotFiles(agentId: string, input: SnapshotOptions) {
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
    async installFiles(agentId: string, input: any) {
      if (agents.get(agentId)?.workspace) throw Object.assign(new Error('Live install requires a private workDir'), { code: 'NOT_ALLOWED' });
      return await fileOperation(agentId, 'install', input) as any;
    },
    async confirmFiles(agentId: string, input: any) { return await fileOperation(agentId, 'confirm', input) as any; },
    prepareFiles(agentId: string, input: { version: number; files: NonNullable<SpawnOptions['files']> }) { return fileOperation(agentId, 'prepare', input); },
    grantFiles(agentId: string, input: { version: number; digest: string }) { return fileOperation(agentId, 'grant', input); },
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
    async interrupt(agentId: string, { interruptId, executionEpoch }: { interruptId: string; executionEpoch: number }): Promise<Omit<InterruptReceipt, 'interruptId'>> {
      const agent = agents.get(agentId);
      if (!agent || agent.stopping || agent.exited || agent.historyLost || closing) return { status: 'unknown' };
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
      agent.executionStopped = true;
      agent.eventPoll.stop();
      await agent.polling;
      if (stopped && agent.started && !agent.exited) {
        agent.exited = true;
        agent.onEvent({ type: 'exit', reason: 'Worker confirmed executor stopped', expected: true });
      }
      return { collectable: stopped };
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
      return agent?.manager.coreResource(agentId);
    },
    async destroy(agentId: string) {
      const agent = agents.get(agentId);
      if (!agent) return;
      if (!agent.executionStopped) throw Object.assign(new Error('Sandbox deletion requires confirmed execution stop'), { code: 'NOT_ALLOWED' });
      agent.eventPoll.stop();
      await agent.manager.stopExecution(agentId);
      await agent.polling;
      if (agent.workspace) {
        const workspaceId = agent.workspace.id;
        const entry = workspaces.get(workspaceId)!;
        entry.owners.delete(agentId);
        if (!entry.owners.size) {
          entry.retiring = disk.sharedWorkspace('delete', { runtimeId, workspaceId }).then(() => workspaces.delete(workspaceId));
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
