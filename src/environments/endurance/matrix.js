import { runAgenshHour } from './agensh.js';
import { runScaleMASHour } from './scalemas.js';
import { HOUR_QUOTAS, validateHourBudgets } from './policy.js';

export const HOUR_BUDGETS = Object.freeze({ setupMs: 720_000, workMs: 4_200_000,
  turnMs: 300_000, cleanupMs: 600_000, recoveryMs: 300_000, marginMs: 120_000 });
const peerCounts = Object.freeze({ flat: 4, agensh: 8, scaleMAS: 6 });
const runners = { agensh: runAgenshHour, scaleMAS: runScaleMASHour };
const invalid = code => Object.assign(new Error(code), { code });

/** Serial by default: every configuration retains its own owner through final
 * receipts. Missing workload/lifetime/quota gates are preparation failures,
 * never replaced by fixtures. Controlled clocks are intentionally absent. */
export async function runHourMatrix({ configurations, modes = ['flat', 'agensh', 'scaleMAS'], signal }) {
  if (!configurations || !Array.isArray(modes) || modes.length < 1 || modes.length > 3 ||
      new Set(modes).size !== modes.length || modes.some(mode => !Object.hasOwn(peerCounts, mode))) throw invalid('HOUR_MATRIX_INVALID');
  const results = [];
  for (const mode of modes) {
    signal?.throwIfAborted();
    if (mode === 'flat') {
      results.push({ mode, accepted: false, preflightFailure: { code: 'FLAT_HOUR_WORKLOAD_PENDING' } });
      continue;
    }
    const create = configurations[mode];
    if (typeof create !== 'function') {
      results.push({ mode, accepted: false, preflightFailure: { code: 'HOUR_CONFIGURATION_MISSING' } });
      continue;
    }
    let ports;
    try {
      ports = await create({ mode, peerCount: peerCounts[mode], budgets: HOUR_BUDGETS, quotas: HOUR_QUOTAS, signal });
      const budgets = validateHourBudgets(HOUR_BUDGETS);
      const runSignal = ports.signal ? AbortSignal.any([ports.signal, ...(signal ? [signal] : [])]) : signal;
      results.push(await runners[mode]({ ...ports, budgets, signal: runSignal, clock: undefined, waitForMs: undefined }));
    } catch (error) {
      // A configuration may have opened its sole quota listener before an
      // Environment preflight rejects; retain an explicit close observation.
      let ownerClosed = !ports?.quota;
      if (ports?.quota) try { await ports.quota.close(); ownerClosed = ports.quota.receipt().closed === true; } catch { /* unknown remains false */ }
      let quotaReceipt;
      try { quotaReceipt = ports?.quota?.receipt(); } catch { /* preserve original preflight failure */ }
      results.push({ mode, accepted: false, quota: quotaReceipt, preflightFailure: { code: /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code ?? '') ? error.code : 'HOUR_CONFIGURATION_FAILED' }, ownerClosed });
      break;
    }
    if (results.at(-1).businessFailure || results.at(-1).cleanup?.cleanup !== 'complete') break;
  }
  // Three real, independently reviewed mode results are the minimum matrix;
  // the current pending Flat workload deliberately prevents a blanket claim.
  const accepted = modes.length === 3 && results.length === 3 && results.every(row =>
    !row.preflightFailure && !row.businessFailure && !row.reportSaveFailure && row.result?.state === 'work-and-cleanup-verified');
  return { accepted, results };
}
