const failure = code => Object.assign(new Error(code), { code });

/** FIFO host admission for actual inputs, not whole peer lifecycles. Unknown or
 * failed admitted work fences the queue before releasing its permit. */
export function createInputAdmission({ maxConcurrent, maxPending, signal }) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || !Number.isSafeInteger(maxPending) ||
      maxPending < maxConcurrent || maxPending > 8 || !(signal instanceof AbortSignal)) throw new TypeError('Input admission needs bounded capacity and cancellation');
  const waiting = []; let active = 0, closed;
  function close(error = failure('INPUT_ADMISSION_CLOSED')) {
    if (closed) return;
    closed = error;
    for (const row of waiting.splice(0)) row.reject(error);
    signal.removeEventListener('abort', aborted);
  }
  const aborted = () => close(failure('INPUT_ADMISSION_ABORTED'));
  signal.addEventListener('abort', aborted, { once: true });
  if (signal.aborted) aborted();
  async function acquire() {
    if (closed) throw closed;
    if (active < maxConcurrent) { active++; return; }
    if (waiting.length + active >= maxPending) throw failure('INPUT_ADMISSION_LIMIT');
    await new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  }
  function release() {
    active--;
    if (!closed && waiting.length) { active++; waiting.shift().resolve(); }
  }
  return Object.freeze({
    async run(work) {
      if (typeof work !== 'function') throw new TypeError('Input work must be a function');
      await acquire();
      try {
        if (closed) throw closed;
        signal.throwIfAborted();
        return await work();
      } catch (error) { close(error); throw error; }
      finally { release(); }
    },
    close,
    snapshot: () => ({ active, waiting: waiting.length, closed: Boolean(closed) }),
  });
}
