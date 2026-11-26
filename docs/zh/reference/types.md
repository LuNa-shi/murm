---
title: 类型定义与源码映射
description: Runtime、输入、观察、收尾、Service 与后端的公共类型，及其权威声明的源码链接。
section: 参考手册
order: 13
---

下面列出 `@murm/core` `0.2.0` 的主要公共类型。完整声明分别位于 [Core types](https://github.com/LuNa-shi/murm/blob/main/src/core/types.ts)、[Service types](https://github.com/LuNa-shi/murm/blob/main/src/core/service-types.ts) 与[后端配置](https://github.com/LuNa-shi/murm/blob/main/src/core/backend-config.ts)。完整可运行程序请从 [SDK 指南](../sdk.md)开始。

## 概念与源码映射

| 概念 | 包导出符号 / 目录 | 源文件 |
| --- | --- | --- |
| **Runtime** | `createRuntime`、`Runtime` | [src/core/index.ts](https://github.com/LuNa-shi/murm/blob/main/src/core/index.ts) · [src/core/types.ts](https://github.com/LuNa-shi/murm/blob/main/src/core/types.ts) |
| **Runtime 观察** | `RuntimeObservation`、`RuntimeObservationSnapshot`、`RuntimeObservationUpdate` | [src/core/runtime-observation.ts](https://github.com/LuNa-shi/murm/blob/main/src/core/runtime-observation.ts) |
| **应用收尾** | `finalizeRun`、`RunFinalizationOptions`、`RunFinalization` | [src/core/run-finalization.ts](https://github.com/LuNa-shi/murm/blob/main/src/core/run-finalization.ts) |
| **Agent 与 Profile** | `Profile`、`AgentInfo`、`AgentStatus`、`AgentEvent` | [src/core/types.ts](https://github.com/LuNa-shi/murm/blob/main/src/core/types.ts) · [src/core/agent-service.ts](https://github.com/LuNa-shi/murm/blob/main/src/core/agent-service.ts) |
| **Service** | `ServiceRegistry`、`ServiceManifest`、`ServiceAdapter`、`ServiceRequest` | [src/core/services.ts](https://github.com/LuNa-shi/murm/blob/main/src/core/services.ts) · [src/core/service-types.ts](https://github.com/LuNa-shi/murm/blob/main/src/core/service-types.ts) |
| **Sandbox 后端** | `createOpenSandboxBackend`、`OpenSandboxBackendConfig` | [src/core/backend-config.ts](https://github.com/LuNa-shi/murm/blob/main/src/core/backend-config.ts) · [src/core/opensandbox-backend.ts](https://github.com/LuNa-shi/murm/blob/main/src/core/opensandbox-backend.ts) |
| **Harnesses** | TaskPool、PeerMesh、Substrate、Lead-Worker、Subagents、Notes | [src/harnesses/](https://github.com/LuNa-shi/murm/tree/main/src/harnesses) · [examples/](https://github.com/LuNa-shi/murm/tree/main/examples) |
| **Run 与 Traces** | `runtime.id`、`outputDir/<runtimeId>/`、`CloseReceipt` | [src/core/run-records.ts](https://github.com/LuNa-shi/murm/blob/main/src/core/run-records.ts) · [src/core/model-trace.ts](https://github.com/LuNa-shi/murm/blob/main/src/core/model-trace.ts) · [src/core/service-trace.ts](https://github.com/LuNa-shi/murm/blob/main/src/core/service-trace.ts) |
| **`swarm` CLI** | `runSwarmCli` | [src/cli/swarm-cli.ts](https://github.com/LuNa-shi/murm/blob/main/src/cli/swarm-cli.ts) |

## Runtime 控制面（`@murm/core`）

```ts
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
  observe(options?: RuntimeObservationOptions): RuntimeObservation;
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
```

## Profile、Spawn、受控文件与状态

```ts
export interface Profile {
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
```

## 输入、事件、回执与错误

```ts
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

export type ConditionalInputReceipt =
  | InputReceipt
  | { inputId: string; status: 'not-accepted'; reason: 'idle' };

export interface InterruptReceipt {
  interruptId: string;
  status: 'interrupted' | 'unknown';
  discardedInputHashes?: readonly string[];
}

export type AgentInitialInputResult = InputReceipt | { status: 'rejected'; error: ErrorInfo } | null;

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
```

## Run 收尾

`finalizeRun` 是从 `@murm/core` 导出的公共函数。其输入与报告分别记录业务结果、产物检查、Core 清理、设施清理及报告保存情况。`JsonValue` 从 `@murm/core/services` 导出。

```ts
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
```

## Runtime 状态观察

新观察订阅返回快照及后续更新；指定 `after` 续读时不返回快照。游标只属于存活的 Runtime 实例。缓存、gap 与取消规则见[观察契约](./api.md#实时观察)。

```ts
export interface RuntimeObservationCursor {
  readonly runtimeId: string;
  readonly sequence: number;
}

export interface RuntimeEvidenceProgress {
  readonly recorded: number;
  readonly lost: number;
  readonly pending: number;
}

export interface AgentObservation {
  readonly id: string;
  readonly profile: string;
  readonly parentId?: string;
  readonly status: AgentStatus;
  readonly agentSeq: number;
  readonly execution: 'active' | 'inactive' | 'unknown';
  readonly cleanup?: {
    readonly status: StopReceipt['cleanup'];
    readonly execution: StopReceipt['execution'];
    readonly action?: PendingCleanup['action'];
    readonly resourceKey?: string;
    readonly sandboxId?: string;
  };
}

export interface RuntimeObservationSnapshot {
  readonly schemaVersion: 1;
  readonly cursor: RuntimeObservationCursor;
  readonly runtimeState: 'open' | 'closing' | 'closed';
  readonly cleanup?: CloseReceipt['cleanup'];
  readonly agents: readonly AgentObservation[];
  readonly evidence: RuntimeEvidenceProgress;
}

export type RuntimeObservationChange =
  | { type: 'runtime'; runtimeState: RuntimeObservationSnapshot['runtimeState']; cleanup?: CloseReceipt['cleanup'] }
  | { type: 'agent'; agent: AgentObservation; cause: 'spawn' | 'stop' | 'interrupt' | AgentEvent['type'] }
  | { type: 'input'; agent: AgentObservation; inputId: string; requestId: string;
      state: ConditionalInputReceipt['status'] | 'registered' | 'dispatched' | 'receipt-query' | 'rejected';
      disposition?: Extract<InputReceipt, { status: 'accepted' }>['disposition']; reason?: string }
  | { type: 'execution'; agent: AgentObservation; phase: 'started' | 'settled'; association: 'unknown';
      workerSequence?: number; outcome?: Extract<AgentEvent, { type: 'settled' }>['outcome'] }
  | { type: 'service'; agentId: string; serviceId: string; operation: string; operationId: string;
      attemptId: string; state: string; outcome: string; errorCode?: string }
  | { type: 'trace-gap'; agent: AgentObservation; expectedWorkerSequence?: number; observedWorkerSequence?: number }
  | { type: 'persistence'; evidence: RuntimeEvidenceProgress };

export type RuntimeObservationUpdate =
  | (RuntimeObservationChange & { readonly schemaVersion: 1; readonly cursor: RuntimeObservationCursor; readonly recordSeq?: number })
  | { readonly type: 'gap'; readonly schemaVersion: 1; readonly cursor: RuntimeObservationCursor;
      readonly reason: 'cursor-expired' | 'slow-consumer'; readonly after: RuntimeObservationCursor };

export interface RuntimeObservationOptions {
  after?: RuntimeObservationCursor;
  signal?: AbortSignal;
}

export interface RuntimeObservation {
  readonly snapshot: RuntimeObservationSnapshot | null;
  readonly events: AsyncIterableIterator<RuntimeObservationUpdate>;
  cancel(): void;
}
```

## Service 协议（`@murm/core/services`）与 Model Access Policy

```ts
export type JsonValue =
  | null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ServiceManifest {
  id: string;
  title: string;
  purpose: string;
  provider_version: string;
  contract_version: '2';
  endpoint: { transport: 'in-process' } | { transport: 'http-json'; url: string };
  capabilities: readonly ServiceCapability[];
}

export interface ServiceCapability {
  name: string;
  operation: string;
  description: string;
  side_effect: 'read' | 'write';
  idempotent: boolean;
  help: { when: string; ref?: string };
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  errors: readonly { code: string; retryable: boolean }[];
  path?: string;
  timeout_ms?: number;
}

export interface ServiceCaller {
  runtimeId: string;
  agentId: string;
  profile: string;
  binding?: string;
}

export interface ServiceRequest {
  manifest: ServiceManifest;
  capability: ServiceCapability;
  input: JsonValue;
  envelope: { operation_id: string; [key: string]: unknown };
  caller: ServiceCaller;
  signal: AbortSignal;
  assertAuthorized(): void;
}

export interface ServiceAdapter {
  invoke(request: ServiceRequest): JsonValue | Promise<JsonValue>;
  exportState?(options: { signal: AbortSignal }): JsonValue | Promise<JsonValue>;
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
```

## OpenSandbox 后端（`@murm/core/backends/opensandbox`）

```ts
export type ExecutorKind = 'pi' | 'codex';

export interface BackendCapabilities {
  readonly activeSteer: boolean;
  readonly followUp: boolean;
  readonly conditionalInput: boolean;
  readonly queuedInputCancellation: boolean;
  readonly contextFork: boolean;
  readonly modelRequestAuthorization: boolean;
  readonly rawModelRequestTrace: boolean;
  readonly steeringModes: readonly ('all' | 'one-at-a-time')[];
}

export interface OpenSandboxBackendConfig {
  /** Defaults to Pi. The backend resolves this selection when the handle is created. */
  executor?: ExecutorKind;
  sandbox: {
    lifecycleBaseUrl: string;
    apiKey?: string;
    execdToken?: string;
    endpointHost?: string;
    resourceLimits?: { cpu: string; memory: string };
    commandTimeoutMs?: number;
    /** Sandbox creation lifetime in seconds; safe integer >= 60, default 3600. Provider limits also apply. */
    timeoutSeconds?: number;
  };
  bridge: { host: string; publicUrl: string };
  modelGateway: {
    host: string;
    advertiseHost: string;
    requestTimeoutMs?: number;
    /** null preserves executor output parameters without a host token clamp. */
    maxOutputTokens?: number | null;
    /** Sets upstream reasoning effort for requests admitted in the selection phase. */
    selectionReasoningEffort?: 'low';
  };
  models: Readonly<Record<string, {
    provider: string;
    model: string;
    upstream: { url: string; headers: Readonly<Record<string, string>> };
  }>>;
  isolation: {
    network: 'local-docker';
    disk: { bytes: number; inodes: number };
  };
}

export type PiOpenSandboxBackendConfig = Omit<OpenSandboxBackendConfig, 'executor'>;
```

`PiOpenSandboxBackendConfig` 从已弃用的 `@murm/core/backends/pi-opensandbox` 入口导出。通用后端入口导出 `ExecutorKind`、`BackendCapabilities` 与 `OpenSandboxBackendConfig`。
