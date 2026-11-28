import type { Runtime } from './types.js';

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
