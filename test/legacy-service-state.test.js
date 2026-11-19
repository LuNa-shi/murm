import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskService } from '../src/task/task-service.js';
import { ContextService } from '../src/context/context-service.js';
import { JudgeService } from '../src/judge/judge-service.js';
import { MissionSubmissionStore } from '../src/runtime/mission-submission.js';
import { MissionWorkspace } from '../src/runtime/mission-workspace.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
import { dropReplayHistory } from '../src/replay/service-history.js';
import { projectLegacyServiceState } from '../src/replay/legacy-service-state.js';
import { normalizeResumedServices } from '../src/replay/resume-experiment.js';

const START = new Date('2026-11-19T08:00:00.000Z');

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const tasks = new TaskService(':memory:');
  dropReplayHistory(tasks.db);
  t.after(() => tasks.close());
  tasks.createMission({ mission_id: 'mission', goal: 'Prove the fixed theorem' });
  tasks.registerBot({ botId: 'author', missionId: 'mission', coreId: 'author',
    selectionDeadline: new Date(Date.now() + 600_000).toISOString() });
  tasks.recordBotSandbox('author', { provider: 'controlled', sandboxId: 'author' });
  tasks.markBotReady('author');
  const create = (id, fields = {}) => tasks.createTask({ task_id: id, mission_id: 'mission',
    summary: `Prove ${id}`, gap: `The theorem needs ${id}`, expected_output: 'A verified lemma',
    priority: 'medium', acceptance_conditions: ['The lemma supports the theorem'], ...fields },
  makeEnvelope({ actorRef: 'author' })).task;
  const revise = (id, changes) => {
    const task = tasks.getTask(id);
    return tasks.dispatch('task_revise', { task_id: id, expected_spec_version: task.spec_version,
      expected_state_version: task.state_version, reason: 'New evidence changes the next obligation', changes },
    makeEnvelope({ actorRef: 'author' })).task;
  };
  const at = () => new Date().toISOString();
  const next = () => { t.mock.timers.tick(1000); return at(); };
  return { tasks, create, revise, at, next };
}

function copy(t, db, filename = 'copy.sqlite') {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-legacy-replay-'));
  const path = join(dir, filename);
  db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
  const destination = new DatabaseSync(path);
  dropReplayHistory(destination);
  t.after(() => { destination.close(); rmSync(dir, { recursive: true, force: true }); });
  return destination;
}

function executionEnvelope(tasks, id, operationId) {
  const execution = tasks.getExecution(id);
  return makeEnvelope({ operationId, actorRef: execution.owner_ref, taskId: execution.task_id,
    executionId: id, specVersion: execution.spec_version, stateVersion: execution.state_version,
    fencingVersion: execution.fencing_version });
}

function contextFixture(t) {
  const base = fixture(t);
  const { tasks, create } = base;
  const context = new ContextService(':memory:', { taskService: tasks });
  dropReplayHistory(context.db);
  tasks.contextService = context;
  t.after(() => context.close());
  create('producer');
  const { execution } = tasks.takeTask('producer', { owner_ref: 'author', core_id: 'author', take_key: 'take-producer' });
  const envelope = id => executionEnvelope(tasks, execution.execution_id, id);
  tasks.dispatch('start_execution', {}, envelope('start-producer'));
  const publish = (id, fields = {}) => context.dispatch('context_publish_material', {
    material_id: id, content: `Mathematical evidence ${id}`, ...fields,
  }, envelope(`publish-${id}`)).material;
  const supersede = () => context.dispatch('material_supersede', {
    material_id: 'old', replacement_material_id: 'new', expected_version: 0, reason: 'Stronger result',
  }, envelope('supersede'));
  const revoke = () => context.dispatch('material_unsupersede', {
    material_id: 'old', replacement_material_id: 'new', expected_version: 1, reason: 'The boundary case is missing',
  }, envelope('revoke'));
  return { ...base, context, envelope, publish, supersede, revoke };
}

