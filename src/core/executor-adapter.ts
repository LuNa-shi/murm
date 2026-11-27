import type { ExecutorCapabilities, ExecutorKind } from './backend-config.js';

export const EXECUTOR_ADAPTER_PROTOCOL = 'murm-executor-v1';

export interface BuiltinExecutorSelection {
  readonly kind: ExecutorKind;
  readonly version?: string;
}

/**
 * Host declaration for a trusted image-installed adapter. The matching guest
 * executable receives newline-delimited JSON RPC on stdin and emits replies
 * and events on stdout. It runs as the Agent UID.
 */
export interface ExecutorAdapter {
  readonly kind: string;
  readonly name: string;
  readonly protocol: typeof EXECUTOR_ADAPTER_PROTOCOL;
  readonly version: string;
  readonly compatibleVersions: readonly string[];
  readonly capabilities: ExecutorCapabilities;
  readonly modelProtocols: readonly string[];
  readonly image: string;
}

export type ExecutorSelection = ExecutorKind | BuiltinExecutorSelection | ExecutorAdapter;

export function snapshotExecutorCapabilities(value: ExecutorCapabilities) {
  if (!value || ![value.activeSteer, value.followUp, value.conditionalInput, value.queuedInputCancellation, value.contextFork]
    .every(flag => typeof flag === 'boolean') || !Array.isArray(value.steeringModes) ||
      !value.steeringModes.length || new Set(value.steeringModes).size !== value.steeringModes.length ||
      value.steeringModes.some(mode => mode !== 'all' && mode !== 'one-at-a-time')) {
    throw new TypeError('Executor capabilities must declare supported input and session operations');
  }
  return Object.freeze({ activeSteer: value.activeSteer, followUp: value.followUp, conditionalInput: value.conditionalInput,
    queuedInputCancellation: value.queuedInputCancellation, contextFork: value.contextFork,
    steeringModes: Object.freeze([...value.steeringModes].sort()) });
}

export function executorVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}
