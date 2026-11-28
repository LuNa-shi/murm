import { randomUUID } from 'node:crypto';

export const WORKER_EVENT_PROTOCOL = 'murm-events-v1';
export interface WorkerEvent {
  worker_sequence: number;
  worker_at: string;
  type: string;
  [key: string]: unknown;
}
export interface WorkerEventCursor {
  workerInstanceId: string;
  streamEpoch: string;
  afterSequence: number;
  waitMs?: number;
  maxRecords?: number;
  maxBytes?: number;
}
export interface WorkerEventPage {
  workerInstanceId: string;
  streamEpoch: string;
  records: WorkerEvent[];
  firstSequence: number | null;
  nextSequence: number;
  historyFloor: number;
  lastSequence: number;
  hasMore: boolean;
  gap: boolean;
  reason?: 'instance-changed' | 'history-expired' | 'cursor-ahead' | 'record-too-large';
}

function invalid(message: string) {
  return Object.assign(new Error(message), { code: 'INVALID_CONTRACT' });
}
function bound(value: unknown, fallback: number, min: number, max: number) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || (selected as number) < min || (selected as number) > max) {
    throw invalid('Worker event request exceeds its bounded limits');
  }
  return selected as number;
}

/** A byte-bounded replay window. A gap is explicit and never advances the caller cursor. */
export function createWorkerEventStream({ workerInstanceId = randomUUID(), streamEpoch = randomUUID(),
  maxRecords = 2048, maxBytes = 8 * 1024 * 1024 }: {
  workerInstanceId?: string; streamEpoch?: string; maxRecords?: number; maxBytes?: number;
} = {}) {
  bound(maxRecords, 2048, 1, 65536);
  bound(maxBytes, 8 * 1024 * 1024, 1, 64 * 1024 * 1024);
  let sequence = 0;
  let bytes = 0;
  let closed = false;
  const history: { event: WorkerEvent; bytes: number }[] = [];
  const waiters = new Set<() => void>();
  const wake = () => { for (const notify of [...waiters]) notify(); };
  function read(input: WorkerEventCursor): WorkerEventPage {
    const after = bound(input.afterSequence, 0, 0, Number.MAX_SAFE_INTEGER);
    const count = bound(input.maxRecords, 128, 1, 1024);
    const limit = bound(input.maxBytes, 1024 * 1024, 1024, 4 * 1024 * 1024);
    const floor = history[0]?.event.worker_sequence ?? sequence + 1;
    const page: WorkerEventPage = { workerInstanceId, streamEpoch, records: [], firstSequence: null,
      nextSequence: after, historyFloor: floor, lastSequence: sequence, hasMore: false, gap: false };
    const reason = input.workerInstanceId !== workerInstanceId || input.streamEpoch !== streamEpoch ? 'instance-changed' :
      after < floor - 1 ? 'history-expired' : after > sequence ? 'cursor-ahead' : undefined;
    if (reason) return { ...page, gap: true, reason };
    let size = 0;
    for (const row of history) {
      if (row.event.worker_sequence <= after) continue;
      if (row.bytes > limit && !page.records.length) return { ...page, gap: true, reason: 'record-too-large' };
      if (page.records.length === count || size + row.bytes > limit) break;
      page.records.push(structuredClone(row.event));
      size += row.bytes;
      page.nextSequence = row.event.worker_sequence;
    }
    page.firstSequence = page.records[0]?.worker_sequence ?? null;
    page.hasMore = page.nextSequence < sequence;
    return page;
  }
  return {
    workerInstanceId, streamEpoch,
    get sequence() { return sequence; },
    get records() { return history.map(row => row.event); },
    snapshot() { return { bytes, records: history.length, waiters: waiters.size, sequence, closed }; },
    publish(record: { type: string; [key: string]: unknown }): WorkerEvent {
      const event = { ...structuredClone(record), worker_sequence: ++sequence, worker_at: new Date().toISOString() };
      const size = Buffer.byteLength(JSON.stringify(event));
      history.push({ event, bytes: size });
      bytes += size;
      while (history.length > maxRecords || bytes > maxBytes) bytes -= history.shift()!.bytes;
      wake();
      return event;
    },
    invalidate(record: { type: string; [key: string]: unknown }) {
      // Reserve an unobservable sequence for discarded source bytes. Every
      // previously committed cursor then receives an explicit history gap.
      sequence++;
      history.length = 0;
      bytes = 0;
      return this.publish(record);
    },
    read,
    async poll(input: WorkerEventCursor, signal?: AbortSignal): Promise<WorkerEventPage> {
      const waitMs = bound(input.waitMs, 25_000, 0, 30_000);
      const current = read(input);
      signal?.throwIfAborted();
      if (closed || !waitMs || current.gap || current.records.length) return current;
      if (waiters.size) throw Object.assign(new Error('Worker already has a suspended event read'), { code: 'SERVICE_UNAVAILABLE' });
      // Register and recheck synchronously. An event cannot disappear between
      // the empty read and waiter installation on the Worker event loop.
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const finish = (error?: unknown) => {
          clearTimeout(timer);
          waiters.delete(notify);
          signal?.removeEventListener('abort', abort);
          if (error) reject(error); else resolve();
        };
        const notify = () => finish();
        const abort = () => finish(signal?.reason ?? new Error('Worker event read cancelled'));
        waiters.add(notify);
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(notify, waitMs);
        if (closed || sequence !== current.lastSequence) notify();
      });
      signal?.throwIfAborted();
      return read(input);
    },
    close() { closed = true; wake(); },
  };
}

/** Validate identity, continuity and bounded page size before committing its cursor. */
export function validateWorkerEventPage(value: unknown, cursor: WorkerEventCursor): WorkerEventPage {
  if (!value || typeof value !== 'object') throw invalid('Worker event response is missing');
  const page = value as WorkerEventPage;
  if (page.workerInstanceId !== cursor.workerInstanceId || page.streamEpoch !== cursor.streamEpoch) {
    throw Object.assign(new Error('Worker event instance changed'), { code: 'EVENT_GAP' });
  }
  if (page.gap) throw Object.assign(new Error('Worker event history cannot resume from the committed cursor'), { code: 'EVENT_GAP', reason: page.reason });
  if (!Array.isArray(page.records) || page.records.length > (cursor.maxRecords ?? 128) ||
      Buffer.byteLength(JSON.stringify(page.records)) > (cursor.maxBytes ?? 1024 * 1024) + 1024 ||
      !Number.isSafeInteger(page.lastSequence) || !Number.isSafeInteger(page.historyFloor) ||
      page.historyFloor < 1 || page.historyFloor > page.lastSequence + 1 ||
      typeof page.hasMore !== 'boolean') throw invalid('Worker event response exceeds its contract');
  let expected = cursor.afterSequence;
  for (const record of page.records) {
    if (!record || record.worker_sequence !== ++expected || typeof record.type !== 'string') {
      throw Object.assign(new Error('Worker event response has a sequence gap'), { code: 'EVENT_GAP' });
    }
  }
  if (page.nextSequence !== expected || page.firstSequence !== (page.records[0]?.worker_sequence ?? null) ||
      page.lastSequence < expected || page.historyFloor > cursor.afterSequence + 1 ||
      page.hasMore !== (expected < page.lastSequence)) throw invalid('Worker event response has inconsistent cursor metadata');
  return page;
}