test('finished legacy experiment restores earlier Task content, deleted dependency and contract without snapshots', t => {
  const { tasks, create, revise, at, next } = fixture(t);
  create('first'); create('alternative');
  const before = create('dependent', { depends_on: ['first'] });
  tasks.reconcileTask('dependent');
  const selected = at();
  const oldRelation = tasks.getTask('dependent').relations.depends_on[0].relation_id;
  next();
  revise('dependent', { summary: 'A later and different obligation', gap: 'Later gap', depends_on: ['alternative'] });
  next(); create('future');
  const sourceBefore = tasks.db.prepare('SELECT * FROM tasks ORDER BY task_id').all();

  const restored = copy(t, tasks.db);
  const summary = projectLegacyServiceState(restored, { domain: 'task', at: selected });
  assert.equal(summary.mode, 'legacy');
  assert.equal(restored.prepare("SELECT summary FROM modern_task_records WHERE task_id = 'dependent'").get().summary, before.summary);
  assert.deepEqual({ ...restored.prepare("SELECT relation_id, related_task_id FROM task_relations WHERE task_id = 'dependent'").get() },
    { relation_id: oldRelation, related_task_id: 'first' });
  assert.equal(restored.prepare("SELECT state FROM tasks WHERE task_id = 'dependent'").get().state, 'BLOCKED');
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_id = 'future'").get().n, 0);
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM task_contract_revisions WHERE task_id = 'dependent'").get().n, 1);
  assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(tasks.db.prepare('SELECT * FROM tasks ORDER BY task_id').all(), sourceBefore);
});

test('Task completion uses closed_at and reopens its dependent only after completion', t => {
  const { tasks, create, at, next } = fixture(t);
  create('lemma'); create('theorem', { depends_on: ['lemma'] });
  tasks.reconcileTask('theorem');
  const { execution } = tasks.takeTask('lemma', { owner_ref: 'worker', take_key: 'take-lemma' });
  tasks.dispatch('start_execution', {}, executionEnvelope(tasks, execution.execution_id, 'start-lemma'));
  next();
  const finish = tasks.dispatch('task_finish', { outcome: 'done' }, executionEnvelope(tasks, execution.execution_id, 'finish-lemma'));
  const requestedAt = at();
  next();
  tasks.finalizeExecutionFinish(execution.execution_id, { fencingVersion: finish.execution.fencing_version });
  const closedAt = at();
  next(); create('future');

  const pending = copy(t, tasks.db);
  projectLegacyServiceState(pending, { domain: 'task', at: requestedAt });
  assert.equal(pending.prepare("SELECT state FROM tasks WHERE task_id = 'lemma'").get().state, 'RUNNING');
  assert.equal(pending.prepare('SELECT closed_at FROM execution_finish_intents').get().closed_at, null);
  assert.equal(pending.prepare("SELECT state FROM tasks WHERE task_id = 'theorem'").get().state, 'BLOCKED');
  assert.equal(pending.prepare('SELECT terminal_reason FROM executions').get().terminal_reason, null);

  const completed = copy(t, tasks.db);
  projectLegacyServiceState(completed, { domain: 'task', at: closedAt });
  assert.equal(completed.prepare("SELECT state FROM tasks WHERE task_id = 'lemma'").get().state, 'DONE');
  assert.equal(completed.prepare("SELECT state FROM tasks WHERE task_id = 'theorem'").get().state, 'OPEN');
  assert.equal(completed.prepare('SELECT closed_at FROM execution_finish_intents').get().closed_at, closedAt);
});

test('same-timestamp legacy receipts use their durable insertion order', t => {
  const { tasks, create, revise, at, next } = fixture(t);
  create('lemma');
  revise('lemma', { summary: 'First revision' });
  revise('lemma', { summary: 'Second revision' });
  const selected = at();
  next(); revise('lemma', { summary: 'Future revision' });
  const restored = copy(t, tasks.db);
  projectLegacyServiceState(restored, { domain: 'task', at: selected });
  assert.equal(restored.prepare("SELECT summary FROM modern_task_records WHERE task_id = 'lemma'").get().summary, 'Second revision');
  assert.equal(restored.prepare("SELECT spec_version FROM tasks WHERE task_id = 'lemma'").get().spec_version, 3);
});

