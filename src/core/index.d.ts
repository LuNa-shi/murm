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
  env?: Readonly<Record<string, string>>;
  network?: { allow: readonly string[] };
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

export interface SpawnOptions {
  requestId: string;
  profile: string;
  parentId?: string;
  writable?: boolean;
  bindings?: Readonly<Record<string, string>>;
  secretEnv?: Readonly<Record<string, string>>;
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

export interface BotInfo {
  id: string;
  profile: string;
  parentId?: string;
  status: 'starting' | 'idle' | 'running' | 'exited' | 'closing' | 'closed';
  cursor: number;
  latestOutput?: string;
  lastError?: ErrorInfo;
  lastStop?: StopReceipt;
}

export type InputMode = 'steer' | 'followUp';

export type InputReceipt =
  | { inputId: string; status: 'accepted'; disposition: 'started' | 'queued' | 'handled' }
  | { inputId: string; status: 'unknown' };

export type BotEvent = { botId: string; seq: number } & (
  | { type: 'output'; text: string }
  | { type: 'settled'; outcome: 'completed' | 'failed' | 'aborted'; output?: string; error?: ErrorInfo }
  | { type: 'error'; error: ErrorInfo; fatal: boolean }
  | { type: 'exit'; reason: string; expected: boolean }
);

export interface StopReceipt {
  botId: string;
  execution: 'stopped' | 'unknown';
  cleanup: 'complete' | 'pending';
  artifacts: readonly string[];
  errors: readonly ErrorInfo[];
}

export interface CloseReceipt {
  bots: readonly StopReceipt[];
  cleanup: 'complete' | 'pending';
  errors: readonly ErrorInfo[];
  outputDir: string;
  reportPath?: string;
}

export interface Runtime {
  readonly id: string;
  spawn(options: SpawnOptions): Promise<BotInfo>;
  get(botId: string): Promise<BotInfo>;
  send(botId: string, input: string, options: { requestId: string; mode?: InputMode }): Promise<InputReceipt>;
  onEvent(handler: (event: BotEvent) => void): () => void;
  stop(botId: string, options?: { timeoutMs?: number }): Promise<StopReceipt>;
  close(options?: { timeoutMs?: number }): Promise<CloseReceipt>;
}

export function createRuntime(options: CreateRuntimeOptions): Promise<Runtime>;
