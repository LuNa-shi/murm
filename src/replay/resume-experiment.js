import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SwarmEnvError } from '../errors.js';
import { TERMINAL_TASK_STATES } from '../task/task-types.js';
import { MissionWorkspace } from '../runtime/mission-workspace.js';
import { parseReplayTime, restoreServiceDatabaseAt } from './service-history.js';
import { upgradeResumedServiceDatabase } from './resume-schema.js';
import { restoreWorkspaceAt } from './workspace-history.js';

export { parseReplayTime } from './service-history.js';

const failure = (code, message, details) => new SwarmEnvError(code, message, details);
const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const within = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};

async function physicalDestination(path) {
  const tail = [];
  let current = resolve(path);
  while (true) {
    try { return join(await realpath(current), ...tail.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT' || dirname(current) === current) throw error;
      // A dangling link could acquire a target inside the source on first write.
      const entry = await lstat(current).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (entry?.isSymbolicLink()) throw failure('REPLAY_DESTINATION_CONFLICT', 'Resume output has a dangling symlink', { path: current });
      tail.push(basename(current));
      current = dirname(current);
    }
  }
}

export async function assertResumeOutputPaths(sourceExperimentDir, outputPaths) {
  const source = await realpath(resolve(sourceExperimentDir));
  for (const path of outputPaths) {
    const output = await physicalDestination(path);
    if (within(source, output) || within(output, source)) {
      throw failure('REPLAY_DESTINATION_CONFLICT', 'Resume output must be separate from the source experiment', { path });
    }
    const entry = await lstat(output).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (entry?.isFile() && entry.nlink > 1) throw failure('REPLAY_DESTINATION_CONFLICT', 'Resume output file has multiple hard links', { path });
  }
}

async function optionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function completedSource(source, at) {
  const metadata = await optionalJson(join(source, 'metadata', 'experiment.json'));
  if (!metadata || !['completed', 'operator_stopped', 'startup_failed', 'failed'].includes(metadata.status) || !Number.isFinite(Date.parse(metadata.ended_at))) {
    throw failure('REPLAY_SOURCE_NOT_FINISHED', 'Resume requires a finished experiment with its completion metadata');
  }
  const audit = await optionalJson(join(source, '.swarmenv-private-audit-v1.json'));
  const closed = audit ? await optionalJson(join(source, '.swarmenv-private-audit-closed.json')) : null;
  if (audit && !Number.isSafeInteger(closed?.closed_at_ms)) {
    throw failure('REPLAY_SOURCE_NOT_FINISHED', 'The source experiment has not finished private-audit cleanup');
  }
  if (!Number.isFinite(Date.parse(metadata.started_at)) || Date.parse(at) < Date.parse(metadata.started_at) || Date.parse(at) > Date.parse(metadata.ended_at)) {
    throw failure('INVALID_REPLAY_TIME', 'Requested time must be within the source experiment interval', {
      started_at: metadata.started_at, ended_at: metadata.ended_at, requested_at: at,
    });
  }
  return metadata;
}

function assertEnvironment(metadata, config) {
  for (const key of ['lean_toolchain', 'mathlib_version', 'checker_ref', 'checker_version', 'environment_ref']) {
    if (config[key] !== undefined && metadata.environment?.[key] !== config[key]) {
      throw failure('REPLAY_ENVIRONMENT_MISMATCH', `Resume requires the original ${key}`, { field: key });
    }
  }
  const expectedCommit = config.fixture_commit ?? config.putnambench_commit;
  const originalCommit = metadata.fixture_commit ?? metadata.putnambench_commit;
  if (expectedCommit !== undefined && originalCommit !== expectedCommit) {
    throw failure('REPLAY_ENVIRONMENT_MISMATCH', 'Resume requires the original benchmark fixture commit');
  }
  if ((metadata.benchmark ?? 'putnambench') !== (config.benchmark ?? 'putnambench')) {
    throw failure('REPLAY_ENVIRONMENT_MISMATCH', 'Resume requires the original benchmark');
  }
}

function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const value = action(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Trusted offline import step. It never invokes a provider or resumes a former Session. */
export function normalizeResumedServices({ projectDir, missionId, now = new Date().toISOString() }) {
  const task = new DatabaseSync(join(projectDir, 'project.sqlite'));
  const judge = new DatabaseSync(join(projectDir, 'judge.sqlite'));
  const context = new DatabaseSync(join(projectDir, 'context.sqlite'));
  const summary = { retired_bot_ids: [], retired_execution_ids: [], affected_task_ids: [],
    interrupted_gate_ids: [], interrupted_check_ids: [], interrupted_submission_ids: [],
    completed_finish_ids: [], inherited_check_admissions: 0, inherited_final_check_admissions: 0,
    interpretation: 'These transitions happen during fresh-run handoff after historical reconstruction; they are not facts that already held at the requested time.' };
  try {
    transaction(task, () => {
      const accepted = task.prepare("SELECT submission_id FROM mission_submissions WHERE mission_id = ? AND state = 'accepted'").get(missionId);
      if (accepted) throw failure('REPLAY_MISSION_COMPLETED', 'The Mission was already accepted at the requested time', { submission_id: accepted.submission_id });
      const executions = task.prepare(`SELECT e.* FROM executions e JOIN task_records m USING (task_id)
        WHERE m.mission_id = ? AND e.state IN ('CREATED', 'RUNNING', 'CLOSING') ORDER BY e.execution_id`).all(missionId);
      const affected = new Set();
      for (const execution of executions) {
        const finish = task.prepare('SELECT * FROM execution_finish_intents WHERE execution_id = ? AND closed_at IS NULL').get(execution.execution_id);
        const current = task.prepare('SELECT state FROM tasks WHERE task_id = ?').get(execution.task_id);
        const terminal = finish?.terminal_state ?? 'FENCED';
        task.prepare(`UPDATE executions SET state = ?, terminal_reason = ?, fencing_version = fencing_version + 1,
          state_version = state_version + 1,
          updated_at = ? WHERE execution_id = ?`).run(terminal, finish?.reason ?? 'historical_resume', now, execution.execution_id);
        summary.retired_execution_ids.push(execution.execution_id);
        if (finish) {
          task.prepare('UPDATE execution_finish_intents SET closed_at = ? WHERE execution_id = ?').run(now, execution.execution_id);
          summary.completed_finish_ids.push(execution.execution_id);
        }
        if (!TERMINAL_TASK_STATES.includes(current.state) && ['done', 'cancelled'].includes(finish?.outcome)) {
          const state = finish.outcome === 'done' ? 'DONE' : 'CANCELED';
          task.prepare(`UPDATE tasks SET state = ?, block_reason = NULL, eligible_at = NULL,
            cancelled_at = CASE WHEN ? = 'CANCELED' THEN ? ELSE cancelled_at END,
            state_version = state_version + 1, updated_at = ? WHERE task_id = ?`)
            .run(state, state, now, now, execution.task_id);
        } else if (current.state === 'RUNNING') {
          task.prepare(`UPDATE tasks SET state = 'OPEN', block_reason = NULL, eligible_at = ?,
            state_version = state_version + 1, updated_at = ? WHERE task_id = ?`).run(now, now, execution.task_id);
        }
        affected.add(execution.task_id);
      }
      const orphan = task.prepare(`SELECT t.task_id FROM tasks t JOIN task_records m USING (task_id)
        WHERE m.mission_id = ? AND t.state = 'RUNNING' LIMIT 1`).get(missionId);
      if (orphan) throw failure('REPLAY_INCOMPLETE_HISTORY', 'Historical Task ownership is missing its Execution', { task_id: orphan.task_id });
      summary.affected_task_ids = [...affected];
      summary.retired_bot_ids = task.prepare("SELECT bot_id FROM bots WHERE mission_id = ? AND state <> 'CLOSED' ORDER BY bot_id").all(missionId).map(row => row.bot_id);
      task.prepare(`UPDATE bots SET state = 'CLOSED', closed_at = ?, exit_reason = 'historical_resume',
        state_version = state_version + 1, updated_at = ? WHERE mission_id = ? AND state <> 'CLOSED'`).run(now, now, missionId);

      if (hasTable(task, 'service_commit_gate')) {
        summary.interrupted_gate_ids = task.prepare('SELECT gate_id FROM service_commit_gate').all().map(row => row.gate_id);
        task.exec('DELETE FROM service_commit_gate');
      }
      for (const table of ['service_commit_events', 'observation_events', 'experiments', 'execution_workspace_requests', 'execution_workspace_state']) {
        if (hasTable(task, table)) task.exec(`DELETE FROM ${table}`);
      }
      for (const row of task.prepare("SELECT * FROM mission_submissions WHERE mission_id = ? AND state IN ('preparing', 'pending')").all(missionId)) {
        const document = { ...JSON.parse(row.document), state: 'error', result: { code: 'HISTORICAL_RESUME_INTERRUPTED' },
          release_pending: false, finished_at: now };
        task.prepare("UPDATE mission_submissions SET state = 'error', document = ? WHERE mission_id = ? AND submission_id = ?")
          .run(JSON.stringify(document), missionId, row.submission_id);
        summary.interrupted_submission_ids.push(row.submission_id);
      }
      summary.inherited_final_check_admissions = task.prepare('SELECT COUNT(*) AS n FROM mission_final_check_admissions WHERE mission_id = ?').get(missionId).n;
      task.prepare('DELETE FROM mission_final_check_admissions WHERE mission_id = ?').run(missionId);
      task.prepare('DELETE FROM mission_final_check_policies WHERE mission_id = ?').run(missionId);
    });
    transaction(judge, () => {
      summary.interrupted_check_ids = judge.prepare("SELECT check_result_id FROM check_results WHERE status IN ('REQUESTED', 'RUNNING') ORDER BY check_result_id").all().map(row => row.check_result_id);
      judge.prepare(`UPDATE check_results SET status = 'RECEIVED', verdict = 'ERROR', judge_operation_status = 'persisted',
        checker_process_status = 'crashed', result_class = 'infrastructure_failure', retryable = 1,
        diagnostic_code = 'historical_resume_interrupted', evidence_json = json_set(evidence_json,
          '$.diagnostic', 'The check had no terminal result at the selected historical time'), updated_at = ?
        WHERE status IN ('REQUESTED', 'RUNNING')`).run(now);
      if (hasTable(judge, 'judge_peer_phases')) {
        judge.exec('DELETE FROM judge_peer_phases');
      }
      if (hasTable(judge, 'checker_preflights')) judge.exec('DELETE FROM checker_preflights');
      summary.inherited_check_admissions = judge.prepare('SELECT COUNT(*) AS n FROM judge_mission_check_admissions WHERE mission_id = ?').get(missionId).n;
      judge.prepare('DELETE FROM judge_mission_check_admissions WHERE mission_id = ?').run(missionId);
      judge.prepare('DELETE FROM judge_mission_check_policies WHERE mission_id = ?').run(missionId);
    });
    if (hasTable(context, 'context_peer_receipts')) context.exec('DELETE FROM context_peer_receipts');
    return summary;
  } finally { context.close(); judge.close(); task.close(); }
}

/** Validate references across the independently reconstructed services, before startup. */
function verifyReferences({ projectDir, workspace, missionId }) {
  const task = new DatabaseSync(join(projectDir, 'project.sqlite'), { readOnly: true });
  const context = new DatabaseSync(join(projectDir, 'context.sqlite'), { readOnly: true });
  const judge = new DatabaseSync(join(projectDir, 'judge.sqlite'), { readOnly: true });
  const missing = (entity, field, reference) => {
    throw failure('REPLAY_INCOMPLETE_HISTORY', 'Historical public data has an unavailable reference', { entity, field, reference });
  };
  try {
    for (const [domain, db] of [['task', task], ['context', context], ['judge', judge]]) {
      const violation = db.prepare('PRAGMA foreign_key_check').get();
      if (violation) throw failure('REPLAY_INCOMPLETE_HISTORY', 'Historical service records have a missing relational dependency', { domain, ...violation });
    }
    const tasks = task.prepare('SELECT * FROM tasks').all();
    const taskIds = new Set(tasks.map(row => row.task_id));
    const executions = task.prepare('SELECT * FROM executions').all();
    const executionIds = new Set(executions.map(row => row.execution_id));
    const materials = context.prepare('SELECT * FROM materials').all();
    const materialIds = new Set(materials.map(row => row.material_id));
    const revisions = new Set(workspace.revisions);
    const checkRevision = (entity, ref) => {
      if (!ref) return;
      if (ref.workspace_id && ref.workspace_id !== workspace.workspace_id) missing(entity, 'workspace_id', ref.workspace_id);
      if (ref.revision && ref.revision !== 'main' && !revisions.has(String(ref.revision))) missing(entity, 'revision', ref.revision);
    };
    for (const row of tasks) {
      for (const id of JSON.parse(row.input_material_refs_json)) if (!materialIds.has(id)) missing(row.task_id, 'input_material_refs', id);
      checkRevision(row.task_id, JSON.parse(row.workspace_json));
    }
    for (const row of task.prepare('SELECT * FROM task_material_links').all()) {
      if (!materialIds.has(row.material_id)) missing(row.link_id, 'material_id', row.material_id);
    }
    for (const row of executions) {
      const input = row.workspace_input_json ? JSON.parse(row.workspace_input_json) : null;
      checkRevision(row.execution_id, input);
      for (const id of JSON.parse(row.input_material_refs_json)) if (!materialIds.has(id)) missing(row.execution_id, 'input_material_refs', id);
      for (const ref of input?.material_inputs ?? []) if (ref.material_id && !materialIds.has(ref.material_id)) missing(row.execution_id, 'material_inputs', ref.material_id);
    }
    for (const row of materials) {
      if (row.mission_id !== missionId) missing(row.material_id, 'mission_id', row.mission_id);
      if (row.producer_task_id && !taskIds.has(row.producer_task_id)) missing(row.material_id, 'producer_task_id', row.producer_task_id);
      if (row.producer_execution_id && !executionIds.has(row.producer_execution_id)) missing(row.material_id, 'producer_execution_id', row.producer_execution_id);
    }
    for (const row of judge.prepare('SELECT * FROM check_results').all()) {
      if (!taskIds.has(row.target_task_id)) missing(row.check_result_id, 'target_task_id', row.target_task_id);
      checkRevision(row.check_result_id, JSON.parse(row.evidence_json)?.workspace_input);
    }
    return { materials: [...materialIds].sort() };
  } finally { judge.close(); context.close(); task.close(); }
}

/** Reconstruct a finished experiment at a retrospectively selected time in a fresh directory. */
export async function prepareExperimentResume({ sourceExperimentDir, destinationProjectDir, problem, config = {}, at }) {
  const selectedAt = parseReplayTime(at);
  if (!problem?.id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(problem.id)) throw new TypeError('Resume requires one safe problem ID');
  const source = await realpath(resolve(sourceExperimentDir));
  const destination = await physicalDestination(destinationProjectDir);
  await assertResumeOutputPaths(source, [destination]);
  const exists = await lstat(destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  if (exists) throw failure('REPLAY_DESTINATION_CONFLICT', 'Resume project directory must not already exist');
  const metadata = await completedSource(source, selectedAt);
  assertEnvironment(metadata, config);
  const sourceProject = await realpath(join(source, 'state', 'projects', problem.id));
  if (within(sourceProject, destination) || within(destination, sourceProject)) {
    throw failure('REPLAY_DESTINATION_CONFLICT', 'Resume output must be separate from the source project storage');
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(dirname(destination), `.resume-${randomUUID()}-`));
  try {
    const services = {};
    for (const [domain, name] of [['task', 'project.sqlite'], ['context', 'context.sqlite'], ['judge', 'judge.sqlite']]) {
      const destinationPath = join(stage, name);
      const history = await restoreServiceDatabaseAt({ sourcePath: join(sourceProject, name), destinationPath, domain, at: selectedAt });
      const imported = new DatabaseSync(destinationPath);
      try {
        services[domain] = { ...history, schema_conversion: upgradeResumedServiceDatabase(imported, { domain }) };
      } finally { imported.close(); }
    }
    const tasks = new DatabaseSync(join(stage, 'project.sqlite'));
    let mission, initialTaskIds, initialExecutionIds;
    try {
      const missions = tasks.prepare('SELECT * FROM missions').all();
      if (missions.length !== 1) throw failure('REPLAY_INCOMPLETE_HISTORY', 'The selected project must identify exactly one historical Mission', { mission_count: missions.length });
      mission = missions[0];
      const acceptance = JSON.parse(mission.acceptance_conditions_json);
      if (acceptance.project !== problem.id || acceptance.source_hash !== problem.source_hash || acceptance.target_path !== problem.problem_file) {
        throw failure('REPLAY_ENVIRONMENT_MISMATCH', 'Historical Mission does not match the selected problem and original formalization');
      }
      initialTaskIds = tasks.prepare('SELECT task_id FROM task_records WHERE mission_id = ? ORDER BY task_id').all(mission.mission_id).map(row => row.task_id);
      initialExecutionIds = tasks.prepare('SELECT e.execution_id FROM executions e JOIN task_records m USING (task_id) WHERE m.mission_id = ? ORDER BY e.execution_id').all(mission.mission_id).map(row => row.execution_id);
    } finally { tasks.close(); }
    const sourceWorkspaceRoot = join(sourceProject, 'mission-workspace');
    const candidates = [];
    for (const entry of await readdir(sourceWorkspaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const record = await optionalJson(join(sourceWorkspaceRoot, entry.name, '.swarm-workspace.json'));
      if (record?.mission_id === mission.mission_id) candidates.push(record.workspace_id);
    }
    if (candidates.length !== 1) throw failure('REPLAY_INCOMPLETE_HISTORY', 'The historical Mission must have one identifiable public Workspace');
    const restored = await restoreWorkspaceAt({ sourceRoot: sourceWorkspaceRoot, destinationRoot: join(stage, 'mission-workspace'), workspaceId: candidates[0], at: selectedAt });
    if (restored.workspace.mission_id !== mission.mission_id || restored.workspace.metadata.input_snapshot_hash !== problem.source_hash) {
      throw failure('REPLAY_ENVIRONMENT_MISMATCH', 'Restored Workspace does not match the historical Mission input');
    }
    const { materials: initialMaterialIds } = verifyReferences({ projectDir: stage, workspace: restored.workspace, missionId: mission.mission_id });
    const normalization = normalizeResumedServices({ projectDir: stage, missionId: mission.mission_id });
    const workspaceStore = new MissionWorkspace({ rootDir: join(stage, 'mission-workspace') });
    if (restored.workspace.frozen_submission_id) {
      await workspaceStore.unfreeze({ workspaceId: restored.workspace.workspace_id, submissionId: restored.workspace.frozen_submission_id });
    }
    const workspace = await workspaceStore.get({ workspaceId: restored.workspace.workspace_id });
    const provenance = { source_experiment_id: metadata.experiment_id ?? basename(source), requested_at: selectedAt,
      source_repository_commit: metadata.repository_commit ?? null, services, workspace_history: restored.history,
      workspace_id: workspace.workspace_id, main_revision: workspace.main_revision,
      inherited_task_count: initialTaskIds.length, inherited_execution_count: initialExecutionIds.length,
      inherited_material_count: initialMaterialIds.length, normalization };
    await writeFile(join(stage, 'resume.json'), JSON.stringify({ ...provenance, source_experiment: source }, null, 2), { flag: 'wx', mode: 0o600 });
    await rename(stage, destination);
    return { missionId: mission.mission_id, workspaceId: workspace.workspace_id, initialTaskIds, initialExecutionIds,
      initialMaterialIds, affectedTaskIds: normalization.affected_task_ids, provenance };
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}
