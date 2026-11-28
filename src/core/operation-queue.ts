import { MurmError, ERROR_CODES } from '../errors.js';

export interface OperationLimits {
  prepare?: number;
  stop?: number;
  renew?: number;
  reconcile?: number;
  transfer?: number;
  queued?: number;
  waitMs?: number;
}

export function operationLimits(input: OperationLimits = {}) {
  const limits = { prepare: 8, stop: 8, renew: 4, reconcile: 4, transfer: 4, queued: 1024, waitMs: 60_000, ...input };
  for (const key of Object.keys(limits)) {
    const value = limits[key as keyof typeof limits];
    if (!(key === 'prepare' || key === 'stop' || key === 'renew' || key === 'reconcile' || key === 'transfer' || key === 'queued' || key === 'waitMs') ||
        !Number.isSafeInteger(value) || value < 1 || value > (key === 'waitMs' ? 600_000 : 4096)) {
      throw new MurmError(ERROR_CODES.INVALID_CONTRACT, 'Invalid Runtime operation limits');
    }
  }
  return limits;
}

export function operationQueue(concurrency: number, maximumQueued: number, waitMs: number) {
  let active = 0;
  const waiting = new Set<() => void>();

  return {
    get active() { return active; },
    get queued() { return waiting.size; },
    async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      signal?.throwIfAborted();
      if (active >= concurrency) {
        if (waiting.size >= maximumQueued) throw new MurmError(ERROR_CODES.SERVICE_UNAVAILABLE,
          'Runtime operation queue is full', {}, { retryable: true });
        await new Promise<void>((resolve, reject) => {
          function cleanup() {
            waiting.delete(admit);
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
          }
          function abort() {
            cleanup();
            reject(signal?.reason);
          }
          function admit() {
            cleanup();
            active++;
            resolve();
          }
          const timer = setTimeout(() => {
            cleanup();
            reject(new MurmError(ERROR_CODES.SERVICE_TIMEOUT, 'Runtime operation queue wait expired', {}, { retryable: true }));
          }, waitMs);
          waiting.add(admit);
          signal?.addEventListener('abort', abort, { once: true });
        });
      } else {
        active++;
      }
      try {
        signal?.throwIfAborted();
        return await work();
      } finally {
        active--;
        waiting.values().next().value?.();
      }
    },
  };
}
