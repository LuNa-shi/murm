const failure = code => Object.assign(new Error(code), { code });

// One absolute budget; operations that ignore cancellation remain tracked by
// their owner, while this host stops waiting and never dispatches a next step.
export function createDeadline(milliseconds, code, deadlineAt = Date.now() + milliseconds) {
  const controller = new AbortController();
  let expired = false;
  const expire = () => { expired = true; controller.abort(failure(code)); };
  const timer = setTimeout(expire, Math.max(0, deadlineAt - Date.now()));
  function remaining(cap = milliseconds) {
    if (expired || Date.now() >= deadlineAt) { expire(); throw failure(code); }
    if (controller.signal.aborted) throw failure(code);
    return Math.max(1, Math.min(cap, deadlineAt - Date.now()));
  }
  return {
    deadlineAt, signal: controller.signal, remaining,
    abort: () => controller.abort(failure(code)),
    expired: () => expired || Date.now() >= deadlineAt,
    async step(operation, cap) {
      const timeoutMs = remaining(cap);
      let abort;
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => { remaining(); return operation({ timeoutMs, signal: controller.signal }); }),
          new Promise((_, reject) => { abort = () => reject(failure(code)); controller.signal.addEventListener('abort', abort, { once: true }); }),
        ]);
        remaining(); return result;
      } catch (error) { remaining(); throw error; }
      finally { controller.signal.removeEventListener('abort', abort); }
    },
    dispose: () => clearTimeout(timer),
  };
}

export function createCleanupBudget(milliseconds = 80_000) {
  let deadline;
  return {
    start(at = Date.now()) { deadline ??= createDeadline(milliseconds, 'ACTUAL_PEER_CLEANUP_EXPIRED', at + milliseconds); return this; },
    started: () => Boolean(deadline),
    remaining(cap) { this.start(); return deadline.remaining(cap); },
    step(operation, cap) { this.start(); return deadline.step(operation, cap); },
    receipt: () => ({ started: Boolean(deadline), deadlineAt: deadline?.deadlineAt, expired: deadline?.expired() ?? false }),
    dispose: () => deadline?.dispose(),
  };
}

// Factory cancellation and safe ownership are separate observations. An abort
// wins promptly; only awaitCreation within the SAME cleanup budget can permit
// later facility teardown. Late callbacks never dispatch cleanup themselves.
export function createWorkGate(milliseconds, code = 'ACTUAL_PEER_WORK_EXPIRED', cleanup = createCleanupBudget()) {
  const deadline = createDeadline(milliseconds, code);
  let harness, creation, creationError, state = 'not-started', finished = false, expiredOnFinish = false;
  deadline.signal.addEventListener('abort', () => {
    const now = Date.now();
    cleanup.start(deadline.expired() ? deadline.deadlineAt : Math.min(now, deadline.deadlineAt));
  }, { once: true });
  return {
    ...deadline, cleanup,
    expired: () => finished ? expiredOnFinish : deadline.expired(),
    finish() { if (finished) return; expiredOnFinish = deadline.expired(); finished = true; deadline.dispose(); cleanup.start(); },
    async create(factory) {
      deadline.remaining(); state = 'pending';
      creation = Promise.resolve().then(() => { deadline.remaining(); return factory(); }).then(value => { harness = value; state = 'owned'; return value; }, error => { creationError = error; state = 'failed'; throw error; });
      // Attach the rejection handler before racing an abort/timeout.
      void creation.catch(() => {});
      return deadline.step(() => creation);
    },
    async awaitCreation() {
      cleanup.start();
      if (state === 'pending') {
        try { await cleanup.step(() => creation); } catch { /* State distinguishes safe failure from still-pending ownership. */ }
      }
      return { state, harness, error: creationError };
    },
    ownership: () => ({ state, ...(creationError?.cleanup ? { cleanup: creationError.cleanup } : {}) }),
    runInput(input, options) {
      if (finished) throw failure(code);
      const timeoutMs = deadline.remaining(options.timeoutMs);
      return harness.runInput(input, { ...options, timeoutMs, signal: deadline.signal });
    },
    harness: () => harness,
  };
}
