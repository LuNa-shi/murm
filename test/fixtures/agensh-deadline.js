const failure = code => Object.assign(new Error(code), { code });

// Test-owned absolute budget. Every allocation checks it before dispatch; a
// timed-out mutation may have happened and must retain its recorded ownership.
export function createDeadline(milliseconds, code) {
  const controller = new AbortController();
  const deadlineAt = Date.now() + milliseconds;
  let expired = false;
  const expire = () => { expired = true; controller.abort(failure(code)); };
  const timer = setTimeout(expire, milliseconds);
  function remaining(cap = milliseconds) {
    if (expired || controller.signal.aborted || Date.now() >= deadlineAt) { expire(); throw failure(code); }
    return Math.max(1, Math.min(cap, deadlineAt - Date.now()));
  }
  return {
    signal: controller.signal,
    remaining,
    abort: () => controller.abort(failure(code)),
    expired: () => expired || Date.now() >= deadlineAt,
    async step(operation, cap) {
      const timeoutMs = remaining(cap);
      try {
        const result = await operation({ timeoutMs, signal: controller.signal });
        remaining();
        return result;
      } catch (error) { remaining(); throw error; }
    },
    dispose: () => clearTimeout(timer),
  };
}

// A factory cannot necessarily be cancelled. Adopt a late result only for
// cleanup, and never allow it to dispatch input after the work budget ends.
export function createWorkGate(milliseconds, code = 'ACTUAL_PEER_WORK_EXPIRED') {
  const deadline = createDeadline(milliseconds, code);
  let environment;
  const close = () => { void environment?.close({ timeoutMs: 1 }).catch(() => {}); };
  deadline.signal.addEventListener('abort', close, { once: true });
  return {
    ...deadline,
    async create(factory) {
      deadline.remaining();
      environment = await factory();
      try { deadline.remaining(); } catch (error) { close(); throw error; }
      return environment;
    },
    runInput(input, options) {
      const timeoutMs = deadline.remaining(options.timeoutMs);
      return environment.runInput(input, { ...options, timeoutMs, signal: deadline.signal });
    },
    environment: () => environment,
  };
}
