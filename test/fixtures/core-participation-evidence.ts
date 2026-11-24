import { runInput } from '../../src/environments/shared/run-input.js';

// Test/host preparation only. The host owns this Runtime's exclusive input
// sources. Correlation uses runInput's idle, followUp and unresolved-input guards;
// Core settled events have no inputId and cannot prove queued input consumption.
// now defaults to the host monotonic clock; only deterministic tests substitute it.
// Receipts prove input completion, never elapsed-hour, business or resource validity.
export function createCoreParticipationEvidence({ runtime, botIds, clockId, now = () => performance.now(), maxInputs }) {
  const fail = code => Object.assign(new Error(code), { code });
  if (!runtime?.id || typeof runtime.get !== 'function' || typeof runtime.onEvent !== 'function' ||
      !Array.isArray(botIds) || !botIds.length || botIds.some(id => typeof id !== 'string' || !id) || new Set(botIds).size !== botIds.length ||
      typeof clockId !== 'string' || !clockId || typeof now !== 'function' || !Number.isSafeInteger(maxInputs) || maxInputs < 1 || maxInputs > 10000) throw new TypeError('Participation evidence requires a fixed team, clock and input bound');
  const members = new Set(botIds), completed = [], active = new Set();
  let attempts = 0, lastAtMs = -Infinity;
  function observeTime() {
    const atMs = now();
    if (typeof atMs !== 'number' || !Number.isFinite(atMs) || atMs < 0 || atMs < lastAtMs) throw fail('INVALID_MONOTONIC_OBSERVATION');
    lastAtMs = atMs; return atMs;
  }
  const failures = [];
  return {
    snapshot: () => structuredClone({ runtimeId: runtime.id, clockId, maxInputs, attempts, pendingBotIds: [...active], completed, failures }),
    async run(botId, input, options) {
      if (!members.has(botId)) throw fail('FOREIGN_PARTICIPANT');
      if (active.has(botId)) throw fail('concurrent_wait_for_bot');
      if (attempts >= maxInputs) throw fail('PARTICIPATION_INPUT_LIMIT');
      observeTime(); attempts++; active.add(botId);
      let unsubscribe;
      try {
        const before = await runtime.get(botId);
        const observations = new Map(); let observationError;
        unsubscribe = runtime.onEvent(event => {
          if (event.botId !== botId || event.type !== 'settled' || event.seq <= before.cursor) return;
          try {
            if (observations.size >= 16) throw fail('PARTICIPATION_EVENT_LIMIT');
            observations.set(event.seq, { atMs: observeTime(), outcome: event.outcome });
          } catch (error) { observationError = error; }
        });
        const result = await runInput(runtime, botId, input, options);
        if (observationError) throw observationError;
        const observed = observations.get(result.settled.seq);
        if (!observed || observed.outcome !== 'completed' || result.settled.botId !== botId || result.inputId !== result.receipt.inputId ||
            result.receipt.status !== 'accepted' || result.receipt.disposition !== 'started') throw fail('UNCONFIRMED_PARTICIPATION');
        const evidence = { runtimeId: runtime.id, clockId, botId, requestId: options.requestId, inputId: result.inputId, seq: result.settled.seq, atMs: observed.atMs };
        completed.push(evidence);
        return { result, evidence: structuredClone(evidence) };
      } catch (error) {
        failures.push({ botId, requestId: typeof options?.requestId === 'string' ? options.requestId : null,
          code: typeof error?.code === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'PARTICIPATION_FAILED' });
        throw error;
      } finally { unsubscribe?.(); active.delete(botId); }
    },
  };
}
