import type { Runtime } from './types.js';
import type { AgentSessionCapabilities } from './session-types.js';

const fences = new WeakMap<Runtime, () => void>();
export function registerRuntimeAdmissionFence(runtime: Runtime, fence: () => void): void {
  fences.set(runtime, fence);
}
/** Close admission immediately while leaving cleanup with the Runtime owner. */
export function fenceRuntimeAdmissions(runtime: Runtime): void {
  const fence = fences.get(runtime);
  if (!fence) throw new TypeError('Runtime was not created by this SDK');
  fence();
}

type ReceiptQuery = (agentId: string, operation: string, requestId: string) => Promise<unknown>;
const receiptQueries = new WeakMap<Runtime, ReceiptQuery>();
export function registerRuntimeReceiptQuery(runtime: Runtime, query: ReceiptQuery): void {
  receiptQueries.set(runtime, query);
}
/** Query only a previously dispatched operation using its original identity. */
export function reconcileRuntimeReceipt(runtime: Runtime, agentId: string, operation: string, requestId: string): Promise<unknown> {
  const query = receiptQueries.get(runtime);
  if (!query) return Promise.resolve({ status: 'unknown', requestId });
  return query(agentId, operation, requestId);
}

type SessionCapabilityReader = (agentId: string) => AgentSessionCapabilities | undefined;
const sessionCapabilities = new WeakMap<Runtime, SessionCapabilityReader>();
export function registerRuntimeSessionCapabilities(runtime: Runtime, read: SessionCapabilityReader): void {
  sessionCapabilities.set(runtime, read);
}
export function readRuntimeSessionCapabilities(runtime: Runtime, agentId: string): AgentSessionCapabilities | undefined {
  return sessionCapabilities.get(runtime)?.(agentId);
}
