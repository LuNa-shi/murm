import { assertServiceCommitSettled } from '../sdk/service-commit-gate.js';
import { createHash } from 'node:crypto';
import { stableStringify } from '../protocol/envelope.js';
import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { assertNewExecutionWork } from '../task/execution-budget.js';
import { publishWorkspace } from './workspace-publication.js';

const hash = (value: any) => createHash('sha256').update(value).digest('hex');
const json = (value: any) => JSON.stringify(value);
const invalid = (message: any) => new SwarmEnvError(ERROR_CODES.INVALID_CONTRACT, message);
const changed = (before: any, after: any) => [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  .filter((path: any) => before[path]?.content_hash !== after[path]?.content_hash || before[path]?.bytes !== after[path]?.bytes);

// Internal coordinator signal: the candidate never owned this durable request.
export class WorkspaceRequestMismatchError extends SwarmEnvError {
  constructor() {
    super(ERROR_CODES.CONFLICT, 'Workspace request ID was reused with another payload');
  }
}

export const EXECUTION_WORKSPACE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS execution_workspace_state (
      execution_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, initial_revision TEXT NOT NULL,
      last_saved_revision TEXT, manifest_json TEXT NOT NULL, parents_json TEXT NOT NULL,
      applied_json TEXT NOT NULL DEFAULT '[]', conflicts_json TEXT NOT NULL DEFAULT '[]', pending_apply INTEGER NOT NULL DEFAULT 0,
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
  declare tasks: any;
  declare context: any;
  declare db: any;
  declare workspace: any;
  declare sandbox: any;
  declare guard: any;
  declare onPending: any;

  constructor({ taskService, contextService = null, workspace, sandboxManager, guard, onPending = null }: any) {
    this.tasks = taskService;
    this.context = contextService;
    this.db = taskService.db;
    this.workspace = workspace;
    this.sandbox = sandboxManager;
    this.guard = guard;
    this.onPending = onPending;
    const busyTimeout = this.db.prepare('PRAGMA busy_timeout').get().timeout;
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(busyTimeout, 1000)}`);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(EXECUTION_WORKSPACE_SCHEMA_SQL);
        this.db.exec('COMMIT');
      } catch (error: any) { this.db.exec('ROLLBACK'); throw error; }
    } finally { this.db.exec(`PRAGMA busy_timeout = ${busyTimeout}`); }
  }

  #state(execution: any) {
    const input = execution.workspace_input;
    if (!input?.workspace_id || !input.revision || !input.manifest) throw invalid('Execution has no pinned public Workspace input');
    this.db.prepare(`INSERT OR IGNORE INTO execution_workspace_state
      (execution_id, workspace_id, initial_revision, manifest_json, parents_json, conflicts_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(execution.execution_id, input.workspace_id, input.revision, json(input.manifest), json([input.revision]), json(input.conflicts ?? []), new Date().toISOString());
    const row = this.db.prepare('SELECT * FROM execution_workspace_state WHERE execution_id = ?').get(execution.execution_id);
    if (row.workspace_id !== input.workspace_id || row.initial_revision !== input.revision) throw invalid('Execution Workspace lineage differs from its immutable initial input');
    return { ...row, manifest: JSON.parse(row.manifest_json), parents: JSON.parse(row.parents_json), applied_revisions: JSON.parse(row.applied_json), conflicts: JSON.parse(row.conflicts_json) };
  }

  #request(executionId: any, requestId: any) {
    return this.db.prepare('SELECT * FROM execution_workspace_requests WHERE execution_id = ? AND request_id = ?').get(executionId, requestId);
  }

  #decodeSnapshot(snapshot: any, execution: any) {
    if (snapshot?.execution_id !== execution.execution_id || snapshot.binding_version !== execution.fencing_version || snapshot.state !== 'ACTIVE' ||
        !snapshot.files || typeof snapshot.files !== 'object' || !snapshot.manifest || typeof snapshot.manifest !== 'object' || Array.isArray(snapshot.files) || Array.isArray(snapshot.manifest)) throw invalid('Worker snapshot does not match the active E');
    if (Object.keys(snapshot.files).length > 10_000) throw invalid('Snapshot exceeds entry bounds');
    const files = Object.create(null), manifest = Object.create(null);
    let total = 0;
    for (const path of Object.keys(snapshot.files).sort()) {
      if (path.includes('\\') || path.includes('\0') || path.split('/').some((part: any) => !part || ['.', '..', '.git', '.pi', '.swarm', '.env', 'node_modules'].includes(part) || part.startsWith('.swarm-') || part.startsWith('.env.'))) throw invalid('Snapshot path is outside the project');
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

  async #capture(execution: any, identity: any) {
    this.guard(identity);
    const snapshot = await this.sandbox.snapshotBotProject({ executionId: execution.execution_id, requestId: `flat:snapshot:${hash(stableStringify([execution.execution_id, identity.requestId]))}` });
    this.guard(identity);
    return this.#decodeSnapshot(snapshot, execution);
  }

  #view(state: any, snapshot: any) {
    return { execution_id: state.execution_id, workspace_id: state.workspace_id, initial_revision: state.initial_revision,
      last_saved_revision: state.last_saved_revision, current_base_revision: state.last_saved_revision ?? state.initial_revision,
      parents: state.parents, applied_revisions: state.applied_revisions, conflicts: state.conflicts,
      dirty: Boolean(state.pending_apply) || hash(stableStringify(state.manifest)) !== snapshot.content_hash, content_hash: snapshot.content_hash,
      changed_paths: changed(state.manifest, snapshot.manifest) };
  }

  async reconcile(executionId: any, { closedConfirmed = false }: any = {}) {
    const execution = this.tasks.getExecution(executionId);
    const pending = this.db.prepare("SELECT * FROM execution_workspace_requests WHERE execution_id = ? AND phase IN ('capturing', 'captured', 'installing', 'installed') ORDER BY created_at, request_id").all(executionId);
    if (!pending.length) return;
    const state = this.#state(execution);
    return this.workspace.repository.requestLocked(this.workspace.workspacePath(state.workspace_id), hash(`execution:${executionId}`), async () => {
      for (const prior of pending) {
        const row = this.#request(executionId, prior.request_id);
        if (row.phase === 'capturing') this.#fail(row, new SwarmEnvError(ERROR_CODES.WORKSPACE_REQUEST_ABORTED, 'Snapshot owner ended before recording its immutable input; use a new request ID'));
        else if (['captured', 'installing', 'installed'].includes(row.phase)) {
          const source = JSON.parse(row.captured_json).source;
          try { await this.#complete(row, { actorRef: source.bot_id, taskId: source.task_id, executionId, fencingVersion: source.fencing_version }, { closedConfirmed }); }
          catch (error: any) { if (this.#request(executionId, row.request_id).phase !== 'failed') throw error; }
        }
      }
    });
  }

  async dispatch(operation: any, input: any, identity: any) {
    if (!['save', 'apply', 'status', 'diff'].includes(operation)) throw invalid('Unknown Execution Workspace operation');
    const allowed = operation === 'save' ? ['resolved', 'material_ids'] : operation === 'apply' ? ['from'] : [];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key: any) => !allowed.includes(key))) throw invalid('Workspace input cannot supply files, paths, lineage or identity');
    if (input.material_ids !== undefined && (!Array.isArray(input.material_ids) || input.material_ids.length > 20 ||
        new Set(input.material_ids).size !== input.material_ids.length ||
        input.material_ids.some((id: any) => typeof id !== 'string' || !id || id.length > 256))) {
      throw invalid('material_ids must contain at most twenty distinct Material IDs');
    }
    if (input.resolved !== undefined && typeof input.resolved !== 'boolean') throw invalid('resolved must be boolean');
    const execution = this.guard(identity, { receiptOnly: true });
    if (operation === 'apply') {
      if (typeof input.from !== 'string' || !/^\d+\.\d+$/.test(input.from)) throw invalid('Apply requires a fixed public revision');
    }
    const state = this.#state(execution);
    const requestId = identity.requestId;
    if (typeof requestId !== 'string' || !requestId) throw invalid('Workspace operation requires a stable request ID');
    const fingerprint = hash(stableStringify({ operation, input }));
    return this.workspace.repository.requestLocked(this.workspace.workspacePath(state.workspace_id), hash(`execution:${execution.execution_id}`), async () => {
      this.guard(identity, { receiptOnly: true });
      const original = this.#request(execution.execution_id, requestId);
      if (original && original.fingerprint !== fingerprint) throw new WorkspaceRequestMismatchError();
      if (original?.error_json) { const error = JSON.parse(original.error_json); throw new SwarmEnvError(error.code, error.message, error.details); }
      if (original?.phase === 'done' && original.result_json) return JSON.parse(original.result_json);
      // A prior process can have committed Git before its SQL acknowledgement.
      // Reconcile captured operations before selecting the next saved parent.
      for (const pending of this.db.prepare("SELECT * FROM execution_workspace_requests WHERE execution_id = ? AND phase IN ('capturing', 'captured', 'installing', 'installed') ORDER BY created_at, request_id").all(execution.execution_id)) {
        if (pending.phase === 'capturing') {
          if (this.sandbox.recoverSnapshot) {
            if (pending.request_id === requestId) continue;
            throw new SwarmEnvError(ERROR_CODES.WORKSPACE_RESULT_UNKNOWN, 'An earlier snapshot awaits its original request ID', undefined, { retryable: true });
          }
          this.#fail(pending, new SwarmEnvError(ERROR_CODES.WORKSPACE_REQUEST_ABORTED, 'Snapshot owner ended before recording its immutable input; use a new request ID'));
        }
        else {
          const source = JSON.parse(pending.captured_json).source;
          try {
            await this.#complete(pending, { actorRef: source.bot_id, taskId: source.task_id,
              executionId: source.execution_id, fencingVersion: source.fencing_version, signal: identity.signal });
          }
          catch (error: any) { if (this.#request(pending.execution_id, pending.request_id).phase !== 'failed') throw error; }
        }
      }
      const existing = this.#request(execution.execution_id, requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new WorkspaceRequestMismatchError();
        if (existing.error_json) { const error = JSON.parse(existing.error_json); throw new SwarmEnvError(error.code, error.message, error.details); }
        if (existing.result_json) return JSON.parse(existing.result_json);
      }
      const active = this.guard(identity);
      const current = this.#state(active);
      if (operation === 'apply' && !original) assertNewExecutionWork(active);
      if (['status', 'diff'].includes(operation)) {
        const snapshot = await this.#capture(execution, identity);
        const view = this.#view(current, snapshot);
        return operation === 'diff' ? { ...view, changes: view.changed_paths.map((path: any) => ({ path, before: current.manifest[path] ?? null, after: snapshot.manifest[path] ?? null })) } : view;
      }
      const timestamp = new Date().toISOString();
      this.db.prepare(`INSERT OR IGNORE INTO execution_workspace_requests (execution_id, request_id, fingerprint, phase, created_at, updated_at) VALUES (?, ?, ?, 'capturing', ?, ?)`)
        .run(execution.execution_id, requestId, fingerprint, timestamp, timestamp);
      try {
        const snapshot = await this.#capture(execution, identity);
        let captured: any = { kind: operation, workspace_id: current.workspace_id, base_revision: current.last_saved_revision ?? current.initial_revision, parents: current.parents,
          state_version: current.version, manifest: snapshot.manifest, files: Object.fromEntries(Object.entries(snapshot.files).map(([path, bytes]: any) => [path, bytes.toString('base64')])),
          source: { mission_id: this.tasks.getTask(execution.task_id).mission_id, task_id: execution.task_id, execution_id: execution.execution_id, bot_id: execution.owner_ref, fencing_version: execution.fencing_version },
          conflicts: current.conflicts };
        if (operation === 'save' && input.material_ids?.length) {
          const context = this.context ?? this.tasks.contextService;
          if (!context?.readWorkspaceMaterialUses) throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, 'Workspace Material use authority is unavailable');
          captured.source.material_uses = context.readWorkspaceMaterialUses({ missionId: captured.source.mission_id,
            taskId: execution.task_id, executionId: execution.execution_id, materialIds: input.material_ids });
        }
        if (operation === 'apply') {
          assertNewExecutionWork(active);
          if (this.#view(current, snapshot).dirty) throw new SwarmEnvError(ERROR_CODES.WORKSPACE_BUSY, 'Save unsaved project changes before apply', { apply_blocker: 'dirty' });
          const plan = await this.workspace.planApply({ workspaceId: current.workspace_id, baseRevision: captured.base_revision, fromRevision: input.from, requestId });
          if (plan.expected_content_hash !== snapshot.content_hash) throw invalid('Apply base differs from the current saved project');
          captured = { kind: 'apply', state_version: current.version, source: captured.source, ...plan,
            snapshot_request_id: `flat:snapshot:${hash(stableStringify([execution.execution_id, identity.requestId]))}`,
            files: Object.fromEntries(Object.entries(plan.files).map(([path, bytes]: any) => [path, Buffer.from(bytes).toString('base64')])) };
        } else if (input.resolved) captured.conflicts = this.#resolveConflicts(current.conflicts, snapshot.files);
        this.db.exec('BEGIN IMMEDIATE');
        try {
          assertServiceCommitSettled(this.db);
          this.guard(identity);
          this.db.prepare("UPDATE execution_workspace_requests SET phase = 'captured', captured_json = ?, updated_at = ? WHERE execution_id = ? AND request_id = ?")
            .run(json(captured), new Date().toISOString(), execution.execution_id, requestId);
          this.db.exec('COMMIT');
        } catch (error: any) { this.db.exec('ROLLBACK'); throw error; }
        return await this.#complete(this.#request(execution.execution_id, requestId), identity);
      } catch (error: any) {
        const row = this.#request(execution.execution_id, requestId);
        if (row.phase === 'capturing') {
          const known = [ERROR_CODES.WORKSPACE_BUSY, ERROR_CODES.INVALID_CONTRACT].includes(error.code);
          const definitive = known || ['NOT_ALLOWED', 'FENCED', 'CONFLICT'].includes(error.code);
          if (this.sandbox.recoverSnapshot && !definitive) {
            this.onPending?.(execution.execution_id);
            throw new SwarmEnvError(ERROR_CODES.WORKSPACE_RESULT_UNKNOWN, 'Snapshot receipt is unknown; retry the original request ID', undefined, { retryable: true, cause: error });
          }
          const outcome = new SwarmEnvError(known ? error.code : ERROR_CODES.WORKSPACE_REQUEST_ABORTED,
            known ? `${error.message}; use a new request ID` : 'Snapshot did not complete; use a new request ID', { ...error.details, cause_code: error.code ?? 'SNAPSHOT_ERROR' });
          this.#fail(row, outcome);
          throw outcome;
        }
        throw error;
      }
    });
  }

  #fail(row: any, error: any) {
    this.db.prepare("UPDATE execution_workspace_requests SET phase = 'failed', captured_json = NULL, error_json = ?, updated_at = ? WHERE execution_id = ? AND request_id = ?")
      .run(json({ code: error.code, message: error.message, details: error.details }), new Date().toISOString(), row.execution_id, row.request_id);
  }

  #resolveConflicts(conflicts: any, files: any) {
    for (const conflict of conflicts) {
      if (!conflict.artifact_root || !Array.isArray(conflict.paths) || !Array.isArray(conflict.marker_labels)) throw invalid('Conflict provenance cannot be verified');
      if (Object.keys(files).some((path: any) => path === conflict.artifact_root || path.startsWith(`${conflict.artifact_root}/`))) throw invalid('Resolve the ordinary project files and remove the recorded conflict alternatives before save --resolved');
      for (const path of conflict.paths) {
        if (!files[path]) continue; // Deleting a conflicted path is an explicit resolution.
        const lines = files[path].toString('utf8').split('\n');
        if ((conflict.marker_lines ?? []).some((marker: any) => marker.path === path && lines.filter((line: any) => line === marker.line).length > (marker.allowed_count ?? 0)) ||
          lines.some((line: any) => /^[<>]+ /.test(line) && conflict.marker_labels.some((label: any) => line.includes(label)))) throw invalid('Recorded conflict markers remain in the project');
      }
    }
    return [];
  }

  // Persist lineage before confirming the Worker acknowledgement and resuming writers.
  async #completeApply(row: any, identity: any, { closedConfirmed = false }: any = {}) {
    const captured: any = JSON.parse(row.captured_json);
    const execution = this.guard(identity, { receiptOnly: true });
    if (captured.source.execution_id !== execution.execution_id || captured.source.bot_id !== execution.owner_ref || captured.source.fencing_version !== identity.fencingVersion) throw invalid('Apply capture identity differs from its E');
    const workerId = `apply:${hash(stableStringify([row.execution_id, row.request_id]))}`;
    const workerInput = { executionId: row.execution_id, request_id: workerId, snapshot_request_id: captured.snapshot_request_id, expected_content_hash: captured.expected_content_hash, content_hash: captured.content_hash, files: captured.files };
    const expectedFingerprint = hash(stableStringify({ expected_content_hash: captured.expected_content_hash, content_hash: captured.content_hash }));
    const verify = (receipt: any) => {
      if (!receipt || receipt.execution_id !== row.execution_id || receipt.binding_version !== identity.fencingVersion || receipt.request_id !== workerId) throw invalid('Worker install receipt does not match its request');
      if (receipt.phase !== 'not_found' && (receipt.fingerprint !== expectedFingerprint || receipt.content_hash !== captured.content_hash)) throw invalid('Worker install receipt does not match its captured tree');
      return receipt;
    };
    try {
      try { this.guard(identity); }
      catch (error: any) {
        let closedReceipt: any = null;
        try { closedReceipt = verify(await this.sandbox.queryBotProjectInstall(workerInput)); } catch { /* No confirmed worker outcome survives. */ }
        if (row.phase === 'installed' && closedReceipt?.phase === 'committed') {
          this.db.prepare("UPDATE execution_workspace_requests SET phase = 'done', captured_json = NULL, updated_at = ? WHERE execution_id = ? AND request_id = ?")
            .run(new Date().toISOString(), row.execution_id, row.request_id);
          return JSON.parse(row.result_json);
        }
        if (!closedConfirmed) throw new SwarmEnvError(ERROR_CODES.WORKSPACE_RESULT_UNKNOWN, 'Apply is waiting for physical close receipts');
        const aborted = new SwarmEnvError(ERROR_CODES.WORKSPACE_REQUEST_ABORTED, 'E closed before apply completion; its private worktree cannot continue', {
          installation: closedReceipt?.phase ?? (row.phase === 'installed' ? 'installed_unconfirmed' : 'unknown'), worktree_closed: true,
          installed_result: row.phase === 'installed' ? JSON.parse(row.result_json) : null });
        this.#fail(row, aborted);
        throw aborted;
      }
      if (row.phase === 'captured') {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          assertServiceCommitSettled(this.db);
          this.guard(identity);
          this.db.prepare("UPDATE execution_workspace_requests SET phase = 'installing', updated_at = ? WHERE execution_id = ? AND request_id = ? AND phase = 'captured'")
            .run(new Date().toISOString(), row.execution_id, row.request_id);
          this.db.exec('COMMIT');
        } catch (error: any) { this.db.exec('ROLLBACK'); throw error; }
        row = this.#request(row.execution_id, row.request_id);
      }
      let receipt = verify(await this.sandbox.queryBotProjectInstall(workerInput));
      if (receipt.phase === 'not_found' && row.phase === 'installing') {
        this.guard(identity);
        try { receipt = verify(await this.sandbox.installBotProject(workerInput)); }
        catch (error: any) {
          if ([ERROR_CODES.WORKSPACE_BUSY, ERROR_CODES.INVALID_CONTRACT].includes(error.code)) this.#fail(row, error);
          throw error;
        }
      }
      if (receipt.phase === 'failed') {
        const error = new SwarmEnvError(receipt.error?.code ?? ERROR_CODES.WORKSPACE_REQUEST_ABORTED, receipt.error?.message ?? 'Apply installation failed');
        this.#fail(row, error); throw error;
      }
      if (!['installed', 'committed'].includes(receipt.phase)) throw new SwarmEnvError(ERROR_CODES.WORKSPACE_RESULT_UNKNOWN, 'Apply installation is not yet acknowledged');
      if (row.phase === 'installing') {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          assertServiceCommitSettled(this.db);
          const current = this.#state(this.guard(identity));
          const applied = [...current.applied_revisions, { revision: captured.source_revision, base_revision: captured.base_revision, request_id: row.request_id, content_hash: captured.content_hash, already_included: captured.already_included }];
          const updated = this.db.prepare(`UPDATE execution_workspace_state SET parents_json = ?, applied_json = ?, conflicts_json = ?, pending_apply = ?, version = version + 1, updated_at = ? WHERE execution_id = ? AND version = ?`)
            .run(json(captured.parents), json(applied), json(captured.conflicts), captured.already_included ? current.pending_apply : 1, new Date().toISOString(), row.execution_id, captured.state_version);
          if (updated.changes !== 1) throw new SwarmEnvError(ERROR_CODES.WORKSPACE_RECONCILIATION_REQUIRED, 'Apply install must reconcile E lineage before resuming writers');
          const result = { workspace_id: captured.workspace_id, execution_id: row.execution_id, initial_revision: current.initial_revision,
            base_revision: captured.base_revision, source_revision: captured.source_revision, parents: captured.parents, conflicts: captured.conflicts,
            content_hash: captured.content_hash, changed_paths: captured.changed_paths, already_included: captured.already_included, applied_revisions: applied };
          this.db.prepare("UPDATE execution_workspace_requests SET phase = 'installed', result_json = ?, updated_at = ? WHERE execution_id = ? AND request_id = ?")
            .run(json(result), new Date().toISOString(), row.execution_id, row.request_id);
          this.db.exec('COMMIT');
        } catch (error: any) { this.db.exec('ROLLBACK'); throw error; }
        row = this.#request(row.execution_id, row.request_id);
      }
      if (receipt.phase !== 'committed') {
        this.guard(identity);
        receipt = verify(await this.sandbox.confirmBotProjectInstall(workerInput));
        if (receipt.phase !== 'committed') throw new SwarmEnvError(ERROR_CODES.WORKSPACE_RESULT_UNKNOWN, 'Worker has not confirmed apply acknowledgement');
      }
      this.db.prepare("UPDATE execution_workspace_requests SET phase = 'done', captured_json = NULL, updated_at = ? WHERE execution_id = ? AND request_id = ?")
        .run(new Date().toISOString(), row.execution_id, row.request_id);
      return JSON.parse(row.result_json);
    } catch (error: any) {
      if (this.#request(row.execution_id, row.request_id).phase === 'failed') throw error;
      this.onPending?.(row.execution_id, 'apply');
      throw new SwarmEnvError(ERROR_CODES.WORKSPACE_RESULT_UNKNOWN, 'Apply result is pending reconciliation; retry the original request ID', undefined, { retryable: true, cause: error });
    }
  }

  async #complete(row: any, identity: any, completionOptions: any = {}) {
    const captured: any = JSON.parse(row.captured_json);
    if (captured.kind === 'apply') return this.#completeApply(row, identity, completionOptions);
    const execution = this.guard(identity, { receiptOnly: true });
    if (captured.source.execution_id !== execution.execution_id || captured.source.bot_id !== execution.owner_ref || captured.source.fencing_version !== identity.fencingVersion) throw invalid('Captured request identity does not match its E');
    const files = Object.fromEntries(Object.entries(captured.files).map(([path, encoded]: any) => [path, Buffer.from(encoded, 'base64')]));
    const options = { workspaceId: captured.workspace_id, baseRevision: captured.base_revision, parentRevisions: captured.parents,
      files, source: captured.source, conflicts: captured.conflicts, requestId: `execution:${row.execution_id}:save:${row.request_id}`, guard: () => this.guard(identity),
      withPublication: (publish: any) => publishWorkspace(this.db, publish) };
    let result;
    try {
      result = await this.workspace.replaySave(options);
      if (!result) { this.guard(identity); result = await this.workspace.save(options); }
    } catch (error: any) {
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
      assertServiceCommitSettled(this.db);
      const updated = this.db.prepare(`UPDATE execution_workspace_state SET last_saved_revision = ?, manifest_json = ?, parents_json = ?, conflicts_json = ?, pending_apply = 0, version = version + 1, updated_at = ?
        WHERE execution_id = ? AND version = ?`).run(result.revision, json(captured.manifest), json([result.revision]), json(captured.conflicts), new Date().toISOString(), row.execution_id, captured.state_version);
      if (updated.changes !== 1) throw new SwarmEnvError(ERROR_CODES.WORKSPACE_RECONCILIATION_REQUIRED, 'Saved revision must be reconciled with E lineage before another write');
      this.db.prepare("UPDATE execution_workspace_requests SET phase = 'done', captured_json = NULL, result_json = ?, updated_at = ? WHERE execution_id = ? AND request_id = ?")
        .run(json(receipt), new Date().toISOString(), row.execution_id, row.request_id);
      this.db.exec('COMMIT');
      return receipt;
    } catch (error: any) {
      if (transaction) { try { this.db.exec('ROLLBACK'); } catch { /* COMMIT may have succeeded before acknowledgement failed. */ } }
      if (error.code === ERROR_CODES.WORKSPACE_RECONCILIATION_REQUIRED) throw error;
      throw new SwarmEnvError('WORKSPACE_RESULT_UNKNOWN', 'Saved revision acknowledgement is unavailable; retry the original request ID', undefined, { retryable: true, cause: error });
    }
  }
}
