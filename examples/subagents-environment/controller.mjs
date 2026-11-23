/** Host-owned multi-source routing. Input receipts are never turn-completion receipts. */
export function createSubagentsController(runtime, parentId, { maxChildren = 2 } = {}) {
  if (!Number.isSafeInteger(maxChildren) || maxChildren < 2 || maxChildren > 7) throw new TypeError('Subagents controller requires two to seven children');
  const waiters = new Set(); const children = new Set();
  const seen = new Set(); const failures = new Set(); const users = new Set();
  const deliveries = []; const parentTurns = []; const turnEvidence = new Map(); const lifecycle = []; const errors = [];
  let pendingJobs = 0; let observationOrder = 0;
  let accepting = true; let fenced = false; let parentClosed = false; let work = Promise.resolve();
  const failure = code => Object.assign(new Error(code), { code });
  function notify() { for (const check of [...waiters]) check(); }
  function enqueue(job) {
    pendingJobs++;
    const result = work.then(job).finally(() => { pendingJobs--; });
    work = result.catch(error => { if (errors.length < 8) errors.push({ code: error?.code ?? 'ROUTING_FAILED' }); }).finally(notify);
    return result;
  }
  async function deliver(input, requestId, source) {
    if (deliveries.length >= 32) { accepting = false; throw failure('DELIVERY_LIMIT'); }
    const entry = { ...source, requestId, state: 'undelivered' }; deliveries.push(entry);
    if (!accepting || fenced || parentClosed) { entry.reason = !accepting ? 'closing' : fenced ? 'input-unknown' : 'parent-closed'; return entry; }
    const parent = await runtime.get(parentId);
    if (!['idle', 'running'].includes(parent.status)) { parentClosed = true; entry.reason = 'parent-closed'; return entry; }
    try {
      // Record invocation before calling send: a fast settled can precede its receipt.
      entry.dispatchOrder = ++observationOrder;
      entry.receipt = await runtime.send(parentId, input, { requestId, mode: 'followUp' });
      entry.state = entry.receipt.status === 'accepted' ? 'accepted' : 'unknown';
      if (entry.state === 'unknown') fenced = true;
    } catch (error) {
      entry.state = 'unknown'; entry.error = { code: error?.code ?? 'SEND_FAILED' }; fenced = true;
      if (error?.inputId) entry.inputId = error.inputId;
    }
    return entry;
  }
  const unsubscribe = runtime.onEvent(event => {
    const key = `${event.botId}:${event.seq}`;
    if (seen.has(key)) return;
    if (seen.size >= 256 || Buffer.byteLength(JSON.stringify(event)) > 64 * 1024) {
      accepting = false; if (errors.length < 8 && !errors.some(error => error.code === 'EVENT_LIMIT')) errors.push({ code: 'EVENT_LIMIT' }); notify(); return;
    }
    seen.add(key);
    const snapshot = structuredClone(event);
    const observedOrder = ++observationOrder;
    if (snapshot.botId === parentId && snapshot.type === 'settled') {
      // Freeze membership in the synchronous callback, not in its later queue job.
      // References may receive a late admission receipt, but future sends never join.
      turnEvidence.set(snapshot.seq, { observedOrder, entries: deliveries.filter(entry => entry.dispatchOrder !== undefined && entry.dispatchOrder < observedOrder) });
    }
    void enqueue(async () => {
      if (snapshot.botId === parentId) {
        if (snapshot.type === 'settled') parentTurns.push(snapshot);
        if (snapshot.type === 'exit') parentClosed = true;
        return;
      }
      const child = await runtime.get(snapshot.botId);
      if (child.parentId !== parentId) return;
      children.add(child.id);
      if (children.size > maxChildren) { accepting = false; throw failure('CHILD_LIMIT'); }
      if (snapshot.type === 'exit') lifecycle.push(snapshot);
      const failedTurn = snapshot.type === 'settled' && ['failed', 'aborted'].includes(snapshot.outcome);
      const terminalFailure = snapshot.type === 'error' && snapshot.fatal || snapshot.type === 'exit' && !snapshot.expected;
      if (snapshot.type !== 'settled' && !terminalFailure) return;
      if (terminalFailure && failures.has(snapshot.botId)) return;
      if (failedTurn || terminalFailure) failures.add(snapshot.botId);
      else failures.delete(snapshot.botId);
      const result = { childId: snapshot.botId, eventSeq: snapshot.seq,
        outcome: snapshot.type === 'settled' ? snapshot.outcome : 'failed',
        ...(snapshot.output === undefined ? {} : { output: snapshot.output }),
        ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
        ...(terminalFailure ? { failure: snapshot.type } : {}) };
      await deliver(JSON.stringify(result), `child-result:${snapshot.botId}:${snapshot.seq}`, { kind: 'child', result });
    }).catch(() => {});
  });
  return Object.freeze({
    submitUser(input, { requestId } = {}) {
      if (users.size >= 5 || typeof input !== 'string' || Buffer.byteLength(input) > 64 * 1024 || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId ?? '') || users.has(requestId)) {
        throw new TypeError('User input requires text and an unused requestId');
      }
      users.add(requestId);
      return enqueue(() => deliver(input, requestId, { kind: 'user' }));
    },
    drain: () => work,
    waitForFinal({ accept, timeoutMs, signal } = {}) {
      if (typeof accept !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new TypeError('Final wait needs a predicate and finite deadline');
      return new Promise((resolve, reject) => {
        const done = (error, result) => { clearTimeout(timer); waiters.delete(check); signal?.removeEventListener('abort', aborted); error ? reject(error) : resolve(structuredClone(result)); };
        const aborted = () => done(failure('WORK_ABORTED'));
        const check = () => {
          try {
            if (signal?.aborted) return aborted();
            if (fenced || errors.length) return done(failure(fenced ? 'INPUT_UNKNOWN' : errors[0].code));
            const event = parentTurns.find(event => event.outcome === 'completed' && accept(event, structuredClone(turnEvidence.get(event.seq).entries.filter(entry => entry.state === 'accepted'))));
            if (event) return done(null, event);
            if (parentClosed) done(failure('PARENT_CLOSED'));
          } catch (error) { done(error); }
        };
        const timer = setTimeout(() => done(failure('WORK_DEADLINE')), timeoutMs);
        waiters.add(check); signal?.addEventListener('abort', aborted, { once: true }); check();
      });
    },
    stop() { accepting = false; },
    dispose() { accepting = false; unsubscribe(); },
    report: () => structuredClone({ accepting, fenced, parentClosed, maxChildren, pendingJobs, childIds: [...children], deliveries, parentTurns, parentEvidence: [...turnEvidence].map(([eventSeq, evidence]) => ({ eventSeq, observedOrder: evidence.observedOrder, dispatchedRequestIds: evidence.entries.map(entry => entry.requestId) })), lifecycle, errors }),
  });
}
