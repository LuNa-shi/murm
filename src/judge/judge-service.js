import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { operationPayload, stableStringify, validateEnvelope } from '../protocol/envelope.js';
import { ensureJudgeSchema } from '../storage/judge-schema.js';
import { validateFixtureManifest } from './fixture.js';
import { LeanChecker } from './lean-adapter.js';
import { agentCheckResult, checkerIdentity, checkerPreflightKey, normalizeCheckerResult, normalizePreflight, storedCheckerProcessStatus, storedResultClass } from './check-result.js';

function now() { return new Date().toISOString(); }
function json(value) { return JSON.stringify(value ?? null); }
function parse(value) { return value === null || value === undefined ? null : JSON.parse(value); }
function hash(value) { return createHash('sha256').update(stableStringify(value)).digest('hex'); }
function contentHash(value) { return createHash('sha256').update(value).digest('hex'); }
function required(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${field} is required`);
  return value;
}

function resultFromRow(row) {
  if (!row) return null;
  const resultClass = storedResultClass({ verdict: row.verdict, resultClass: row.result_class, checkerProcessStatus: row.checker_process_status });
  const checkerProcessStatus = storedCheckerProcessStatus({ verdict: row.verdict, resultClass: row.result_class, checkerProcessStatus: row.checker_process_status });
  return {
    ...row,
    result_class: resultClass,
    checker_process_status: checkerProcessStatus,
    process_status: checkerProcessStatus,
    mathematical_outcome: resultClass === 'PASS' ? 'PASS' : resultClass === 'source_failure' ? 'FAIL' : 'unassessed',
    retryable: Boolean(row.retryable),
    evidence: parse(row.evidence_json),
  };
}

export class JudgeService {
  constructor(database = ':memory:', { checker, logger = null, maxInfrastructureRetries = 2, dependencyEventSink = null } = {}) {
    this.db = database instanceof DatabaseSync ? database : new DatabaseSync(database);
    ensureJudgeSchema(this.db);
    this.checker = checker ?? new LeanChecker();
    this.logger = logger;
    this.maxInfrastructureRetries = Number.isInteger(maxInfrastructureRetries) && maxInfrastructureRetries >= 0 ? maxInfrastructureRetries : 2;
    this.dependencyEventSink = dependencyEventSink;
  }

  close() { this.db.close(); }

  setDependencyEventSink(listener) {
    if (listener !== null && typeof listener !== 'function') throw new TypeError('dependencyEventSink must be a function or null');
    this.dependencyEventSink = listener;
  }

  getCheckResult(checkResultId) {
    return resultFromRow(this.db.prepare('SELECT * FROM check_results WHERE check_result_id = ?').get(checkResultId));
  }

  getAgentCheckResult(checkResultId) {
    return agentCheckResult(this.getCheckResult(checkResultId));
  }

  getByRequestKey(requestKey) {
    return resultFromRow(this.db.prepare('SELECT * FROM check_results WHERE request_key = ?').get(requestKey));
  }

  getCheckerPreflight(preflightKey) {
    const row = this.db.prepare('SELECT * FROM checker_preflights WHERE preflight_key = ?').get(preflightKey);
    if (!row) return null;
    return { ...row, retryable: Boolean(row.retryable), evidence: parse(row.evidence_json) };
  }

  listCheckerPreflights() {
    return this.db.prepare('SELECT * FROM checker_preflights ORDER BY first_seen_at, preflight_key').all()
      .map((row) => ({ ...row, retryable: Boolean(row.retryable), evidence: parse(row.evidence_json) }));
  }

  dispatch(operation, payload = {}, envelope) {
    validateEnvelope(envelope);
    if (operation === 'get_check_result') return this.getAgentCheckResult(required(payload.check_result_id, 'check_result_id'));
    if (operation !== 'submit_check_result') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `unsupported Judge operation: ${operation}`);
    return this.#transaction(() => {
      const fingerprint = operationPayload(operation, payload, envelope);
      const replay = this.#replay(envelope.operation_id, fingerprint);
      if (replay) return replay;
      const result = this.#record(payload, envelope);
      this.#saveOperation(envelope.operation_id, operation, fingerprint, result);
      return result;
    });
  }

  async judgeCandidate(input, { operationId = randomUUID(), actorRef = 'judge:lean' } = {}) {
    this.logger?.append({ event: 'judge.start', service: 'judge', operation_id: operationId, target_task_id: input?.target_task_id, candidate_material_id: input?.candidate_material_id });
    const normalized = this.#validateRequest(input);
    const requestHash = hash(normalized);
    const request = this.#beginRequest(normalized, requestHash);
    if (!request.shouldCheck) return request.result;
    const requested = request.result;
    const preflight = await this.#runPreflight(normalized);
    let checked;
    if (preflight.status !== 'healthy') {
      checked = {
        verdict: 'ERROR',
        checker_process_status: preflight.checker_process_status,
        result_class: 'infrastructure_failure',
        retryable: preflight.retryable,
        diagnostic_code: preflight.diagnostic_code,
        evidence: {
          ...preflight.evidence,
          diagnostic: preflight.evidence?.diagnostic ?? preflight.diagnostic_code ?? 'checker unavailable',
          preflight_key: preflight.preflight_key,
          preflight_status: preflight.status,
          infrastructure_attempt_count: preflight.attempt_count,
          retry_exhausted: preflight.retry_exhausted,
        },
      };
    } else {
      try {
        checked = await this.checker.check({ candidate: normalized.candidate, targetTask: normalized.target_task, workspace: normalized.workspace, fixtureManifest: normalized.fixture_manifest });
      } catch (error) {
        checked = { verdict: 'ERROR', evidence: { diagnostic: error.message, error: error.name, checker_started: false } };
      }
      if (!checked || !['PASS', 'FAIL', 'INCONCLUSIVE', 'ERROR'].includes(checked.verdict)) {
        checked = { verdict: 'ERROR', evidence: { diagnostic: 'checker returned an invalid verdict', checker_started: false } };
      }
    }
    checked = normalizeCheckerResult(checked);
    if (preflight.status === 'healthy' && checked.result_class === 'infrastructure_failure') {
      const health = this.#persistPreflight(checkerIdentity(normalized.fixture_manifest), normalizePreflight({
        status: 'unavailable',
        checker_process_status: checked.checker_process_status,
        evidence: checked.evidence,
      }, checkerIdentity(normalized.fixture_manifest)));
      checked = {
        ...checked,
        retryable: health.retryable,
        diagnostic_code: health.diagnostic_code ?? checked.diagnostic_code,
        evidence: {
          ...checked.evidence,
          preflight_key: health.preflight_key,
          preflight_status: health.status,
          infrastructure_attempt_count: health.attempt_count,
          retry_exhausted: health.retry_exhausted,
        },
      };
    } else if (checked.result_class === 'PASS' || checked.result_class === 'source_failure') {
      this.#markCheckerHealthy(normalized);
    }
    const envelope = {
      operation_id: operationId,
      actor_ref: actorRef,
      task_id: normalized.target_task_id,
      execution_id: normalized.execution_id ?? null,
      spec_version: normalized.target_spec_version,
      state_version: normalized.state_version ?? null,
    };
    const result = this.dispatch('submit_check_result', {
      ...normalized,
      status: 'RECEIVED',
      verdict: checked.verdict,
      checker_process_status: checked.checker_process_status,
      result_class: checked.result_class,
      retryable: checked.retryable,
      diagnostic_code: checked.diagnostic_code,
      evidence: checked.evidence,
      check_result_id: requested.check_result_id,
      request_hash: requestHash,
    }, envelope);
    this.logger?.append({
      event: 'judge.complete', service: 'judge', operation_id: operationId, ok: true,
      operation_status: result.judge_operation_status,
      verdict: result.verdict,
      checker_process_status: result.checker_process_status,
      result_class: result.result_class,
      mathematical_outcome: result.mathematical_outcome,
      checker_result_available: ['PASS', 'source_failure'].includes(result.result_class),
      retryable: result.retryable,
      diagnostic_code: result.diagnostic_code,
      check_result_id: result.check_result_id,
      candidate_material_id: result.candidate_material_id,
    });
    return result;
  }

  async preflightChecker(input = {}) {
    const normalized = this.#validateRequest({ ...input, candidate: input.candidate ?? { content: '' } });
    return this.#runPreflight(normalized);
  }

  #validateRequest(input) {
    if (!input || typeof input !== 'object') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'check request is required');
    validateFixtureManifest(input.fixture_manifest);
    required(input.candidate_material_id, 'candidate_material_id');
    required(input.target_task_id, 'target_task_id');
    required(input.input_snapshot_hash, 'input_snapshot_hash');
    required(input.checker_ref, 'checker_ref');
    required(input.checker_version, 'checker_version');
    required(input.environment_ref, 'environment_ref');
    if (input.checker_ref !== input.fixture_manifest.checker_ref || input.checker_version !== input.fixture_manifest.checker_version || input.environment_ref !== input.fixture_manifest.environment_ref) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'check request does not match the locked fixture checker or environment');
    }
    if (!Number.isInteger(input.target_spec_version) || input.target_spec_version < 0) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'target_spec_version is required');
    if (input.target_task !== undefined && input.target_task !== null &&
      (input.target_task.task_id !== input.target_task_id || input.target_task.spec_version !== input.target_spec_version)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'target_task does not match target_task_id or target_spec_version');
    }
    if (!input.candidate || typeof input.candidate.content !== 'string') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'candidate content is required');
    if (input.candidate.material_id !== undefined && input.candidate.material_id !== input.candidate_material_id) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'candidate material_id does not match candidate_material_id');
    }
    if (input.candidate.content_hash !== undefined && input.candidate.content_hash !== contentHash(input.candidate.content)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'candidate content_hash does not match content');
    }
    const workspace = input.workspace ?? null;
    if (workspace?.input_snapshot_hash !== undefined && workspace.input_snapshot_hash !== input.input_snapshot_hash) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'workspace does not match input_snapshot_hash');
    }
    const requestKey = required(input.request_key ?? hash({
      candidate_material_id: input.candidate_material_id,
      target_task_id: input.target_task_id,
      target_spec_version: input.target_spec_version,
      checker_ref: input.checker_ref,
      checker_version: input.checker_version,
      environment_ref: input.environment_ref,
      input_snapshot_hash: input.input_snapshot_hash,
    }), 'request_key');
    return {
      request_key: requestKey,
      candidate_material_id: input.candidate_material_id,
      target_task_id: input.target_task_id,
      target_spec_version: input.target_spec_version,
      input_snapshot_hash: input.input_snapshot_hash,
      checker_ref: input.checker_ref,
      checker_version: input.checker_version,
      environment_ref: input.environment_ref,
      candidate: input.candidate,
      target_task: input.target_task ?? null,
      workspace,
      fixture_manifest: input.fixture_manifest,
      execution_id: input.execution_id ?? null,
      state_version: input.state_version ?? null,
    };
  }

  #record(payload, envelope) {
    const normalized = this.#validateRequest(payload);
    const requestHash = payload.request_hash ?? hash(normalized);
    if (envelope.task_id !== normalized.target_task_id || envelope.spec_version !== normalized.target_spec_version) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'CheckResult envelope does not match the target task binding');
    }
    if (payload.status !== 'RECEIVED') throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Judge submissions must be RECEIVED results');
    if (!['PASS', 'FAIL', 'INCONCLUSIVE', 'ERROR'].includes(payload.verdict)) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'invalid CheckResult verdict');
    const checked = normalizeCheckerResult(payload);
    const existing = this.getByRequestKey(normalized.request_key);
    if (existing) {
      if (existing.request_hash !== requestHash) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'request_key was reused with a different check request');
      if (payload.status === 'RECEIVED' && ['REQUESTED', 'RUNNING'].includes(existing.status)) {
        this.db.prepare(`UPDATE check_results SET status = ?, verdict = ?, judge_operation_status = ?, checker_process_status = ?, result_class = ?, retryable = ?, diagnostic_code = ?, evidence_json = ?, updated_at = ? WHERE check_result_id = ?`)
          .run('RECEIVED', checked.verdict, 'persisted', checked.checker_process_status, checked.result_class, checked.retryable ? 1 : 0, checked.diagnostic_code, json(checked.evidence), now(), existing.check_result_id);
        return this.getCheckResult(existing.check_result_id);
      }
      return existing;
    }
    const checkResultId = payload.check_result_id ?? randomUUID();
    const createdAt = now();
    this.db.prepare(`INSERT INTO check_results (
      check_result_id, request_key, request_hash, candidate_material_id, target_task_id, target_spec_version,
      execution_id, input_snapshot_hash, checker_ref, checker_version, environment_ref, status, verdict,
      judge_operation_status, checker_process_status, result_class, retryable, diagnostic_code, evidence_json,
      applied_task_state_version, applied_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`)
      .run(checkResultId, normalized.request_key, requestHash, normalized.candidate_material_id, normalized.target_task_id, normalized.target_spec_version,
        normalized.execution_id, normalized.input_snapshot_hash, normalized.checker_ref, normalized.checker_version, normalized.environment_ref,
        checked.verdict, 'persisted', checked.checker_process_status, checked.result_class, checked.retryable ? 1 : 0, checked.diagnostic_code,
        json(checked.evidence), createdAt, createdAt);
    return resultFromRow(this.db.prepare('SELECT * FROM check_results WHERE check_result_id = ?').get(checkResultId));
  }

  #beginRequest(normalized, requestHash) {
    return this.#transaction(() => {
      const existing = this.getByRequestKey(normalized.request_key);
      if (existing) {
        if (existing.request_hash !== requestHash) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'request_key was reused with a different check request');
        return { result: existing, shouldCheck: false };
      }
      // request_key is the transport idempotency key, but it is not a license
      // to rerun an unchanged candidate under a fresh key.  A candidate and
      // its locked checker/input binding define the durable check identity;
      // only retryable infrastructure failures may be checked again after a
      // new request.  This also closes the cross-Core duplicate path where
      // each Agent invents a different request key for the same Material.
      const equivalent = this.db.prepare(`SELECT * FROM check_results
        WHERE candidate_material_id = ? AND target_task_id = ? AND target_spec_version = ?
          AND input_snapshot_hash = ? AND checker_ref = ? AND checker_version = ? AND environment_ref = ?
        ORDER BY created_at, check_result_id LIMIT 1`).get(
        normalized.candidate_material_id,
        normalized.target_task_id,
        normalized.target_spec_version,
        normalized.input_snapshot_hash,
        normalized.checker_ref,
        normalized.checker_version,
        normalized.environment_ref,
      );
      if (equivalent) {
        const existingResult = resultFromRow(equivalent);
        const retryableInfrastructure = existingResult.result_class === 'infrastructure_failure' &&
          existingResult.retryable && !existingResult.evidence?.retry_exhausted;
        if (!retryableInfrastructure) {
          return {
            result: {
              ...existingResult,
              deduplicated: true,
              duplicate_of_request_key: existingResult.request_key,
            },
            shouldCheck: false,
          };
        }
      }
      const checkResultId = randomUUID();
      const createdAt = now();
      this.db.prepare(`INSERT INTO check_results (
        check_result_id, request_key, request_hash, candidate_material_id, target_task_id, target_spec_version,
        execution_id, input_snapshot_hash, checker_ref, checker_version, environment_ref, status, verdict,
        judge_operation_status, checker_process_status, result_class, retryable, diagnostic_code, evidence_json,
        applied_task_state_version, applied_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', NULL, 'accepted', 'not_started', 'unassessed', 0, NULL, ?, NULL, NULL, ?, ?)`)
        .run(checkResultId, normalized.request_key, requestHash, normalized.candidate_material_id, normalized.target_task_id, normalized.target_spec_version,
          normalized.execution_id, normalized.input_snapshot_hash, normalized.checker_ref, normalized.checker_version, normalized.environment_ref,
          json({}), createdAt, createdAt);
      return { result: this.getCheckResult(checkResultId), shouldCheck: true };
    });
  }

  async #runPreflight(normalized) {
    const identity = checkerIdentity(normalized.fixture_manifest);
    let result;
    if (typeof this.checker.preflight !== 'function') {
      // A checker that cannot prove its executable, toolchain, working
      // directory, and locked input binding is unavailable. Treating an
      // adapter without this gate as healthy would let a Candidate reach the
      // Judge with no evidence that the checker can produce a mathematical
      // result.
      result = normalizePreflight({
        status: 'unavailable',
        checker_process_status: 'not_started',
        evidence: {
          preflight_supported: false,
          preflight_verified: false,
          diagnostic_code: 'checker_preflight_unsupported',
          diagnostic: 'checker adapter does not expose the required preflight gate',
          checker_started: false,
        },
      }, identity);
    } else {
      try {
        result = normalizePreflight(await this.checker.preflight({ fixtureManifest: normalized.fixture_manifest }), identity);
      } catch (error) {
        result = normalizePreflight({
          status: 'unavailable',
          checker_process_status: 'not_started',
          evidence: { diagnostic: error.message, error: error.name, checker_started: false },
        }, identity);
      }
    }
    return this.#persistPreflight(identity, result);
  }

  #persistPreflight(identity, result) {
    const preflightKey = checkerPreflightKey(identity);
    const fingerprint = hash({
      status: result.status,
      checker_process_status: result.checker_process_status,
      diagnostic_code: result.diagnostic_code,
      diagnostic: result.evidence?.diagnostic ?? null,
      evidence: { exit_code: result.evidence?.exit_code ?? null, error_code: result.evidence?.error_code ?? null },
    });
    const existing = this.getCheckerPreflight(preflightKey);
    const sameHealth = existing?.status === result.status && existing?.health_fingerprint === fingerprint;
    const attemptCount = result.status === 'unavailable'
      ? (sameHealth || (existing?.status === 'healthy' && (existing?.attempt_count ?? 0) > 0)
        ? (existing?.attempt_count ?? 0) + 1
        : 1)
      : (existing?.attempt_count ?? 0);
    const retryExhausted = result.status === 'unavailable' && attemptCount > this.maxInfrastructureRetries;
    const retryable = result.status === 'unavailable' && !retryExhausted;
    const timestamp = now();
    const evidence = {
      ...(result.evidence ?? {}),
      preflight_status: result.status,
      preflight_key: preflightKey,
      health_fingerprint: fingerprint,
      infrastructure_attempt_count: attemptCount,
      retry_exhausted: retryExhausted,
    };
    if (existing) {
      this.db.prepare(`UPDATE checker_preflights SET status = ?, checker_process_status = ?, diagnostic_code = ?, retryable = ?, attempt_count = ?, health_fingerprint = ?, evidence_json = ?, last_seen_at = ? WHERE preflight_key = ?`)
        .run(result.status, result.checker_process_status, result.diagnostic_code, retryable ? 1 : 0, attemptCount, fingerprint, json(evidence), timestamp, preflightKey);
    } else {
      this.db.prepare(`INSERT INTO checker_preflights (
        preflight_key, fixture_id, checker_ref, checker_version, environment_ref, project_root,
        status, checker_process_status, diagnostic_code, retryable, attempt_count, health_fingerprint,
        evidence_json, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(preflightKey, identity.fixture_id, identity.checker_ref, identity.checker_version, identity.environment_ref, identity.project_root,
          result.status, result.checker_process_status, result.diagnostic_code, retryable ? 1 : 0, attemptCount, fingerprint, json(evidence), timestamp, timestamp);
    }
    const persisted = this.getCheckerPreflight(preflightKey);
    if (!sameHealth) {
      try {
        this.dependencyEventSink?.({ kind: 'checker_health_changed', operation: 'checker_preflight', preflight_key: preflightKey, health_fingerprint: fingerprint });
      } catch { /* health notification is advisory; the persisted preflight remains authoritative */ }
    }
    return {
      ...result,
      ...persisted,
      preflight_key: preflightKey,
      retryable,
      retry_exhausted: retryExhausted,
      evidence,
    };
  }

  #markCheckerHealthy(normalized) {
    const key = checkerPreflightKey(checkerIdentity(normalized.fixture_manifest));
    const existing = this.getCheckerPreflight(key);
    if (!existing || existing.attempt_count === 0) return;
    const evidence = { ...(existing.evidence ?? {}), retry_exhausted: false, infrastructure_attempt_count: 0, preflight_status: 'healthy' };
    this.db.prepare(`UPDATE checker_preflights SET status = 'healthy', checker_process_status = 'completed', diagnostic_code = NULL, retryable = 0, attempt_count = 0, evidence_json = ?, last_seen_at = ? WHERE preflight_key = ?`)
      .run(json(evidence), now(), key);
    try {
      this.dependencyEventSink?.({ kind: 'checker_health_changed', operation: 'checker_preflight', preflight_key: key, health_fingerprint: existing.health_fingerprint });
    } catch { /* health notification is advisory; the persisted preflight remains authoritative */ }
  }

  #replay(operationId, fingerprint) {
    const row = this.db.prepare('SELECT fingerprint, result_json FROM operations WHERE operation_id = ?').get(operationId);
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'operation_id was reused with a different payload');
    return parse(row.result_json);
  }

  #saveOperation(operationId, operation, fingerprint, result) {
    this.db.prepare('INSERT INTO operations (operation_id, operation, fingerprint, result_json, created_at) VALUES (?, ?, ?, ?, ?)').run(operationId, operation, fingerprint, json(result), now());
  }

  #transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
