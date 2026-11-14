import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ContextService } from '../src/context/context-service.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
import { createMissionCoordination } from '../src/runtime/mission-coordination.js';
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
  const bot = (id, permissions = []) => {
    taskService.registerBot({ botId: id, coreId: id, missionId, coordinationPermissions: permissions,
      selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
    taskService.recordBotSandbox(id, { provider: 'controlled', sandboxId: id });
    taskService.markBotReady(id);
  };
  const bind = id => {
    const task = taskService.createTask({ mission_id: missionId, summary: 'Investigate an independent claim', expected_output: 'A note',
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
  return { taskService, contextService, workspace, bot, bind, store, calls, accepted, stop: () => { stopping = true; } };
}

test('granted unbound Bot submits fixed Material references and acceptance survives submitter closure', async t => {
  const { taskService, contextService, bot, bind, store, calls, accepted } = await fixture(t);
  bot('producer');
  const source = bind('producer');
  const { material } = contextService.dispatch('context_publish_material', { material_id: 'evidence',
    content: 'PRIVATE MATERIAL BODY kept out of the submission' }, source.envelope());
  bot('coordinator', ['mission_submit']);
  const input = { missionId, workspaceId, actorRef: 'coordinator', requestId: 'scientific-check', materialIds: [material.material_id] };
  const submission = await store.submit(input);
  assert.equal(submission.state, 'pending');
  assert.deepEqual(submission.materials, [{ material_id: 'evidence', content_hash: material.content_hash, version: material.version,
    relation_version: 0, disputed: false, active_successor_ids: [] }]);
  assert.doesNotMatch(JSON.stringify(submission), /PRIVATE MATERIAL BODY/);
  assert.equal(calls[0].input.files['solution.lean'].toString(), 'fixed public bytes');
  taskService.requestBotStop('coordinator', 'selection ended after admission');
  calls[0].resolve({ verdict: 'PASS' });
  await store.waitForIdle();
  assert.equal(store.isAccepted(missionId), true);
  assert.deepEqual(accepted, ['scientific-check']);
});

test('Mission submission rejects implicit Material inputs, forged scope and stale active fences', async t => {
  const { taskService, bot, bind, store, calls, stop } = await fixture(t);
  bot('ordinary');
  bot('coordinator', ['mission_submit']);
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
  const { contextService, workspace, bot, bind, store, calls } = await fixture(t);
  bot('producer'); const source = bind('producer');
  const { material } = contextService.dispatch('context_publish_material', { material_id: 'changing-evidence', content: 'A specific claim' }, source.envelope());
  bot('coordinator', ['mission_submit']);
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
  const { contextService, bot, bind, store, calls } = await fixture(t);
  bot('producer'); const source = bind('producer');
  const material = contextService.dispatch('context_publish_material', { content: 'Selected evidence attachment',
    attachments: [{ name: 'evidence.txt', content_base64: Buffer.from('fixed evidence').toString('base64') }] }, source.envelope()).material;
  contextService.db.prepare('UPDATE material_attachments SET bytes = ? WHERE material_id = ?').run(Buffer.from('corrupted bytes'), material.material_id);
  bot('coordinator', ['mission_submit']);
  const result = await store.submit({ missionId, workspaceId, actorRef: 'coordinator', materialIds: [material.material_id], requestId: 'unreadable-input' });
  assert.equal(result.state, 'error');
  assert.deepEqual(calls, []);
});
