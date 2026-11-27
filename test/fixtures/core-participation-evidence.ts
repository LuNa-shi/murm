import { runInput } from '../../src/harnesses/shared/run-input.js';

// Test/host preparation only. The host owns this Runtime's exclusive input
// sources. Correlation uses runInput's idle, followUp and unresolved-input guards;
// Core settled events have no inputId and cannot prove queued input consumption.
// now defaults to the host monotonic clock; only deterministic tests substitute it.
// Receipts prove input completion, never elapsed-hour, business or resource validity.
export function createCoreParticipationEvidence({ runtime, agentIds, clockId, now = () => performance.now(), maxInputs }) {
  const fail = code => Object.assign(new Error(code), { code });
  if (!runtime?.id || typeof runtime.get !== 'function' || typeof runtime.onEvent !== 'function' ||
      !Array.isArray(agentIds) || !agentIds.length || agentIds.some(id => typeof id !== 'string' || !id) || new Set(agentIds).size !== agentIds.length ||
      typeof clockId !== 'string' || !clockId || typeof now !== 'function' || !Number.isSafeInteger(maxInputs) || maxInputs < 1 || maxInputs > 10000) throw new TypeError('Participation evidence requires a fixed team, clock and input bound');
  const members = new Set(agentIds), completed = [], active = new Set();
  let attempts = 0, observationSequence = 0, lastAtMs = -Infinity;
  function observeTime() {
    const atMs = now();
    if (typeof atMs !== 'number' || !Number.isFinite(atMs) || atMs < 0 || atMs < lastAtMs) throw fail('INVALID_MONOTONIC_OBSERVATION');
    lastAtMs = atMs; return atMs;
  }
  const failures = [];
  return {
    snapshot: () => structuredClone({ runtimeId: runtime.id, clockId, maxInputs, attempts, pendingAgentIds: [...active], completed, failures }),
    async run(agentId, input, options) {
      if (!members.has(agentId)) throw fail('FOREIGN_PARTICIPANT');
      if (active.has(agentId)) throw fail('concurrent_wait_for_agent');
      if (attempts >= maxInputs) throw fail('PARTICIPATION_INPUT_LIMIT');
      observeTime(); attempts++; active.add(agentId);
      let unsubscribe;
      try {
        let observed, observationError, submitted = false;
        unsubscribe = runtime.onEvent(event => {
          if (!submitted || observed || observationError || event.agentId !== agentId || event.type !== 'settled') return;
          try { observed = { atMs: observeTime(), seq: ++observationSequence, outcome: event.outcome }; }
          catch (error) { observationError = error; }
        });
        const result = await runInput(runtime, agentId, input, { ...options, beforeSend() {
          options.beforeSend?.();
          submitted = true;
        } });
        if (observationError) throw observationError;
        if (!observed || observed.outcome !== 'completed' || result.settled.agentId !== agentId || result.inputId !== result.receipt.inputId ||
            result.receipt.status !== 'accepted' || result.receipt.disposition !== 'started') throw fail('UNCONFIRMED_PARTICIPATION');
        const evidence = { runtimeId: runtime.id, clockId, agentId, requestId: options.requestId, inputId: result.inputId, seq: observed.seq, atMs: observed.atMs };
        completed.push(evidence);
        return { result, evidence: structuredClone(evidence) };
      } catch (error) {
        failures.push({ agentId, requestId: typeof options?.requestId === 'string' ? options.requestId : null,
          code: typeof error?.code === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'PARTICIPATION_FAILED' });
        throw error;
      } finally { unsubscribe?.(); active.delete(agentId); }
    },
  };
}
