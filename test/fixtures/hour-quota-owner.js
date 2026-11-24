import { HOUR_QUOTAS } from '../../src/environments/endurance/policy.js';

/** Deterministic accounting port; never forwards a model request. Its callers
 * inject the monitor clock, so this fixture cannot establish real acceptance. */
export function controlledHourQuota(budgets) {
  let closed = false;
  const phases = { ...budgets }; delete phases.turnMs;
  const receipt = { profile: 'endurance', model: 'k3', createdAt: 1, deadlineAt: 1 + budgets.setupMs + budgets.workMs,
    ownerDeadlineAt: 1 + budgets.setupMs + budgets.workMs + budgets.cleanupMs + budgets.recoveryMs + budgets.marginMs,
    frozenPolicy: { ...HOUR_QUOTAS, phases }, forwarded: 1, committedOutputTokens: 1,
    reservedInputBytes: 1, peakConcurrent: 1, rejectedArrivals: 0, activeRequests: 0,
    outstandingOutputTokens: 0, requests: [{ status: 'complete', terminal: true, usage: { outputTokens: 1 } }] };
  return { receipt: () => structuredClone({ ...receipt, admissionClosed: closed, closed }),
    close: async () => { closed = true; } };
}
