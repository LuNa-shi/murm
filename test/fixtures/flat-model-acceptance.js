import { validateHeaderName, validateHeaderValue } from 'node:http';

export function parsePrivateUpstreamHeaders(value) {
  try {
    const headers = JSON.parse(value ?? '{}');
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new Error();
    for (const [name, content] of Object.entries(headers)) {
      if (typeof content !== 'string') throw new Error();
      validateHeaderName(name); validateHeaderValue(name, content);
    }
    return headers;
  } catch { throw new Error('FLAT_PRIVATE_UPSTREAM_CONFIGURATION_INVALID'); }
}

// Observation is sticky even if cleanup disables the timer or the clock later changes.
export function createAcceptanceDeadline(deadlineAt, onExpire) {
  let deadlineExpired = false;
  const expire = () => { deadlineExpired = true; onExpire(); };
  const timer = setTimeout(expire, Math.max(0, deadlineAt - Date.now()));
  return {
    expired() { if (Date.now() >= deadlineAt) deadlineExpired = true; return deadlineExpired; },
    stop() { clearTimeout(timer); },
  };
}

export function acceptanceFailed(report, deadlineExpired, live) {
  return Boolean(report.failure || deadlineExpired || report.upstream?.deadlineReached ||
    report.upstream?.arrivals !== report.requestCap || report.upstream?.forwarded !== report.requestCap ||
    (!live && (report.localArrivals !== report.requestCap || report.localAccepted !== report.requestCap)) ||
    !report.selectionCompleted || !report.usageObserved || (!live && (!report.streamRevoked || !report.deniedBeforeUpstream)) ||
    report.domainState !== 'CLOSED' || !report.close?.length ||
    report.close.some(row => row.cleanup !== 'complete') || !report.resources[report.runtimeId]?.empty);
}
