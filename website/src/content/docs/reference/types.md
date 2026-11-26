---
title: Types & Mapping
description: Public TypeScript definitions for @murm/core 0.2.0 (f98eb71d0eac61ac99a1b98a9d04ef353f781fec) and their mapping to murm concepts.
section: REFERENCE
order: 13
---

Selected public TypeScript declarations from `@murm/core` `0.2.0` at commit [`f98eb71d`](https://github.com/LuNa-shi/SwarmEnv/commit/f98eb71d0eac61ac99a1b98a9d04ef353f781fec).

## Concept-to-code mapping

| `murm` concept | Package symbol / directory | Source file |
| --- | --- | --- |
| `Runtime` | `createRuntime`, `Runtime` | [src/core/types.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/core/types.ts) |
| `Agent` | `AgentInfo`, `AgentStatus`, `AgentEvent`, `Profile` | [src/core/types.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/core/types.ts) |
| `Service` | `ServiceRegistry`, `ServiceManifest`, `ServiceAdapter`, `ServiceRequest` | [src/core/service-types.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/core/service-types.ts) |
| `Sandbox` | `createPiOpenSandboxBackend`, `PiOpenSandboxBackendConfig` | [src/core/backend-config.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/core/backend-config.ts) |
| `Harness` | `src/harnesses/` and `examples/` | [src/harnesses/](https://github.com/LuNa-shi/SwarmEnv/tree/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/harnesses) |
| `Run` | `runtime.id` + `outputDir/<runtimeId>/` + `CloseReceipt` | [src/core/run-records.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/core/run-records.ts) |

## Runtime control surface

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

## Profile, Spawn & Status

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

export type AgentStatus = 'starting' | 'idle' | 'running' | 'exited' | 'closing' | 'closed';

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

## Input, Events & Interrupt Receipts

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

export type AgentEvent = { agentId: string; seq: number } & (
  | { type: 'output'; text: string }
  | { type: 'settled'; outcome: 'completed' | 'failed' | 'aborted'; output?: string; error?: ErrorInfo }
  | { type: 'error'; error: ErrorInfo; fatal: boolean }
  | { type: 'exit'; reason: string; expected: boolean }
);
```

## Service Protocol & Model Access Policy

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

export interface ModelPermit {
  phase: 'selection' | 'work' | 'closeout';
  deadlineAt: number;
  lease?: { key: string; version: number; expiresAt: number };
}

export interface ModelAccessPolicy {
  authorize(caller: {
    readonly runtimeId: string;
    readonly agentId: string;
    readonly profile: string;
    readonly model: string;
  }): ModelPermit | null;
  withCommit<T>(commit: () => T): T;
}
```
