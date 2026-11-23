import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { TaskService } from '../src/task/task-service.js';
import { ContextService } from '../src/context/context-service.js';
import { JudgeService } from '../src/judge/judge-service.js';
import { EXECUTION_WORKSPACE_SCHEMA_SQL } from '../src/runtime/execution-workspace.js';
import { MissionWorkspace } from '../src/runtime/mission-workspace.js';
import { ObservationStore } from '../src/observability/observation-store.js';
import { ServiceCommitGate } from '../src/sdk/service-commit-gate.js';
import { CONTEXT_PEER_SCHEMA_SQL, JUDGE_PEER_SCHEMA_SQL } from '../src/storage/service-peer-schema.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
import { parseReplayTime, prepareExperimentResume } from '../src/replay/resume-experiment.js';
import { dropReplayHistory } from '../src/replay/service-history.js';
import { WORKSPACE_HISTORY_DIR } from '../src/runtime/workspace-repository.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

const envelope = (service, executionId, operationId) => {
  const e = service.getExecution(executionId);
  return makeEnvelope({ actorRef: e.owner_ref, taskId: e.task_id, executionId, operationId,
    specVersion: e.spec_version, stateVersion: e.state_version, fencingVersion: e.fencing_version });
};

async function finishedExperiment(t, { accepted = false, brokenMaterialReference = false, legacy = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-time-resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const problem = { id: 'time_resume_fixture', problem_file: 'input.lean', source: 'example : True := by trivial', source_hash: 'a'.repeat(64) };
  const config = { lean_project_root: root, putnam_bench_root: root, putnambench_commit: 'b'.repeat(40),
    lean_toolchain: 'controlled', mathlib_version: 'controlled', checker_ref: 'controlled', checker_version: '1', environment_ref: 'controlled' };
  const projectDir = join(source, 'state', 'projects', problem.id);
  await mkdir(projectDir, { recursive: true });
  await mkdir(join(source, 'metadata'));
  const startedAt = new Date().toISOString();
  const tasks = new TaskService(join(projectDir, 'project.sqlite'));
  const observations = new ObservationStore(tasks.db);
  observations.registerExperiment({ experimentId: 'original-observations', status: 'RUNNING' });
  const context = new ContextService(join(projectDir, 'context.sqlite'), { taskService: tasks });
  tasks.contextService = context;
  const judge = new JudgeService(join(projectDir, 'judge.sqlite'), { taskService: tasks });
  if (legacy) for (const db of [tasks.db, context.db, judge.db]) dropReplayHistory(db);
  const workspace = new MissionWorkspace({ rootDir: join(projectDir, 'mission-workspace') });
  const missionId = 'mission:historical';
  tasks.createMission({ mission_id: missionId, goal: 'Continue a partially proved statement', acceptance_conditions: {
    project: problem.id, source_hash: problem.source_hash, target_path: problem.problem_file, required_check: null,
  } }, makeEnvelope({ actorRef: 'operator:test' }));
  const initial = await workspace.create({ missionId, workspaceId: 'workspace-historical',
    initialFiles: { 'input.lean': problem.source }, metadata: { input_snapshot_hash: problem.source_hash } });
  const createTask = (id, extra = {}) => tasks.createTask({ mission_id: missionId, task_id: id,
    summary: `Resolve the independent local claim ${id}`, expected_output: 'A reusable checked local argument',
    acceptance_conditions: ['The local argument addresses its stated claim'], ...extra }, makeEnvelope({ actorRef: 'operator:test' })).task;
  createTask('task:active');
  createTask('task:dependent', { depends_on: ['task:active'] });
  tasks.reconcileTask('task:dependent');
  createTask('task:done');
  tasks.registerBot({ botId: 'historical:finished', missionId, coreId: 'core-2', selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
  tasks.recordBotSandbox('historical:finished', { provider: 'controlled', sandboxId: 'done-sandbox' });
  tasks.markBotReady('historical:finished');
  const done = tasks.takeTask('task:done', { owner_ref: 'historical:finished', core_id: 'core-2', take_key: 'take:done' }).execution;
  tasks.dispatch('start_execution', {}, envelope(tasks, done.execution_id, 'start:done'));
  tasks.dispatch('task_finish', { outcome: 'done' }, envelope(tasks, done.execution_id, 'finish:done'));
  tasks.finalizeExecutionFinish(done.execution_id, { fencingVersion: done.fencing_version });
  tasks.finalizeBotClose('historical:finished');
  tasks.registerBot({ botId: 'bot:historical', missionId, coreId: 'core-1', selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
  tasks.recordBotSandbox('bot:historical', { provider: 'controlled', sandboxId: 'original-sandbox-must-not-be-touched' });
  tasks.markBotReady('bot:historical');
  const taken = tasks.takeTask('task:active', { owner_ref: 'bot:historical', core_id: 'core-1', take_key: 'take:historical' }).execution;
  tasks.dispatch('start_execution', {}, envelope(tasks, taken.execution_id, 'start:historical'));
  const material = context.dispatch('context_publish_material', { content: 'The first reusable local fact' },
    envelope(tasks, taken.execution_id, 'material:before')).material;
  context.dispatch('consume_materials', { material_ids: [material.material_id], action: 'task', impact: 'Use the local fact in the active task' },
    envelope(tasks, taken.execution_id, 'consumption:before'));
  const saved = await workspace.save({ workspaceId: initial.workspace_id, baseRevision: initial.main_revision,
    files: { 'input.lean': problem.source, 'lemma.lean': 'example : 1 = 1 := by rfl' } });
  const checkTime = new Date().toISOString();
  judge.db.prepare(`INSERT INTO check_results
    (check_result_id, request_key, request_hash, workspace_source_id, target_task_id, target_spec_version,
      execution_id, input_snapshot_hash, checker_ref, checker_version, environment_ref, status, verdict,
      judge_operation_status, checker_process_status, evidence_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', NULL, 'running', 'running', ?, ?, ?)`)
    .run('check:historical', 'request:historical', 'c'.repeat(64), 'source:historical', 'task:active', 1,
      taken.execution_id, taken.input_snapshot_hash, 'controlled', '1', 'controlled', JSON.stringify({ workspace_input: {
        workspace_id: initial.workspace_id, revision: saved.revision, path: 'lemma.lean',
      } }), checkTime, checkTime);
  context.db.exec(CONTEXT_PEER_SCHEMA_SQL);
  context.db.prepare('INSERT INTO context_peer_receipts VALUES (?, ?, ?)').run('old-context-call', 'old-digest', '{"terminal":true}');
  judge.db.exec(JUDGE_PEER_SCHEMA_SQL);
  judge.db.prepare('INSERT INTO judge_peer_phases VALUES (?, ?, ?, ?, ?, NULL)').run('old-judge-call', 'old-digest', 'old-generation', 'old-call', 'source');
  judge.db.prepare(`INSERT INTO checker_preflights
    (preflight_key, fixture_id, checker_ref, checker_version, environment_ref, status, checker_process_status,
      health_fingerprint, evidence_json, first_seen_at, last_seen_at)
    VALUES ('old-health', 'old-fixture', 'controlled', '1', 'controlled', 'healthy', 'completed', 'old-health', '{}', ?, ?)`)
    .run(checkTime, checkTime);
  judge.db.prepare('INSERT INTO judge_mission_check_policies (mission_id, max_requests, max_concurrent) VALUES (?, 10, 1)').run(missionId);
  judge.db.prepare('INSERT INTO judge_mission_check_admissions (mission_id, check_result_id, admitted_at) VALUES (?, ?, ?)')
    .run(missionId, 'check:historical', checkTime);
  tasks.db.prepare('INSERT INTO mission_final_check_policies VALUES (?, 4, 1)').run(missionId);
  tasks.db.prepare('INSERT INTO mission_final_check_admissions VALUES (?, ?, ?, NULL)').run(missionId, 'submission:historical', checkTime);
  const pendingSubmission = { mission_id: missionId, submission_id: 'submission:historical', state: 'pending',
    snapshot_fingerprint: 'snapshot', created_at: checkTime, release_pending: true };
  tasks.db.prepare('INSERT INTO mission_submissions VALUES (?, ?, ?, ?, ?, ?)').run(missionId, 'submission:historical', 'request', 'snapshot', 'pending',
    JSON.stringify(pendingSubmission));
  await workspace.freeze({ workspaceId: initial.workspace_id, submissionId: 'submission:historical', expectedMainRevision: initial.main_revision });
  const gate = new ServiceCommitGate(tasks);
  const admission = gate.acquire({ service: 'judge', generation: 'old-generation', call_id: 'old-call', phase: 'source' });
  tasks.db.prepare('INSERT INTO service_commit_events VALUES (?, ?, 0)').run('old-undelivered-event', '[]');
  if (brokenMaterialReference) tasks.db.prepare('UPDATE tasks SET input_material_refs_json = ? WHERE task_id = ?')
    .run('["material:missing"]', 'task:active');
  await delay(10);
  const earlyTime = new Date().toISOString();
  await delay(10);

  gate.settle(admission, { terminal: true });
  tasks.db.exec(EXECUTION_WORKSPACE_SCHEMA_SQL);
  const futureAt = new Date().toISOString();
  tasks.db.prepare(`INSERT INTO execution_workspace_requests
    (execution_id, request_id, fingerprint, phase, result_json, created_at, updated_at)
    VALUES (?, 'future-save', 'future', 'done', '{"revision":"0.3"}', ?, ?)`).run(taken.execution_id, futureAt, futureAt);
  tasks.db.prepare(`INSERT INTO execution_workspace_state
    (execution_id, workspace_id, initial_revision, last_saved_revision, manifest_json, parents_json, updated_at)
    VALUES (?, ?, '0.1', '0.3', '{}', '["0.3"]', ?)`).run(taken.execution_id, initial.workspace_id, futureAt);
  observations.append({ experimentId: 'original-observations', source: 'test', kind: 'future_fact', payload: { future: true } });
  tasks.db.prepare("UPDATE mission_submissions SET state = 'rejected', document = ? WHERE submission_id = 'submission:historical'")
    .run(JSON.stringify({ ...pendingSubmission, state: 'rejected', finished_at: new Date().toISOString(), release_pending: false }));
  await workspace.unfreeze({ workspaceId: initial.workspace_id, submissionId: 'submission:historical' });
  const futureMaterial = context.dispatch('context_publish_material', { content: 'This fact only exists in the future' },
    envelope(tasks, taken.execution_id, 'material:after')).material;
  const merged = await workspace.merge({ workspaceId: initial.workspace_id, fromRevision: saved.revision, expectedMainRevision: initial.main_revision });
  judge.db.prepare("UPDATE check_results SET status = 'RECEIVED', verdict = 'PASS', checker_process_status = 'completed', result_class = 'PASS', updated_at = ? WHERE check_result_id = ?")
    .run(new Date().toISOString(), 'check:historical');
  tasks.dispatch('task_finish', { outcome: 'done' }, envelope(tasks, taken.execution_id, 'finish:historical'));
  await delay(10);
  const finishAcceptedTime = new Date().toISOString();
  await delay(10);
  tasks.finalizeExecutionFinish(taken.execution_id, { fencingVersion: taken.fencing_version });
  tasks.finalizeBotClose('bot:historical');
  if (accepted) tasks.db.prepare("UPDATE mission_submissions SET state = 'accepted', document = ? WHERE submission_id = 'submission:historical'")
    .run(JSON.stringify({ ...pendingSubmission, state: 'accepted', finished_at: new Date().toISOString(), release_pending: false }));
  await delay(10);
  const lateTime = new Date().toISOString();
  context.close(); judge.close(); tasks.close();
  if (legacy) await rm(join(projectDir, 'mission-workspace', initial.workspace_id, WORKSPACE_HISTORY_DIR), { recursive: true });
  await delay(5);
  const metadata = { experiment_id: 'source-finished-run', status: 'completed', started_at: startedAt,
    ended_at: new Date().toISOString(), putnambench_commit: config.putnambench_commit, environment: config };
  await writeFile(join(source, 'metadata', 'experiment.json'), JSON.stringify(metadata));
  const sourceHashes = Object.fromEntries(await Promise.all(['project.sqlite', 'context.sqlite', 'judge.sqlite'].map(async name => [name, digest(await readFile(join(projectDir, name)))])));
  return { root, source, projectDir, problem, config, missionId, workspaceId: initial.workspace_id,
    earlyTime, finishAcceptedTime, lateTime, materialId: material.material_id, futureMaterialId: futureMaterial.material_id,
    executionId: taken.execution_id, savedRevision: saved.revision, mergedRevision: merged.main_revision, sourceHashes };
}

test('an ended experiment can be reconstructed at multiple retrospectively chosen times and claimed by fresh Bots', async t => {
  const f = await finishedExperiment(t);
  const destination = join(f.root, 'early', 'state', 'projects', f.problem.id);
  const result = await prepareExperimentResume({ sourceExperimentDir: f.source, destinationProjectDir: destination,
    problem: f.problem, config: f.config, at: f.earlyTime });
  assert.equal(result.provenance.main_revision, '0.1', 'an unmerged save is not historical main');
  assert.equal(result.initialTaskIds.length, 3);
  assert.deepEqual(result.initialMaterialIds, [f.materialId]);
  const tasks = new TaskService(join(destination, 'project.sqlite'));
  const context = new ContextService(join(destination, 'context.sqlite'), { taskService: tasks });
  tasks.contextService = context;
  const judge = new JudgeService(join(destination, 'judge.sqlite'), { taskService: tasks });
  try {
    assert.equal(tasks.getTask('task:active').state, 'OPEN');
    assert.equal(tasks.getTask('task:done').state, 'DONE');
    assert.equal(tasks.getTask('task:dependent').state, 'BLOCKED');
    assert.equal(tasks.getBot('bot:historical').state, 'CLOSED');
    assert.equal(tasks.getExecution(f.executionId).state, 'FENCED');
    assert.equal(context.getMaterial(f.futureMaterialId), null);
    assert.equal(judge.getCheckResult('check:historical').verdict, 'ERROR');
    assert.equal(judge.getCheckResult('check:historical').diagnostic_code, 'historical_resume_interrupted');
    for (const table of ['execution_workspace_requests', 'execution_workspace_state', 'service_commit_gate', 'service_commit_events', 'observation_events', 'experiments',
      'mission_final_check_admissions', 'mission_final_check_policies']) {
      assert.equal(tasks.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${table} belongs to the old runtime`);
    }
    for (const table of ['checker_preflights', 'judge_peer_phases', 'judge_mission_check_admissions', 'judge_mission_check_policies']) {
      assert.equal(judge.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${table} must be fresh`);
    }
    assert.equal(context.db.prepare('SELECT COUNT(*) AS n FROM context_peer_receipts').get().n, 0);
    assert.equal(tasks.db.prepare("SELECT state FROM mission_submissions WHERE submission_id = 'submission:historical'").get().state, 'error');
    assert.equal(result.provenance.normalization.inherited_check_admissions, 1);
    assert.equal(result.provenance.normalization.inherited_final_check_admissions, 1);
    for (let index = 1; index <= 4; index++) {
      tasks.registerBot({ botId: `bot:new-${index}`, missionId: f.missionId, coreId: `core-${index}`,
        selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
      tasks.recordBotSandbox(`bot:new-${index}`, { provider: 'controlled', sandboxId: `new-sandbox-${index}` });
      tasks.markBotReady(`bot:new-${index}`);
    }
    const next = tasks.takeTask('task:active', { owner_ref: 'bot:new-1', core_id: 'core-1', take_key: 'new:take' }).execution;
    assert.notEqual(next.execution_id, f.executionId);
    tasks.dispatch('start_execution', {}, envelope(tasks, next.execution_id, 'new:start'));
    const read = context.dispatch('context_get_material', { material_id: f.materialId }, envelope(tasks, next.execution_id, 'new:read'));
    assert.equal(read.material.content, 'The first reusable local fact');
    assert.equal(tasks.getTask('task:active').state, 'RUNNING');
    for (let index = 2; index <= 4; index += 1) {
      const botId = `bot:new-${index}`;
      const proposed = tasks.createTask({ summary: `Verify independent claim ${index}`, gap: `Claim ${index} needs an argument`,
        priority: 'medium', expected_output: 'A checked argument', acceptance_conditions: ['Discharge the claim'] },
        makeEnvelope({ actorRef: botId })).task;
      const execution = tasks.takeTask(proposed.task_id, { owner_ref: botId, core_id: `core-${index}`, take_key: `resumed-take-${index}` }).execution;
      tasks.dispatch('start_execution', {}, envelope(tasks, execution.execution_id, `resumed-start-${index}`));
      const inherited = context.dispatch('context_get_material', { material_id: f.materialId }, envelope(tasks, execution.execution_id, `resumed-read-${index}`));
      assert.equal(inherited.material.content, 'The first reusable local fact');
    }
    assert.deepEqual(tasks.listActiveExecutions().map(execution => execution.core_id).sort(), ['core-1', 'core-2', 'core-3', 'core-4']);
    const workspace = new MissionWorkspace({ rootDir: join(destination, 'mission-workspace') });
    assert.equal((await workspace.get({ workspaceId: f.workspaceId })).frozen_submission_id, null);
    assert.equal((await workspace.read({ workspaceId: f.workspaceId, revision: f.savedRevision, path: 'lemma.lean' })).content,
      'example : 1 = 1 := by rfl');
    await assert.rejects(workspace.read({ workspaceId: f.workspaceId, path: 'lemma.lean' }));
  } finally { context.close(); judge.close(); tasks.close(); }
  const later = join(f.root, 'later', 'state', 'projects', f.problem.id);
  const late = await prepareExperimentResume({ sourceExperimentDir: f.source, destinationProjectDir: later,
    problem: f.problem, config: f.config, at: f.lateTime });
  assert.equal(late.provenance.main_revision, f.mergedRevision);
  assert.equal(late.initialMaterialIds.length, 2);
  const lateDb = new DatabaseSync(join(later, 'project.sqlite'), { readOnly: true });
  try { assert.equal(lateDb.prepare("SELECT state FROM tasks WHERE task_id = 'task:active'").get().state, 'DONE'); }
  finally { lateDb.close(); }
  for (const [name, before] of Object.entries(f.sourceHashes)) assert.equal(digest(await readFile(join(f.projectDir, name))), before);
});

test('an already finished legacy run resumes from retained receipts and Git without any new history tables', async t => {
  const f = await finishedExperiment(t, { legacy: true });
  const destination = join(f.root, 'legacy-resume');
  const result = await prepareExperimentResume({ sourceExperimentDir: f.source, destinationProjectDir: destination,
    problem: f.problem, config: f.config, at: f.earlyTime });
  for (const service of Object.values(result.provenance.services)) assert.equal(service.mode, 'legacy');
  assert.equal(result.provenance.workspace_history.mode, 'legacy');
  assert.equal(result.provenance.main_revision, '0.1');
  assert.deepEqual(result.initialMaterialIds, [f.materialId]);
  const tasks = new TaskService(join(destination, 'project.sqlite'));
  const context = new ContextService(join(destination, 'context.sqlite'), { taskService: tasks });
  try {
    assert.equal(tasks.getTask('task:active').state, 'OPEN');
    assert.equal(tasks.getTask('task:done').state, 'DONE');
    assert.equal(tasks.getTask('task:dependent').state, 'BLOCKED');
    assert.equal(context.getMaterial(f.futureMaterialId), null);
    assert.equal(context.getMaterial(f.materialId).content, 'The first reusable local fact');
  } finally { context.close(); tasks.close(); }
  for (const [name, before] of Object.entries(f.sourceHashes)) assert.equal(digest(await readFile(join(f.projectDir, name))), before);
});

test('accepted Task finishes are completed only during handoff and an already accepted Mission stops resume', async t => {
  const f = await finishedExperiment(t, { accepted: true });
  const destination = join(f.root, 'accepted-finish');
  const result = await prepareExperimentResume({ sourceExperimentDir: f.source, destinationProjectDir: destination,
    problem: f.problem, config: f.config, at: f.finishAcceptedTime });
  assert.deepEqual(result.provenance.normalization.completed_finish_ids, [f.executionId]);
  assert.match(result.provenance.normalization.interpretation, /handoff.*not facts/);
  const db = new DatabaseSync(join(destination, 'project.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT state FROM tasks WHERE task_id = 'task:active'").get().state, 'DONE');
    assert.ok(db.prepare('SELECT closed_at FROM execution_finish_intents WHERE execution_id = ?').get(f.executionId).closed_at > f.finishAcceptedTime);
  } finally { db.close(); }
  const rejectedDestination = join(f.root, 'already-accepted');
  await assert.rejects(prepareExperimentResume({ sourceExperimentDir: f.source, destinationProjectDir: rejectedDestination,
    problem: f.problem, config: f.config, at: f.lateTime }), { code: 'REPLAY_MISSION_COMPLETED' });
  await assert.rejects(access(rejectedDestination), { code: 'ENOENT' });
});

test('missing cross-service history names the unavailable Task Material and does not publish a destination', async t => {
  const f = await finishedExperiment(t, { brokenMaterialReference: true });
  const destination = join(f.root, 'incomplete');
  await assert.rejects(prepareExperimentResume({ sourceExperimentDir: f.source, destinationProjectDir: destination,
    problem: f.problem, config: f.config, at: f.earlyTime }), error => {
    assert.equal(error.code, 'REPLAY_INCOMPLETE_HISTORY');
    assert.deepEqual(error.details, { entity: 'task:active', field: 'input_material_refs', reference: 'material:missing' });
    return true;
  });
  await assert.rejects(access(destination), { code: 'ENOENT' });
});

test('a terminal failed run with an admitted Mission can resume from its earlier public state', async t => {
  const f = await finishedExperiment(t);
  const path = join(f.source, 'metadata', 'experiment.json');
  const metadata = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...metadata, status: 'failed' }));
  const result = await prepareExperimentResume({ sourceExperimentDir: f.source, destinationProjectDir: join(f.root, 'recovered'),
    problem: f.problem, config: f.config, at: f.earlyTime });
  assert.equal(result.missionId, f.missionId);
  assert.deepEqual(result.initialMaterialIds, [f.materialId]);
});

test('resume validates the historical interval, source completion, environment and physical destination', async t => {
  const f = await finishedExperiment(t);
  const request = { sourceExperimentDir: f.source, destinationProjectDir: join(f.root, 'target'), problem: f.problem, config: f.config, at: f.earlyTime };
  assert.throws(() => parseReplayTime('2026-11-19T12:30:00'), /timezone/);
  await assert.rejects(prepareExperimentResume({ ...request, at: '2000-01-01T00:00:00Z' }), { code: 'INVALID_REPLAY_TIME' });
  await assert.rejects(prepareExperimentResume({ ...request, config: { ...f.config, checker_version: 'different' } }), { code: 'REPLAY_ENVIRONMENT_MISMATCH' });
  const alias = join(f.root, 'source-alias'); await symlink(f.source, alias);
  await assert.rejects(prepareExperimentResume({ ...request, destinationProjectDir: join(alias, 'would-overwrite-source') }), { code: 'REPLAY_DESTINATION_CONFLICT' });
  const path = join(f.source, 'metadata', 'experiment.json');
  const metadata = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...metadata, status: 'running' }));
  await assert.rejects(prepareExperimentResume(request), { code: 'REPLAY_SOURCE_NOT_FINISHED' });
});
