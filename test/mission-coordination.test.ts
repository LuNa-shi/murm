import { ServicesBridge } from '../src/agent/services-bridge.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ContextService } from '../src/context/context-service.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
import { createMissionCoordination } from '../examples/taskpool/mission-coordination.js';
import { createMissionSubmissionAccess } from '../src/runtime/mission-submission-access.js';
import { MissionWorkspace } from '../src/runtime/mission-workspace.js';
import { TaskService } from '../src/task/task-service.js';

const missionId = 'mission:coordination';
const workspaceId = 'workspace-coordination';
const identity = { checker_ref: 'lean', checker_version: 'locked', environment_ref: 'fixture' };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mission-coordination-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskService = new TaskService(join(directory, 'tasks.sqlite'));
  const contextService = new ContextService(join(directory, 'context.sqlite'), { taskService });
  taskService.contextService = contextService;
  const workspace = new MissionWorkspace({ rootDir: directory });
  await workspace.create({ missionId, workspaceId, initialFiles: { 'solution.lean': 'fixed public bytes' } });
  taskService.createMission({ mission_id: missionId, goal: 'Research a fixed question', acceptance_conditions: { required_check: identity } },
    makeEnvelope({ actorRef: 'operator:test' }));
  const agent = (id, permissions = []) => {
    taskService.registerAgent({ agentId: id, coreId: id, missionId, coordinationPermissions: permissions,
      selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
    taskService.recordAgentSandbox(id, { provider: 'controlled', sandboxId: id });
    taskService.markAgentReady(id);
  };
  const bind = id => {
    const task = taskService.createTask({ mission_id: missionId, summary: 'Investigate an independent claim', gap: 'The Mission needs evidence for this independent claim', priority: 'medium', expected_output: 'A note',
      acceptance_conditions: ['Explain result'] }, makeEnvelope({ actorRef: id })).task;
    const { execution } = taskService.takeTask(task.task_id, { owner_ref: id, core_id: id, take_key: id });
    const envelope = () => {
      const current = taskService.getExecution(execution.execution_id);
      return makeEnvelope({ actorRef: id, taskId: task.task_id, executionId: current.execution_id, specVersion: current.spec_version,
        stateVersion: current.state_version, fencingVersion: current.fencing_version });
    };
    taskService.dispatch('start_execution', {}, envelope());
    return { taskId: task.task_id, executionId: execution.execution_id, fencingVersion: execution.fencing_version, envelope };
  };
  let stopping = false;
  const accepted = [];
  const calls = [];
  const store = createMissionCoordination({ taskService, contextService, workspace, missionId, workspaceId, deadline: Date.now() + 60_000,
    isStopping: () => stopping, onAccepted: submission => { accepted.push(submission.submission_id); },
    checker: { identity, check: input => new Promise(resolve => calls.push({ input, resolve })) },
  });
  t.after(async () => {
    for (const call of calls) call.resolve({ verdict: 'ERROR' });
    await store.waitForIdle();
    contextService.close();
    taskService.close();
  });
  return { directory, taskService, contextService, workspace, agent, bind, store, calls, accepted, stop: () => { stopping = true; } };
}

test('granted unbound Agent submits fixed Material references and acceptance survives submitter closure', async t => {
  const { taskService, contextService, agent, bind, store, calls, accepted } = await fixture(t);
  agent('producer');
  const source = bind('producer');
  const { material } = contextService.dispatch('context_publish_material', { material_id: 'evidence',
    content: 'PRIVATE MATERIAL BODY kept out of the submission' }, source.envelope());
  agent('coordinator', ['mission_submit']);
  const input = { missionId, workspaceId, actorRef: 'coordinator', requestId: 'scientific-check', materialIds: [material.material_id] };
  const submission = await store.submit(input);
  assert.equal(submission.state, 'pending');
  assert.deepEqual(submission.materials, [{ material_id: 'evidence', content_hash: material.content_hash, version: material.version,
    relation_version: 0, disputed: false, active_successor_ids: [] }]);
  assert.doesNotMatch(JSON.stringify(submission), /PRIVATE MATERIAL BODY/);
  assert.equal(calls[0].input.files['solution.lean'].toString(), 'fixed public bytes');
  taskService.requestAgentStop('coordinator', 'selection ended after admission');
  calls[0].resolve({ verdict: 'PASS' });
  await store.waitForIdle();
  assert.equal(store.isAccepted(missionId), true);
  assert.deepEqual(accepted, ['scientific-check']);
});

test('Mission submission rejects implicit Material inputs, forged scope and stale active fences', async t => {
  const { taskService, agent, bind, store, calls, stop } = await fixture(t);
  agent('ordinary');
  agent('coordinator', ['mission_submit']);
  const bound = bind('coordinator');
  const input = { missionId, workspaceId, actorRef: 'coordinator', materialIds: [], requestId: 'scope', taskId: bound.taskId,
    executionId: bound.executionId, fencingVersion: bound.fencingVersion };
  await assert.rejects(store.submit({ ...input, materialIds: undefined }), { code: 'INVALID_CONTRACT' });
  await assert.rejects(store.submit({ ...input, actorRef: 'ordinary', taskId: null, executionId: null, fencingVersion: null }), { code: 'NOT_ALLOWED' });
  await assert.rejects(store.submit({ ...input, workspaceId: 'another-workspace' }), { code: 'NOT_ALLOWED' });
  await assert.rejects(store.submit({ ...input, fencingVersion: bound.fencingVersion + 1 }), { code: 'FENCED' });
  taskService.db.prepare('UPDATE executions SET handoff_deadline = ? WHERE execution_id = ?')
    .run(new Date(Date.now() - 1).toISOString(), bound.executionId);
  await assert.rejects(store.submit(input), error => error.code === 'NOT_ALLOWED' && error.details.phase === 'soft_closeout');
  stop();
  await assert.rejects(store.submit(input), { code: 'NOT_ALLOWED' });
  assert.deepEqual(calls, []);
});

test('a correction committed before freeze cannot leave stale observed Material state in acceptance', async t => {
  const { contextService, workspace, agent, bind, store, calls } = await fixture(t);
  agent('producer'); const source = bind('producer');
  const { material } = contextService.dispatch('context_publish_material', { material_id: 'changing-evidence', content: 'A specific claim' }, source.envelope());
  agent('coordinator', ['mission_submit']);
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const entering = new Promise(resolve => { entered = resolve; });
  const original = workspace.exportRevision.bind(workspace);
  workspace.exportRevision = async input => { const value = await original(input); entered(); await held; return value; };
  const submitting = store.submit({ missionId, workspaceId, actorRef: 'coordinator', requestId: 'observed-before-correction', materialIds: [material.material_id] });
  await entering;
  contextService.dispatch('material_dispute', { material_id: material.material_id, claim: 'The main assertion', reason: 'Counterexample discovered before acceptance' }, source.envelope());
  release();
  const submission = await submitting;
  await store.waitForIdle();
  assert.equal(submission.state, 'error');
  assert.deepEqual(calls, []);
  assert.equal((await workspace.get({ workspaceId })).frozen_submission_id, null);
});

test('unreadable selected attachment cannot start Mission checking', async t => {
  const { contextService, agent, bind, store, calls } = await fixture(t);
  agent('producer'); const source = bind('producer');
  const material = contextService.dispatch('context_publish_material', { content: 'Selected evidence attachment',
    attachments: [{ name: 'evidence.txt', content_base64: Buffer.from('fixed evidence').toString('base64') }] }, source.envelope()).material;
  contextService.db.prepare('UPDATE material_attachments SET bytes = ? WHERE material_id = ?').run(Buffer.from('corrupted bytes'), material.material_id);
  agent('coordinator', ['mission_submit']);
  const result = await store.submit({ missionId, workspaceId, actorRef: 'coordinator', materialIds: [material.material_id], requestId: 'unreadable-input' });
  assert.equal(result.state, 'error');
  assert.deepEqual(calls, []);
});


test('independent public contributions merge before a failed Mission check and after its freeze releases', async t => {
  const { taskService, workspace, agent, bind, store, calls } = await fixture(t);
  agent('coordinator', ['mission_submit']);
  const bound = bind('coordinator');
  const input = { missionId, workspaceId, actorRef: 'coordinator', materialIds: [],
    taskId: bound.taskId, executionId: bound.executionId, fencingVersion: bound.fencingVersion };
  const saved = await workspace.save({ workspaceId, files: { 'independent.txt': 'Public note while the Mission is unsolved' } });
  const merge = await workspace.merge({ workspaceId, fromRevision: saved.revision, requestId: 'merge-partial' });
  assert.equal(merge.check, null);
  assert.equal(calls.length, 0);
  const followup = await workspace.save({ workspaceId, baseRevision: saved.revision,
    files: { 'independent.txt': 'Public note while the Mission is unsolved', 'followup.txt': 'Another useful contribution' } });
  const submit = await store.submit({ ...input, requestId: 'check-unsolved' });
  assert.equal(submit.main_revision, merge.main_revision);
  assert.equal(calls.length, 1);
  calls[0].resolve({ verdict: 'FAIL', check_result_id: 'unsolved-final' });
  await store.waitForIdle();
  const describe = submissionId => store.describe({ missionId, workspaceId, submissionId });
  const settled = await describe(submit.submission_id);
  assert.equal(settled.result.verdict, 'FAIL');
  assert.equal(settled.freeze_release_result, 'released');
  assert.equal(settled.current.merge_allowed, true);
  assert.match(settled.notice, /An unsuccessful result must not be recorded as success/);
  const discovery = await describe();
  assert.equal(discovery.state, 'open');
  assert.equal(discovery.current.main_revision, merge.main_revision);
  assert.equal(discovery.active_submission_id, null);
  const observed = discovery.submissions.find(row => row.submission_id === submit.submission_id);
  assert.equal(observed.state, 'failed');
  assert.equal(observed.main_revision, merge.main_revision);
  assert.equal((await workspace.get({ workspaceId })).frozen_submission_id, null);
  const next = await workspace.merge({ workspaceId, fromRevision: followup.revision, requestId: 'merge-after-unfreeze' });
  assert.notEqual(next.main_revision, merge.main_revision);
  const second = await store.submit({ ...input, requestId: 'check-new-main' });
  assert.equal(calls.length, 2);
  try {
    const old = await describe(submit.submission_id);
    assert.equal(old.freeze_release_result, 'released');
    assert.equal(old.current.active_submission_id, second.submission_id);
    assert.equal(old.current.main_revision, next.main_revision);
    assert.equal(old.current.merge_allowed, false);
    assert.match(old.current.observed_at, /^\d{4}-/);
  } finally { calls[1].resolve({ verdict: 'FAIL' }); await store.waitForIdle(); }
  assert.equal(taskService.getExecution(bound.executionId).state, 'RUNNING');
});

test('Mission coordination pins current main and explicit empty Materials and enforces acceptance across SQLite connections', async t => {
  const { directory, taskService, workspace, agent, bind, store, calls } = await fixture(t);
  taskService.setMissionStopReader(id => store.isAccepted(id));
  agent('coordinator', ['mission_submit']);
  const bound = bind('coordinator');
  const input = { missionId, workspaceId, actorRef: 'coordinator', taskId: bound.taskId,
    executionId: bound.executionId, fencingVersion: bound.fencingVersion, requestId: 'accepted-snapshot' };
  await assert.rejects(store.submit(input), { code: 'INVALID_CONTRACT' });
  assert.equal(calls.length, 0);
  const submission = await store.submit({ ...input, materialIds: [] });
  assert.equal(submission.state, 'pending');
  assert.deepEqual(submission.materials, []);
  assert.equal(submission.actor_ref, 'coordinator');
  assert.equal(submission.main_revision, (await workspace.get({ workspaceId })).main_revision);
  assert.equal(submission.main_revision, '0.1');
  assert.deepEqual(submission.checker, identity);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.files['solution.lean'].toString(), 'fixed public bytes');
  assert.equal(calls[0].input.tree, submission.git_tree);
  calls[0].resolve({ verdict: 'PASS', check_result_id: 'trusted-check' });
  await store.waitForIdle();
  const accepted = await store.describe({ missionId, workspaceId, submissionId: submission.submission_id });
  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.result.check_result_id, 'trusted-check');
  const current = taskService.getExecution(bound.executionId);
  const second = new TaskService(join(directory, 'tasks.sqlite'));
  try {
    for (const connection of [taskService, second]) {
      assert.throws(() => connection.createTask({ gap: 'No new research after accepted Mission', priority: 'medium', mission_id: missionId,
        summary: 'Late new research', expected_output: 'Note', acceptance_conditions: ['Evidence'] },
      makeEnvelope({ actorRef: 'coordinator', taskId: current.task_id, executionId: current.execution_id,
        specVersion: current.spec_version, stateVersion: current.state_version, fencingVersion: current.fencing_version })), { code: 'NOT_ALLOWED' });
    }
  } finally { second.close(); }
});


