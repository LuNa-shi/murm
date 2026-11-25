import type { BotEvent, ErrorInfo, FileSnapshot, InputMode, InterruptReceipt, Profile, SpawnOptions, SteerOptions } from './types.js';
import type { SessionFork } from '../../scripts/core-session-fork.js';
import type { createCoreBridge } from './bridge.js';
import { renderStartupPrompt } from './startup-prompt.js';
import type { createCoreModelAccess } from './model-access.js';

export type BackendEvent = {
  [Kind in BotEvent['type']]: Omit<Extract<BotEvent, { type: Kind }>, 'botId' | 'seq'>
}[BotEvent['type']];

export type BackendInputReceipt =
  | { status: 'unknown'; reason: string }
  | { status: 'accepted'; disposition: 'started' | 'queued' | 'handled' };

interface InputSubmission {
  input: string;
  mode: InputMode;
  first: boolean;
  receipt?: Extract<BackendInputReceipt, { status: 'accepted' }>;
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

interface BackendBot {
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
  pollController: AbortController;
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
    data?: { disposition?: 'started' | 'queued' | 'handled' };
  };
  status?: string;
}

interface SandboxManager {
  agentRpc(botId: string, input: Record<string, unknown>, options: { timeoutMs: number; since?: number }): Promise<WorkerReply>;
  coreFileOperation(botId: string, action: 'snapshot', input: SnapshotOptions): Promise<Omit<FileSnapshot, 'botId'>>;
  coreFileOperation(botId: string, action: 'prepare' | 'grant', input: unknown): Promise<{ version: number; digest: string; writable?: boolean }>;
  coreFileOperation(botId: string, action: 'pause' | 'resume', input: { requestId: string }): Promise<{ paused: boolean; requestId: string }>;
  coreSessionSnapshot(botId: string): Promise<SessionFork>;
  collectCoreSession(botId: string): AsyncIterable<import('./artifact-collection.js').ArtifactRecord>;
  ensureExecution(options: Record<string, unknown>): Promise<{ sandbox_id: string }>;
  agentVersions(options: { executionId: string }): Promise<{ piVersion?: string; [key: string]: unknown }>;
  startAgent(options: Record<string, unknown>): Promise<unknown>;
  stopAgent(botId: string, signal: string, options: { preserveWorker: boolean }): Promise<boolean>;
  collectCoreFiles(botId: string, specification: NonNullable<Profile['collect']>): AsyncIterable<import('./artifact-collection.js').ArtifactRecord>;
  coreResource(botId: string): {
    resourceKey: string;
    sandboxId?: string;
    creation: 'created' | 'pending' | 'absent';
    executionStopped: boolean;
  } | undefined;
  stopExecution(botId: string): Promise<unknown>;
}

interface SandboxManagerConstructor {
  new (options: PiOpenSandboxBackendConfig['sandbox'] & { image: string }): SandboxManager;
}

