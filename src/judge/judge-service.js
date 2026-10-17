import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { operationPayload, stableStringify, validateEnvelope } from '../protocol/envelope.js';
import { ensureJudgeSchema } from '../storage/judge-schema.js';
import { validateFixtureManifest } from './fixture.js';
import { LeanChecker } from './lean-adapter.js';

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
  return { ...row, evidence: parse(row.evidence_json) };
}

export class JudgeService {
  constructor(database = ':memory:', { checker } = {}) {
    this.db = database instanceof DatabaseSync ? database : new DatabaseSync(database);
    ensureJudgeSchema(this.db);
    this.checker = checker ?? new LeanChecker();
  }

  close() { this.db.close(); }

  getCheckResult(checkResultId) {
    return resultFromRow(this.db.prepare('SELECT * FROM check_results WHERE check_result_id = ?').get(checkResultId));
  }

  getByRequestKey(requestKey) {
    return resultFromRow(this.db.prepare('SELECT * FROM check_results WHERE request_key = ?').get(requestKey));
  }

  dispatch(operation, payload = {}, envelope) {
    validateEnvelope(envelope);
    if (operation === 'get_check_result') return this.getCheckResult(required(payload.check_result_id, 'check_result_id'));
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
    const normalized = this.#validateRequest(input);
    const requestHash = hash(normalized);
    const request = this.#beginRequest(normalized, requestHash);
    if (!request.shouldCheck) return request.result;
    const requested = request.result;
    let checked;
    try {
      checked = await this.checker.check({ candidate: normalized.candidate, targetTask: normalized.target_task, initialContext: normalized.initial_context, fixtureManifest: normalized.fixture_manifest });
    } catch (error) {
      checked = { verdict: 'ERROR', evidence: { diagnostic: error.message, error: error.name } };
    }
    if (!checked || !['PASS', 'FAIL', 'INCONCLUSIVE', 'ERROR'].includes(checked.verdict)) {
      checked = { verdict: 'ERROR', evidence: { diagnostic: 'checker returned an invalid verdict' } };
    }
    const envelope = {
      operation_id: operationId,
      actor_ref: actorRef,
      task_id: normalized.target_task_id,
      execution_id: normalized.execution_id ?? null,
      spec_version: normalized.target_spec_version,
      state_version: normalized.state_version ?? null,
    };
    return this.dispatch('submit_check_result', { ...normalized, status: 'RECEIVED', verdict: checked.verdict, evidence: checked.evidence, check_result_id: requested.check_result_id, request_hash: requestHash }, envelope);
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
    if (input.initial_context?.input_snapshot_hash !== undefined && input.initial_context.input_snapshot_hash !== input.input_snapshot_hash) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'initial_context does not match input_snapshot_hash');
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
      initial_context: input.initial_context ?? null,
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
    const existing = this.getByRequestKey(normalized.request_key);
    if (existing) {
      if (existing.request_hash !== requestHash) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'request_key was reused with a different check request');
      if (payload.status === 'RECEIVED' && ['REQUESTED', 'RUNNING'].includes(existing.status)) {
        this.db.prepare('UPDATE check_results SET status = ?, verdict = ?, evidence_json = ?, updated_at = ? WHERE check_result_id = ?')
          .run('RECEIVED', payload.verdict, json(payload.evidence ?? {}), now(), existing.check_result_id);
        return this.getCheckResult(existing.check_result_id);
      }
      return existing;
    }
    const checkResultId = payload.check_result_id ?? randomUUID();
    const createdAt = now();
    this.db.prepare(`INSERT INTO check_results (
      check_result_id, request_key, request_hash, candidate_material_id, target_task_id, target_spec_version,
      execution_id, input_snapshot_hash, checker_ref, checker_version, environment_ref, status, verdict, evidence_json,
      applied_task_state_version, applied_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?, ?, NULL, NULL, ?, ?)`)
      .run(checkResultId, normalized.request_key, requestHash, normalized.candidate_material_id, normalized.target_task_id, normalized.target_spec_version,
        normalized.execution_id, normalized.input_snapshot_hash, normalized.checker_ref, normalized.checker_version, normalized.environment_ref,
        payload.verdict, json(payload.evidence ?? {}), createdAt, createdAt);
    return resultFromRow(this.db.prepare('SELECT * FROM check_results WHERE check_result_id = ?').get(checkResultId));
  }

  #beginRequest(normalized, requestHash) {
    return this.#transaction(() => {
      const existing = this.getByRequestKey(normalized.request_key);
      if (existing) {
        if (existing.request_hash !== requestHash) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'request_key was reused with a different check request');
        return { result: existing, shouldCheck: false };
      }
      const checkResultId = randomUUID();
      const createdAt = now();
      this.db.prepare(`INSERT INTO check_results (
        check_result_id, request_key, request_hash, candidate_material_id, target_task_id, target_spec_version,
        execution_id, input_snapshot_hash, checker_ref, checker_version, environment_ref, status, verdict, evidence_json,
        applied_task_state_version, applied_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', NULL, ?, NULL, NULL, ?, ?)`)
        .run(checkResultId, normalized.request_key, requestHash, normalized.candidate_material_id, normalized.target_task_id, normalized.target_spec_version,
          normalized.execution_id, normalized.input_snapshot_hash, normalized.checker_ref, normalized.checker_version, normalized.environment_ref,
          json({}), createdAt, createdAt);
      return { result: this.getCheckResult(checkResultId), shouldCheck: true };
    });
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
