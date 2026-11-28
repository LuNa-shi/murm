import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

export async function finishCleanup<T extends { cleanup: 'complete' | 'pending'; errors: readonly { retryable: boolean }[] }>(
  operation: (timeoutMs: number) => Promise<T>, deadline: number,
) {
  let remaining = Math.max(1, Math.ceil(deadline - performance.now()));
  let receipt = await operation(remaining);
  while (receipt.cleanup === 'pending' && !receipt.errors.some(error => !error.retryable)) {
    remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) break;
    await delay(Math.min(remaining, 500));
    remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) break;
    receipt = await operation(remaining);
  }
  return receipt;
}
