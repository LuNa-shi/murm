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
    /** Cap new upstream attempts per Runtime and model alias, including unknown outcomes. */
    maxRequests?: number;
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
