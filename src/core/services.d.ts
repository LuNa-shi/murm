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
  /** Check immediately before committing an effect after an asynchronous wait. */
  assertAuthorized(): void;
}

export interface ServiceAdapter {
  invoke(request: ServiceRequest): JsonValue | Promise<JsonValue>;
  /** Optional bounded host-only snapshot called during Runtime close. */
  exportState?(options: { signal: AbortSignal }): JsonValue | Promise<JsonValue>;
}

export class ServiceRegistry {
  registerService(registration: { manifest: ServiceManifest; adapter: ServiceAdapter }): void;
}

export function createInProcessAdapter(implementation: ServiceAdapter): ServiceAdapter;

/** Host-only Service credential; HTTP Service must authenticate this connection before trusting caller. */
export function createHttpJsonAdapter(options?: { token?: string; timeoutMs?: number; fetchImpl?: typeof fetch }): ServiceAdapter;