test('retained Bridge uses host-owned TaskPool submission and observes stop changes without Runtime forwarding', async t => {
  const { taskService, contextService, store, calls } = await fixture(t);
  const start = async (bridge, id) => {
    await bridge.start();
    t.after(() => bridge.stop());
    taskService.registerAgent({ agentId: id, coreId: bridge.coreId, missionId, coordinationPermissions: ['mission_submit'],
      selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
    bridge.startAgentIdentity(id);
    taskService.recordAgentSandbox(id, { provider: 'controlled', sandboxId: id });
    taskService.markAgentReady(id);
  };
  let stopped = false;
  const bridge = new ServicesBridge({ taskService, contextService, runtime: {}, coreId: 'core:submission',
    missionSubmission: createMissionSubmissionAccess({ store, workspaceId, isStopped: id => {
      assert.equal(id, missionId);
      return stopped;
    } }),
  });
  await start(bridge, 'coordinator');
  const receipt = await bridge.call({ operation: 'mission_submit', operation_id: 'taskpool-host-submission', payload: { material_ids: [] } });
  assert.equal(receipt.state, 'pending');
  assert.equal(receipt.workspace_id, workspaceId);
  assert.equal(receipt.current.mission_state, 'open');
  assert.equal(calls.length, 1);
  stopped = true;
  const observed = await bridge.call({ operation: 'mission_submission_get', payload: { submission_id: receipt.submission_id } });
  assert.equal(observed.submission_id, receipt.submission_id);
  assert.equal(observed.current.mission_state, 'stopped');
  assert.equal(observed.current.merge_allowed, false);

  const disabled = new ServicesBridge({ taskService, contextService, runtime: {}, coreId: 'core:disabled' });
  await start(disabled, 'disabled');
  for (const operation of ['mission_submit', 'mission_submission_get']) {
    await assert.rejects(disabled.call({ operation, payload: { material_ids: [] } }),
      { code: 'SERVICE_UNAVAILABLE', message: 'Mission submission is not enabled' });
  }
});