test('future cancellation and Execution Workspace input do not survive old Task receipt reconstruction', t => {
  const { tasks, create, at, next } = fixture(t);
  create('lemma');
  const cancelled = create('alternative');
  const { execution } = tasks.takeTask('lemma', { owner_ref: 'worker', take_key: 'workspace-lemma' });
  const selected = at();
  next();
  tasks.dispatch('save_workspace_revision', { workspace_ref: 'future-workspace', workspace_revision: 1,
    workspace_content_hash: 'a'.repeat(64), workspace_input: { workspace_id: 'future-workspace', mission_id: 'mission',
      revision: '0.2', git_commit: 'b'.repeat(40), content_hash: 'a'.repeat(64) },
  }, executionEnvelope(tasks, execution.execution_id, 'later-input'));
  tasks.dispatch('task_cancel', { task_id: cancelled.task_id, expected_spec_version: cancelled.spec_version,
    expected_state_version: cancelled.state_version, reason: 'Future finding invalidated this approach' }, makeEnvelope({ actorRef: 'author' }));

  const restored = copy(t, tasks.db);
  projectLegacyServiceState(restored, { domain: 'task', at: selected });
  const task = restored.prepare("SELECT state, cancelled_at FROM tasks WHERE task_id = 'alternative'").get();
  assert.equal(task.state, 'OPEN');
  assert.equal(task.cancelled_at, null);
  assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM task_cancellations').get().n, 0);
  const oldExecution = restored.prepare('SELECT workspace_input_json, workspace_ref, terminal_reason FROM executions').get();
  assert.equal(JSON.parse(oldExecution.workspace_input_json), null);
  assert.equal(oldExecution.workspace_ref, null);
  assert.equal(oldExecution.terminal_reason, null);
});

test('a notification first delivered and handled after T becomes pending for a fresh core', t => {
  const { tasks, create, at, next } = fixture(t);
  create('lemma');
  const { execution } = tasks.takeTask('lemma', { owner_ref: 'worker', take_key: 'notification-lemma' });
  const notification = tasks.enqueueNotification({ deliveryKey: 'known-material', missionId: 'mission',
    recipientTaskId: 'lemma', recipientExecutionId: execution.execution_id, type: 'material_available',
    payload: { summary: 'A supporting lemma is available' } });
  const selected = at();
  next();
  tasks.recordNotificationAttempt(notification.notification_id);
  tasks.markNotificationDelivered(notification.notification_id, execution.execution_id);
  tasks.markNotificationHandled(notification.notification_id, execution.execution_id, {
    decision: 'accepted', action: 'read', details: { conclusion: 'Future handling result' },
  });
  assert.equal(tasks.listPendingNotifications('lemma', execution.execution_id).length, 0);

  const restored = copy(t, tasks.db, 'project.sqlite');
  const summary = projectLegacyServiceState(restored, { domain: 'task', at: selected });
  const row = restored.prepare('SELECT * FROM task_notifications').get();
  assert.equal(row.delivered_at, null);
  assert.equal(row.delivered_execution_id, null);
  assert.equal(row.delivery_attempts, 0);
  assert.equal(row.handled_at, null);
  assert.equal(row.handled_execution_id, null);
  assert.equal(row.handling_json, '{}');
  assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM task_notification_receipts').get().n, 0);
  assert.ok(summary.warnings.some(warning => warning.table === 'task_notifications' && /per-attempt history/.test(warning.reason)));

  const projectDir = dirname(restored.prepare('PRAGMA database_list').get().file);
  for (const [Service, filename] of [[ContextService, 'context.sqlite'], [JudgeService, 'judge.sqlite']]) {
    const service = new Service(join(projectDir, filename), { taskService: tasks });
    dropReplayHistory(service.db);
    service.close();
  }
  normalizeResumedServices({ projectDir, missionId: 'mission', now: at() });
  const resumed = new TaskService(join(projectDir, 'project.sqlite'));
  try {
    assert.equal(resumed.getExecution(execution.execution_id).state, 'FENCED');
    const pending = resumed.listPendingNotifications('lemma');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].notification_id, notification.notification_id);
    assert.equal(pending[0].delivery_attempts, 0);
    assert.deepEqual(pending[0].payload, { summary: 'A supporting lemma is available' });
  } finally { resumed.close(); }
});

