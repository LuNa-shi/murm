export interface ResourceError { code: string; retryable: boolean }
interface ResourceRegistration { kind: string; id: string; close?: () => unknown | PromiseLike<unknown>; retained?: boolean }
interface OwnedResource extends ResourceRegistration {
  state: 'owned' | 'retained' | 'closed' | 'pending';
  error?: ResourceError;
  work?: Promise<void>;
}

/** Environment ownership only. Shared data is retained; adapters own secrets. */
export function createOwnedResources({ timeoutMs = 10_000 }: { timeoutMs?: number } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('Invalid resource cleanup bound');
  const rows: OwnedResource[] = [];
  let closing: Promise<{ cleanup: string; pending: ReturnType<typeof snapshot>; resources: ReturnType<typeof snapshot> }> | undefined;
  const snapshot = () => rows.map(({ kind, id, state, error }) => ({ kind, id, state, ...(error ? { error } : {}) }));
  async function closeOne(row: OwnedResource) {
    if (row.state === 'closed' || row.state === 'retained') return;
    if (!row.work) {
      row.work = Promise.resolve().then(row.close).then(() => { row.state = 'closed'; row.error = undefined; }, () => {
        row.state = 'pending'; row.error = { code: 'RESOURCE_CLEANUP_FAILED', retryable: true }; row.work = undefined;
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([row.work, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]); }
    finally { clearTimeout(timer); }
    if ((row as OwnedResource).state !== 'closed') { row.state = 'pending'; row.error ??= { code: 'RESOURCE_CLEANUP_UNKNOWN', retryable: false }; }
  }
  return Object.freeze({
    own({ kind, id, close, retained = false }: ResourceRegistration) {
      if (closing || ![kind, id].every((value) => typeof value === 'string' && value) || (!retained && typeof close !== 'function') || rows.some((row) => row.kind === kind && row.id === id)) throw new TypeError('Invalid owned resource');
      rows.push({ kind, id, close, state: retained ? 'retained' : 'owned' });
    },
    snapshot,
    close() {
      if (!closing) closing = Promise.all([...rows].reverse().map(closeOne)).then(() => {
        const pending = snapshot().filter((row) => row.state === 'pending');
        return { cleanup: pending.length ? 'pending' : 'complete', pending, resources: snapshot() };
      }).finally(() => { closing = undefined; });
      return closing;
    },
  });
}
