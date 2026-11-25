---
title: TypeScript 类型与映射
description: 与 SwarmEnv 主干提交 ac72c76 完全同步的公共 TypeScript 类型定义，以及 murm 新概念与当前包导出的映射关系。
section: 参考与部署
order: 13
---

本页汇总 `@swarmenv/core` `0.2.0`（固定源码提交 [`ac72c76`](https://github.com/LuNa-shi/SwarmEnv/commit/ac72c76)）的全部公共 TypeScript 类型声明。

## `murm` 概念与当前代码符号对照

| `murm` 文档概念 | 当前包 / 符号 | 源码文件 |
| --- | --- | --- |
| `Runtime` | `createRuntime`, `Runtime` | [src/core/types.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/core/types.ts) |
| `Agent` | `BotInfo`, `BotStatus`, `BotEvent`, `Profile` | [src/core/types.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/core/types.ts) |
| `Service` | `ServiceRegistry`, `ServiceManifest`, `ServiceAdapter`, `ServiceRequest` | [src/core/service-types.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/core/service-types.ts) |
| `Sandbox` | `createPiOpenSandboxBackend`, `PiOpenSandboxBackendConfig` | [src/core/backend-config.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/core/backend-config.ts) |
| `Program` | `src/environments/*`, `examples/*-environment/` | [src/environments/](https://github.com/LuNa-shi/SwarmEnv/tree/ac72c76/src/environments) |
| `Run` | `runtime.id` + `outputDir/<runtimeId>/` + `CloseReceipt` | [src/core/run-records.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/core/run-records.ts) |

## Runtime 与核心控制类型

```ts
export interface Runtime {
  readonly id: string;
  spawn(options: SpawnOptions): Promise<BotInfo>;
  get(botId: string): Promise<BotInfo>;
  list(filter?: BotListFilter): Promise<BotInfo[]>;
  start(botId: string, input: string, options: { requestId: string }): Promise<InputReceipt>;
  steer(botId: string, input: string, options: SteerOptions): Promise<InputReceipt>;
  interrupt(botId: string, options: { requestId: string; timeoutMs?: number }): Promise<InterruptReceipt>;
  send(botId: string, input: string, options: SendOptions & { wakeIfIdle?: true }): Promise<InputReceipt>;
  send(botId: string, input: string, options: SendOptions): Promise<ConditionalInputReceipt>;
  onEvent(handler: (event: BotEvent) => void): () => void;
  stop(botId: string, options?: { timeoutMs?: number }): Promise<StopReceipt>;
  close(options?: { timeoutMs?: number }): Promise<CloseReceipt>;
  readonly files: {
    snapshot(
      botId: string,
      options: { requestId: string; paths: readonly string[]; includeGit?: boolean; maxBytes?: number }
    ): Promise<FileSnapshot>;
    prepare(botId: string, options: { requestId: string; files: FileSeed }): Promise<PreparedFiles>;
    grant(options: { requestId: string; prepared: PreparedFiles }): Promise<GrantReceipt>;
  };
}
```

## Profile、Spawn 与状态类型

```ts
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

export interface CreateRuntimeOptions {
  backend: Backend;
  profiles: Readonly<Record<string, Profile>>;
  services: ServiceRegistry;
  maxBots: number;
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

export type BotStatus = 'starting' | 'idle' | 'running' | 'exited' | 'closing' | 'closed';

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
```

## 输入、事件与中断回执

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

export type BotEvent = { botId: string; seq: number } & (
  | { type: 'output'; text: string }
  | { type: 'settled'; outcome: 'completed' | 'failed' | 'aborted'; output?: string; error?: ErrorInfo }
  | { type: 'error'; error: ErrorInfo; fatal: boolean }
  | { type: 'exit'; reason: string; expected: boolean }
);
```

## Service 协议与模型准入类型

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
  botId: string;
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
    readonly botId: string;
    readonly profile: string;
    readonly model: string;
  }): ModelPermit | null;
  withCommit<T>(commit: () => T): T;
}
```