test('legacy notification projection preserves known delivery and explicitly resets undated retry counts', t => {
  const { tasks, create, at, next } = fixture(t);
  create('lemma');
  const { execution } = tasks.takeTask('lemma', { owner_ref: 'worker', take_key: 'retried-notification' });
  const notification = tasks.enqueueNotification({ deliveryKey: 'already-delivered', missionId: 'mission',
    recipientTaskId: 'lemma', type: 'material_available' });
  tasks.markNotificationDelivered(notification.notification_id, execution.execution_id);
  const selected = at();
  next();
  tasks.markNotificationDelivered(notification.notification_id, execution.execution_id);
  tasks.markNotificationHandled(notification.notification_id, execution.execution_id, {
    decision: 'accepted', action: 'read', details: { conclusion: 'Future handling result' },
  });
  const restored = copy(t, tasks.db);
  const summary = projectLegacyServiceState(restored, { domain: 'task', at: selected });
  const receipt = restored.prepare('SELECT * FROM task_notification_receipts').get();
  assert.equal(receipt.delivered_at, selected);
  assert.equal(receipt.delivery_attempts, 1);
  assert.equal(receipt.handled_at, null);
  assert.equal(receipt.handling_json, '{}');
  assert.equal(restored.prepare('SELECT delivered_at FROM task_notifications').get().delivered_at, selected);
  assert.ok(summary.warnings.some(warning => warning.table === 'task_notification_receipts' && /per-attempt history/.test(warning.reason)));
});

