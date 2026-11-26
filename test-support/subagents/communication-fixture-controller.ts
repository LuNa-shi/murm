/** Host-owned multi-source routing. Input receipts are never turn-completion receipts. */
export function createSubagentsController(runtime: any, parentId: any, { maxChildren = 2 }: any = {}) {
  if (!Number.isSafeInteger(maxChildren) || maxChildren < 2 || maxChildren > 7) throw new TypeError('Subagents controller requires two to seven children');
  const waiters: any = new Set(); const children: any = new Set();
  let eventSequence = 0; const failures: any = new Set(); const users: any = new Set();
  const deliveries: any[] = []; const parentTurns: any[] = []; const turnEvidence: any = new Map(); const lifecycle: any[] = []; const errors: any[] = [];
  let pendingJobs = 0; let observationOrder = 0;
  let accepting = true; let fenced = false; let parentClosed = false; let work = Promise.resolve();
  const failure = (code: any) => Object.assign(new Error(code), { code });
  function notify() { for (const check of [...waiters]) check(); }
  function enqueue(job: any) {
    pendingJobs++;
    const result = work.then(job).finally(() => { pendingJobs--; });
    work = result.catch((error: any) => { if (errors.length < 8) errors.push({ code: error?.code ?? 'ROUTING_FAILED' }); }).finally(notify);
    return result;
  }
  async function deliver(input: any, requestId: any, source: any) {
    if (deliveries.length >= 32) { accepting = false; throw failure('DELIVERY_LIMIT'); }
    const entry: any = { ...source, requestId, state: 'undelivered' }; deliveries.push(entry);
    if (!accepting || fenced || parentClosed) { entry.reason = !accepting ? 'closing' : fenced ? 'input-unknown' : 'parent-closed'; return entry; }
    const parent = await runtime.get(parentId);
    if (!['idle', 'running'].includes(parent.status)) { parentClosed = true; entry.reason = 'parent-closed'; return entry; }
    try {
      // Record invocation before calling send: a fast settled can precede its receipt.
      entry.dispatchOrder = ++observationOrder;
      entry.receipt = await runtime.send(parentId, input, { requestId, mode: 'followUp' });
      entry.state = entry.receipt.status === 'accepted' ? 'accepted' : 'unknown';
      if (entry.state === 'unknown') fenced = true;
    } catch (error: any) {
      entry.state = 'unknown'; entry.error = { code: error?.code ?? 'SEND_FAILED' }; fenced = true;
      if (error?.inputId) entry.inputId = error.inputId;
    }
    return entry;
  }
  const unsubscribe = runtime.onEvent((value: any) => {
    if (!value.agentId || value.type === 'agentChanged') return;
    const event = { ...value, seq: ++eventSequence };
    if (eventSequence > 256 || Buffer.byteLength(JSON.stringify(event)) > 64 * 1024) {
      accepting = false; if (errors.length < 8 && !errors.some((error: any) => error.code === 'EVENT_LIMIT')) errors.push({ code: 'EVENT_LIMIT' }); notify(); return;
    }
    const snapshot = structuredClone(event);
    const observedOrder = ++observationOrder;
    if (snapshot.agentId === parentId && snapshot.type === 'settled') {
      // Freeze membership in the synchronous callback, not in its later queue job.
      // References may receive a late admission receipt, but future sends never join.
      turnEvidence.set(snapshot.seq, { observedOrder, entries: deliveries.filter((entry: any) => entry.dispatchOrder !== undefined && entry.dispatchOrder < observedOrder) });
    }
    void enqueue(async () => {
      if (snapshot.agentId === parentId) {
        if (snapshot.type === 'settled') parentTurns.push(snapshot);
        if (snapshot.type === 'exit') parentClosed = true;
        return;
      }
      const child = await runtime.get(snapshot.agentId);
      if (child.parentId !== parentId) return;
      children.add(child.id);
      if (children.size > maxChildren) { accepting = false; throw failure('CHILD_LIMIT'); }
      if (snapshot.type === 'exit') lifecycle.push(snapshot);
      const failedTurn = snapshot.type === 'settled' && ['failed', 'aborted'].includes(snapshot.outcome);
      const terminalFailure = snapshot.type === 'error' && snapshot.fatal || snapshot.type === 'exit' && !snapshot.expected;
      if (snapshot.type !== 'settled' && !terminalFailure) return;
      if (terminalFailure && failures.has(snapshot.agentId)) return;
      if (failedTurn || terminalFailure) failures.add(snapshot.agentId);
      else failures.delete(snapshot.agentId);
      const result: any = { childId: snapshot.agentId, eventSeq: snapshot.seq,
        outcome: snapshot.type === 'settled' ? snapshot.outcome : 'failed',
        ...(snapshot.output === undefined ? {} : { output: snapshot.output }),
        ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
        ...(terminalFailure ? { failure: snapshot.type } : {}) };
      await deliver(JSON.stringify(result), `child-result:${snapshot.agentId}:${snapshot.seq}`, { kind: 'child', result, eventOrder: observedOrder });
    }).catch(() => {});
  });
  return Object.freeze({
    submitUser(input: any, { requestId }: any = {}) {
      if (users.size >= 5 || typeof input !== 'string' || Buffer.byteLength(input) > 64 * 1024 || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId ?? '') || users.has(requestId)) {
        throw new TypeError('User input requires text and an unused requestId');
      }
      users.add(requestId);
      return enqueue(() => deliver(input, requestId, { kind: 'user' }));
    },
    drain: () => work,
    waitForFinal({ accept, timeoutMs, signal }: any = {}) {
      if (typeof accept !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new TypeError('Final wait needs a predicate and finite deadline');
      return new Promise<any>((resolve: any, reject: any) => {
        const done = (error: any, result?: any) => { clearTimeout(timer); waiters.delete(check); signal?.removeEventListener('abort', aborted); error ? reject(error) : resolve(structuredClone(result)); };
        const aborted = () => done(failure('WORK_ABORTED'));
        const check = () => {
          try {
            if (signal?.aborted) return aborted();
            if (fenced || errors.length) return done(failure(fenced ? 'INPUT_UNKNOWN' : errors[0].code));
            const event = parentTurns.find((event: any) => event.outcome === 'completed' && accept(event, structuredClone(turnEvidence.get(event.seq).entries.filter((entry: any) => entry.state === 'accepted'))));
            if (event) return done(null, event);
            if (parentClosed) done(failure('PARENT_CLOSED'));
          } catch (error: any) { done(error); }
        };
        const timer = setTimeout(() => done(failure('WORK_DEADLINE')), timeoutMs);
        waiters.add(check); signal?.addEventListener('abort', aborted, { once: true }); check();
      });
    },
    stop() { accepting = false; },
    dispose() { accepting = false; unsubscribe(); },
    report: () => structuredClone({ accepting, fenced, parentClosed, maxChildren, pendingJobs, childIds: [...children], deliveries, parentTurns, parentEvidence: [...turnEvidence].map(([eventSeq, evidence]: any) => ({ eventSeq, observedOrder: evidence.observedOrder, dispatchedRequestIds: evidence.entries.map((entry: any) => entry.requestId) })), lifecycle, errors }),
  });
}
