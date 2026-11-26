import type { ExecutorKind, ModelConfig, RuntimeConnectionOptions, Sandbox, SteeringMode } from './backend-config.js';
import type { ServiceRegistry } from './services.js';

export {};

export interface Profile {
  /** Optional Harness instructions added to the standard startup prompt. */
  prompt?: string;
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

export interface CreateRuntimeOptions {
  sandbox: Sandbox;
  executor?: ExecutorKind;
  models: Readonly<Record<string, ModelConfig>>;
  connection?: RuntimeConnectionOptions;
  profiles: Readonly<Record<string, Profile>>;
  services: ServiceRegistry;
  maxAgents: number;
  outputDir: string;
}

export interface FileEntry {
  readonly encoding: 'utf8' | 'base64';
  readonly data: string;
  readonly mode?: 0o644 | 0o755;
}
export type FileTree = Readonly<Record<string, FileEntry>>;
export type CompleteFileDigest = `complete:sha256:${string}`;
export type PartialFileDigest = `partial:sha256:${string}`;

export interface FileSnapshotOptions {
  requestId: string;
  paths: readonly string[];
  maxBytes?: number;
}
export interface CompleteFileSnapshotOptions extends FileSnapshotOptions {
  paths: readonly ['.'];
}
export interface CompleteFileSnapshot {
  readonly agentId: string;
  readonly requestId: string;
  readonly version: number;
  readonly files: FileTree;
  readonly scope: 'complete';
  readonly digest: CompleteFileDigest;
}
export interface PartialFileSnapshot {
  readonly agentId: string;
  readonly requestId: string;
  readonly version: number;
  readonly files: FileTree;
  readonly scope: 'partial';
  readonly digest: PartialFileDigest;
}
export type FileSnapshot = CompleteFileSnapshot | PartialFileSnapshot;

export interface FileReplaceOptions {
  requestId: string;
  expectedDigest: CompleteFileDigest;
  files: FileTree;
  writable?: true;
}
export type FileReplaceReceipt = {
  readonly agentId: string;
  readonly requestId: string;
} & (
  | { readonly status: 'completed'; readonly digest: CompleteFileDigest; readonly writable: boolean }
  | { readonly status: 'failed'; readonly error: ErrorInfo }
  | { readonly status: 'unknown' }
);

export interface CollectionSpec {
  paths: readonly string[];
  includeGit: boolean;
  allowMissingGit?: boolean;
  maxBytes: number;
  required: boolean;
}

export type WorkspaceOptions = { id: string; mode: 'read-only' | 'read-write' };

export interface SpawnOptions {
  forkFrom?: string;
  requestId: string;
  profile: string;
  parentId?: string;
  writable?: boolean;
  files?: FileTree;
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
  agentId?: string;
  requestId?: string;
  cleanup: 'complete' | 'pending';
  reportPath?: string;
  details: readonly ErrorInfo[];
}

export type AgentStatus = 'starting' | 'idle' | 'running' | 'exited' | 'closing' | 'closed';

export interface AgentListFilter {
  parentId?: string | null;
  status?: AgentStatus | readonly AgentStatus[];
}

export interface AgentInfo {
  id: string;
  profile: string;
  parentId?: string;
  status: AgentStatus;
  latestOutput?: string;
  lastError?: ErrorInfo;
  lastStop?: StopReceipt;
}

export type InputMode = 'steer' | 'followUp';

export interface SendOptions {
  requestId: string;
  mode?: InputMode;
  source?: string;
  steeringMode?: SteeringMode;
  wakeIfIdle?: boolean;
}

export type InputReceipt =
  | { inputId: string; status: 'accepted'; disposition: 'started' | 'queued' | 'handled' }
  | { inputId: string; status: 'unknown' };

export type ConditionalInputReceipt = InputReceipt | { inputId: string; status: 'not-accepted'; reason: 'idle' };

export interface InterruptReceipt {
  interruptId: string;
  status: 'interrupted' | 'unknown';
  discardedInputHashes?: readonly string[];
}

export type AgentInitialInputResult = InputReceipt | { status: 'rejected'; error: ErrorInfo } | null;

/** Built-in agent.spawn Service result, distinct from host Runtime.spawn. */
export interface AgentSpawnReceipt {
  agent: AgentInfo;
  initialInput: AgentInitialInputResult;
}

export type AgentEvent = { agentId: string } & (
  | { type: 'output'; text: string }
  | { type: 'settled'; outcome: 'completed' | 'failed' | 'aborted'; output?: string; error?: ErrorInfo }
  | { type: 'error'; error: ErrorInfo; fatal: boolean }
  | { type: 'exit'; reason: string; expected: boolean }
);

export type RuntimeEvent = AgentEvent
  | { type: 'agentChanged'; agentId: string }
  | { type: 'runtimeChanged' };

export type RuntimeState = 'open' | 'closing' | 'closed';

export interface InterruptOptions {
  requestId: string;
  timeoutMs?: number;
}

export interface StopOptions { timeoutMs?: number }
export interface CloseOptions { timeoutMs?: number }

export interface PendingCleanup {
  kind: 'agent' | 'bridge' | 'model' | 'backend' | 'report';
  id: string;
  action: 'await-startup' | 'stop-execution' | 'archive-session' | 'collect-artifacts' | 'delete-sandbox' | 'close' | 'save';
  error?: ErrorInfo;
  resourceKey?: string;
  providerId?: string;
  sandboxId?: string;
  creation?: 'created' | 'pending' | 'absent';
  executionStopped?: boolean;
}

export interface StopReceipt {
  agentId: string;
  execution: 'stopped' | 'unknown';
  cleanup: 'complete' | 'pending';
  artifacts: readonly string[];
  sessionArchive?: string;
  errors: readonly ErrorInfo[];
  pending?: PendingCleanup;
}

export interface CloseReceipt {
  agents: readonly StopReceipt[];
  cleanup: 'complete' | 'pending';
  errors: readonly ErrorInfo[];
  pending: readonly PendingCleanup[];
  outputDir: string;
  reportPath?: string;
  evidence: { path?: string; recorded: number; lost: number; pending: number };
}

export interface Runtime {
  readonly id: string;
  readonly state: RuntimeState;
  spawn(options: SpawnOptions): Promise<AgentInfo>;
  get(agentId: string): Promise<AgentInfo>;
  list(filter?: AgentListFilter): Promise<AgentInfo[]>;
  interrupt(agentId: string, options: InterruptOptions): Promise<InterruptReceipt>;
  send(agentId: string, input: string, options: SendOptions & { wakeIfIdle?: true }): Promise<InputReceipt>;
  send(agentId: string, input: string, options: SendOptions): Promise<ConditionalInputReceipt>;
  onEvent(handler: (event: RuntimeEvent) => void | Promise<void>): () => void;
  stop(agentId: string, options?: StopOptions): Promise<StopReceipt>;
  close(options?: CloseOptions): Promise<CloseReceipt>;
  readonly files: RuntimeFiles;
}

export interface RuntimeFiles {
  snapshot(agentId: string, options: CompleteFileSnapshotOptions): Promise<CompleteFileSnapshot>;
  snapshot(agentId: string, options: FileSnapshotOptions): Promise<FileSnapshot>;
  replace(agentId: string, options: FileReplaceOptions): Promise<FileReplaceReceipt>;
}
