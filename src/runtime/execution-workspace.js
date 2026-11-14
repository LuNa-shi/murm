import { createHash } from 'node:crypto';
import { stableStringify } from '../protocol/envelope.js';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value);
const invalid = message => new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, message);
const changed = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  .filter(path => before[path]?.content_hash !== after[path]?.content_hash || before[path]?.bytes !== after[path]?.bytes);

export const EXECUTION_WORKSPACE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS execution_workspace_state (
      execution_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, initial_revision TEXT NOT NULL,
      last_saved_revision TEXT, manifest_json TEXT NOT NULL, parents_json TEXT NOT NULL,
      applied_json TEXT NOT NULL DEFAULT '[]', conflicts_json TEXT NOT NULL DEFAULT '[]',
      version INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_workspace_requests (
      execution_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      phase TEXT NOT NULL, captured_json TEXT, result_json TEXT, error_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(execution_id, request_id)
    );`;

/** Private E state and request recovery around immutable public Workspace saves.
 * The only file input is an authenticated, paused guest snapshot. Callers select
 * no path, tree, parent, Workspace, source identity or checker policy.
 */
export class ExecutionWorkspace {
  constructor({ taskService, workspace, sandboxManager, guard }) {
    this.tasks = taskService;
    this.db = taskService.db;
    this.workspace = workspace;
    this.sandbox = sandboxManager;
    this.guard = guard;
    this.db.exec(EXECUTION_WORKSPACE_SCHEMA_SQL);
  }

  #state(execution) {
    const input = execution.workspace_input;
    if (!input?.workspace_id || !input.revision || !input.manifest) throw invalid('Execution has no pinned public Workspace input');
    this.db.prepare(`INSERT OR IGNORE INTO execution_workspace_state
      (execution_id, workspace_id, initial_revision, manifest_json, parents_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(execution.execution_id, input.workspace_id, input.revision, json(input.manifest), json([input.revision]), new Date().toISOString());
    const row = this.db.prepare('SELECT * FROM execution_workspace_state WHERE execution_id = ?').get(execution.execution_id);
    if (row.workspace_id !== input.workspace_id || row.initial_revision !== input.revision) throw invalid('Execution Workspace lineage differs from its immutable initial input');
    return { ...row, manifest: JSON.parse(row.manifest_json), parents: JSON.parse(row.parents_json), applied_revisions: JSON.parse(row.applied_json), conflicts: JSON.parse(row.conflicts_json) };
  }

  #request(executionId, requestId) {
    return this.db.prepare('SELECT * FROM execution_workspace_requests WHERE execution_id = ? AND request_id = ?').get(executionId, requestId);
  }

  #decodeSnapshot(snapshot, execution) {
    if (snapshot?.execution_id !== execution.execution_id || snapshot.binding_version !== execution.fencing_version || snapshot.state !== 'ACTIVE' ||
        !snapshot.files || typeof snapshot.files !== 'object' || !snapshot.manifest || typeof snapshot.manifest !== 'object' || Array.isArray(snapshot.files) || Array.isArray(snapshot.manifest)) throw invalid('Worker snapshot does not match the active E');
    if (Object.keys(snapshot.files).length > 10_000) throw invalid('Snapshot exceeds entry bounds');
    const files = Object.create(null), manifest = Object.create(null);
    let total = 0;
    for (const path of Object.keys(snapshot.files).sort()) {
      if (path.includes('\\') || path.includes('\0') || path.split('/').some(part => !part || ['.', '..', '.git', '.pi', '.swarm', '.env', 'node_modules'].includes(part) || part.startsWith('.swarm-') || part.startsWith('.env.'))) throw invalid('Snapshot path is outside the project');
      const encoded = snapshot.files[path];
      if (typeof encoded !== 'string' || encoded.length > 4 * Math.ceil(2 * 1024 * 1024 / 3)) throw invalid('Snapshot content must be bounded base64 bytes');
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded) throw invalid('Snapshot contains invalid base64');
      total += bytes.length;
      if (bytes.length > 2 * 1024 * 1024 || total > 16 * 1024 * 1024) throw invalid('Snapshot exceeds byte bounds');
      files[path] = bytes;
      manifest[path] = { bytes: bytes.length, content_hash: hash(bytes) };
    }
    if (stableStringify(manifest) !== stableStringify(snapshot.manifest) || hash(stableStringify(manifest)) !== snapshot.content_hash) throw invalid('Snapshot content and manifest disagree');
    return { files, manifest, content_hash: snapshot.content_hash };
  }

  async #capture(execution, identity) {
    this.guard(identity);
    const snapshot = await this.sandbox.snapshotBotProject({ executionId: execution.execution_id });
    this.guard(identity);
    return this.#decodeSnapshot(snapshot, execution);
  }

  #view(state, snapshot) {
    return { execution_id: state.execution_id, workspace_id: state.workspace_id, initial_revision: state.initial_revision,
      last_saved_revision: state.last_saved_revision, current_base_revision: state.last_saved_revision ?? state.initial_revision,
      parents: state.parents, applied_revisions: state.applied_revisions, conflicts: state.conflicts,
      dirty: hash(stableStringify(state.manifest)) !== snapshot.content_hash, content_hash: snapshot.content_hash,
      changed_paths: changed(state.manifest, snapshot.manifest) };
  }

  async reconcile(executionId) {
    const execution = this.tasks.getExecution(executionId);
    const pending = this.db.prepare("SELECT * FROM execution_workspace_requests WHERE execution_id = ? AND phase IN ('capturing', 'captured') ORDER BY created_at, request_id").all(executionId);
    if (!pending.length) return;
    const state = this.#state(execution);
    return this.workspace.repository.requestLocked(this.workspace.workspacePath(state.workspace_id), hash(`execution:${executionId}`), async () => {
      for (const prior of pending) {
        const row = this.#request(executionId, prior.request_id);
        if (row.phase === 'capturing') this.#fail(row, new SwarmEnvError(ERROR_CODES.WORKSPACE_REQUEST_ABORTED, 'Snapshot owner ended before recording its immutable input; use a new request ID'));
        else if (row.phase === 'captured') {
          const source = JSON.parse(row.captured_json).source;
          try { await this.#complete(row, { actorRef: source.bot_id, taskId: source.task_id, executionId, fencingVersion: source.fencing_version }); }
          catch (error) { if (this.#request(executionId, row.request_id).phase !== 'failed') throw error; }
        }
      }
    });
  }

  async dispatch(operation, input, identity) {
    if (!['save', 'status', 'diff'].includes(operation)) throw invalid('Unknown Execution Workspace operation');
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw invalid('Workspace input cannot supply files, paths, lineage or identity; conflict resolution requires apply integration');
    const execution = this.guard(identity, { receiptOnly: true });
    const state = this.#state(execution);
    const requestId = identity.requestId;
    if (typeof requestId !== 'string' || !requestId) throw invalid('Workspace operation requires a stable request ID');
    const fingerprint = hash(stableStringify({ operation, input }));
    return this.workspace.repository.requestLocked(this.workspace.workspacePath(state.workspace_id), hash(`execution:${execution.execution_id}`), async () => {
      this.guard(identity, { receiptOnly: true });
      const original = this.#request(execution.execution_id, requestId);
      if (original && original.fingerprint !== fingerprint) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Workspace request ID was reused with another payload');
      // A prior process can have committed Git before its SQL acknowledgement.
      // Reconcile captured operations before selecting the next saved parent.
      for (const pending of this.db.prepare("SELECT * FROM execution_workspace_requests WHERE execution_id = ? AND phase IN ('capturing', 'captured') ORDER BY created_at, request_id").all(execution.execution_id)) {
        if (pending.phase === 'capturing') this.#fail(pending, new SwarmEnvError(ERROR_CODES.WORKSPACE_REQUEST_ABORTED, 'Snapshot owner ended before recording its immutable input; use a new request ID'));
        else {
          const source = JSON.parse(pending.captured_json).source;
          try { await this.#complete(pending, { actorRef: source.bot_id, taskId: source.task_id, executionId: source.execution_id, fencingVersion: source.fencing_version }); }
          catch (error) { if (this.#request(pending.execution_id, pending.request_id).phase !== 'failed') throw error; }
        }
      }
      const existing = this.#request(execution.execution_id, requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new SwarmEnvError(ERROR_CODES.CONFLICT, 'Workspace request ID was reused with another payload');
        if (existing.error_json) { const error = JSON.parse(existing.error_json); throw new SwarmEnvError(error.code, error.message, error.details); }
        if (existing.result_json) return JSON.parse(existing.result_json);
      }
      const current = this.#state(this.guard(identity));
      if (operation !== 'save') {
        const snapshot = await this.#capture(execution, identity);
        const view = this.#view(current, snapshot);
        return operation === 'diff' ? { ...view, changes: view.changed_paths.map(path => ({ path, before: current.manifest[path] ?? null, after: snapshot.manifest[path] ?? null })) } : view;
      }
      const timestamp = new Date().toISOString();
      this.db.prepare(`INSERT INTO execution_workspace_requests (execution_id, request_id, fingerprint, phase, created_at, updated_at) VALUES (?, ?, ?, 'capturing', ?, ?)`)
        .run(execution.execution_id, requestId, fingerprint, timestamp, timestamp);
      try {
        const snapshot = await this.#capture(execution, identity);
        const captured = { workspace_id: current.workspace_id, base_revision: current.last_saved_revision ?? current.initial_revision, parents: current.parents,
          state_version: current.version, manifest: snapshot.manifest, files: Object.fromEntries(Object.entries(snapshot.files).map(([path, bytes]) => [path, bytes.toString('base64')])),
          source: { mission_id: this.tasks.getTask(execution.task_id).mission_id, task_id: execution.task_id, execution_id: execution.execution_id, bot_id: execution.owner_ref, fencing_version: execution.fencing_version },
          conflicts: current.conflicts };
        this.guard(identity);
        this.db.prepare("UPDATE execution_workspace_requests SET phase = 'captured', captured_json = ?, updated_at = ? WHERE execution_id = ? AND request_id = ?")
          .run(json(captured), new Date().toISOString(), execution.execution_id, requestId);
        return await this.#complete(this.#request(execution.execution_id, requestId), identity);
      } catch (error) {
        const row = this.#request(execution.execution_id, requestId);
        if (row.phase === 'capturing') {
          const outcome = new SwarmEnvError(error.code === ERROR_CODES.WORKSPACE_BUSY ? ERROR_CODES.WORKSPACE_BUSY : ERROR_CODES.WORKSPACE_REQUEST_ABORTED,
            error.code === ERROR_CODES.WORKSPACE_BUSY ? 'No stable snapshot window; use a new request ID' : 'Snapshot did not complete; use a new request ID', { cause_code: error.code ?? 'SNAPSHOT_ERROR' });
          this.#fail(row, outcome);
          throw outcome;
        }
        throw error;
      }
    });
  }

  #fail(row, error) {
    this.db.prepare("UPDATE execution_workspace_requests SET phase = 'failed', captured_json = NULL, error_json = ?, updated_at = ? WHERE execution_id = ? AND request_id = ?")
      .run(json({ code: error.code, message: error.message, details: error.details }), new Date().toISOString(), row.execution_id, row.request_id);
  }

  async #complete(row, identity) {
    const captured = JSON.parse(row.captured_json);
    const execution = this.guard(identity, { receiptOnly: true });
    if (captured.source.execution_id !== execution.execution_id || captured.source.bot_id !== execution.owner_ref || captured.source.fencing_version !== identity.fencingVersion) throw invalid('Captured request identity does not match its E');
    const files = Object.fromEntries(Object.entries(captured.files).map(([path, encoded]) => [path, Buffer.from(encoded, 'base64')]));
    const options = { workspaceId: captured.workspace_id, baseRevision: captured.base_revision, parentRevisions: captured.parents,
      files, source: captured.source, requestId: `execution:${row.execution_id}:save:${row.request_id}`, guard: () => this.guard(identity),
      withPublication: publish => {
        // All TaskService writers serialize with this transaction. Hold it
        // across the final guard and synchronous Git intent/publication, so
        // another process cannot accept finish in between those two points.
        try { this.db.exec('BEGIN IMMEDIATE'); }
        catch (error) {
          if (error.errcode === 5) throw new SwarmEnvError(ERROR_CODES.WORKSPACE_BUSY, 'Publication lock is busy; retry the original request ID', undefined, { retryable: true, cause: error });
          throw error;
        }
        try { publish(); this.db.exec('COMMIT'); }
        catch (error) { this.db.exec('ROLLBACK'); throw error; }
      } };
    let result;
    try {
      result = await this.workspace.replaySave(options);
      if (!result) { this.guard(identity); result = await this.workspace.save(options); }
    } catch (error) {
      // Only known pre-publication rejections are terminal. I/O/unknown commit
      // errors retain the exact capture for later Git receipt reconciliation.
      if ([ERROR_CODES.NOT_ALLOWED, ERROR_CODES.INVALID_CONTRACT, ERROR_CODES.CONFLICT, ERROR_CODES.WORKSPACE_REQUEST_ABORTED].includes(error.code)) this.#fail(row, error);
      throw error;
    }
    let transaction = false;
    try {
      const receipt = { ...result, execution_id: row.execution_id, initial_revision: this.#state(this.tasks.getExecution(row.execution_id)).initial_revision,
        changed_paths: result.changed_files, conflicts: captured.conflicts };
      this.db.exec('BEGIN IMMEDIATE');
      transaction = true;
      const updated = this.db.prepare(`UPDATE execution_workspace_state SET last_saved_revision = ?, manifest_json = ?, parents_json = ?, version = version + 1, updated_at = ?
        WHERE execution_id = ? AND version = ?`).run(result.revision, json(captured.manifest), json([result.revision]), new Date().toISOString(), row.execution_id, captured.state_version);
      if (updated.changes !== 1) throw new SwarmEnvError(ERROR_CODES.WORKSPACE_RECONCILIATION_REQUIRED, 'Saved revision must be reconciled with E lineage before another write');
      this.db.prepare("UPDATE execution_workspace_requests SET phase = 'done', captured_json = NULL, result_json = ?, updated_at = ? WHERE execution_id = ? AND request_id = ?")
        .run(json(receipt), new Date().toISOString(), row.execution_id, row.request_id);
      this.db.exec('COMMIT');
      return receipt;
    } catch (error) {
      if (transaction) { try { this.db.exec('ROLLBACK'); } catch { /* COMMIT may have succeeded before acknowledgement failed. */ } }
      if (error.code === ERROR_CODES.WORKSPACE_RECONCILIATION_REQUIRED) throw error;
      throw new SwarmEnvError('WORKSPACE_RESULT_UNKNOWN', 'Saved revision acknowledgement is unavailable; retry the original request ID', undefined, { retryable: true, cause: error });
    }
  }
}