interface BotNetwork {
  isolate(options: {
    sandboxId: string;
    bot: { bot_id: string; runtime_id: string; resource_key: string };
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
  botId: string;
  profile: Profile;
  options?: SpawnOptions;
  signal?: AbortSignal;
  onEvent(event: BackendEvent): void;
  onExecutionStart?: () => void;
  recordAllocation(record: AllocationRecord): void;
}

import type { Backend } from './types.js';
import type { PiOpenSandboxBackendConfig } from './backend-config.js';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenSandboxManager } from '../runtime/opensandbox-manager.js';
import { DockerBotNetwork } from '../runtime/docker-bot-network.js';
import { DockerBotDisk } from '../runtime/docker-bot-disk.js';

const handles = new WeakMap<Backend, { config: PiOpenSandboxBackendConfig; claimed: boolean }>();

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

export function createPiOpenSandboxBackend(config: PiOpenSandboxBackendConfig): Backend {
  if (config?.isolation?.network !== 'local-docker') throw invalid('Pi/OpenSandbox requires local-docker isolation');
  httpUrl(config.sandbox?.lifecycleBaseUrl, 'sandbox.lifecycleBaseUrl');
  const timeoutSeconds = config.sandbox.timeoutSeconds === undefined ? 3600 : config.sandbox.timeoutSeconds;
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 60) throw invalid('sandbox.timeoutSeconds must be a safe integer of at least 60');
  if (typeof config.bridge?.host !== 'string' || !config.bridge.publicUrl?.includes('{port}')) throw invalid('Bridge host and publicUrl with {port} are required');
  httpUrl(config.bridge.publicUrl.replaceAll('{port}', '12345'), 'bridge.publicUrl');
  if (typeof config.modelGateway?.host !== 'string' || typeof config.modelGateway.advertiseHost !== 'string') throw invalid('Model gateway host and advertiseHost are required');
  const outputPolicy = config.modelGateway.maxOutputTokens;
  if (outputPolicy !== undefined && outputPolicy !== null && (!Number.isSafeInteger(outputPolicy) || outputPolicy < 16)) {
    throw invalid('modelGateway.maxOutputTokens must be null or a safe integer of at least 16');
  }
  if (!Number.isSafeInteger(config.isolation.disk?.bytes) || !Number.isSafeInteger(config.isolation.disk?.inodes)) throw invalid('Explicit disk byte and inode limits are required');
  try { new DockerBotDisk(config.isolation.disk); } catch (caught) {
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
  handles.set(handle, { config: freeze(structuredClone(config)), claimed: false });
  return handle;
}

export function claimPiOpenSandboxBackend(handle: Backend) {
  const entry = handles.get(handle);
  if (!entry || entry.claimed) throw invalid('A fresh Pi/OpenSandbox backend handle is required');
  entry.claimed = true;
  return entry.config;
}

export async function openPiOpenSandboxBackend(config: PiOpenSandboxBackendConfig, { runtimeId, bridge, modelAccess, registerPrivateValues = () => {} }: BackendOptions) {
  const bots = new Map<string, BackendBot>();
  const workspaces = new Map<string, WorkspaceOwners>();
  let closing = false;
  const network = new DockerBotNetwork() as unknown as BotNetwork;
  const disk = new DockerBotDisk(config.isolation.disk);

  function consume(bot: BackendBot, records: WorkerRecord[]) {
    if (bot.historyLost) return;
    for (const record of records) {
      const sequence = record.worker_sequence;
      if (Number.isSafeInteger(sequence) && sequence <= bot.cursor) continue;
      if (!Number.isSafeInteger(sequence) || sequence !== bot.cursor + 1) {
        bot.historyLost = true;
        bot.onEvent({ type: 'error', error: { code: 'SERVICE_UNAVAILABLE', message: 'Worker event history has a gap', retryable: false }, fatal: true });
        return;
      }
      bot.cursor = sequence;
      if (record.type === 'agent_start') {
        bot.onExecutionStart?.();
        bot.output = '';
        bot.error = null;
        bot.outcome = 'completed';
      }
      if (record.type === 'message_end' && record.message?.role === 'assistant') {
        const message = record.message;
        bot.output = (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('');
        bot.error = message.stopReason === 'error' || message.stopReason === 'aborted'
          ? { code: 'MODEL_ERROR', message: message.errorMessage ?? message.stopReason, retryable: false } : null;
        bot.outcome = message.stopReason === 'aborted' ? 'aborted' : bot.error ? 'failed' : 'completed';
        if (bot.output) bot.onEvent({ type: 'output', text: bot.output });
      }
      if (record.type === 'agent_settled') {
        const outcome = record.aborted ? 'aborted' : bot.outcome ?? 'completed';
        bot.onEvent({ type: 'settled', outcome, output: bot.output, ...(bot.error ? { error: bot.error } : {}) });
      }
      if (record.type === 'worker_exit') {
        bot.exited = true;
        bot.onEvent({ type: 'exit', reason: `Pi exited (${record.code ?? record.signal ?? 'unknown'})`, expected: bot.stopping });
      }
      if (record.type === 'worker_error') bot.onEvent({ type: 'error', error: { code: 'PROCESS_EXITED', message: record.message, retryable: false }, fatal: true });
    }
  }

  async function poll(bot: BackendBot) {
    while (!bot.pollController.signal.aborted && !bot.exited && !bot.historyLost) {
      try {
        const result = await bot.manager.agentRpc(bot.id, { type: 'get_state', since: bot.cursor }, { timeoutMs: 5000 });
        consume(bot, result.records ?? []);
      } catch (caught) {
    const error = caught as Error & { code: string };
        if (!bot.stopping) bot.onEvent({ type: 'error', error: { code: error.code ?? 'SERVICE_UNAVAILABLE', message: 'Worker event polling failed', retryable: true }, fatal: false });
      }
      await delay(100, undefined, { signal: bot.pollController.signal }).catch(() => undefined);
    }
  }

  function fileOperation(botId: string, action: 'snapshot', input: SnapshotOptions): Promise<Omit<FileSnapshot, 'botId'>>;
  function fileOperation(botId: string, action: 'prepare' | 'grant', input: unknown): Promise<{ version: number; digest: string; writable?: boolean }>;
  function fileOperation(botId: string, action: 'snapshot' | 'prepare' | 'grant', input: unknown) {
    const bot = bots.get(botId);
    if (!bot || bot.stopping || bot.exited || bot.historyLost || closing) {
      throw Object.assign(new Error('Core Bot is unavailable for file control'), { code: 'NOT_ALLOWED' });
    }
    return action === 'snapshot' ? bot.manager.coreFileOperation(botId, action, input as SnapshotOptions)
      : bot.manager.coreFileOperation(botId, action, input);
  }

  return {
    async spawn({ botId, profile, options = {} as SpawnOptions, signal, onEvent, onExecutionStart, recordAllocation }: BackendSpawnOptions) {
      if (closing || signal?.aborted) throw Object.assign(new Error('Backend is closing'), { code: 'NOT_ALLOWED' });
      let forkSession;
      if (options.forkFrom !== undefined) {
        const source = bots.get(options.forkFrom);
        if (!source || source.stopping || source.exited || source.historyLost) throw Object.assign(new Error('Context Fork source is unavailable'), { code: 'NOT_ALLOWED' });
        forkSession = await source.manager.coreSessionSnapshot(source.id);
        if (source.stopping || source.exited || source.historyLost || signal?.aborted || closing) throw Object.assign(new Error('Context Fork source stopped during capture'), { code: 'NOT_ALLOWED' });
      }
      const manager = new (OpenSandboxManager as unknown as SandboxManagerConstructor)({ ...config.sandbox, image: profile.image });
      const bot: BackendBot = { id: botId, manager, onEvent, onExecutionStart, cursor: 0, output: '', error: null, stopping: false, exited: false, pollController: new AbortController() };
      bots.set(botId, bot);
      const workspace = options.workspace?.mode !== 'frozen-copy' ? options.workspace : undefined;
      if (workspace) {
        let entry = workspaces.get(workspace.id);
        if (entry?.retiring) { await entry.retiring; entry = workspaces.get(workspace.id); }
        if (!entry) {
          entry = { owners: new Set(), ready: disk.sharedWorkspace('create', { runtimeId, workspaceId: workspace.id }) };
          workspaces.set(workspace.id, entry);
        }
        bot.workspace = workspace;
        entry.owners.add(botId);
        await entry.ready;
        await entry.captureWork;
      }
      const assertOpen = () => {
        if (closing || bot.stopping || signal?.aborted) throw Object.assign(new Error('Bot startup is closing'), { code: 'NOT_ALLOWED' });
      };
      assertOpen();
      const sandbox = await manager.ensureExecution({ executionId: botId, botId, timeoutSeconds: config.sandbox.timeoutSeconds ?? 3600, projectQuotaRequired: true, cleanupOnFailure: false,
        metadata: { runtime_id: runtimeId }, onWorkerToken: (token: string) => registerPrivateValues([token]),
        onCreateDispatch: (entry: { timeout_seconds: number }) => recordAllocation({ state: 'allocation-dispatched', timeoutSeconds: entry.timeout_seconds }),
        onCreated: (entry: { sandbox_id: string; expires_at?: string }) => recordAllocation({ state: 'allocation-observed', sandboxId: entry.sandbox_id,
          observation: Object.hasOwn(entry, 'expires_at') ? 'create-response' : 'cleanup-lookup', expiresAt: sandboxExpiry(entry.expires_at) }),
      });
      assertOpen();
      const identity = { bot_id: botId, runtime_id: runtimeId, resource_key: botId };
      const credentials = modelAccess.credentialsForBot(botId, profile.model);
      const bridgeCredentials = bridge.credentialsForBot(botId);
      registerPrivateValues([...Object.values(credentials.secretEnvironment), ...Object.values(bridgeCredentials.secretEnvironment)]);
      await network.isolate({ sandboxId: sandbox.sandbox_id, bot: identity, bridgeUrl: bridge.publicUrl, modelUrl: credentials.baseUrl, additionalEndpoints: profile.network?.allow ?? [] });
      assertOpen();
      const quota = await disk.isolate({ sandboxId: sandbox.sandbox_id, bot: identity });
      if (workspace) await disk.sharedWorkspace('attach', { runtimeId, workspaceId: workspace.id, mode: workspace.mode,
        sandboxId: sandbox.sandbox_id, bot: identity });
      const versions = await manager.agentVersions({ executionId: botId });
      if (versions.piVersion !== '1.3.0') throw invalid('Backend requires Pi 1.3.0');
      assertOpen();
      const model = config.models[profile.model];
      await manager.startAgent({ executionId: botId, command: 'pi',
        args: ['--mode', 'rpc', '--session-dir', '/workspace/runtime/pi-session',
          ...(forkSession ? ['--session', '/workspace/runtime/pi-session/fork.jsonl'] : ['--session-id', randomUUID()]),
          '--tools', 'read,write,edit,bash', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
          '--system-prompt', '/workspace/runtime/profile-prompt.txt', '--provider', model.provider, '--model', model.model],
        systemPrompt: renderStartupPrompt(bridge.visibleServices(profile.services), profile.prompt),
        systemPromptPath: '/workspace/runtime/profile-prompt.txt', resources: [],
        writable: options.writable ?? profile.writable,
        files: options.files, forkSession, workspace,
        env: { ...(profile.env ?? {}), ...bridgeCredentials.environment, ...credentials.environment },
        secretEnvironment: { ...(options.secretEnv ?? {}), ...bridgeCredentials.secretEnvironment, ...credentials.secretEnvironment },
        projectQuota: quota, modelCatalogResource: credentials.catalogResource, beforeAgentStart: assertOpen });
      bot.started = true;
      const ready = await manager.agentRpc(botId, { type: 'get_state', id: `ready-${randomUUID()}` }, { timeoutMs: 10000 });
      if (ready.response?.success !== true || ready.response.command !== 'get_state') throw invalid('Pi readiness response was not confirmed');
      consume(bot, ready.records ?? []);
      assertOpen();
      bot.polling = poll(bot);
      return { sandboxId: sandbox.sandbox_id, versions };
    },
    async snapshotFiles(botId: string, input: SnapshotOptions) {
      const bot = bots.get(botId);
      if (!bot?.workspace) return fileOperation(botId, 'snapshot', input);
      const workspace = workspaces.get(bot.workspace.id)!;
      const before = workspace.captureWork ?? Promise.resolve();
      const work = before.then(async () => {
        const owners = [...workspace.owners].map(id => bots.get(id));
        if (owners.some(owner => !owner?.started || owner.stopping || owner.exited)) throw Object.assign(new Error('Shared workspace owners are changing'), { code: 'WORKSPACE_BUSY' });
        const fence = randomUUID();
        const paused: BackendBot[] = [];
        try {
          const results = await Promise.allSettled(owners.map(async owner => {
            paused.push(owner!);
            const reply = await owner!.manager.coreFileOperation(owner!.id, 'pause', { requestId: fence });
            if (reply?.paused !== true || reply.requestId !== fence) throw new Error('Shared writer fence was not confirmed');
          }));
          if (results.some(result => result.status === 'rejected')) {
            throw Object.assign(new Error('Shared workspace writers could not all be paused'), { code: 'WORKSPACE_BUSY' });
          }
          return await fileOperation(botId, 'snapshot', input);
        } finally {
          await Promise.all(paused.map(owner => owner.manager.coreFileOperation(owner.id, 'resume', { requestId: fence }).catch(() => undefined)));
        }
      });
      workspace.captureWork = work.catch(() => undefined);
      return work;
    },
    prepareFiles(botId: string, input: { version: number; files: NonNullable<SpawnOptions['files']> }) { return fileOperation(botId, 'prepare', input); },
    grantFiles(botId: string, input: { version: number; digest: string }) { return fileOperation(botId, 'grant', input); },
    async send(botId: string, input: string, { mode, inputId, steeringMode, executionEpoch }: { mode: InputMode; inputId: string; steeringMode?: SteerOptions['steeringMode']; executionEpoch?: number }): Promise<BackendInputReceipt> {
      const bot = bots.get(botId);
      if (!bot) throw Object.assign(new Error('Bot is unavailable'), { code: 'NOT_ALLOWED' });
      bot.submissions ??= new Map();
      let submission = bot.submissions.get(inputId);
      if (submission && (submission.input !== input || submission.mode !== mode)) {
        throw Object.assign(new Error('Input identity has different parameters'), { code: 'CONFLICT' });
      }
      if (!submission) {
        if (bot.stopping || bot.exited || bot.historyLost || closing) throw Object.assign(new Error('Bot is unavailable'), { code: 'NOT_ALLOWED' });
        submission = { input, mode, first: true };
        bot.submissions.set(inputId, submission);
      }
      if (submission!.receipt) return submission!.receipt;
      if (!submission.work) {
        const dispatch = submission.first;
        submission.first = false;
        submission.work = (async (): Promise<BackendInputReceipt> => {
          let result;
          try {
            // A prior attempt, including a failed socket, can only be queried.
            // Never transparently resubmit an uncertain prompt to Pi.
            result = await bot.manager.agentRpc(botId, dispatch
              ? { type: 'prompt', id: inputId, message: input, streamingBehavior: mode,
                ...(executionEpoch ? { executionEpoch } : {}),
                ...(steeringMode === undefined ? {} : { steeringMode }) }
              : { type: 'get_rpc_result', id: inputId, since: bot.cursor }, { timeoutMs: 30000, since: bot.cursor });
          } catch {
            // Transport status codes also cover Worker-side failures after
            // writing stdin. Only a correlated Pi response proves rejection.
            return { status: 'unknown', reason: 'worker-transport' };
          }
          consume(bot, result.records ?? []);
          if (result.response?.id !== inputId || result.response?.command !== 'prompt') return {
            status: 'unknown', reason: result.status === 'pending' ? 'worker-pending' : 'worker-uncorrelated-reply',
          };
          if (result.response?.success !== true) {
            if (result.response?.success === false) throw Object.assign(new Error(result.response.error ?? 'Pi rejected input'), {
              code: result.response.code === 'NOT_ALLOWED' ? 'NOT_ALLOWED' : 'INVALID_CONTRACT', inputRejected: true,
            });
            return { status: 'unknown', reason: 'worker-prompt-status-missing' };
          }
          const disposition = result.response.data?.disposition;
          if (!['started', 'queued', 'handled'].includes(disposition!)) return { status: 'unknown', reason: 'worker-disposition-missing' };
          submission!.receipt = { status: 'accepted', disposition: disposition! };
          return submission!.receipt;
        })().finally(() => { submission!.work = undefined; });
      }
      return submission.work;
    },
    async interrupt(botId: string, { interruptId, executionEpoch }: { interruptId: string; executionEpoch: number }): Promise<Pick<InterruptReceipt, 'status'>> {
      const bot = bots.get(botId);
      if (!bot || bot.stopping || bot.exited || bot.historyLost || closing) return { status: 'unknown' };
      const result = await bot.manager.agentRpc(botId, { type: 'core_interrupt', id: interruptId, executionEpoch },
        { timeoutMs: 30_000, since: bot.cursor });
      consume(bot, result.records ?? []);
      const confirmed = !bot.historyLost && !bot.exited && !bot.stopping && result.response?.id === interruptId &&
        result.response.command === 'core_interrupt' && result.response.success === true;
      return { status: confirmed ? 'interrupted' : 'unknown' };
    },
    async stopExecution(botId: string) {
      const bot = bots.get(botId);
      if (!bot) return { collectable: false };
      bot.stopping = true;
      const stopped = await bot.manager.stopAgent(botId, 'SIGTERM', { preserveWorker: true });
      bot.executionStopped = true;
      bot.pollController.abort();
      await bot.polling;
      if (stopped && bot.started && !bot.exited) {
        bot.exited = true;
        bot.onEvent({ type: 'exit', reason: 'Worker confirmed Pi stopped', expected: true });
      }
      return { collectable: stopped };
    },
    async *collectSession(botId: string) {
      const bot = bots.get(botId);
      if (!bot?.executionStopped) throw Object.assign(new Error('Session archive requires confirmed execution stop'), { code: 'NOT_ALLOWED' });
      yield* bot.manager.collectCoreSession(botId);
    },
    async *collect(botId: string, specification: NonNullable<Profile['collect']>) {
      const bot = bots.get(botId);
      if (!bot?.executionStopped) throw Object.assign(new Error('Artifact collection requires confirmed execution stop'), { code: 'NOT_ALLOWED' });
      try { yield* bot.manager.collectCoreFiles(botId, specification); }
      catch (caught) {
    const error = caught as Error & { code: string };
        const rejected = ['INVALID_CONTRACT', 'NOT_ALLOWED', 'CONFLICT'].includes(error.code);
        throw Object.assign(new Error(rejected ? error.message : 'Worker artifact export could not be confirmed'), {
          code: 'ARTIFACT_EXPORT_FAILED', retryable: !rejected,
        });
      }
    },
    resource(botId: string) {
      const bot = bots.get(botId);
      return bot?.manager.coreResource(botId);
    },
    async destroy(botId: string) {
      const bot = bots.get(botId);
      if (!bot) return;
      if (!bot.executionStopped) throw Object.assign(new Error('Sandbox deletion requires confirmed execution stop'), { code: 'NOT_ALLOWED' });
      bot.pollController.abort();
      await bot.manager.stopExecution(botId);
      await bot.polling;
      if (bot.workspace) {
        const workspaceId = bot.workspace.id;
        const entry = workspaces.get(workspaceId)!;
        entry.owners.delete(botId);
        if (!entry.owners.size) {
          entry.retiring = disk.sharedWorkspace('delete', { runtimeId, workspaceId }).then(() => workspaces.delete(workspaceId));
          try { await entry.retiring; } catch (error) { entry.retiring = undefined; throw error; }
        }
      }
      bots.delete(botId);
    },
    async close() {
      closing = true;
      if (bots.size) throw Object.assign(new Error('Backend still owns Bot resources'), { code: 'CONFLICT' });
    },
  };
}
