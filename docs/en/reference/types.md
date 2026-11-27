---
title: Types & Source Map
description: Public Runtime, input, observation, finalization, Service and backend types, with links to their authoritative declarations.
section: REFERENCE
order: 13
---

The excerpts below cover the main public type families in `@luna-shi/murm`. The complete declarations live in [Core types](https://github.com/LuNa-shi/murm/blob/main/src/core/types.ts), [Service types](https://github.com/LuNa-shi/murm/blob/main/src/core/service-types.ts), [backend configuration](https://github.com/LuNa-shi/murm/blob/main/src/core/backend-config.ts), [executor adapters](https://github.com/LuNa-shi/murm/blob/main/src/core/executor-adapter.ts), [file policy](https://github.com/LuNa-shi/murm/blob/main/src/core/file-policy.ts), [model transport](https://github.com/LuNa-shi/murm/blob/main/src/core/model-transport.ts), and [default Worker image](https://github.com/LuNa-shi/murm/blob/main/src/core/worker-image.ts). For guided walkthroughs, start with [Runtime](../runtime.md) and [Build a Swarm Harness](../build-your-harness.md).

Import public values (`createSandbox`, `resolveSandboxConnection`, `createRuntime`, `createPiExecutor`, `createCodexExecutor`, `createExecutorAdapter`, `EXECUTOR_ADAPTER_PROTOCOL`, `getExecutorCapabilities`, `DEFAULT_WORKER_IMAGE`, `workerImageFor`, `ServiceRegistry`, `createInProcessAdapter`, `createHttpJsonAdapter`) and public types from `@luna-shi/murm`. The declarations cover Runtime, files, receipts, Sandbox and the Service author boundary.

## Runtime, Profile, FileTree and events

```ts
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
  agentAccessPolicy?: AgentAccessPolicy;
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

type AgentEvent = { agentId: string } & (
  | { type: 'output'; text: string }
  | { type: 'settled'; outcome: 'completed' | 'failed' | 'aborted'; output?: string; error?: ErrorInfo }
  | { type: 'error'; error: ErrorInfo; fatal: boolean }
  | { type: 'exit'; reason: string; expected: boolean }
);

export type RuntimeEvent = AgentEvent
  | { type: 'agentChanged'; agentId: string }
  | { type: 'runtimeChanged' }
  | { type: 'management'; change: RuntimeManagementChange };

export type RuntimeState = 'open' | 'closing' | 'closed';

export interface InterruptOptions {
  requestId: string;
  timeoutMs?: number;
}

export interface StopOptions { timeoutMs?: number }
export interface CloseOptions { timeoutMs?: number }

export interface PendingCleanup {
  kind: 'agent' | 'bridge' | 'model' | 'backend' | 'report' | 'service';
  id: string;
  action: 'await-startup' | 'stop-execution' | 'archive-session' | 'collect-artifacts' | 'delete-sandbox' | 'close' | 'save' | 'retire-service';
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

export interface ProfileRegistration {
  readonly actorId?: string;
  readonly id: string;
  readonly requestId: string;
  readonly profile: Profile;
}

export interface ProfileDefinition {
  readonly actorId?: string;
  readonly id: string;
  readonly digest: string;
  readonly sequence: number;
  readonly profile: Profile;
}

export interface RuntimeServiceRegistration {
  readonly actorId?: string;
  readonly requestId: string;
  readonly registration: ServiceRegistration;
  readonly deploymentRef: string;
  readonly implementationId: string;
  readonly ownership: 'run' | 'external';
}

export interface ServiceRetirement {
  readonly actorId?: string;
  readonly serviceId: string;
  readonly requestId: string;
  readonly timeoutMs?: number;
}

export interface RuntimeServiceDefinition {
  readonly actorId?: string;
  readonly id: string;
  readonly manifest: ServiceManifest;
  readonly sequence: number;
  readonly state: 'ready' | 'retiring' | 'retired';
  readonly deploymentRef?: string;
  readonly implementationId?: string;
  readonly ownership?: RuntimeServiceRegistration['ownership'];
  readonly error?: ErrorInfo;
}

export type AgentAccessRequest = {
  readonly runtimeId: string;
  readonly callerId: string;
  readonly agentId: string;
} & (
  | { readonly operation: 'access_get' }
  | { readonly operation: 'grant' | 'revoke'; readonly serviceId: string; readonly operations: readonly string[] }
);

export type AgentAccessPolicy = (request: AgentAccessRequest) => boolean;

export interface AgentAccess {
  readonly agentId: string;
  readonly version: number;
  readonly services: Readonly<Record<string, readonly string[]>>;
}

export interface AgentAccessMutation {
  readonly agentId: string;
  readonly serviceId: string;
  readonly operations: readonly string[];
  readonly requestId: string;
}

export type AgentAccessGrant = AgentAccessMutation & { readonly binding?: string };

export interface RuntimeManagementSnapshot {
  readonly sequence: number;
  readonly profiles: readonly ProfileDefinition[];
  readonly services: readonly RuntimeServiceDefinition[];
  readonly access: readonly AgentAccess[];
}

export type RuntimeManagementChange = {
  readonly sequence: number;
  readonly caller: string;
  readonly requestId: string;
} & (
  | { readonly operation: 'profile.register'; readonly definition: ProfileDefinition }
  | { readonly operation: 'service.register' | 'service.retire'; readonly definition: RuntimeServiceDefinition }
  | { readonly operation: 'access.grant' | 'access.revoke'; readonly access: AgentAccess; readonly serviceId: string; readonly operations: readonly string[] }
);

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
  readonly profiles: {
    register(input: ProfileRegistration): Promise<ProfileDefinition>;
    get(id: string): ProfileDefinition | null;
    list(): readonly ProfileDefinition[];
  };
  readonly access: {
    get(agentId: string): AgentAccess | null;
    grant(input: AgentAccessGrant): Promise<AgentAccess>;
    revoke(input: AgentAccessMutation): Promise<AgentAccess>;
  };
  readonly services: {
    register(input: RuntimeServiceRegistration): Promise<RuntimeServiceDefinition>;
    get(id: string): RuntimeServiceDefinition | null;
    list(): readonly RuntimeServiceDefinition[];
    retire(input: ServiceRetirement): Promise<RuntimeServiceDefinition>;
  };
  readonly management: { get(): RuntimeManagementSnapshot };
  readonly files: RuntimeFiles;
}

export interface RuntimeFiles {
  snapshot(agentId: string, options: CompleteFileSnapshotOptions): Promise<CompleteFileSnapshot>;
  snapshot(agentId: string, options: FileSnapshotOptions): Promise<FileSnapshot>;
  replace(agentId: string, options: FileReplaceOptions): Promise<FileReplaceReceipt>;
}
```

## Sandbox and Runtime connection

```ts
declare const sandboxBrand: unique symbol;

export interface Sandbox {
  readonly [sandboxBrand]: true;
}

export interface SandboxConfig {
  kind?: 'opensandbox';
  lifecycleBaseUrl: string;
  apiKey?: string;
  execdToken?: string;
  endpointHost?: string;
  useServerProxy?: boolean;
  resourceLimits?: { cpu: string; memory: string };
  commandTimeoutMs?: number;
  timeoutSeconds?: number;
  isolation?:
    | { network?: 'local-docker'; disk: { bytes: number; inodes: number } }
    | { network?: 'api'; disk?: { bytes: number; inodes?: never } };
}

export type ExecutorKind = 'pi' | 'codex';
export type SteeringMode = 'all' | 'one-at-a-time';

export interface ExecutorCapabilities {
  readonly activeSteer: boolean;
  readonly followUp: boolean;
  readonly conditionalInput: boolean;
  readonly queuedInputCancellation: boolean;
  readonly contextFork: boolean;
  readonly steeringModes: readonly SteeringMode[];
}

export interface ModelConfig {
  provider: string;
  model: string;
  upstream: { url: string; headers: Readonly<Record<string, string>> };
}

export interface RuntimeConnectionOptions {
  advertiseHost?: string;
  bridge?: { host?: string; publicUrl?: string };
  modelGateway?: {
    host?: string;
    advertiseHost?: string;
    publicUrl?: string;
    requestTimeoutMs?: number;
    maxOutputTokens?: number | null;
    maxRequests?: number;
  };
}
```

## Service author interfaces

```ts
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

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
  /** Host-registered invocation deadline, 1..86400000 ms. Defaults to 30000. */
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
  /** Recheck caller authority immediately before a Service commits its side effect. */
  assertAuthorized(): void;
}

export interface ServiceAdapter {
  invoke(request: ServiceRequest): JsonValue | Promise<JsonValue>;
  /** Optional bounded host-only snapshot called during Runtime close. */
  exportState?(options: { signal: AbortSignal }): JsonValue | Promise<JsonValue>;
}

export interface ServiceRegistration {
  manifest: ServiceManifest;
  adapter: ServiceAdapter;
}

export interface HttpJsonAdapterOptions {
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}
```

[See Service author and HTTP wire contracts in the API reference.](api.md#service-protocol--built-in-agent-service)
