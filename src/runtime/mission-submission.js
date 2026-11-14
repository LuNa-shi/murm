import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { stableStringify } from '../protocol/envelope.js';

import { createManualMissionChecker, MANUAL_CHECKER_REF } from './manual-mission-review.js';
import { MISSION_SUBMISSION_SCHEMA_SQL } from '../storage/schema.js';

export { MISSION_SUBMISSION_SCHEMA_SQL };

const accepted = 'accepted';
const active = ['preparing', 'pending'];
const checkerFields = ['checker_ref', 'checker_version', 'environment_ref'];
const hash = value => createHash('sha256').update(stableStringify(value)).digest('hex');
const iso = time => new Date(time).toISOString();

function required(value, name) {
  if (typeof value !== 'string' || !value) throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, `${name} is required`);
  return value;
}

function timedOut() {
  return new SwarmEnvError('SERVICE_TIMEOUT', 'Mission submission deadline elapsed');
}

/** Mission-owned submission receipts. Workspace locking serializes freeze with
 * merge; SQLite serializes authorization and submission transitions. An intent
 * precedes each cross-store freeze or release, so recovery can repeat it.
 */
export class MissionSubmissionStore {
  constructor({ database = null, file = null, workspace = null, authorize = null, snapshotMaterials = null,
    validateMaterials = null, validateCompletion = null, checker = null, manualReview = null, timeoutMs = 120_000, maxInfrastructureRetries = 0, maxFinalChecks = 4, maxConcurrentFinalChecks = 1, onAccepted = null } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Mission submission timeout must be a timer-safe positive integer');
    }
    if (!Number.isSafeInteger(maxInfrastructureRetries) || maxInfrastructureRetries < 0) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Mission infrastructure retry limit must be a nonnegative integer');
    }
    if ((manualReview && checker) || checker?.identity?.checker_ref === MANUAL_CHECKER_REF) {
      throw new TypeError('Select either the configured machine checker or explicit manual Mission review');
    }
    if (manualReview && !database) throw new TypeError('Manual review requires a trusted shared owner-private database');
    if (!Number.isSafeInteger(maxFinalChecks) || maxFinalChecks < 1 || maxFinalChecks > 10_000 ||
        !Number.isSafeInteger(maxConcurrentFinalChecks) || maxConcurrentFinalChecks < 1 || maxConcurrentFinalChecks > maxFinalChecks) {
      throw new TypeError('Mission final checker budget requires finite positive request and concurrent limits');
    }
    this.maxFinalChecks = maxFinalChecks;
    this.maxConcurrentFinalChecks = maxConcurrentFinalChecks;
    this.maxInfrastructureRetries = maxInfrastructureRetries;
    this.ownsDatabase = database === null;
    this.db = database ?? new DatabaseSync(file ? `${file}.sqlite` : ':memory:');
    this.workspace = workspace;
    this.authorize = authorize;
    this.snapshotMaterials = snapshotMaterials;
    this.validateMaterials = validateMaterials;
    this.manualReview = manualReview !== null;
    this.checker = manualReview ? createManualMissionChecker({ ...manualReview, database: this.db }) : checker;
    this.validateCompletion = validateCompletion;
    this.timeoutMs = timeoutMs;
    this.onAccepted = onAccepted;
    this.work = new Map();
    this.recoveryTimers = new Map();
    this.tasks = new Set();
    this.admissions = new Set();
    this.stops = new Map();
    this.shuttingDown = false;
    this.shutdownPromise = null;
    this.db.exec(MISSION_SUBMISSION_SCHEMA_SQL);
    if (!this.db.prepare('PRAGMA table_info(mission_submission_audit)').all().some(column => column.name === 'details_json')) {
      this.db.exec('ALTER TABLE mission_submission_audit ADD COLUMN details_json TEXT');
    }
  }

  #transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  #read(missionId, submissionId) {
    const row = this.db.prepare('SELECT document FROM mission_submissions WHERE mission_id = ? AND submission_id = ?').get(missionId, submissionId);
    return row ? JSON.parse(row.document) : null;
  }

  #rows(missionId) {
    return this.db.prepare('SELECT document FROM mission_submissions WHERE mission_id = ? ORDER BY rowid').all(missionId)
      .map(row => JSON.parse(row.document));
  }

  #write(submission, expectedState = null) {
    return this.db.prepare(`UPDATE mission_submissions SET state = ?, document = ?, snapshot_fingerprint = ?
      WHERE mission_id = ? AND submission_id = ? AND (? IS NULL OR state = ?)`)
      .run(submission.state, JSON.stringify(submission), submission.snapshot_fingerprint,
        submission.mission_id, submission.submission_id, expectedState, expectedState).changes === 1;
  }

  #audit(submission, event, result) {
    const details = { result, freeze_epoch: submission.freeze_epoch, main_commit: submission.main_commit,
      git_tree: submission.git_tree, checker: submission.checker };
    this.db.prepare('INSERT INTO mission_submission_audit (mission_id, submission_id, event, observed_at, details_json) VALUES (?, ?, ?, ?, ?)')
      .run(submission.mission_id, submission.submission_id, event, iso(Date.now()), JSON.stringify(details));
  }

  getFinalCheckBudget(missionId) {
    if (this.manualReview || !this.checker) return null;
    const policy = this.db.prepare('SELECT max_checks, max_concurrent FROM mission_final_check_policies WHERE mission_id = ?').get(missionId);
    const usage = this.db.prepare(`SELECT COUNT(*) AS admitted_checks,
      COUNT(*) FILTER (WHERE settled_at IS NULL) AS active_checks
      FROM mission_final_check_admissions WHERE mission_id = ?`).get(missionId);
    return { max_checks: policy?.max_checks ?? this.maxFinalChecks, max_concurrent: policy?.max_concurrent ?? this.maxConcurrentFinalChecks, ...usage };
  }

  #assertFinalCheckAvailable(missionId) {
    if (this.manualReview) return;
    const budget = this.getFinalCheckBudget(missionId);
    if (budget.max_checks !== this.maxFinalChecks || budget.max_concurrent !== this.maxConcurrentFinalChecks) throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, 'Mission final checker budget differs from the fixed policy');
    if (budget.admitted_checks >= budget.max_checks) throw new SwarmEnvError('CHECKER_BUDGET_EXHAUSTED', 'Mission final checker budget is exhausted', budget);
    if (budget.active_checks >= budget.max_concurrent) throw new SwarmEnvError('CHECKER_BUSY', 'Previous final checker has not confirmed resource cleanup', budget, { retryable: true });
  }

  #reserveFinalCheck(submission) {
    if (this.manualReview) return;
    const { mission_id: missionId, submission_id: submissionId } = submission;
    this.db.prepare(`INSERT INTO mission_final_check_policies VALUES (?, ?, ?)
      ON CONFLICT(mission_id) DO NOTHING`).run(missionId, this.maxFinalChecks, this.maxConcurrentFinalChecks);
    this.#assertFinalCheckAvailable(missionId);
    this.db.prepare('INSERT INTO mission_final_check_admissions VALUES (?, ?, ?, NULL)').run(missionId, submissionId, iso(Date.now()));
  }

  #settleFinalCheck(submission) {
    if (this.manualReview) return;
    this.db.prepare(`UPDATE mission_final_check_admissions SET settled_at = ?
      WHERE mission_id = ? AND submission_id = ? AND settled_at IS NULL`).run(iso(Date.now()), submission.mission_id, submission.submission_id);
  }

  #track(missionId, promise) {
    const task = { missionId, promise };
    this.tasks.add(task);
    const done = () => this.tasks.delete(task);
    void promise.then(done, done);
    return promise;
  }

  async waitForIdle({ missionId = null } = {}) {
    while (true) {
      const pending = [...this.tasks].filter(task => missionId === null || task.missionId === missionId);
      if (!pending.length) return;
      await Promise.allSettled(pending.map(task => task.promise));
    }
  }

  #assertRunning(missionId) {
    if (this.shuttingDown || this.stops.has(missionId)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Mission submission service is stopping');
    }
  }

  #exact(input, fingerprint) {
    const existing = this.#read(input.missionId, input.requestId);
    if (existing && existing.request_fingerprint !== fingerprint) {
      throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Mission submission request ID was reused with different input');
    }
    return existing;
  }

  #ready(input) {
    if (!this.workspace || typeof this.authorize !== 'function' || typeof this.checker?.check !== 'function') {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, 'Mission submission requires trusted authorization and a configured checker');
    }
    const policy = this.authorize(input);
    if (!policy?.acceptance || typeof policy.acceptance !== 'object') {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Mission submission requires the current Mission coordination identity');
    }
    const identity = Object.fromEntries(checkerFields.map(field => [field, required(this.checker.identity?.[field], field)]));
    const requirement = policy.acceptance.required_check;
    if (!requirement || checkerFields.some(field => requirement[field] !== identity[field]) ||
        Object.entries(requirement).some(([field, value]) => identity[field] !== value)) {
      throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, 'Trusted checker does not match fixed Mission acceptance');
    }
    return { acceptance: policy.acceptance, identity, deadline: policy.deadline ?? Infinity };
  }

  async #materials(input, signal) {
    if (!input.materialIds.length) return [];
    if (typeof this.snapshotMaterials !== 'function') throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, 'Mission Material snapshots are unavailable');
    const materials = await this.snapshotMaterials({ ...input, signal });
    if (!Array.isArray(materials) || materials.length !== input.materialIds.length) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Requested Material snapshot is incomplete');
    }
    return input.materialIds.map(id => {
      const material = materials.find(item => item?.material_id === id);
      if (!material || !/^[a-f0-9]{64}$/.test(material.content_hash) || !material.version) {
        throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'Material snapshot must fix ID, immutable version and SHA-256');
      }
      return structuredClone(material);
    });
  }

  async submit({ missionId, workspaceId, materialIds, actorRef, taskId = null, executionId = null, fencingVersion = null, requestId = randomUUID() }) {
    required(missionId, 'mission_id');
    required(workspaceId, 'workspace_id');
    required(actorRef, 'actor_ref');
    required(requestId, 'request_id');
    if (!Array.isArray(materialIds) || materialIds.some(id => typeof id !== 'string' || !id)) {
      throw new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, 'material_ids must be an array of IDs');
    }
    const input = { missionId, workspaceId, materialIds: [...new Set(materialIds)].sort(), actorRef, taskId, executionId, fencingVersion, requestId };
    const fingerprint = hash(input);
    const replay = this.#exact(input, fingerprint);
    if (replay) return replay;
    this.#assertRunning(missionId);
    const policy = this.#ready(input);
    const deadline = Math.min(Date.now() + this.timeoutMs, Date.now() + (this.checker.timeoutMs ?? this.timeoutMs), policy.deadline);
    if (!Number.isFinite(deadline) || deadline <= Date.now()) throw timedOut();
    const receipt = this.#transaction(() => {
      const existing = this.#exact(input, fingerprint);
      if (existing) return { existing };
      this.#assertRunning(missionId);
      this.#ready(input);
      const busy = this.#rows(missionId).find(row => active.includes(row.state) || row.release_pending);
      if (busy) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Mission already has a submission or a pending freeze release', { submission_id: busy.submission_id });
      const document = { mission_id: missionId, submission_id: requestId, workspace_id: workspaceId,
        actor_ref: actorRef, task_id: taskId, execution_id: executionId, fencing_version: fencingVersion, material_ids: input.materialIds,
        request_fingerprint: fingerprint, snapshot_fingerprint: '', state: 'preparing', result: null,
        freeze_id: `mission:${hash([missionId, requestId])}`, freeze_epoch: null,
        release_pending: false, stop_pending: false, created_at: iso(Date.now()), deadline: iso(deadline),
        acceptance: structuredClone(policy.acceptance), checker: policy.identity };
      this.#insert(document);
      return { document };
    });
    if (receipt.existing) return receipt.existing;
    const initial = receipt.document;
    const controller = new AbortController();
    const admission = { missionId, requestId, controller };
    this.admissions.add(admission);
    const preparing = this.#track(missionId, this.#admit(input, initial, deadline, controller.signal)
      .catch(error => this.#failPreparation(initial, error))
      .finally(() => this.admissions.delete(admission)));
    let resolveTimeout;
    let rejectTimeout;
    const timeout = new Promise((resolve, reject) => { resolveTimeout = resolve; rejectTimeout = reject; });
    const timer = setTimeout(() => {
      const error = timedOut();
      controller.abort(error);
      try { resolveTimeout(this.#failPreparation(initial, error)); }
      catch (failure) { rejectTimeout(failure); }
    }, Math.max(0, deadline - Date.now()));
    try {
      return await Promise.race([preparing, timeout]);
    } finally { clearTimeout(timer); }
  }

  #failPreparation(initial, error) {
    const expired = error?.code === 'SERVICE_TIMEOUT';
    const terminal = this.#transaction(() => {
      const current = this.#read(initial.mission_id, initial.submission_id);
      if (current.state !== 'preparing') return current;
      const quotaRejection = ['CHECKER_BUSY', 'CHECKER_BUDGET_EXHAUSTED'].includes(error?.code);
      const row = { ...current, state: expired ? 'timed_out' : 'error', finished_at: iso(Date.now()),
        ...(quotaRejection ? { attempt_number: null, attempt_of: null } : {}),
        result: { code: expired ? 'SERVICE_TIMEOUT' : (typeof error?.code === 'string' ? error.code : 'MISSION_ADMISSION_ERROR'),
          ...(quotaRejection ? { retryable: error.retryable } : {}) },
        release_pending: current.freeze_epoch !== null };
      this.#write(row);
      return row;
    });
    if (terminal.release_pending) {
      void this.#track(initial.mission_id, this.#settle(terminal)).catch(() => undefined);
    }
    return terminal;
  }

  async #admit(input, initial, deadline, signal) {
    const { missionId, workspaceId } = input;
    const checkDeadline = () => {
      this.#assertRunning(missionId);
      if (signal.aborted || Date.now() >= deadline) throw timedOut();
    };
    // Immutable snapshots are prepared without either coordinator write lock.
    const snapshots = await Promise.allSettled([
      this.workspace.exportRevision({ workspaceId, revision: 'main' }),
      this.#materials(input, signal),
    ]);
    checkDeadline();
    for (const result of snapshots) if (result.status === 'rejected') throw result.reason;
    const [workspace, materials] = snapshots.map(result => result.value);
    if (workspace.mission_id !== missionId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Workspace does not belong to the Mission');
    const freezeId = initial.freeze_id;
    let newlyAdmitted = false;
    const submission = await this.workspace.freeze({ workspaceId, submissionId: freezeId, expectedMainRevision: workspace.revision,
      coordinate: ({ previous, frozen, publish }) => {
        checkDeadline();
        const current = this.#read(initial.mission_id, initial.submission_id);
        if (current.state !== 'preparing') return current;
        const livePolicy = this.#ready(input);
        if (Date.now() >= livePolicy.deadline) throw timedOut();
        if (hash(initial.acceptance) !== hash(livePolicy.acceptance) || hash(initial.checker) !== hash(livePolicy.identity)) {
          throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Mission acceptance changed during preparation');
        }
        const snapshot = { workspace_id: workspaceId, main_revision: workspace.revision, main_commit: workspace.git_commit,
          git_tree: workspace.git_tree, content_hash: workspace.content_hash, materials, checker: livePolicy.identity, acceptance: livePolicy.acceptance };
        const snapshotFingerprint = hash(snapshot);
        const rows = this.#rows(missionId);
        const cached = rows.find(row => row.snapshot_fingerprint === snapshotFingerprint && [accepted, 'failed'].includes(row.state));
        const busy = rows.find(row => row.submission_id !== initial.submission_id &&
          (active.includes(row.state) || row.state === accepted || row.release_pending));
        if (busy && (busy.release_pending || busy.submission_id !== cached?.submission_id)) {
          throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Mission already has a submission or a pending freeze release', { submission_id: busy.submission_id });
        }
        if (frozen.main_commit !== workspace.git_commit) throw new SwarmEnvError('MAIN_MOVED', 'Mission main commit changed before submission');
        const attempts = rows.filter(row => row.snapshot_fingerprint === snapshotFingerprint && row.attempt_number > 0);
        const lastAttempt = attempts.at(-1);
        const base = { ...initial, ...snapshot, snapshot_fingerprint: snapshotFingerprint,
          deadline: iso(Math.min(deadline, livePolicy.deadline)), freeze_epoch: frozen.freeze_epoch };
        if (cached) {
          const alias = { ...base, state: 'reused', freeze_epoch: null, reused_submission_id: cached.submission_id,
            outcome: cached.state, result: cached.result, finished_at: cached.finished_at };
          if (!this.#write(alias, 'preparing')) return this.#read(initial.mission_id, initial.submission_id);
          return alias;
        }
        if (lastAttempt && (!['error', 'timed_out'].includes(lastAttempt.state) ||
            lastAttempt.attempt_number > this.maxInfrastructureRetries)) {
          const limited = { ...base, state: 'error', freeze_epoch: null, finished_at: iso(Date.now()),
            attempt_of: lastAttempt.attempt_of, result: { code: 'MISSION_RETRY_EXHAUSTED' } };
          if (!this.#write(limited, 'preparing')) return this.#read(initial.mission_id, initial.submission_id);
          return limited;
        }
        if (previous.frozen_submission_id && previous.frozen_submission_id !== freezeId) {
          throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Workspace is frozen by another Mission submission');
        }
        this.#assertFinalCheckAvailable(missionId);
        // Record the intended owner and generation before filesystem publication.
        const intent = { ...base, state: 'preparing', attempt_number: (lastAttempt?.attempt_number ?? 0) + 1,
          attempt_of: lastAttempt?.attempt_of ?? initial.submission_id };
        if (!this.#write(intent, 'preparing')) return this.#read(initial.mission_id, initial.submission_id);
        return this.#transaction(() => {
          const latest = this.#read(initial.mission_id, initial.submission_id);
          if (latest.state !== 'preparing') return latest;
          const currentPolicy = this.#ready(input);
          if (hash(currentPolicy.acceptance) !== hash(livePolicy.acceptance) ||
              hash(currentPolicy.identity) !== hash(livePolicy.identity)) {
            throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Mission acceptance changed during admission');
          }
          if (Date.now() >= currentPolicy.deadline) throw timedOut();
          if (this.validateMaterials) {
            const validation = this.validateMaterials({ missionId, materials });
            if (validation?.then || validation === false) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Material observations failed admission validation');
          }
          checkDeadline();
          this.#reserveFinalCheck(intent);
          publish();
          const pending = { ...intent, state: 'pending' };
          this.#write(pending, 'preparing');
          newlyAdmitted = true;
          return pending;
        });
      } });
    if (newlyAdmitted) {
      if (this.shuttingDown || this.stops.has(missionId)) this.#settleFinalCheck(submission);
      else this.#launch(submission, workspace.files);
    }
    return submission;
  }

  #insert(submission) {
    this.db.prepare('INSERT INTO mission_submissions VALUES (?, ?, ?, ?, ?, ?)')
      .run(submission.mission_id, submission.submission_id, submission.request_fingerprint, submission.snapshot_fingerprint,
        submission.state, JSON.stringify(submission));
  }

  #launch(submission, files) {
    const key = submission.freeze_id;
    if (this.work.has(key)) return;
    const controller = new AbortController();
    const deadline = Date.parse(submission.deadline);
    const work = { controller, timer: null, missionId: submission.mission_id };
    this.work.set(key, work);
    work.timer = setTimeout(() => {
      controller.abort();
      void this.#track(submission.mission_id, this.#finish(submission, 'timed_out', { code: 'SERVICE_TIMEOUT' })).catch(() => undefined);
    }, Math.max(0, deadline - Date.now()));
    work.timer.unref?.();
    work.promise = this.#track(submission.mission_id, Promise.resolve().then(() => {
      if (controller.signal.aborted || Date.now() >= deadline) throw timedOut();
      return this.checker.check({ workspaceId: submission.workspace_id, revision: submission.main_revision,
        tree: submission.git_tree, files, submission: structuredClone(submission), signal: controller.signal, deadline });
    }).finally(() => this.#settleFinalCheck(submission)).then(result => {
      const verdict = result?.verdict;
      const state = verdict === 'PASS' ? accepted : verdict === 'FAIL' ? 'failed' : 'error';
      return this.#finish(submission, state, { verdict: verdict === 'PASS' || verdict === 'FAIL' ? verdict : 'ERROR',
        check_result_id: typeof result?.check_result_id === 'string' ? result.check_result_id.slice(0, 256) : null,
        diagnostic: typeof result?.diagnostic === 'string' ? result.diagnostic.slice(0, 2048) : null });
    }, error => this.#finish(submission, error?.code === 'SERVICE_TIMEOUT' ? 'timed_out' : 'error',
      { code: error?.code === 'SERVICE_TIMEOUT' ? 'SERVICE_TIMEOUT' : 'CHECKER_ERROR' }))
      .catch(() => undefined).finally(() => {
        clearTimeout(work.timer);
        this.work.delete(key);
      }));
  }

  async #finish(expected, state, result) {
    const matches = current => current?.state === 'pending' && current.freeze_epoch === expected.freeze_epoch &&
      current.freeze_id === expected.freeze_id && current.snapshot_fingerprint === expected.snapshot_fingerprint;
    const submission = await this.workspace.withSubmissionFreeze({ workspaceId: expected.workspace_id, inspect: workspace => this.#transaction(() => {
      const current = this.#read(expected.mission_id, expected.submission_id);
      if (!matches(current)) {
        this.#audit(expected, `late_${state}`, result);
        return current;
      }
      if (this.shuttingDown || this.stops.has(current.mission_id)) {
        if (state !== 'cancelled') this.#audit(expected, `late_${state}`, result);
        state = 'cancelled';
        result = { code: 'MISSION_CHECK_CANCELLED' };
      } else if (Date.now() >= Date.parse(current.deadline)) {
        if (state !== 'timed_out') this.#audit(expected, `late_${state}`, result);
        state = 'timed_out';
        result = { code: 'SERVICE_TIMEOUT' };
      }
      if (workspace.frozen_submission_id !== current.freeze_id || workspace.freeze_epoch !== current.freeze_epoch ||
          workspace.main_revision !== current.main_revision || workspace.main_commit !== current.main_commit) {
        this.#audit(expected, `unmatched_${state}`, result);
        state = 'error';
        result = { code: 'MISSION_FREEZE_MISMATCH' };
      }
      if (state === accepted) {
        let eligible = false;
        try {
          eligible = checkerFields.every(field => this.checker?.identity?.[field] === current.checker[field]) &&
            this.validateCompletion?.(current) === true;
        } catch {
          this.#audit(expected, 'acceptance_validation_error', result);
          state = 'error';
          result = { code: 'MISSION_ACCEPTANCE_VALIDATION_ERROR' };
        }
        if (state === accepted && !eligible) {
          this.#audit(expected, 'unmatched_accepted', result);
          state = 'cancelled';
          result = { code: 'MISSION_NO_LONGER_ACCEPTING' };
        }
      }
      const terminal = { ...current, state, result, finished_at: iso(Date.now()),
        release_pending: state !== accepted, stop_pending: state === accepted };
      this.#write(terminal);
      return terminal;
    }) });
    if (submission) await this.#settle(submission);
    return submission;
  }

  async #settle(submission) {
    const { mission_id: missionId, submission_id: id } = submission;
    if (submission.release_pending) {
      await this.workspace.unfreeze({ workspaceId: submission.workspace_id, submissionId: submission.freeze_id })
        .catch(error => { if (error.code !== ERROR_CODES.FENCED) throw error; });
      this.#transaction(() => {
        const current = this.#read(missionId, id);
        if (current?.release_pending) this.#write({ ...current, release_pending: false });
      });
    }
    if (submission.stop_pending && this.onAccepted) {
      await this.onAccepted(structuredClone(submission));
      this.#transaction(() => {
        const current = this.#read(missionId, id);
        if (current?.stop_pending) this.#write({ ...current, stop_pending: false });
      });
    }
  }

  cancel(input) {
    return this.#track(input.missionId, this.#cancel(input));
  }

  async #cancel({ missionId, submissionId }) {
    // Persist before aborting: an adapter may synchronously resolve PASS in
    // its abort handler. The completion transaction must see cancellation.
    const cancelled = this.#transaction(() => {
      const current = this.#read(missionId, submissionId);
      if (!current || !active.includes(current.state)) return current;
      const row = { ...current, state: 'cancelled', result: { code: 'MISSION_CHECK_CANCELLED' },
        release_pending: current.freeze_epoch !== null, finished_at: iso(Date.now()) };
      this.#write(row);
      return row;
    });
    if (cancelled?.state !== 'cancelled') return cancelled;
    for (const admission of this.admissions) {
      if (admission.missionId === missionId && admission.requestId === submissionId) admission.controller.abort();
    }
    this.work.get(cancelled.freeze_id)?.controller.abort();
    await this.#settle(cancelled);
    return this.#read(missionId, submissionId);
  }

  reconcile(input) {
    return this.#track(input.missionId, this.#reconcile(input));
  }

  async #reconcile({ missionId }) {
    for (const submission of this.#rows(missionId)) {
      if (submission.state === 'preparing' && ![...this.admissions].some(admission => admission.missionId === missionId && admission.requestId === submission.submission_id)) {
        const recovered = await this.workspace.withSubmissionFreeze({ workspaceId: submission.workspace_id, inspect: () => this.#transaction(() => {
          const current = this.#read(missionId, submission.submission_id);
          if (current.state !== 'preparing') return current;
          const terminal = { ...current, state: 'error', result: { code: 'MISSION_ADMISSION_INTERRUPTED' },
            release_pending: current.freeze_epoch !== null, finished_at: iso(Date.now()) };
          this.#write(terminal);
          return terminal;
        }) });
        await this.#settle(recovered);
      } else if (submission.state === 'pending' && Date.now() >= Date.parse(submission.deadline)) {
        this.work.get(submission.freeze_id)?.controller.abort();
        await this.#finish(submission, 'timed_out', { code: 'SERVICE_TIMEOUT' });
      } else if (!this.shuttingDown && !this.stops.has(missionId) && submission.state === 'pending' && !this.work.has(submission.freeze_id) && !this.recoveryTimers.has(submission.freeze_id)) {
        if (this.manualReview && checkerFields.every(field => submission.checker?.[field] === this.checker.identity[field])) {
          this.#launch(submission, null);
          continue;
        }
        const timer = setTimeout(() => {
          this.recoveryTimers.delete(submission.freeze_id);
          void this.reconcile({ missionId }).catch(() => undefined);
        }, Math.max(1, Date.parse(submission.deadline) - Date.now()));
        timer.unref?.();
        this.recoveryTimers.set(submission.freeze_id, { missionId, timer });
      } else await this.#settle(submission);
    }
  }

  stop({ missionId }) {
    required(missionId, 'mission_id');
    if (this.stops.has(missionId)) return this.stops.get(missionId);
    // Fence synchronous admission immediately, including callbacks resuming
    // from Workspace or Material I/O while a shutdown waits on them.
    const stopping = Promise.resolve().then(() => this.#stopMission(missionId));
    this.stops.set(missionId, stopping);
    return stopping;
  }

  async #stopMission(missionId) {
    let error;
    let settlements = [];
    try {
      settlements = this.#transaction(() => this.#rows(missionId).map(row => {
        if (!active.includes(row.state)) return row;
        const cancelled = { ...row, state: 'cancelled', result: { code: 'MISSION_CHECK_CANCELLED' },
          release_pending: row.freeze_epoch !== null, finished_at: iso(Date.now()) };
        this.#write(cancelled);
        return cancelled;
      }));
    } catch (failure) { error = failure; }
    finally {
      const reason = new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Mission submission service stopped');
      for (const admission of this.admissions) if (admission.missionId === missionId) admission.controller.abort(reason);
      for (const work of this.work.values()) if (work.missionId === missionId) {
        clearTimeout(work.timer);
        work.controller.abort(reason);
      }
      for (const [key, recovery] of this.recoveryTimers) if (recovery.missionId === missionId) {
        clearTimeout(recovery.timer);
        this.recoveryTimers.delete(key);
      }
    }
    const settled = await Promise.allSettled(settlements.map(row => this.#track(missionId, this.#settle(row))));
    await this.waitForIdle({ missionId });
    if (error) throw error;
    const rejected = settled.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.#shutdown();
    return this.shutdownPromise;
  }

  async #shutdown() {
    const missionIds = new Set([
      ...this.db.prepare('SELECT DISTINCT mission_id FROM mission_submissions').all().map(row => row.mission_id),
      ...[...this.tasks].map(task => task.missionId),
    ]);
    const stopped = await Promise.allSettled([...missionIds].map(missionId => this.stop({ missionId })));
    await this.waitForIdle();
    if (this.ownsDatabase) this.db.close();
    const errors = stopped.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Mission submission cleanup failed');
  }

  isAccepted(missionId) {
    return Boolean(this.db.prepare("SELECT 1 FROM mission_submissions WHERE mission_id = ? AND state = 'accepted'").get(missionId));
  }

  async finish() {
    throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Mission verdict must come from the configured checker');
  }

  async describe({ missionId, submissionId, workspaceId, isStopped = () => false }) {
    return this.workspace.withSubmissionFreeze({ workspaceId, inspect: workspace => {
      const rows = this.#rows(missionId);
      const matches = row => row.workspace_id === workspaceId;
      const frozen = rows.find(row => matches(row) && row.freeze_id === workspace.frozen_submission_id);
      const winner = rows.find(row => row.state === accepted);
      const state = winner ? accepted : isStopped() ? 'stopped' : 'open';
      const live = { observed_at: iso(Date.now()), mission_state: state, main_revision: workspace.main_revision,
        active_submission_id: frozen?.submission_id ?? null, frozen: Boolean(workspace.frozen_submission_id),
        merge_allowed: state === 'open' && !workspace.frozen_submission_id };
      const describe = row => {
        const outcome = row.state === 'reused' ? row.outcome : row.state;
        const materials = row.materials?.map(item => item.material_id).join(', ') || '[]';
        const held = Boolean(workspace.frozen_submission_id && workspace.frozen_submission_id === row.freeze_id);
        const freeze_release_result = held ? 'held' : row.freeze_epoch == null || row.state === 'reused' ? 'never_acquired' : 'released';
        let notice;
        if (row.state === 'pending') notice = `submission ${row.submission_id} 已固定 main ${row.main_revision} 和材料 ${materials}。新的 main merge 暂停；查询同一 submission，不创建第二个有效提交。`;
        else if (outcome === accepted) notice = `submission ${row.submission_id} 已通过，接受的成果为 ${row.main_revision} 和材料 ${materials}。进入正常收尾；现有 E 仅在剩余收尾额度内 save/publish/finish，不再扩展工作。`;
        else if (!active.includes(row.state)) notice = `submission ${row.submission_id} 结果为 ${outcome}：${row.result?.code ?? row.result?.verdict ?? outcome}，检查对象仍固定为 ${row.main_revision ?? '未固定'}。本提交冻结的处理结果为 ${freeze_release_result}；当前 Mission 为 ${state}，当前冻结归属为 ${live.active_submission_id ?? '无'}，main 合入可用性为 ${live.merge_allowed}。未通过不能记为成功，旧结果不能解除较新提交或停止状态的限制。`;
        return { ...row, current: live, freeze_release_result, ...(notice ? { notice } : {}) };
      };
      if (submissionId) {
        const row = rows.find(item => item.submission_id === submissionId && matches(item));
        return row ? describe(row) : null;
      }
      return { mission_id: missionId, state, active_submission_id: live.active_submission_id,
        accepted_submission_id: winner?.submission_id ?? null, current: live, submissions: rows.filter(matches).map(describe) };
    } });
  }

  async get({ missionId, submissionId = null }) {
    if (submissionId) return this.#read(missionId, submissionId);
    const rows = this.#rows(missionId);
    if (!rows.length) return null;
    const pending = rows.find(row => active.includes(row.state));
    const winner = rows.find(row => row.state === accepted);
    return { mission_id: missionId, state: winner ? accepted : 'open', active_submission_id: pending?.submission_id ?? null,
      accepted_submission_id: winner?.submission_id ?? null, submissions: rows };
  }
}
