// Fixed acceptance preparation only: no business input or actual-hour verdict.
export const lifetimeProbePlan = Object.freeze({ bots: 4, timeoutSeconds: 5100,
  workMs: 3600000, cleanupMs: 180000, recoveryMs: 300000, marginMs: 120000 });

export async function runLifetimeProbe({ runtime, admit, verifyDeleted, upstreamRequests, bounded }) {
  let admission, close, failed = false;
  try {
    const bots = await bounded(Promise.all(Array.from({ length: 4 }, (_, i) =>
      runtime.spawn({ profile: 'worker', requestId: `lifetime-${i}` }))), 100000);
    if (bots.some(bot => bot.status !== 'idle') || upstreamRequests() !== 0) throw new Error('LIFETIME_NOT_IDLE');
    admission = await bounded(admit(bots.map(bot => bot.id)), 10000);
    if (admission.resources.length !== 4 || admission.resources.some(row => row.requestedSeconds !== 5100 ||
        row.expiresAtMs - admission.observedAtMs < 4200000) ||
        admission.stopAtMs < admission.workDeadlineAtMs) throw new Error('LIFETIME_PLAN_NOT_COVERED');
  } catch { failed = true; }
  // close owns late allocation reconciliation even when startup has timed out.
  try {
    close = await bounded(runtime.close({ timeoutMs: 45000 }), 50000);
    if (close.cleanup !== 'complete' || close.bots.length !== 4 || close.bots.some(bot => bot.execution !== 'stopped' || bot.cleanup !== 'complete')) failed = true;
  } catch { failed = true; }
  let deletion;
  try { deletion = await bounded(verifyDeleted(admission), 10000); if (!deletion.complete) failed = true; }
  catch { failed = true; }
  const requests = upstreamRequests();
  return { status: failed || requests !== 0 || !admission ? 'failed' : 'passed', plan: lifetimeProbePlan,
    admission: admission ?? null, close: close ? { cleanup: close.cleanup, bots: close.bots.map(({ botId, execution, cleanup }) => ({ botId, execution, cleanup })) } : null, deletion: deletion ?? null,
    modelRequests: requests, actualHourVerified: false, businessVerified: false };
}
