import type {
  RuntimeObservation, RuntimeObservationChange, RuntimeObservationCursor, RuntimeObservationOptions,
  RuntimeObservationSnapshot, RuntimeObservationUpdate,
} from './types.js';

const historyLimit = 256;
const subscriptionLimit = 64;

function problem(code: string, message: string) {
  return Object.assign(new Error(message), { code, operation: 'observe' });
}

export function createRuntimeObservation(runtimeId: string) {
  let sequence = 0;
  const history: Exclude<RuntimeObservationUpdate, { type: 'gap' }>[] = [];
  const subscribers = new Set<() => void>();
  const cursor = (position: number): RuntimeObservationCursor => ({ runtimeId, sequence: position });

  function publish(change: RuntimeObservationChange, recordSeq?: number) {
    history.push({ ...change, schemaVersion: 1, cursor: cursor(++sequence),
      ...(recordSeq === undefined ? {} : { recordSeq }) });
    if (history.length > historyLimit) history.shift();
    for (const notify of subscribers) notify();
  }

  function subscribe(
    { after, signal }: RuntimeObservationOptions,
    snapshot: () => Omit<RuntimeObservationSnapshot, 'schemaVersion' | 'cursor'>,
  ): RuntimeObservation {
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw problem('INVALID_CONTRACT', 'Observation cancellation requires an AbortSignal');
    }
    if (after !== undefined && (after?.runtimeId !== runtimeId ||
        !Number.isSafeInteger(after.sequence) || after.sequence < 0 || after.sequence > sequence)) {
      throw problem('INVALID_CONTRACT', 'The observation cursor must refer to this Runtime and an observed position');
    }
    if (subscribers.size >= subscriptionLimit && !signal?.aborted) {
      throw problem('CONFLICT', 'This Runtime has no free observation subscription');
    }
    let position = after?.sequence ?? sequence;
    const initial = after === undefined ? { ...snapshot(), schemaVersion: 1 as const, cursor: cursor(position) } : null;
    const expiredAtStart = position < sequence - history.length;
    let ended = false;
    let reading = false;
    let waiter: (() => void) | undefined;

    function notify() {
      const wake = waiter;
      waiter = undefined;
      wake?.();
    }

    function cancel() {
      ended = true;
      subscribers.delete(notify);
      signal?.removeEventListener('abort', cancel);
      notify();
    }

    if (signal?.aborted) cancel();
    else {
      subscribers.add(notify);
      signal?.addEventListener('abort', cancel, { once: true });
    }

    const events: AsyncIterableIterator<RuntimeObservationUpdate> = {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        if (reading) throw problem('CONFLICT', 'Only one observation read can wait at a time');
        reading = true;
        try {
          while (!ended) {
            const oldest = sequence - history.length + 1;
            if (position < oldest - 1) {
              cancel();
              return { done: false, value: { type: 'gap', schemaVersion: 1, cursor: cursor(sequence),
                after: cursor(position), reason: expiredAtStart ? 'cursor-expired' : 'slow-consumer' } };
            }
            if (position < sequence) {
              const update = history[position + 1 - oldest];
              position++;
              return { done: false, value: structuredClone(update) };
            }
            await new Promise<void>(resolve => { waiter = resolve; });
          }
          return { done: true, value: undefined };
        } finally {
          reading = false;
        }
      },
      async return() {
        cancel();
        return { done: true, value: undefined };
      },
    };
    return { snapshot: initial, events, cancel };
  }

  return { publish, subscribe };
}
