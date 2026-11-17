import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { runBenchmarkProject, writeUnavailableProjectReport } from './putnam-runner.js';

/** Compose existing complete Mission runs; never share an attempt's mutable state. */
export async function runPassK(problem, config, options, { runAttempt = runBenchmarkProject, now = Date.now, wait = sleep } = {}) {
  const k = options.k;
  const duration = options.timeboxMs ?? 3_600_000;
  if (!Number.isSafeInteger(k) || k < 1 || k > 4) throw new TypeError('Pass@K requires an integer K from 1 through 4');
  if (!Number.isSafeInteger(duration) || duration <= 0) throw new TypeError('Pass@K requires a positive timebox');
  const startedAt = now();
  const deadline = startedAt + duration;
  const runId = options.runId ?? randomUUID();
  const reports = await Promise.all(Array.from({ length: k }, async (_, index) => {
    const attemptOptions = {
      ...options, runId: `${runId}-attempt-${index + 1}`, attemptIndex: index + 1,
      agentMode: 'solver', cores: 1, startedAt, initialBotStaggerMs: 0,
      botMaxMs: duration, executionTimeoutMs: duration,
      coordinationPermissions: ['mission_submit'],
    };
    try { return await runAttempt(problem, config, attemptOptions); }
    catch (error) { return writeUnavailableProjectReport(problem, attemptOptions, error); }
  }));
  // A terminal Mission need not retain an idle sandbox, but it cannot shorten the
  // group's registered window or be replaced by another independent sample.
  while (!options.signal?.aborted && now() < deadline) await wait(Math.min(1000, deadline - now()));
  const attempts = reports.map((report, index) => {
    const acceptedAt = Date.parse(report.run?.accepted_at ?? '');
    const valid = report.run?.protocol_valid !== false && report.audit?.invalid === false;
    const passed = valid && report.run?.solved === true && Number.isFinite(acceptedAt) && acceptedAt >= startedAt && acceptedAt <= deadline;
    return { attempt_index: index + 1, passed, valid,
      accepted_after_deadline: Number.isFinite(acceptedAt) && acceptedAt > deadline,
      first_success_ms: passed ? acceptedAt - startedAt : null,
      stop_reason: report.run?.stop_reason ?? null };
  });
  const successes = attempts.filter(attempt => attempt.passed);
  return { reports, summary: {
    k, started_at: new Date(startedAt).toISOString(), deadline: new Date(deadline).toISOString(),
    timebox_ms: duration, window_elapsed_ms: Math.min(duration, Math.max(0, now() - startedAt)),
    settlement_elapsed_ms: Math.max(0, now() - startedAt - duration),
    stopped_by_operator: options.signal?.aborted === true,
    passed: successes.length > 0, valid: !options.signal?.aborted && attempts.every(attempt => attempt.valid),
    first_success_ms: successes.length ? Math.min(...successes.map(attempt => attempt.first_success_ms)) : null,
    attempts,
  } };
}
