import { createHash } from 'node:crypto';
import { stableStringify } from '../protocol/envelope.js';

export const CHECKER_PROCESS_STATUSES = Object.freeze([
  'not_started',
  'started',
  'completed',
  'timeout',
  'crashed',
]);

export const CHECK_RESULT_CLASSES = Object.freeze([
  'PASS',
  'source_failure',
  'infrastructure_failure',
  'request_failure',
  'unassessed',
]);

// Older CheckResult rows predate the explicit result class and were migrated
// with the safe `unassessed` default.  Their PASS/FAIL verdict is still the
// only durable source-level signal, so readers may recover the legacy class
// without changing the meaning of newly written rows.
export function storedResultClass({ verdict, resultClass, checkerProcessStatus } = {}) {
  if (resultClass && resultClass !== 'unassessed') return resultClass;
  if (verdict === 'PASS') return 'PASS';
  if (verdict === 'FAIL') return 'source_failure';
  return resultClass ?? 'unassessed';
}

export function storedCheckerProcessStatus({ verdict, resultClass, checkerProcessStatus } = {}) {
  if (checkerProcessStatus && !(checkerProcessStatus === 'not_started' && (!resultClass || resultClass === 'unassessed') && ['PASS', 'FAIL'].includes(verdict))) {
    return checkerProcessStatus;
  }
  if (['PASS', 'FAIL'].includes(verdict) && (!resultClass || resultClass === 'unassessed')) return 'completed';
  return checkerProcessStatus ?? 'not_started';
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

const MAX_SAFE_TEXT_LENGTH = 16_000;

function bounded(value) {
  if (typeof value !== 'string') return value;
  return value.length <= MAX_SAFE_TEXT_LENGTH ? value : `${value.slice(0, MAX_SAFE_TEXT_LENGTH)}…[truncated]`;
}

function boundedEvidence(value = {}) {
  const evidence = { ...value };
  for (const key of ['diagnostic', 'error', 'stdout', 'stderr']) evidence[key] = bounded(evidence[key]);
  return evidence;
}

function diagnosticText(evidence) {
  return [evidence?.diagnostic, evidence?.error, evidence?.stderr, evidence?.stdout]
    .map(text)
    .filter(Boolean)
    .join('\n');
}

export function diagnosticCodeFor({ verdict, evidence = {}, checkerProcessStatus = null, resultClass = null } = {}) {
  if (text(evidence.diagnostic_code)) return text(evidence.diagnostic_code);
  const diagnostic = diagnosticText(evidence);
  if (resultClass === 'PASS' || verdict === 'PASS') return 'checker_pass';
  if (resultClass === 'request_failure') return 'checker_request_rejected';
  if (resultClass === 'source_failure' || verdict === 'FAIL') return 'source_failure';
  if (checkerProcessStatus === 'timeout' || evidence.timed_out || /timed out|timeout/i.test(diagnostic)) return 'checker_timeout';
  if (checkerProcessStatus === 'crashed' || evidence.signal) return 'checker_crashed';
  if (checkerProcessStatus === 'not_started' || evidence.error_code === 'ENOENT' || /spawn .*ENOENT|command not found|no such file|executable/i.test(diagnostic)) return 'checker_unavailable';
  if (resultClass === 'infrastructure_failure' && checkerProcessStatus === 'completed') return 'checker_preflight_failed';
  if (verdict === 'ERROR' || resultClass === 'infrastructure_failure') return 'checker_no_result';
  if (verdict === 'INCONCLUSIVE' || resultClass === 'unassessed') return 'checker_no_result';
  return null;
}

function inferProcessStatus({ verdict, evidence = {}, checkerProcessStatus = null, resultClass = null } = {}) {
  if (CHECKER_PROCESS_STATUSES.includes(checkerProcessStatus)) return checkerProcessStatus;
  if (verdict === 'PASS' || verdict === 'FAIL') return 'completed';
  if (evidence.timed_out) return 'timeout';
  if (evidence.signal) return 'crashed';
  if (evidence.error || evidence.error_code || resultClass === 'infrastructure_failure') {
    return evidence.checker_started ? 'crashed' : 'not_started';
  }
  if (verdict === 'ERROR') return 'started';
  return 'not_started';
}

function inferResultClass({ verdict, evidence = {}, checkerProcessStatus, resultClass = null } = {}) {
  if (CHECK_RESULT_CLASSES.includes(resultClass)) return resultClass;
  if (verdict === 'PASS' && checkerProcessStatus === 'completed') return 'PASS';
  if (verdict === 'FAIL' && checkerProcessStatus === 'completed') return 'source_failure';
  if (evidence.forbidden_placeholder || /sorry|admit|axiom/i.test(diagnosticText(evidence))) return 'request_failure';
  if (verdict === 'ERROR' || ['not_started', 'started', 'timeout', 'crashed'].includes(checkerProcessStatus)) return 'infrastructure_failure';
  return 'unassessed';
}

export function normalizeCheckerResult(result = {}) {
  const verdict = ['PASS', 'FAIL', 'INCONCLUSIVE', 'ERROR'].includes(result.verdict) ? result.verdict : 'ERROR';
  const evidence = boundedEvidence(result.evidence ?? {});
  const checkerProcessStatus = inferProcessStatus({
    verdict,
    evidence,
    checkerProcessStatus: result.checker_process_status ?? result.process_status,
    resultClass: result.result_class,
  });
  const resultClass = inferResultClass({
    verdict,
    evidence,
    checkerProcessStatus,
    resultClass: result.result_class,
  });
  const diagnosticCode = diagnosticCodeFor({
    verdict,
    evidence,
    checkerProcessStatus,
    resultClass,
  });
  const retryable = result.retryable !== undefined
    ? Boolean(result.retryable)
    : resultClass === 'infrastructure_failure';
  const mathematicalOutcome = resultClass === 'PASS'
    ? 'PASS'
    : resultClass === 'source_failure'
      ? 'FAIL'
      : 'unassessed';
  return {
    verdict,
    checker_process_status: checkerProcessStatus,
    process_status: checkerProcessStatus,
    result_class: resultClass,
    mathematical_outcome: mathematicalOutcome,
    retryable,
    diagnostic_code: diagnosticCode,
    evidence: {
      ...evidence,
      checker_process_status: checkerProcessStatus,
      result_class: resultClass,
      mathematical_outcome: mathematicalOutcome,
      retryable,
      diagnostic_code: diagnosticCode,
    },
  };
}

export function checkerIdentity(fixtureManifest = {}) {
  return {
    fixture_id: fixtureManifest.fixture_id ?? null,
    checker_ref: fixtureManifest.checker_ref ?? null,
    checker_version: fixtureManifest.checker_version ?? null,
    environment_ref: fixtureManifest.environment_ref ?? null,
    project_root: fixtureManifest.project_root ?? null,
  };
}

export function checkerPreflightKey(identity) {
  return createHash('sha256').update(stableStringify(identity)).digest('hex');
}

export function normalizePreflight(result = {}, identity = {}) {
  const status = result.status === 'healthy' ? 'healthy' : 'unavailable';
  const evidence = boundedEvidence(result.evidence ?? {});
  const processStatus = inferProcessStatus({
    verdict: status === 'healthy' ? 'PASS' : 'ERROR',
    evidence,
    checkerProcessStatus: result.checker_process_status ?? result.process_status,
    resultClass: status === 'healthy' ? 'PASS' : 'infrastructure_failure',
  });
  const diagnosticCode = status === 'healthy'
    ? null
    : diagnosticCodeFor({
      verdict: 'ERROR',
      evidence,
      checkerProcessStatus: processStatus,
      resultClass: 'infrastructure_failure',
    });
  return {
    ...result,
    status,
    checker_process_status: processStatus,
    diagnostic_code: diagnosticCode,
    retryable: status !== 'healthy',
    checker_identity: identity,
    evidence: {
      ...evidence,
      checker_process_status: processStatus,
      diagnostic_code: diagnosticCode,
    },
  };
}
