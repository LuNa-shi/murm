import type { ServiceRegistry } from './services.js';
import type { JsonValue } from './service-types.js';

export {};

declare const backendBrand: unique symbol;

export interface Backend {
  readonly [backendBrand]: true;
}

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

export interface ModelCaller {
  readonly runtimeId: string;
  readonly agentId: string;
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
  maxAgents: number;
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
  allowMissingGit?: boolean;
  maxBytes: number;
  required: boolean;
}

export interface PreparedFiles {
  readonly agentId: string;
  readonly version: number;
  readonly digest: string;
}

export interface FileSnapshot {
  readonly agentId: string;
  readonly requestId: string;
  readonly version: number;
  readonly digest: string;
  readonly files: FileSeed;
}

export interface FileInstall {
  readonly agentId: string;
  readonly requestId: string;
  readonly version: number;
  readonly digest: string;
  readonly phase: 'installed' | 'committed';
}

export interface GrantReceipt {
  readonly agentId: string;
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

export interface SendOptions extends SteerOptions {
  mode?: InputMode;
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

export type AgentEvent = { agentId: string; seq: number } & (
  | { type: 'output'; text: string }
  | { type: 'settled'; outcome: 'completed' | 'failed' | 'aborted'; output?: string; error?: ErrorInfo }
  | { type: 'error'; error: ErrorInfo; fatal: boolean }
  | { type: 'exit'; reason: string; expected: boolean }
);

export interface PendingCleanup {
  kind: 'agent' | 'bridge' | 'model' | 'backend' | 'report';
  id: string;
  action: 'await-startup' | 'stop-execution' | 'archive-session' | 'collect-artifacts' | 'delete-sandbox' | 'close' | 'save';
  error?: ErrorInfo;
  resourceKey?: string;
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

export type RunBusinessOutcome<Result extends JsonValue = JsonValue> =
  | { status: 'completed'; value: Result }
  | { status: 'failed' | 'cancelled'; error: { code: string; message: string } };

export interface RunFinalizationError {
  code: string;
  message: string;
  details?: readonly unknown[];
}

export type RunCoreClose =
  | { status: 'complete' | 'pending'; receipt: CloseReceipt }
  | { status: 'unknown'; error: RunFinalizationError };

export type RunArtifactVerification =
  | { status: 'not-requested' | 'passed' }
  | { status: 'pending' | 'failed'; error: RunFinalizationError };

export type RunFacilityCleanup = { id: string } & (
  | { status: 'complete' }
  | { status: 'pending'; error: RunFinalizationError }
);

export interface RunFinalizationOptions<Result extends JsonValue = JsonValue> {
  runtime: Pick<Runtime, 'id' | 'close'>;
  outputDir: string;
  business: RunBusinessOutcome<Result>;
  cleanupTimeoutMs?: number;
  verifyArtifacts?(receipt: CloseReceipt, signal: AbortSignal): void | Promise<void>;
  ownedFacilities?: readonly { id: string; close(signal: AbortSignal): void | Promise<void> }[];
}

export interface RunLateFacilityCleanup {
  runtimeId: string;
  facility: RunFacilityCleanup;
  reportSaveFailure: RunFinalizationError | null;
  reportPath?: string;
}

export interface RunFinalization<Result extends JsonValue = JsonValue> {
  runtimeId: string;
  business: RunBusinessOutcome<Result>;
  coreClose: RunCoreClose;
  artifactVerification: RunArtifactVerification;
  facilities: readonly RunFacilityCleanup[];
  reportSaveFailure: RunFinalizationError | null;
  reportPath?: string;
  lateFacilityReportPath?: string;
  lateFacilityCleanup?: {
    current(): RunLateFacilityCleanup | undefined;
    readonly result: Promise<RunLateFacilityCleanup>;
  };
}

export interface Runtime {
  readonly id: string;
  spawn(options: SpawnOptions): Promise<AgentInfo>;
  get(agentId: string): Promise<AgentInfo>;
  list(filter?: AgentListFilter): Promise<AgentInfo[]>;
  start(agentId: string, input: string, options: { requestId: string }): Promise<InputReceipt>;
  steer(agentId: string, input: string, options: SteerOptions): Promise<InputReceipt>;
  interrupt(agentId: string, options: { requestId: string; timeoutMs?: number }): Promise<InterruptReceipt>;
  send(agentId: string, input: string, options: SendOptions & { wakeIfIdle?: true }): Promise<InputReceipt>;
  send(agentId: string, input: string, options: SendOptions): Promise<ConditionalInputReceipt>;
  onEvent(handler: (event: AgentEvent) => void): () => void;
  stop(agentId: string, options?: { timeoutMs?: number }): Promise<StopReceipt>;
  close(options?: { timeoutMs?: number }): Promise<CloseReceipt>;
  readonly files: {
    snapshot(agentId: string, options: { requestId: string; paths: readonly string[]; includeGit?: boolean; maxBytes?: number }): Promise<FileSnapshot>;
    installStatus(agentId: string, options: { requestId: string }): Promise<FileInstall | null>;
    install(agentId: string, options: { requestId: string; expected: FileSnapshot; files: FileSeed }): Promise<FileInstall>;
    confirm(agentId: string, options: { requestId: string }): Promise<FileInstall>;
    prepare(agentId: string, options: { requestId: string; files: FileSeed }): Promise<PreparedFiles>;
    grant(options: { requestId: string; prepared: PreparedFiles }): Promise<GrantReceipt>;
  };
}