test('legacy Mission submission preserves acceptance only at or after its completed result', async t => {
  const { tasks, at, next } = fixture(t);
  const beforeCreation = at();
  const dir = mkdtempSync(join(tmpdir(), 'swarm-legacy-submission-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = new MissionWorkspace({ rootDir: dir });
  await workspace.create({ missionId: 'mission', workspaceId: 'workspace', initialFiles: { 'proof.lean': 'theorem result : True := by trivial' } });
  const identity = { checker_ref: 'fixture', checker_version: '1', environment_ref: 'deterministic' };
  const checked = Promise.withResolvers();
  const store = new MissionSubmissionStore({ database: tasks.db, workspace,
    authorize: () => ({ acceptance: { required_check: identity } }), validateCompletion: () => true,
    checker: { identity, check: () => checked.promise },
  });
  next();
  await store.submit({ missionId: 'mission', workspaceId: 'workspace', actorRef: 'author', materialIds: [], requestId: 'final-check' });
  const requestedAt = at();
  next();
  checked.resolve({ verdict: 'PASS', check_result_id: 'final-proof' });
  await store.waitForIdle();
  const acceptedAt = at();
  assert.equal(tasks.isMissionStopped('mission'), true);

  const before = copy(t, tasks.db);
  projectLegacyServiceState(before, { domain: 'task', at: beforeCreation });
  assert.equal(before.prepare('SELECT COUNT(*) AS n FROM mission_submissions').get().n, 0);
  assert.equal(before.prepare('SELECT COUNT(*) AS n FROM mission_final_check_admissions').get().n, 0);

  const pending = copy(t, tasks.db);
  const summary = projectLegacyServiceState(pending, { domain: 'task', at: requestedAt });
  const pendingRow = pending.prepare('SELECT * FROM mission_submissions').get();
  const pendingDocument = JSON.parse(pendingRow.document);
  assert.equal(pendingRow.state, 'preparing');
  assert.equal(pendingDocument.result, null);
  assert.equal(pendingDocument.finished_at, undefined);
  assert.equal(pendingDocument.main_commit, undefined);
  assert.equal(pendingDocument.materials, undefined);
  assert.equal(pendingDocument.stop_pending, false);
  assert.equal(pendingRow.snapshot_fingerprint, '');
  assert.equal(pending.prepare('SELECT settled_at FROM mission_final_check_admissions').get().settled_at, null);
  assert.ok(summary.warnings.some(warning => warning.table === 'mission_submissions'));
  assert.equal(new MissionSubmissionStore({ database: pending }).isAccepted('mission'), false);

  const accepted = copy(t, tasks.db);
  projectLegacyServiceState(accepted, { domain: 'task', at: acceptedAt });
  const acceptedRow = accepted.prepare('SELECT * FROM mission_submissions').get();
  const acceptedDocument = JSON.parse(acceptedRow.document);
  assert.equal(acceptedRow.state, 'accepted');
  assert.equal(acceptedDocument.result.check_result_id, 'final-proof');
  assert.equal(acceptedDocument.finished_at, acceptedAt);
  assert.ok(acceptedDocument.main_commit);
  assert.equal(new MissionSubmissionStore({ database: accepted }).isAccepted('mission'), true);
  assert.equal(tasks.isMissionStopped('mission'), true);
});

test('restoring an old Mission check first removes a later request occupying the inflight slot', async t => {
  const { tasks, at, next } = fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'swarm-legacy-submission-slot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = new MissionWorkspace({ rootDir: dir });
  await workspace.create({ missionId: 'mission', workspaceId: 'workspace', initialFiles: { 'proof.lean': 'candidate' } });
  const identity = { checker_ref: 'fixture', checker_version: '1', environment_ref: 'deterministic' };
  const firstResult = Promise.withResolvers();
  const laterResult = Promise.withResolvers();
  let checks = 0;
  const store = new MissionSubmissionStore({ database: tasks.db, workspace,
    authorize: () => ({ acceptance: { required_check: identity } }), validateCompletion: () => true,
    maxInfrastructureRetries: 1,
    checker: { identity, check: () => (++checks === 1 ? firstResult : laterResult).promise },
  });
  const input = { missionId: 'mission', workspaceId: 'workspace', actorRef: 'author', materialIds: [] };
  await store.submit({ ...input, requestId: 'first-check' });
  const selected = at();
  next(); firstResult.resolve({ verdict: 'ERROR', code: 'CHECKER_UNAVAILABLE' });
  await store.waitForIdle();
  next();
  const later = await store.submit({ ...input, requestId: 'later-check' });
  assert.equal(later.state, 'pending');
  const restored = copy(t, tasks.db);
  laterResult.resolve({ verdict: 'FAIL' });
  await store.waitForIdle();

  projectLegacyServiceState(restored, { domain: 'task', at: selected });
  const submissions = restored.prepare('SELECT submission_id, state FROM mission_submissions').all();
  assert.deepEqual(submissions.map(row => ({ ...row })), [{ submission_id: 'first-check', state: 'preparing' }]);
});

test('legacy Material reconstruction restores supersession before revocation and preserves attachment bytes', t => {
  const { context, publish, supersede, revoke, at, next } = contextFixture(t);
  const bytes = Buffer.from([0, 255, 8, 42]);
  publish('old', { attachments: [
    { name: 'evidence.bin', media_type: 'application/octet-stream', content_base64: bytes.toString('base64') },
    { name: 'Z-proof.txt', content_base64: Buffer.from('ordered hash input').toString('base64') },
  ] });
  publish('new');
  next(); const replaced = supersede(); const selected = at();
  next(); revoke();
  next(); publish('future');
  const restored = copy(t, context.db);
  projectLegacyServiceState(restored, { domain: 'context', at: selected });
  assert.equal(restored.prepare('SELECT active FROM material_relations WHERE relation_id = ?').get(replaced.relation.relation_id).active, 1);
  assert.equal(restored.prepare("SELECT version FROM material_relation_heads WHERE material_id = 'old'").get().version, 1);
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM materials WHERE material_id = 'future'").get().n, 0);
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM material_relation_events WHERE action = 'revoked'").get().n, 0);
  assert.deepEqual(Buffer.from(restored.prepare("SELECT bytes FROM material_attachments WHERE name = 'evidence.bin'").get().bytes), bytes);
  assert.equal(context.db.prepare('SELECT active FROM material_relations').get().active, 0);
});

test('legacy correction receipt can supply a missing relation-event row', t => {
  const { context, publish, supersede, revoke, at, next } = contextFixture(t);
  publish('old'); publish('new');
  next(); supersede();
  next(); revoke(); const selected = at();
  context.db.prepare("DELETE FROM material_relation_events WHERE action = 'revoked'").run();
  next(); publish('future');
  const restored = copy(t, context.db);
  projectLegacyServiceState(restored, { domain: 'context', at: selected });
  assert.equal(restored.prepare('SELECT active FROM material_relations').get().active, 0);
  assert.equal(restored.prepare("SELECT version FROM material_relation_heads WHERE material_id = 'old'").get().version, 2);
  const event = restored.prepare("SELECT actor_ref, reason FROM material_relation_events WHERE action = 'revoked'").get();
  assert.equal(event.actor_ref, 'author');
  assert.equal(event.reason, 'The boundary case is missing');
});

test('missing indispensable historical evidence is precise and rolls back the destination', t => {
  const { context, publish, supersede, revoke, at, next } = contextFixture(t);
  publish('old'); publish('new');
  next(); supersede(); const selected = at();
  next(); revoke();
  const restored = copy(t, context.db);
  restored.exec("DELETE FROM material_relation_events WHERE action = 'revoked'; DELETE FROM operations WHERE operation = 'unsupersede_material'");
  const before = restored.prepare('SELECT * FROM material_relations').all();
  assert.throws(() => projectLegacyServiceState(restored, { domain: 'context', at: selected }), error => {
    assert.equal(error.code, 'REPLAY_HISTORY_MISSING');
    assert.equal(error.details.table, 'material_relations');
    assert.match(error.details.reason, /revocation/);
    return true;
  });
  assert.deepEqual(restored.prepare('SELECT * FROM material_relations').all(), before);
});

test('legacy Material import refuses missing attachment bytes instead of silently weakening evidence', t => {
  const { context, publish, at } = contextFixture(t);
  publish('old', { attachments: [{ name: 'proof.txt', content_base64: Buffer.from('complete proof').toString('base64') }] });
  const restored = copy(t, context.db);
  restored.exec('DELETE FROM material_attachments');
  assert.throws(() => projectLegacyServiceState(restored, { domain: 'context', at: at() }), {
    code: 'REPLAY_HISTORY_MISSING',
  });
});

test('legacy Task import reports a missing past value rather than copying its future contract', t => {
  const { tasks, create, revise, at, next } = fixture(t);
  create('lemma'); const selected = at();
  next(); revise('lemma', { summary: 'Only the future value remains' });
  const restored = copy(t, tasks.db);
  restored.prepare('DELETE FROM operations WHERE created_at <= ?').run(selected);
  restored.prepare('DELETE FROM task_contract_revisions WHERE created_at <= ?').run(selected);
  assert.throws(() => projectLegacyServiceState(restored, { domain: 'task', at: selected }), error => {
    assert.equal(error.code, 'REPLAY_HISTORY_MISSING');
    assert.equal(error.details.entity_id, 'lemma');
    assert.equal(error.details.table, 'tasks');
    return true;
  });
  assert.equal(restored.prepare("SELECT summary FROM modern_task_records WHERE task_id = 'lemma'").get().summary, 'Only the future value remains');
});

const fixtureManifest = { fixture_id: 'legacy-replay', putnambench_commit: 'a'.repeat(40), problem_file: 'input.lean',
  problem_file_hash: 'b'.repeat(64), lean_toolchain: 'leanprover/lean4:v4.33.1', mathlib_version: 'fixture',
  checker_ref: 'lean', checker_version: 'fixture', environment_ref: 'fixture' };

test('a Judge result completed after T cannot leak its verdict or evidence into a legacy replay', async t => {
  const { tasks, create, at, next } = fixture(t);
  create('lemma');
  const { execution } = tasks.takeTask('lemma', { owner_ref: 'author', core_id: 'author', take_key: 'check-lemma' });
  tasks.dispatch('start_execution', {}, executionEnvelope(tasks, execution.execution_id, 'start-check'));
  const entered = Promise.withResolvers();
  const result = Promise.withResolvers();
  const judge = new JudgeService(':memory:', { taskService: tasks, fixtureManifest,
    checker: { timeoutMs: 1000,
      preflight: ({ startProcess }) => startProcess(async () => ({ status: 'healthy', checker_process_status: 'completed',
        evidence: { input_binding_verified: true, toolchain_version_verified: true, checker_version_verified: true } })),
      check: ({ startProcess }) => startProcess(() => { entered.resolve(); return result.promise; }),
    },
  });
  dropReplayHistory(judge.db);
  t.after(() => judge.close());
  const checking = judge.checkWorkspaceSource({ request_key: 'check', source: { content: 'theorem lemma : True := by trivial' } },
    executionEnvelope(tasks, execution.execution_id, 'check'));
  await entered.promise;
  const requestedAt = at();
  next(); result.resolve({ verdict: 'PASS', evidence: { checker_started: true, exit_code: 0, diagnostic: 'future verification succeeded' } });
  const checked = await checking;
  const completedAt = at();

  const earlier = copy(t, judge.db);
  projectLegacyServiceState(earlier, { domain: 'judge', at: requestedAt });
  const before = earlier.prepare('SELECT verdict, evidence_json FROM check_results WHERE check_result_id = ?').get(checked.check_result_id);
  assert.equal(before.verdict, null);
  assert.doesNotMatch(before.evidence_json, /future verification/);
  const later = copy(t, judge.db);
  projectLegacyServiceState(later, { domain: 'judge', at: completedAt });
  assert.equal(later.prepare('SELECT verdict FROM check_results WHERE check_result_id = ?').get(checked.check_result_id).verdict, 'PASS');
});
