/** Environment ownership only. Shared data is retained; adapters own secrets. */
export function createOwnedResources({ timeoutMs = 10_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('Invalid resource cleanup bound');
  const rows = [];
  let closing;
  const snapshot = () => rows.map(({ kind, id, state, error }) => ({ kind, id, state, ...(error ? { error } : {}) }));
  async function closeOne(row) {
    if (row.state === 'closed' || row.state === 'retained') return;
    if (!row.work) {
      row.work = Promise.resolve().then(row.close).then(() => { row.state = 'closed'; row.error = undefined; }, () => {
        row.state = 'pending'; row.error = { code: 'RESOURCE_CLEANUP_FAILED', retryable: true }; row.work = undefined;
      });
    }
    let timer;
    try { await Promise.race([row.work, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
    finally { clearTimeout(timer); }
    if (row.state !== 'closed') { row.state = 'pending'; row.error ??= { code: 'RESOURCE_CLEANUP_UNKNOWN', retryable: false }; }
  }
  return Object.freeze({
    own({ kind, id, close, retained = false }) {
      if (closing || ![kind, id].every(value => typeof value === 'string' && value) || (!retained && typeof close !== 'function') || rows.some(row => row.kind === kind && row.id === id)) throw new TypeError('Invalid owned resource');
      rows.push({ kind, id, close, state: retained ? 'retained' : 'owned' });
    },
    snapshot,
    close() {
      if (!closing) closing = Promise.all([...rows].reverse().map(closeOne)).then(() => {
        const pending = snapshot().filter(row => row.state === 'pending');
        return { cleanup: pending.length ? 'pending' : 'complete', pending, resources: snapshot() };
      }).finally(() => { closing = undefined; });
      return closing;
    },
  });
}
