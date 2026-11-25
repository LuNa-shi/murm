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

export function storedResultClass({ resultClass }: any = {}) {
  return resultClass ?? 'unassessed';
}

export function storedCheckerProcessStatus({ checkerProcessStatus }: any = {}) {
  return checkerProcessStatus ?? 'not_started';
}

function text(value: any) {
  return typeof value === 'string' ? value.trim() : '';
}

const MAX_SAFE_TEXT_LENGTH = 16_000;
const MAX_AGENT_DIAGNOSTIC_LENGTH = 4_096;

function bounded(value: any) {
  if (typeof value !== 'string') return value;
  return value.length <= MAX_SAFE_TEXT_LENGTH ? value : `${value.slice(0, MAX_SAFE_TEXT_LENGTH)}…[truncated]`;
}

function boundedAgent(value: any) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const marker = '…[truncated]';
  return trimmed.length <= MAX_AGENT_DIAGNOSTIC_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_AGENT_DIAGNOSTIC_LENGTH - marker.length)}${marker}`;
}

// Checker output is untrusted process text.  Keep the Agent-facing excerpt
// useful for repairing a proof, while preventing common credentials that may
// accidentally appear in a tool error or environment dump from crossing the
// Agent boundary.  The canonical evidence remains local and is never changed.
const DIAGNOSTIC_SECRET_PATTERNS = Object.freeze([
  [/(\bBearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]'],
  [/\b([A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|secret|credential|private[_-]?key|token))(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[REDACTED]'],
  [/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password)=)[^&#\s]+/gi, '$1[REDACTED]'],
  [/\b(?:sk|rk|ghp|github_pat|xox[abprs])-[A-Za-z0-9_-]{16,}\b/gi, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@'],
  [/(Authorization\s*:\s*Basic\s+)[^\s,;]+/gi, '$1[REDACTED]'],
  [/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
]);

function redactDiagnostic(value: any) {
  if (typeof value !== 'string') return value;
  return DIAGNOSTIC_SECRET_PATTERNS.reduce(
    (redacted: any, [pattern, replacement]: any) => redacted.replace(pattern, replacement),
    value,
  );
}

function boundedEvidence(value: any = {}) {
  const evidence = { ...value };
  for (const key of ['diagnostic', 'error', 'stdout', 'stderr']) evidence[key] = bounded(evidence[key]);
  return evidence;
}

function diagnosticText(evidence: any) {
  return [evidence?.diagnostic, evidence?.error, evidence?.stderr, evidence?.stdout]
    .map(text)
    .filter(Boolean)
    .join('\n');
}

function numberValue(value: any) {
  if (Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function diagnosticLocation(evidence: any = {}, diagnostic: any = '') {
  const explicit = evidence.diagnostic_location ?? evidence.location ?? {};
  const explicitFile = text(explicit.file ?? explicit.path ?? explicit.file_path ?? evidence.file ?? evidence.file_path);
  const explicitLine = numberValue(explicit.line ?? explicit.line_number ?? evidence.line ?? evidence.line_number);
  const explicitColumn = numberValue(explicit.column ?? explicit.column_number ?? evidence.column ?? evidence.column_number);
  let file = explicitFile || null;
  let line = explicitLine;
  let column = explicitColumn;
  if (!file || line === null || column === null) {
    const match = /(?:^|\n)\s*([^:\n]+):(\d+):(\d+)(?::|\s|$)/.exec(diagnostic);
    if (match) {
      file ??= match[1].trim();
      line ??= Number(match[2]);
      column ??= Number(match[3]);
    }
  }
  if (!file && line === null && column === null) return null;
  return { file, line, column };
}

/**
 * Project the canonical persisted CheckResult onto the Agent tool boundary.
 *
 * The Judge keeps the full evidence object for local diagnosis and reports,
 * but an Agent only needs bounded feedback that can guide the next workspace_source.
 * In particular, workspace_source hashes, raw process streams, and arbitrary evidence
 * keys must not cross this boundary. The diagnostic excerpt is deliberately
 * bounded and is the only selected process text exposed to the Agent.
 */
export function agentCheckResult(result: any) {
  if (!result) return null;
  const evidence = result.evidence ?? { ...Object.fromEntries(['preflight_key', 'preflight_status', 'preflight_verified', 'input_binding_verified',
    'toolchain_version_verified', 'checker_ref_verified', 'checker_version_verified', 'checker_identity_verified', 'health_fingerprint',
    'infrastructure_attempt_count', 'retry_exhausted'].map((key: any) => [key, result[key]])),
    ...result.process_evidence, diagnostic: result.diagnostic_excerpt,
    diagnostic_location: result.diagnostic_location, checker_started: result.checker_started, workspace_input: result.workspace_input,
    ...(result.build ? { checked_paths: result.build.checked_paths, checked_count: result.build.checked_count, build_warnings: result.build.warnings, build_scope: result.build.scope, requested_path: result.build.requested_path, build_cache: result.build.cache } : {}) };
  const safeEvidence = boundedEvidence(evidence);
  const storedClass = result.result_class ?? evidence.result_class;
  const storedProcessStatus = result.checker_process_status ?? evidence.checker_process_status;
  const resultClass = storedResultClass({
    verdict: result.verdict,
    resultClass: storedClass,
    checkerProcessStatus: storedProcessStatus,
  });
  const checkerProcessStatus = storedCheckerProcessStatus({
    verdict: result.verdict,
    resultClass: storedClass,
    checkerProcessStatus: storedProcessStatus,
  });
  const mathematicalOutcome = result.mathematical_outcome
    ?? evidence.mathematical_outcome
    ?? (resultClass === 'PASS' ? 'PASS' : resultClass === 'source_failure' ? 'FAIL' : 'unassessed');
  const diagnosticExcerpt = boundedAgent(redactDiagnostic(diagnosticText(safeEvidence)));
  return {
    check_result_id: result.check_result_id ?? null,
    request_key: result.request_key ?? null,
    workspace_source_id: result.workspace_source_id ?? null,
    target_task_id: result.target_task_id ?? null,
    execution_id: result.execution_id ?? null,
    workspace_input: evidence.workspace_input ? Object.fromEntries(['workspace_id', 'revision', 'path', 'git_commit', 'git_tree', 'tree_content_hash', 'content_hash', 'check_mode']
      .filter((key: any) => typeof evidence.workspace_input[key] === 'string').map((key: any) => [key, evidence.workspace_input[key]])) : null,
    ...(['lean-project', 'lean-module'].includes(evidence.workspace_input?.check_mode) ? { build: {
      scope: evidence.build_scope ?? 'project',
      requested_path: evidence.requested_path ?? null,
      cache: evidence.build_cache ?? null,
      checked_paths_truncated: (evidence.checked_paths?.length ?? 0) > 100,
      checked_count: evidence.checked_count ?? evidence.checked_paths?.length ?? 0,
      checked_paths: (evidence.checked_paths ?? []).slice(0, 100),
      warnings: (evidence.build_warnings ?? []).map((warning: any) => boundedAgent(redactDiagnostic(warning))),
    } } : {}),
    status: result.status ?? null,
    verdict: result.verdict ?? null,
    judge_operation_status: result.judge_operation_status ?? 'persisted',
    checker_ref: result.checker_ref ?? null,
    checker_version: result.checker_version ?? null,
    environment_ref: result.environment_ref ?? null,
    checker_process_status: checkerProcessStatus,
    checker_started: evidence.checker_started ?? ['started', 'completed', 'timeout', 'crashed'].includes(checkerProcessStatus),
    result_class: resultClass,
    mathematical_outcome: ['lean-project', 'lean-module'].includes(evidence.workspace_input?.check_mode) ? 'unassessed' : mathematicalOutcome,
    retryable: result.retryable ?? Boolean(evidence.retryable),
    diagnostic_code: result.diagnostic_code ?? evidence.diagnostic_code ?? null,
    diagnostic_excerpt: diagnosticExcerpt,
    diagnostic_location: diagnosticLocation(safeEvidence, diagnosticExcerpt ?? ''),
    process_evidence: {
      exit_code: evidence.exit_code ?? null,
      signal: evidence.signal ?? null,
      timed_out: Boolean(evidence.timed_out),
      error_code: evidence.error_code ?? null,
    },
    preflight_key: evidence.preflight_key ?? null,
    preflight_status: evidence.preflight_status ?? null,
    preflight_verified: evidence.preflight_verified ?? null,
    input_binding_verified: evidence.input_binding_verified ?? null,
    toolchain_version_verified: evidence.toolchain_version_verified ?? null,
    checker_ref_verified: evidence.checker_ref_verified ?? null,
    checker_version_verified: evidence.checker_version_verified ?? null,
    checker_identity_verified: evidence.checker_identity_verified ?? null,
    health_fingerprint: evidence.health_fingerprint ?? null,
    infrastructure_attempt_count: evidence.infrastructure_attempt_count ?? null,
    retry_exhausted: Boolean(evidence.retry_exhausted),
  };
}

export function diagnosticCodeFor({ verdict, evidence = {}, checkerProcessStatus = null, resultClass = null }: any = {}) {
  if (evidence.forbidden_placeholder === true) return 'forbidden_placeholder';
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

function inferProcessStatus({ verdict, evidence = {}, checkerProcessStatus = null, resultClass = null }: any = {}) {
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

function inferResultClass({ verdict, evidence = {}, checkerProcessStatus, resultClass = null }: any = {}) {
  if (CHECK_RESULT_CLASSES.includes(resultClass)) return resultClass;
  if (verdict === 'PASS' && checkerProcessStatus === 'completed') return 'PASS';
  if (verdict === 'FAIL' && checkerProcessStatus === 'completed') return 'source_failure';
  if (evidence.forbidden_placeholder || /sorry|admit|axiom/i.test(diagnosticText(evidence))) return 'request_failure';
  if (verdict === 'ERROR' || ['not_started', 'started', 'timeout', 'crashed'].includes(checkerProcessStatus)) return 'infrastructure_failure';
  return 'unassessed';
}

export function normalizeCheckerResult(result: any = {}) {
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
  const mathematicalOutcome = ['lean-project', 'lean-module'].includes(evidence.workspace_input?.check_mode) ? 'unassessed' : resultClass === 'PASS'
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

export function checkerIdentity(fixtureManifest: any = {}) {
  return {
    fixture_id: fixtureManifest.fixture_id ?? null,
    checker_ref: fixtureManifest.checker_ref ?? null,
    checker_version: fixtureManifest.checker_version ?? null,
    environment_ref: fixtureManifest.environment_ref ?? null,
    project_root: fixtureManifest.project_root ?? null,
  };
}

export function checkerPreflightKey(identity: any) {
  return createHash('sha256').update(stableStringify(identity)).digest('hex');
}

export function normalizePreflight(result: any = {}, identity: any = {}) {
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
