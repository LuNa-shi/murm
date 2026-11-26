export interface PiOpenSandboxBackendConfig {
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
    /** null preserves provider/Pi output parameters without a host token clamp. */
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
