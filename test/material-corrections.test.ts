import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskService } from '../src/task/task-service.js';
import { ContextService } from '../src/context/context-service.js';
import { makeEnvelope } from '../src/protocol/envelope.js';

function fixture(t, database = ':memory:') {
  const tasks = new TaskService(database);
  const context = new ContextService(tasks.db, { taskService: tasks });
  tasks.contextService = context;
  t.after(() => tasks.close());
  tasks.createMission({ mission_id: 'corrections', goal: 'Check claims' }, makeEnvelope({ actorRef: 'operator:test' }));
  const actor = id => {
    tasks.registerBot({ botId: id, missionId: 'corrections', coreId: id, selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
    tasks.recordBotSandbox(id, { provider: 'controlled', sandboxId: id }); tasks.markBotReady(id);
    const task = tasks.createTask({ mission_id: 'corrections', summary: `Check a separate claim ${id}`, gap: `The Mission needs evidence for independent claim ${id}`, priority: 'medium', expected_output: 'A complete note', acceptance_conditions: ['Evidence explained'] }, makeEnvelope({ actorRef: id })).task;
    const { execution } = tasks.takeTask(task.task_id, { owner_ref: id, core_id: id, take_key: id });
    const envelope = operationId => {
      const e = tasks.getExecution(execution.execution_id);
      return makeEnvelope({ operationId, actorRef: id, taskId: task.task_id, executionId: e.execution_id, specVersion: e.spec_version, stateVersion: e.state_version, fencingVersion: e.fencing_version });
    };
    tasks.dispatch('start_execution', {}, envelope(`start:${id}`));
    return envelope;
  };
  const one = actor('first'); const two = actor('second');
  const publish = (id, envelope = one, extra = {}) => context.dispatch('context_publish_material', { material_id: id, content: `Complete research note ${id}`, ...extra }, envelope(`publish:${id}`)).material;
  const replace = (old, next, version, request, envelope = one) => context.dispatch('material_supersede', { material_id: old, replacement_material_id: next, expected_version: version, reason: 'Complete revised account' }, envelope(request));
  const revoke = (old, next, version, request, envelope = two) => context.dispatch('material_unsupersede', { material_id: old, replacement_material_id: next, expected_version: version, reason: 'Counterexample makes the replacement premature' }, envelope(request));
  return { tasks, context, one, two, publish, replace, revoke };
}

test('competing successors use observed CAS, reject forks/cycles and preserve exact historical reads', t => {
  const { context, one, publish, replace } = fixture(t);
  for (const id of ['a', 'b', 'c']) publish(id);
  const first = replace('a', 'b', 0, 'replace-a');
  assert.equal(first.material.relation_version, 1);
  assert.throws(() => replace('a', 'c', 0, 'competing-c'), { code: 'STALE_VERSION' });
  assert.throws(() => replace('a', 'c', 1, 'fork-c'), { code: 'CONFLICT' });
  assert.equal(context.getMaterial('a').relation_version, 1);
  assert.throws(() => replace('b', 'a', 0, 'cycle'), { code: 'CONFLICT' });
  assert.equal(context.getMaterial('b').relation_version, 0);
  assert.deepEqual(context.dispatch('read_materials', {}, one('list')).materials.map(m => m.material_id).sort(), ['b', 'c']);
  assert.equal(context.dispatch('context_get_material', { material_id: 'a' }, one('exact')).material.content, 'Complete research note a');
  assert.deepEqual(replace('a', 'b', 0, 'replace-a'), first);
  assert.throws(() => replace('a', 'c', 0, 'replace-a'), { code: 'CONFLICT' });
});

test('any live same-Mission Execution can revoke, while ABA and late retries cannot erase a newer successor', t => {
  const { tasks, context, one, two, publish, replace, revoke } = fixture(t);
  for (const id of ['a', 'b', 'c']) publish(id);
  const first = replace('a', 'b', 0, 'replace-a');
  const reversed = revoke('a', 'b', first.material.relation_version, 'revoke-a');
  assert.equal(reversed.relation_version, 2);
  assert.equal(reversed.relation.active, false);
  replace('a', 'c', 2, 'replace-a-again');
  assert.deepEqual(revoke('a', 'b', 1, 'revoke-a'), reversed);
  assert.throws(() => revoke('a', 'b', 1, 'late-other-request'), { code: 'CONFLICT' });
  const view = context.dispatch('context_get_material', { material_id: 'a' }, two('view'));
  assert.equal(view.material.relation_version, 3);
  assert.deepEqual(view.active_successors.map(r => r.replacement_material_id), ['c']);
  assert.deepEqual(view.correction_events.map(e => [e.action, e.actor_ref, e.relation_version]), [['created', 'first', 1], ['revoked', 'second', 2], ['created', 'first', 3]]);
  assert.equal(view.relations.find(r => r.relation_id === first.relation.relation_id).reason, 'Complete revised account');
  tasks.dispatch('task_finish', { outcome: 'incomplete' }, two('finish'));
  assert.deepEqual(revoke('a', 'b', 1, 'revoke-a'), reversed);
  assert.throws(() => revoke('a', 'c', 3, 'after-finish'), { code: 'NOT_ALLOWED' });
});

test('separate disputes retain claims, reasons, authors and evidence links in the body without hiding content', t => {
  const { context, one, two, publish, replace, revoke } = fixture(t);
  publish('a'); publish('b');
  const payload = { material_id: 'a', claim: 'Section 1', reason: 'The boundary example fails; see the input in Material b' };
  const original = context.dispatch('material_dispute', payload, one('dispute-1'));
  context.dispatch('material_dispute', { ...payload, claim: 'Section 2', reason: 'Different counterexample' }, two('dispute-2'));
  assert.deepEqual(context.dispatch('material_dispute', payload, one('dispute-1')), original);
  replace('a', 'b', 0, 'replace'); revoke('a', 'b', 1, 'revoke');
  const view = context.dispatch('context_get_material', { material_id: 'a' }, one('view'));
  assert.equal(view.disputed, true);
  assert.deepEqual(view.relations.filter(r => r.relation_kind === 'dispute').map(r => r.claim).sort(), ['Section 1', 'Section 2']);
  const listed = context.dispatch('read_materials', {}, one('list')).materials;
  assert.equal(listed.length, 2);
  assert.equal(listed.find(m => m.material_id === 'a').disputed, true);
  assert.equal(listed.find(m => m.material_id === 'a').disputes.length, 2);
});

test('inline publish cannot bypass observed CAS and missing reason/version rolls back the new Material', t => {
  const { context, one, publish, replace } = fixture(t);
  publish('a'); publish('b'); replace('a', 'b', 0, 'first');
  assert.throws(() => publish('c', one, { supersedes: 'a', expected_version: 0, supersede_reason: 'Inline fork' }), { code: 'STALE_VERSION' });
  assert.equal(context.getMaterial('c'), null);
  assert.throws(() => publish('d', one, { supersedes: 'b' }), { code: 'INVALID_CONTRACT' });
  assert.equal(context.getMaterial('d'), null);
  assert.throws(() => context.dispatch('material_unsupersede', { material_id: 'a', replacement_material_id: 'b', reason: 'No observed version' }, one('no-version')), { code: 'INVALID_CONTRACT' });
  assert.throws(() => context.dispatch('material_unsupersede', { material_id: 'a', replacement_material_id: 'b', expected_version: 1 }, one('no-reason')), { code: 'INVALID_CONTRACT' });
});

test('exact correction view uses one snapshot while another connection commits a successor', t => {
  const root = mkdtempSync(join(tmpdir(), 'material-correction-snapshot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const database = join(root, 'state.sqlite');
  const { tasks, context, one, publish } = fixture(t, database);
  tasks.db.exec('PRAGMA journal_mode = WAL');
  publish('a'); publish('b');
  const otherTasks = new TaskService(database);
  const otherContext = new ContextService(otherTasks.db, { taskService: otherTasks });
  t.after(() => otherTasks.close());
  const get = context.getMaterial.bind(context);
  let interleaved = false;
  context.getMaterial = id => {
    const value = get(id);
    if (!interleaved && id === 'a') {
      interleaved = true;
      otherContext.dispatch('material_supersede', { material_id: 'a', replacement_material_id: 'b', expected_version: 0, reason: 'Concurrent complete correction' }, one('other-connection'));
    }
    return value;
  };
  const before = context.dispatch('context_get_material', { material_id: 'a' }, one('snapshot'));
  assert.equal(interleaved, true);
  assert.equal(before.material.relation_version, 0);
  assert.deepEqual(before.active_successors, []);
  assert.deepEqual(before.correction_events, []);
  context.getMaterial = get;
  const after = context.dispatch('context_get_material', { material_id: 'a' }, one('next-read'));
  assert.equal(after.material.relation_version, 1);
  assert.equal(after.active_successors[0].replacement_material_id, 'b');
});

test('fresh reuse of an already-published combined replacement cannot bypass the current successor', t => {
  const { context, one, publish, replace, revoke } = fixture(t);
  publish('old');
  const payload = { material_id: 'replacement', content: 'Complete correction', supersedes: 'old', expected_version: 0, supersede_reason: 'Correct the old account' };
  const first = context.dispatch('context_publish_material', payload, one('combined-original'));
  revoke('old', 'replacement', 1, 'revoke-original');
  publish('new'); replace('old', 'new', 2, 'current-successor');
  assert.deepEqual(context.dispatch('context_publish_material', payload, one('combined-original')), first);
  assert.throws(() => context.dispatch('context_publish_material', payload, one('combined-fresh')), { code: 'CONFLICT' });
  const view = context.dispatch('context_get_material', { material_id: 'old' }, one('view-current'));
  assert.equal(view.material.relation_version, 3);
  assert.deepEqual(view.active_successors.map(r => r.replacement_material_id), ['new']);
  assert.throws(() => context.dispatch('material_dispute', { material_id: 'old', reason: 'No specific claim' }, one('missing-claim')), { code: 'INVALID_CONTRACT' });
});

test('only explicitly granted live unbound coordinator can revoke and cannot publish research', t => {
  const { tasks, context, one, publish, replace } = fixture(t);
  publish('a'); publish('b'); replace('a', 'b', 0, 'replace');
  for (const [id, permissions] of [['coordinator', ['unsupersede']], ['ordinary', []]]) {
    tasks.registerBot({ botId: id, missionId: 'corrections', coreId: id, coordinationPermissions: permissions, selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
    tasks.recordBotSandbox(id, { provider: 'controlled', sandboxId: id }); tasks.markBotReady(id);
  }
  const payload = { material_id: 'a', replacement_material_id: 'b', expected_version: 1, reason: 'Correct a mistaken replacement' };
  const env = (id, operationId) => makeEnvelope({ actorRef: id, operationId });
  assert.throws(() => context.dispatch('material_unsupersede', payload, env('ordinary', 'ordinary-revoke')), { code: 'NOT_ALLOWED' });
  const reversed = context.dispatch('material_unsupersede', payload, env('coordinator', 'granted-revoke'));
  assert.equal(reversed.relation_version, 2);
  assert.equal(context.dispatch('context_get_material', { material_id: 'a' }, one('view')).correction_events.find(e => e.action === 'revoked').producer_execution_id, null);
  for (const [operation, input] of [
    ['context_publish_material', { content: 'Cannot create research outside an E' }],
    ['material_dispute', { material_id: 'a', claim: 'The main claim', reason: 'Needs evidence' }],
    ['material_supersede', { ...payload, expected_version: 2 }],
  ]) assert.throws(() => context.dispatch(operation, input, env('coordinator', `denied-${operation}`)), { code: 'NOT_ALLOWED' });
  tasks.requestBotStop('coordinator', 'test close', { terminalState: 'FAILED' });
  assert.deepEqual(context.dispatch('material_unsupersede', payload, env('coordinator', 'granted-revoke')), reversed);
  assert.throws(() => context.dispatch('material_unsupersede', payload, env('coordinator', 'closed-revoke')), { code: 'NOT_ALLOWED' });
});

test('quarantined foreign correction rows cannot block, form cycles or be revoked as local facts', t => {
  const { tasks, context, one, publish, replace, revoke } = fixture(t);
  for (const id of ['a', 'b', 'c']) publish(id);
  tasks.createMission({ mission_id: 'foreign', goal: 'Other research' }, makeEnvelope({ actorRef: 'operator:test' }));
  const foreignTask = tasks.createTask({ mission_id: 'foreign', summary: 'Foreign responsibility', expected_output: 'An account', acceptance_conditions: ['Documented'] }, makeEnvelope({ actorRef: 'operator:test' })).task;
  const foreign = tasks.takeTask(foreignTask.task_id, { owner_ref: 'foreign-worker', core_id: 'foreign-core', take_key: 'foreign' }).execution;
  const insert = (id, from, to) => tasks.db.prepare(`INSERT INTO material_relations
    (relation_id, material_id, replacement_material_id, relation_kind, active, reason, actor_ref, producer_task_id, producer_execution_id, version, created_at)
    VALUES (?, ?, ?, 'supersede', 1, 'Quarantined old origin', 'foreign-worker', ?, ?, 50, ?)`).run(id, from, to, foreignTask.task_id, foreign.execution_id, new Date().toISOString());
  insert('foreign-forward', 'a', 'c'); insert('foreign-backward', 'b', 'a');
  tasks.db.prepare(`WITH RECURSIVE offsets(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM offsets WHERE n < 101)
    INSERT INTO material_relations (relation_id, material_id, replacement_material_id, relation_kind, active,
      reason, actor_ref, producer_task_id, producer_execution_id, version, created_at)
    SELECT 'foreign-extra-' || n, 'a', 'c', 'supersede', 1, 'Foreign correction',
      'foreign-worker', ?, ?, 100 + n, ? FROM offsets`).run(foreignTask.task_id, foreign.execution_id, new Date().toISOString());
  tasks.db.prepare(`WITH RECURSIVE offsets(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM offsets WHERE n < 101)
    INSERT INTO material_relations (relation_id, material_id, relation_kind, active,
      reason, actor_ref, producer_task_id, producer_execution_id, version, created_at)
    SELECT 'foreign-dispute-' || n, 'b', 'dispute', 1, 'Foreign dispute',
      'foreign-worker', ?, ?, n, ? FROM offsets`).run(foreignTask.task_id, foreign.execution_id, new Date().toISOString());
  assert.throws(() => revoke('a', 'c', 0, 'must-not-touch-foreign'), { code: 'CONFLICT' });
  replace('a', 'b', 0, 'local-replacement');
  context.dispatch('material_dispute', { material_id: 'b', claim: 'The second conclusion', reason: 'A valid local qualification' }, one('local-dispute'));
  const shown = context.dispatch('read_materials', {}, one('listed-after-replace')).materials;
  assert.equal(shown.some(m => m.material_id === 'a'), false);
  assert.equal(shown.find(m => m.material_id === 'b').disputed, true);
  assert.deepEqual(shown.find(m => m.material_id === 'b').disputes.map(relation => relation.reason), ['A valid local qualification']);
  const view = context.dispatch('context_get_material', { material_id: 'a' }, one('view'));
  assert.deepEqual(view.active_successors.map(r => r.replacement_material_id), ['b']);
  assert.equal(view.relations.some(r => r.relation_id.startsWith('foreign')), false);
  revoke('a', 'b', 1, 'local-revoke');
  assert.equal(tasks.db.prepare("SELECT active FROM material_relations WHERE relation_id = 'foreign-forward'").get().active, 1);
  assert.equal(context.dispatch('read_materials', {}, one('list')).materials.some(m => m.material_id === 'a'), true);
});
