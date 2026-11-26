---
title: Types & Source Map
description: Exact public TypeScript declarations for @murm/core 0.2.0 and source links into the murm repository.
section: REFERENCE
order: 13
---

All declarations below are taken directly from `@murm/core` `0.2.0` on `main`.

## Concept-to-source mapping

| Concept | Package symbol / path | Source file |
| --- | --- | --- |
| **Runtime** | `createRuntime`, `Runtime` | [src/core/index.ts](https://github.com/LuNa-shi/murm/blob/main/src/core/index.ts) · [src/core/types.ts](https://github.com/LuNa-shi/murm/blob/main/src/core/types.ts) |
| **Agent & Profile** | `Profile`, `AgentInfo`, `AgentStatus`, `AgentEvent` | [src/core/types.ts](https://github.com/LuNa-shi/murm/blob/main/src/core/types.ts) · [src/core/agent-service.ts](https://github.com/LuNa-shi/murm/blob/main/src/core/agent-service.ts) |
| **Service** | `ServiceRegistry`, `ServiceManifest`, `ServiceAdapter`, `ServiceRequest` | [src/core/services.ts](https://github.com/LuNa-shi/murm/blob/main/src/core/services.ts) · [src/core/service-types.ts](https://github.com/LuNa-shi/murm/blob/main/src/core/service-types.ts) |
| **Sandbox backend** | `createOpenSandboxBackend`, `OpenSandboxBackendConfig` | [src/core/backend-config.ts](https://github.com/LuNa-shi/murm/blob/main/src/core/backend-config.ts) · [src/core/opensandbox-backend.ts](https://github.com/LuNa-shi/murm/blob/main/src/core/opensandbox-backend.ts) |
| **Harnesses** | TaskPool, PeerMesh, Substrate, Lead-Worker, Subagents, Notes | [src/harnesses/](https://github.com/LuNa-shi/murm/tree/main/src/harnesses) · [examples/](https://github.com/LuNa-shi/murm/tree/main/examples) |
| **Run & Traces** | `runtime.id`, `outputDir/<runtimeId>/`, `CloseReceipt` | [src/core/run-records.ts](https://github.com/LuNa-shi/murm/blob/main/src/core/run-records.ts) · [src/core/model-trace.ts](https://github.com/LuNa-shi/murm/blob/main/src/core/model-trace.ts) · [src/core/service-trace.ts](https://github.com/LuNa-shi/murm/blob/main/src/core/service-trace.ts) |
| **`swarm` CLI** | `runSwarmCli` | [src/cli/swarm-cli.ts](https://github.com/LuNa-shi/murm/blob/main/src/cli/swarm-cli.ts) |

## Runtime control surface (`@murm/core`)

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
  stop(agentId: string, options?: { timeoutMs?: number }): Promise<StopReceipt>;
  close(options?: { timeoutMs?: number }): Promise<CloseReceipt>;
  readonly files: {
    snapshot(
      agentId: string,
      options: { requestId: string; paths: readonly string[]; includeGit?: boolean; maxBytes?: number }
    ): Promise<FileSnapshot>;
    installStatus(agentId: string, options: { requestId: string }): Promise<FileInstall | null>;
    install(
      agentId: string,
      options: { requestId: string; expected: FileSnapshot; files: FileSeed }
    ): Promise<FileInstall>;
    confirm(agentId: string, options: { requestId: string }): Promise<FileInstall>;
    prepare(agentId: string, options: { requestId: string; files: FileSeed }): Promise<PreparedFiles>;
    grant(options: { requestId: string; prepared: PreparedFiles }): Promise<GrantReceipt>;
  };
}
```

## Profile, Spawn, Files & Status

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

## Input, Events, Receipts & Errors

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

## Service Protocol (`@murm/core/services`) & Model Access Policy

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

## Pi/OpenSandbox Backend (`@murm/core/backends/pi-opensandbox`)

```ts
export interface PiOpenSandboxBackendConfig {
  sandbox: {
    lifecycleBaseUrl: string;
    apiKey?: string;
    execdToken?: string;
    endpointHost?: string;
    resourceLimits?: { cpu: string; memory: string };
    commandTimeoutMs?: number;
    timeoutSeconds?: number;
  };
  bridge: { host: string; publicUrl: string };
  modelGateway: {
    host: string;
    advertiseHost: string;
    requestTimeoutMs?: number;
    maxOutputTokens?: number | null;
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
```
