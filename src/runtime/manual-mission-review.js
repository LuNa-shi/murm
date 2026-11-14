import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { stableStringify } from '../protocol/envelope.js';

export const MANUAL_CHECKER_REF = 'manual-operator';

export const MANUAL_MISSION_REVIEW_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS mission_manual_reviews (
    mission_id TEXT NOT NULL,
    submission_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    document TEXT NOT NULL,
    PRIMARY KEY (mission_id, submission_id, request_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS mission_manual_one_timely_decision
  ON mission_manual_reviews (mission_id, submission_id)
  WHERE json_extract(document, '$.timely') = 1;
`;

const fail = (code, message) => new SwarmEnvError(code, message);
const value = (input, max = 256) => typeof input === 'string' && input.trim() && input.length <= max && !input.includes('\0');

export function readManualMissionReview(db, missionId, submissionId) {
  const row = db.prepare('SELECT document FROM mission_submissions WHERE mission_id = ? AND submission_id = ?').get(missionId, submissionId);
  const submission = row && JSON.parse(row.document);
  if (submission?.checker?.checker_ref !== MANUAL_CHECKER_REF || !submission.snapshot_fingerprint || !submission.attempt_number) {
    throw fail(ERROR_CODES.NOT_FOUND, 'Manual Mission review snapshot is unavailable');
  }
  const { state, snapshot_fingerprint, workspace_id, main_revision, main_commit, git_tree, content_hash,
    materials, checker, acceptance, freeze_epoch, deadline } = submission;
  return { mission_id: missionId, submission_id: submissionId, state, snapshot_fingerprint, workspace_id, main_revision,
    main_commit, git_tree, content_hash, materials, checker, acceptance, freeze_epoch, deadline };
}

export function recordManualMissionReview(db, { missionId, submissionId, requestId, fingerprint, verdict, reason }) {
  if (![missionId, submissionId, requestId].every(item => value(item)) || !/^[a-f0-9]{64}$/.test(fingerprint ?? '') ||
      !['PASS', 'FAIL'].includes(verdict) || !value(reason, 2048)) throw fail(ERROR_CODES.INVALID_CONTRACT, 'Review requires IDs, exact snapshot fingerprint, PASS or FAIL, and a reason');
  const { uid, username } = userInfo();
  const decision = { request_id: requestId, verdict, reason, reviewer: { uid, username } };
  db.exec('BEGIN IMMEDIATE');
  try {
    const snapshot = readManualMissionReview(db, missionId, submissionId);
    if (snapshot.snapshot_fingerprint !== fingerprint) throw fail(ERROR_CODES.CONFLICT, 'Review snapshot fingerprint is stale');
    const existing = db.prepare('SELECT document FROM mission_manual_reviews WHERE mission_id = ? AND submission_id = ? AND request_id = ?')
      .get(missionId, submissionId, requestId);
    if (existing) {
      const prior = JSON.parse(existing.document);
      if (Object.keys(decision).some(key => stableStringify(decision[key]) !== stableStringify(prior[key]))) {
        throw fail(ERROR_CODES.CONFLICT, 'Review request ID has a different decision');
      }
      db.exec('COMMIT');
      return prior;
    }
    const observed = Date.now();
    const { state, ...manifest } = snapshot;
    const current = db.prepare(`SELECT 1 FROM mission_manual_reviews WHERE mission_id = ? AND submission_id = ?
      AND json_extract(document, '$.timely') = 1`).get(missionId, submissionId);
    if (state === 'pending' && observed < Date.parse(snapshot.deadline) && current) throw fail(ERROR_CODES.CONFLICT, 'A timely human decision already exists');
    const receipt = { ...decision, snapshot: manifest, observed_state: state, observed_at: new Date(observed).toISOString(),
      timely: state === 'pending' && observed < Date.parse(snapshot.deadline),
      review_id: createHash('sha256').update(stableStringify([missionId, submissionId, requestId])).digest('hex') };
    db.prepare('INSERT INTO mission_manual_reviews VALUES (?, ?, ?, ?)').run(missionId, submissionId, requestId, JSON.stringify(receipt));
    db.exec('COMMIT');
    return receipt;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}

export function createManualMissionChecker({ database, checkerVersion, environmentRef, timeoutMs } = {}) {
  if (!value(checkerVersion) || !value(environmentRef) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new TypeError('Manual Mission review requires a fixed checker version, environment and finite wait');
  }
  database.exec(MANUAL_MISSION_REVIEW_SCHEMA_SQL);
  const find = database.prepare(`SELECT document FROM mission_manual_reviews WHERE mission_id = ? AND submission_id = ?
    AND json_extract(document, '$.timely') = 1`);
  return {
    identity: { checker_ref: MANUAL_CHECKER_REF, checker_version: checkerVersion, environment_ref: environmentRef },
    timeoutMs,
    async check({ submission, deadline, signal }) {
      while (!signal.aborted && Date.now() < deadline) {
        const row = find.get(submission.mission_id, submission.submission_id);
        const decision = row && JSON.parse(row.document);
        if (decision && decision.snapshot.snapshot_fingerprint === submission.snapshot_fingerprint) {
          return { verdict: decision.verdict, check_result_id: decision.review_id };
        }
        try { await delay(Math.max(1, Math.min(100, deadline - Date.now())), undefined, { signal }); }
        catch (error) { if (!signal.aborted) throw error; }
      }
      throw fail('SERVICE_TIMEOUT', 'Manual Mission review wait ended');
    },
  };
}
