// Fixed acceptance preparation only: no business input or actual-hour verdict.
export const lifetimeProbePlan = Object.freeze({ agents: 4, timeoutSeconds: 5100,
  resourceLimits: Object.freeze({ cpu: '1', memory: '1Gi' }),
  modelGatewayLimits: Object.freeze({ requestTimeoutMs: 1000, maxOutputTokens: 16 }),
  workMs: 3600000, cleanupMs: 180000, recoveryMs: 300000, marginMs: 120000 });

// Every phase shares the clock started before Runtime assembly. Factories are
// admitted before dispatch, so exhausted setup cannot launch new allocations.
export function createLifetimeProbeBudget({ now = () => performance.now() } = {}) {
  const started = now();
  return {
    elapsedMs: () => now() - started,
    async run(factory, cutoffMs) {
      const remaining = cutoffMs - (now() - started);
      if (remaining <= 0) throw Error('LIFETIME_PROBE_TIMEOUT');
      let timer;
      try {
        return await Promise.race([Promise.resolve().then(() => { if (now() - started >= cutoffMs) throw Error('LIFETIME_PROBE_TIMEOUT'); return factory(); }), new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('LIFETIME_PROBE_TIMEOUT')), remaining);
        })]);
      } finally { clearTimeout(timer); }
    },
  };
}

export async function runLifetimeProbe({ runtime, admit, verifyDeleted, upstreamRequests, budget }) {
  let admission, close, failed = false;
  try {
    const agents = await budget.run(() => Promise.all(Array.from({ length: lifetimeProbePlan.agents }, (_, i) =>
      runtime.spawn({ profile: 'worker', requestId: `lifetime-${i}` }))), 100000);
    if (agents.some(agent => agent.status !== 'idle') || upstreamRequests() !== 0) throw new Error('LIFETIME_NOT_IDLE');
    admission = await budget.run(() => admit(agents.map(agent => agent.id)), 110000);
    if (admission.resources.length !== lifetimeProbePlan.agents || admission.resources.some(row => row.requestedSeconds !== lifetimeProbePlan.timeoutSeconds ||
        row.expiresAtMs - admission.observedAtMs < lifetimeProbePlan.workMs + lifetimeProbePlan.cleanupMs + lifetimeProbePlan.recoveryMs + lifetimeProbePlan.marginMs) ||
        admission.stopAtMs < admission.workDeadlineAtMs) throw new Error('LIFETIME_PLAN_NOT_COVERED');
  } catch { failed = true; }
  // close owns late allocation reconciliation even when startup has timed out.
  try {
    close = await budget.run(() => runtime.close({ timeoutMs: Math.min(45000, Math.max(1, 160000 - budget.elapsedMs())) }), 160000);
    if (close.cleanup !== 'complete' || close.agents.length !== lifetimeProbePlan.agents || close.agents.some(agent => agent.execution !== 'stopped' || agent.cleanup !== 'complete')) failed = true;
  } catch { failed = true; }
  let deletion;
  try { deletion = await budget.run(() => verifyDeleted(admission), 170000); if (!deletion.complete) failed = true; }
  catch { failed = true; }
  const requests = upstreamRequests();
  return { status: failed || requests !== 0 || !admission ? 'failed' : 'passed', plan: lifetimeProbePlan,
    admission: admission ?? null, close: close ? { cleanup: close.cleanup, agents: close.agents.map(({ agentId, execution, cleanup }) => ({ agentId, execution, cleanup })) } : null, deletion: deletion ?? null,
    modelRequests: requests, actualHourVerified: false, businessVerified: false };
}
