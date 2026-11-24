import type { ServiceRegistry } from './services.js';

declare const backendBrand: unique symbol;

export interface Backend {
  readonly [backendBrand]: true;
}

export interface Profile {
  prompt: string;
  model: string;
  image: string;
  writable: boolean;
  services: Readonly<Record<string, readonly string[]>>;
  spawnProfiles?: readonly string[];
  allowContextFork?: boolean;
  env?: Readonly<Record<string, string>>;
  network?: { allow: readonly string[] };
  collect?: CollectionSpec;
}

export interface ModelCaller {
  readonly runtimeId: string;
  readonly botId: string;
  readonly profile: string;
  readonly model: string;
}

export interface ModelPermit {
  phase: 'selection' | 'work' | 'closeout';
  deadlineAt: number;
  lease?: { key: string; version: number; expiresAt: number };
}

export interface ModelAccessPolicy {
  authorize(caller: ModelCaller): ModelPermit | null;
  withCommit<T>(commit: () => T): T;
}

export interface CreateRuntimeOptions {
  backend: Backend;
  profiles: Readonly<Record<string, Profile>>;
  services: ServiceRegistry;
  maxBots: number;
  outputDir: string;
  modelAccessPolicy?: ModelAccessPolicy;
}

export interface FileEntry {
  encoding: 'utf8' | 'base64';
  data: string;
  mode?: 0o644 | 0o755;
}

export type FileSeed = Readonly<Record<string, FileEntry>>;

export interface CollectionSpec {
  paths: readonly string[];
  includeGit: boolean;
  maxBytes: number;
  required: boolean;
}

export interface PreparedFiles {
  readonly botId: string;
  readonly version: number;
  readonly digest: string;
}

export interface FileSnapshot {
  readonly botId: string;
  readonly requestId: string;
  readonly version: number;
  readonly digest: string;
  readonly files: FileSeed;
}

export interface GrantReceipt {
  readonly botId: string;
  readonly version: number;
  readonly writable: true;
}

export type WorkspaceOptions =
  | { id: string; mode: 'read-only' | 'read-write' }
  | { mode: 'frozen-copy'; files: FileSeed };

export interface SpawnOptions {
  forkFrom?: string;
  requestId: string;
  profile: string;
  parentId?: string;
  writable?: boolean;
  files?: FileSeed;
  bindings?: Readonly<Record<string, string>>;
  secretEnv?: Readonly<Record<string, string>>;
  workspace?: WorkspaceOptions;
  collect?: CollectionSpec;
}

export interface ErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ResourceError extends Error {
  code: string;
  operation: string;
  runtimeId?: string;
  botId?: string;
  requestId?: string;
  cleanup: 'complete' | 'pending';
  reportPath?: string;
  details: readonly ErrorInfo[];
}

export type BotStatus = 'starting' | 'idle' | 'running' | 'exited' | 'closing' | 'closed';

export interface BotListFilter {
  parentId?: string | null;
  status?: BotStatus | readonly BotStatus[];
}

export interface BotInfo {
  id: string;
  profile: string;
  parentId?: string;
  status: BotStatus;
  cursor: number;
  latestOutput?: string;
  lastError?: ErrorInfo;
  lastStop?: StopReceipt;
}

export type InputMode = 'steer' | 'followUp';

export interface SteerOptions {
  requestId: string;
  source?: string;
  steeringMode?: 'all' | 'one-at-a-time';
}

export type InputReceipt =
  | { inputId: string; status: 'accepted'; disposition: 'started' | 'queued' | 'handled' }
  | { inputId: string; status: 'unknown' };

export interface InterruptReceipt {
  interruptId: string;
  status: 'interrupted' | 'unknown';
}

export type BotInitialInputResult = InputReceipt | { status: 'rejected'; error: ErrorInfo } | null;

/** Built-in bot.spawn Service result, distinct from host Runtime.spawn. */
export interface BotSpawnReceipt {
  bot: BotInfo;
  initialInput: BotInitialInputResult;
}

export type BotEvent = { botId: string; seq: number } & (
  | { type: 'output'; text: string }
  | { type: 'settled'; outcome: 'completed' | 'failed' | 'aborted'; output?: string; error?: ErrorInfo }
  | { type: 'error'; error: ErrorInfo; fatal: boolean }
  | { type: 'exit'; reason: string; expected: boolean }
);

export interface PendingCleanup {
  kind: 'bot' | 'bridge' | 'model' | 'backend' | 'report';
  id: string;
  action: 'await-startup' | 'stop-execution' | 'archive-session' | 'collect-artifacts' | 'delete-sandbox' | 'close' | 'save';
  error?: ErrorInfo;
  resourceKey?: string;
  sandboxId?: string;
  creation?: 'created' | 'pending' | 'absent';
  executionStopped?: boolean;
}

export interface StopReceipt {
  botId: string;
  execution: 'stopped' | 'unknown';
  cleanup: 'complete' | 'pending';
  artifacts: readonly string[];
  sessionArchive?: string;
  errors: readonly ErrorInfo[];
  pending?: PendingCleanup;
}

export interface CloseReceipt {
  bots: readonly StopReceipt[];
  cleanup: 'complete' | 'pending';
  errors: readonly ErrorInfo[];
  pending: readonly PendingCleanup[];
  outputDir: string;
  reportPath?: string;
  evidence: { path?: string; recorded: number; lost: number; pending: number };
}

export interface Runtime {
  readonly id: string;
  spawn(options: SpawnOptions): Promise<BotInfo>;
  get(botId: string): Promise<BotInfo>;
  list(filter?: BotListFilter): Promise<BotInfo[]>;
  start(botId: string, input: string, options: { requestId: string }): Promise<InputReceipt>;
  steer(botId: string, input: string, options: SteerOptions): Promise<InputReceipt>;
  interrupt(botId: string, options: { requestId: string; timeoutMs?: number }): Promise<InterruptReceipt>;
  send(botId: string, input: string, options: { requestId: string; mode?: InputMode }): Promise<InputReceipt>;
  onEvent(handler: (event: BotEvent) => void): () => void;
  stop(botId: string, options?: { timeoutMs?: number }): Promise<StopReceipt>;
  close(options?: { timeoutMs?: number }): Promise<CloseReceipt>;
  readonly files: {
    snapshot(botId: string, options: { requestId: string; paths: readonly string[]; includeGit?: boolean; maxBytes?: number }): Promise<FileSnapshot>;
    prepare(botId: string, options: { requestId: string; files: FileSeed }): Promise<PreparedFiles>;
    grant(options: { requestId: string; prepared: PreparedFiles }): Promise<GrantReceipt>;
  };
}

export function createRuntime(options: CreateRuntimeOptions): Promise<Runtime>;
