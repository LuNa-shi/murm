import { randomUUID } from 'node:crypto';

export const WORKER_CONTROL_PROTOCOL = 'murm-control-v1';
export interface WorkerTakeover {
  requestId: string;
  workerInstanceId: string;
  expectedEpoch: number;
  nextEpoch: number;
}
export interface WorkerTakeoverReceipt extends WorkerTakeover { controllerEpoch: number }
function fail(message: string, code = 'NOT_ALLOWED') { return Object.assign(new Error(message), { code }); }

/** One live Worker identity and a replayable compare-and-swap controller fence. */
export function createWorkerControl({ workerInstanceId = randomUUID(), initialEpoch = 0,
  persist = async () => {}, drainTimeoutMs = 15_000 }: {
  workerInstanceId?: string; initialEpoch?: number;
  persist?: (state: { workerInstanceId: string; controllerEpoch: number; receipts: WorkerTakeoverReceipt[] }) => Promise<void>;
  drainTimeoutMs?: number;
} = {}) {
  if (!Number.isSafeInteger(initialEpoch) || initialEpoch < 0) throw fail('Invalid initial Controller epoch', 'INVALID_CONTRACT');
  let epoch = initialEpoch;
  let takeoverPending = false;
  let persistenceUnconfirmed = false;
  let takeoverQueue = Promise.resolve();
  const receipts = new Map<string, WorkerTakeoverReceipt>();
  const active = new Set<Promise<unknown>>();
  function assertEpoch(value: unknown) {
    if (value !== epoch || takeoverPending || persistenceUnconfirmed) throw fail('Worker Controller epoch is fenced');
  }
  return {
    workerInstanceId,
    get controllerEpoch() { return epoch; },
    assertEpoch,
    async run<T>(value: unknown, operation: () => Promise<T>): Promise<T> {
      assertEpoch(value);
      const work = Promise.resolve().then(operation);
      active.add(work);
      try { return await work; } finally { active.delete(work); }
    },
    async takeover(input: WorkerTakeover): Promise<WorkerTakeoverReceipt> {
      if (!input || typeof input.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.requestId) ||
          input.workerInstanceId !== workerInstanceId || !Number.isSafeInteger(input.expectedEpoch) ||
          !Number.isSafeInteger(input.nextEpoch) || input.expectedEpoch < 0 || input.nextEpoch <= input.expectedEpoch) {
        throw fail('Invalid Worker Controller takeover', 'INVALID_CONTRACT');
      }
      const operation = takeoverQueue.then(async () => {
        const existing = receipts.get(input.requestId);
        if (existing) {
          if (existing.workerInstanceId !== input.workerInstanceId || existing.expectedEpoch !== input.expectedEpoch || existing.nextEpoch !== input.nextEpoch) {
            throw fail('Worker takeover identity has different parameters', 'CONFLICT');
          }
          return structuredClone(existing);
        }
        if (epoch !== input.expectedEpoch) throw fail('Worker Controller takeover expected epoch does not match', 'CONFLICT');
        if (receipts.size >= 4096) throw fail('Worker takeover receipt capacity is exhausted', 'SERVICE_UNAVAILABLE');
        takeoverPending = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.allSettled([...active]),
            new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(fail('Worker controls have not drained for takeover', 'SERVICE_UNAVAILABLE')), drainTimeoutMs); }),
          ]);
          const receipt = { ...input, controllerEpoch: input.nextEpoch };
          // Keep receipt and epoch in the same durable write before admitting
          // the new owner or returning a successful takeover response.
          persistenceUnconfirmed = true;
          await persist({ workerInstanceId, controllerEpoch: input.nextEpoch, receipts: [...receipts.values(), receipt] });
          persistenceUnconfirmed = false;
          epoch = input.nextEpoch;
          receipts.set(input.requestId, receipt);
          return structuredClone(receipt);
        } finally {
          clearTimeout(timer);
          takeoverPending = false;
        }
      });
      takeoverQueue = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
}
