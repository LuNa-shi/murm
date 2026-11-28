declare const sandboxBrand: unique symbol;

export interface Sandbox {
  readonly [sandboxBrand]: true;
}

import type { OpenSandboxProvider, SandboxProvider } from './sandbox/opensandbox-provider.js';
import type { ModelCapabilities, ModelProtocol, ModelTransport } from './model/model-transport.js';
import type { ExecutorSelection } from './executor-adapter.js';

export interface SandboxProviderConfig {
  provider: SandboxProvider;
  timeoutSeconds?: number;
}

export interface SandboxConfig {
  kind?: 'opensandbox';
  endpoint?: string;
  /** Migration alias for endpoint. */
  lifecycleBaseUrl?: string;
  apiKey?: string;
  execdToken?: string;
  endpointHost?: string;
  useServerProxy?: boolean;
  /** Assertion by the deployment administrator. Smoke verifies the actual policy. */
  egressMode?: 'dns+nft';
  resourceLimits?: { cpu: string; memory: string };
  resourceRequests?: { cpu: string; memory: string };
  commandTimeoutMs?: number;
  timeoutSeconds?: number;
  isolation?:
    | { network?: 'local-docker'; disk: { bytes: number; inodes: number } }
    | { network?: 'api'; disk?: { bytes: number; inodes?: never } };
}

export type ExecutorKind = 'pi' | 'codex';
export type SteeringMode = 'all' | 'one-at-a-time';

export interface ExecutorCapabilities {
  readonly session?: import('./session-types.js').AgentSessionCapabilities;
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
  protocol?: ModelProtocol | ModelTransport;
  capabilities?: ModelCapabilities;
  upstream: { url: string; headers: Readonly<Record<string, string>> };
}

export interface RuntimeConnectionOptions {
  publicUrl?: string;
  bindHost?: string;
  bindPort?: number;
  advertiseHost?: string;
  bridge?: { host?: string; publicUrl?: string };
  modelGateway?: {
    host?: string;
    advertiseHost?: string;
    publicUrl?: string;
    requestTimeoutMs?: number;
    maxOutputTokens?: number | null;
    /** Maximum new upstream attempts per Runtime and model alias, including unknown outcomes. */
    maxRequests?: number;
  };
}

export interface OpenSandboxBackendConfig {
  /** Defaults to Pi. Runtime resolves this selection at assembly. */
  executor?: ExecutorSelection;
  sandbox: {
    lifecycleBaseUrl?: string;
    apiKey?: string;
    execdToken?: string;
    endpointHost?: string;
    useServerProxy?: boolean;
    egressMode?: 'dns+nft';
    publicUrl?: string;
    advertiseHost?: string;
    resourceLimits?: { cpu: string; memory: string };
    resourceRequests?: { cpu: string; memory: string };
    commandTimeoutMs?: number;
    /** Sandbox creation lifetime in seconds; safe integer >= 60, default 3600. Provider limits also apply. */
    timeoutSeconds?: number;
  };
  callback?: { host: string; port: number; publicUrl: string };
  bridge: { host: string; publicUrl: string };
  modelGateway: {
    host: string;
    advertiseHost?: string;
    publicUrl?: string;
    requestTimeoutMs?: number;
    /** Cap new upstream attempts per Runtime and model alias, including unknown outcomes. */
    maxRequests?: number;
    /** null preserves executor output parameters without a host token clamp. */
    maxOutputTokens?: number | null;
  };
  models: Readonly<Record<string, ModelConfig>>;
  provider?: SandboxProvider & OpenSandboxProvider;
  isolation: { network: 'api' | 'provider'; disk?: never };
}
