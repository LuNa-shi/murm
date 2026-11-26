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
  resourceLimits?: { cpu: string; memory: string };
  commandTimeoutMs?: number;
  timeoutSeconds?: number;
  isolation: {
    network?: 'local-docker';
    disk: { bytes: number; inodes: number };
  };
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
    requestTimeoutMs?: number;
    maxOutputTokens?: number | null;
  };
}

export interface OpenSandboxBackendConfig {
  /** Defaults to Pi. Runtime resolves this selection at assembly. */
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
  };
  models: Readonly<Record<string, ModelConfig>>;
  isolation: {
    network: 'local-docker';
    disk: { bytes: number; inodes: number };
  };
}
