import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskService } from '../src/task/task-service.js';
import { ContextService } from '../src/context/context-service.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { MissionWorkspace } from '../src/runtime/mission-workspace.js';
import { TaskController } from '../src/runtime/task-controller.js';
import { IdentityTaskLoop } from '../src/runtime/identity-task-loop.js';

function fixture(t, database = ':memory:') {
  const tasks = new TaskService(database);
  const context = new ContextService(tasks.db, { taskService: tasks });
  tasks.contextService = context;
  t.after(() => tasks.close());
  const actor = (id, missionId, { start = true, take = true } = {}) => {
    if (!tasks.getMission(missionId)) tasks.createMission({ mission_id: missionId, goal: 'Investigate independent questions' }, makeEnvelope({ actorRef: 'operator:test' }));
    tasks.registerBot({ botId: id, missionId, coreId: id, selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
    tasks.recordBotSandbox(id, { provider: 'controlled', sandboxId: id }); tasks.markBotReady(id);
    let execution;
    const envelope = operationId => {
      const e = execution && tasks.getExecution(execution.execution_id);
      return makeEnvelope({ operationId, actorRef: id, taskId: e?.task_id, executionId: e?.execution_id,
        specVersion: e?.spec_version, stateVersion: e?.state_version, fencingVersion: e?.fencing_version });
    };
    if (take) {
      const task = tasks.createTask({ mission_id: missionId, summary: `Investigate the independent question for ${id}`, expected_output: 'Reusable research note', acceptance_conditions: ['Explain evidence and limitations'] }, envelope(`propose:${id}`)).task;
      execution = tasks.takeTask(task.task_id, { owner_ref: id, core_id: id, take_key: `take:${id}` }).execution;
      if (start) execution = tasks.dispatch('start_execution', {}, envelope(`start:${id}`)).execution;
    }
    return { id, envelope, execution };
  };
  const publish = (bot, id, extra = {}) => context.dispatch('context_publish_material', { role: 'experience', content: `Research note ${id}`, ...extra }, bot.envelope(id));
  return { tasks, context, actor, publish };
}

test('Material service rejects unbound, preparing and closing Bots independently of Bridge', t => {
  const { tasks, actor, publish } = fixture(t);
  const unbound = actor('unbound', 'mission:a', { take: false });
  assert.throws(() => publish(unbound, 'unbound-write'), { code: 'NOT_ALLOWED' });
  const preparing = actor('preparing', 'mission:a', { start: false });
  assert.throws(() => publish(preparing, 'preparing-write'), { code: 'NOT_ALLOWED' });
  const active = actor('active', 'mission:a');
  assert.ok(publish(active, 'accepted').material.material_id);
  tasks.requestBotStop(active.id, 'controlled-stop', { terminalState: 'FAILED' });
  assert.equal(tasks.getExecution(active.execution.execution_id).state, 'RUNNING');
  assert.throws(() => publish(active, 'after-stop'), { code: 'NOT_ALLOWED' });
});

test('Material reads, consumption and correction cannot cross the durable Bot Mission', t => {
  const { context, actor, publish } = fixture(t);
  const one = actor('one', 'mission:a');
  const two = actor('two', 'mission:b');
  const a = publish(one, 'a').material;
  const b = publish(two, 'b').material;
  assert.deepEqual(context.dispatch('read_materials', {}, one.envelope('list-a')).map(m => m.material_id), [a.material_id]);
  for (const [operation, payload] of [
    ['get_material', { material_id: b.material_id }],
    ['read_materials', { mission_id: 'mission:b' }],
    ['consume_materials', { material_ids: [b.material_id], action: 'task', action_ref: 'foreign-use' }],
    ['dispute_material', { material_id: b.material_id, reason: 'foreign claim' }],
    ['supersede_material', { material_id: a.material_id, replacement_material_id: b.material_id, expected_version: 0, reason: 'foreign successor' }],
  ]) assert.throws(() => context.dispatch(operation, payload, one.envelope(`foreign:${operation}`)), { code: 'NOT_ALLOWED' });
});

test('accepted Material publication replays across heartbeat and finish with its original provenance', t => {
  const { context, tasks, actor, publish } = fixture(t);
  const bot = actor('producer', 'mission:a');
  const original = publish(bot, 'stable-publish');
  tasks.dispatch('heartbeat', {}, bot.envelope('heartbeat'));
  assert.deepEqual(publish(bot, 'stable-publish'), original);
  tasks.dispatch('task_finish', { outcome: 'incomplete' }, bot.envelope('finish'));
  assert.deepEqual(publish(bot, 'stable-publish'), original);
  assert.throws(() => publish(bot, 'new-after-finish'), { code: 'NOT_ALLOWED' });
  assert.equal(context.getMaterial(original.material.material_id).producer_bot_id, bot.id);
  assert.throws(() => publish(bot, 'stable-publish', { content: 'changed' }), { code: 'CONFLICT' });
});

test('Task Material links also check the receiving actor Mission for nonproducer Experience', t => {
  const { tasks, actor, publish } = fixture(t);
  const one = actor('owner-a', 'mission:a');
  const two = actor('owner-b', 'mission:b');
  const b = publish(two, 'other-material').material;
  assert.throws(() => tasks.dispatch('task_link_material', { material_id: b.material_id, role: 'experience',
    task_id: two.execution.task_id, receiving_task_id: two.execution.task_id }, one.envelope('foreign-link')), { code: 'NOT_ALLOWED' });
});

test('Material publication holds the lifecycle writer lock until the content and receipt commit', t => {
  const root = mkdtempSync(join(tmpdir(), 'material-lifecycle-'));
  const database = join(root, 'state.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { tasks, actor, publish } = fixture(t, database);
  const bot = actor('writer', 'mission:a');
  const authorize = tasks.materialScope.bind(tasks);
  let blocked = false;
  tasks.materialScope = (...args) => {
    const scope = authorize(...args);
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA busy_timeout = 40');
      try { db.prepare("UPDATE bots SET state = 'CLOSING' WHERE bot_id = ?").run(process.argv[2]); console.log('incorrectly closed'); }
      catch (error) { console.log(error.errcode === 5 ? 'blocked' : error.message); }
      db.close();
    `, database, bot.id], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.trim(), 'blocked'); blocked = true;
    return scope;
  };
  const accepted = publish(bot, 'publication-first');
  tasks.materialScope = authorize;
  assert.equal(blocked, true);
  tasks.dispatch('task_finish', { outcome: 'incomplete' }, bot.envelope('finish-after-publication'));
  assert.deepEqual(publish(bot, 'publication-first'), accepted);
  assert.throws(() => publish(bot, 'new-after-close'), { code: 'NOT_ALLOWED' });
});

test('Material provenance cannot be claimed by another producer or upgraded by a Bot name prefix', t => {
  const { actor, publish } = fixture(t);
  const first = actor('judge:pretender', 'mission:a');
  const second = actor('second-producer', 'mission:a');
  const input = { material_id: 'fixed-material-id', content: 'same bytes', evidence_state: 'accepted', provenance: { actor_ref: 'system:forged', bot_id: 'forged' } };
  const material = publish(first, 'first-producer', input).material;
  assert.equal(material.producer_bot_id, first.id);
  assert.equal(material.provenance.bot_id, first.id);
  assert.equal(material.provenance.actor_ref, first.id);
  assert.equal(material.evidence_state, 'proposed');
  assert.throws(() => publish(second, 'second-producer', input), { code: 'CONFLICT' });
});

test('unbound Bot reads public Material in its Mission but separate commit domains reject registered writes', t => {
  const { tasks, context, actor, publish } = fixture(t);
  const producer = actor('producer-read', 'mission:a');
  const material = publish(producer, 'readable').material;
  const reader = actor('reader', 'mission:a', { take: false });
  assert.equal(context.dispatch('get_material', { material_id: material.material_id }, reader.envelope('read')).material.content_hash, material.content_hash);
  const isolated = new ContextService(':memory:', { taskService: tasks });
  t.after(() => isolated.close());
  assert.throws(() => isolated.dispatch('context_publish_material', { role: 'experience', content: 'unsafe separate commit' }, producer.envelope('separate-write')), { code: 'SERVICE_NOT_READY' });
});

test('Material contribution verifies the current fence, owner and deadline instead of supplied provenance', t => {
  const { tasks, context, actor, publish } = fixture(t);
  const bot = actor('fenced-producer', 'mission:a');
  const payload = { role: 'experience', content: 'A bounded note' };
  assert.throws(() => context.dispatch('context_publish_material', payload, { ...bot.envelope('stale-fence'), fencing_version: 0 }), { code: 'FENCED' });
  assert.throws(() => context.dispatch('context_publish_material', payload, { ...bot.envelope('forged-owner'), actor_ref: 'system:forged' }), { code: 'NOT_ALLOWED' });
  tasks.db.prepare('UPDATE bots SET hard_deadline = ? WHERE bot_id = ?').run(new Date(Date.now() - 1).toISOString(), bot.id);
  assert.throws(() => publish(bot, 'past-deadline'), { code: 'NOT_ALLOWED' });
});

test('historical cross-Mission relations and links stay stored but cannot affect public reads or new links', t => {
  const { tasks, context, actor, publish } = fixture(t);
  const one = actor('history-one', 'mission:a');
  const two = actor('history-two', 'mission:b');
  const a = publish(one, 'history-a').material;
  const b = publish(two, 'history-b').material;
  tasks.db.prepare(`INSERT INTO material_relations
    (relation_id, material_id, replacement_material_id, relation_kind, active, actor_ref, version, created_at)
    VALUES ('old-foreign-edge', ?, ?, 'supersede', 1, 'legacy', 1, ?)`).run(a.material_id, b.material_id, new Date().toISOString());
  assert.deepEqual(context.dispatch('list_material_relations', {}, one.envelope('history-relations')), []);
  assert.deepEqual(context.dispatch('read_materials', {}, one.envelope('history-visible')).map(m => m.material_id), [a.material_id]);
  assert.equal(context.listMaterialRelations({ material_id: a.material_id }).length, 1);
  const successor = publish(one, 'history-local-successor').material;
  for (const kind of ['dispute', 'supersede']) tasks.db.prepare(`INSERT INTO material_relations
    (relation_id, material_id, replacement_material_id, relation_kind, active, actor_ref, source_task, source_execution, version, created_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, 2, ?)`).run(`foreign-origin-${kind}`, a.material_id, kind === 'supersede' ? successor.material_id : null,
    kind, two.id, two.execution.task_id, two.execution.execution_id, new Date().toISOString());
  assert.deepEqual(context.dispatch('list_material_relations', {}, one.envelope('local-endpoints-foreign-author')), []);
  assert.ok(context.dispatch('read_materials', {}, one.envelope('foreign-author-cannot-hide')).some(m => m.material_id === a.material_id));
  tasks.db.prepare(`INSERT INTO material_consumptions (operation_id, material_id, reader_task, reader_execution, action, created_at)
    VALUES ('old-foreign-consumption', ?, ?, ?, 'task', ?)`).run(a.material_id, two.execution.task_id, two.execution.execution_id, new Date().toISOString());
  assert.deepEqual(context.dispatch('list_material_consumptions', {}, one.envelope('scoped-consumers')), []);
  assert.equal(context.listMaterialConsumptions({ material_id: a.material_id }).length, 1);
  tasks.dispatch('task_link_material', { material_id: a.material_id, role: 'experience' }, one.envelope('before-contamination'));
  tasks.db.prepare('UPDATE materials SET mission_id = ? WHERE material_id = ?').run('mission:b', a.material_id);
  assert.throws(() => context.dispatch('get_material', { material_id: a.material_id }, two.envelope('mismatched-producer')), { code: 'NOT_ALLOWED' });
  assert.ok(!context.dispatch('read_materials', {}, two.envelope('mismatched-producer-list')).some(m => m.material_id === a.material_id));
  assert.deepEqual(tasks.dispatch('list_task_materials', { task_id: one.execution.task_id }, one.envelope('after-contamination')).links, []);
  assert.deepEqual(tasks.getTask(one.execution.task_id).materials, []);
  assert.equal(tasks.db.prepare('SELECT COUNT(*) AS count FROM task_material_links WHERE material_id = ?').get(a.material_id).count, 1);
  assert.throws(() => tasks.dispatch('task_link_material', { material_id: a.material_id, role: 'experience' }, one.envelope('contaminated-link')), { code: 'NOT_ALLOWED' });
});

test('concurrent Context constructors migrate old Material identity storage under one writer lock', async t => {
  const root = mkdtempSync(join(tmpdir(), 'material-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const database = join(root, 'context.sqlite');
  const old = new ContextService(database);
  old.db.exec('ALTER TABLE materials DROP COLUMN producer_bot_id'); old.close();
  const source = `
    import { ContextService } from './src/context/context-service.js';
    const context = new ContextService(process.argv[1]);
    console.log(context.db.prepare('PRAGMA table_info(materials)').all().filter(column => column.name === 'producer_bot_id').length);
    context.close();
  `;
  const results = await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath,
    ['--input-type=module', '-e', source, database], { timeout: 10000 })));
  for (const result of results) assert.equal(result.stdout.trim(), '1');
});

test('durable public changes wake no-work discovery even with lost hints and an unchanged eligible queue', async t => {
  const root = mkdtempSync(join(tmpdir(), 'discovery-public-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { tasks, context, actor, publish } = fixture(t);
  const producer = actor('public-producer', 'mission:a');
  const workspace = new MissionWorkspace({ rootDir: root });
  await workspace.create({ workspaceId: 'public-wake', missionId: 'mission:a', initialFiles: { 'note.txt': 'initial input' } });
  let discoveries = 0;
  const idle = new IdentityTaskLoop({ coreId: 'idle-core', listEligibleTasks: () => [], takeTask: async () => {
    discoveries += 1; return { no_work: true };
  } });
  const controller = new TaskController({ taskService: tasks, sweepIntervalMs: 0,
    listEligibleTasks: () => tasks.listEligibleTasks({ missionId: 'mission:a' }),
    listIdentityLoops: () => [idle.snapshot(), { core_id: producer.id, state: 'RUNNING', healthy: true }],
    signalIdleIdentity: (_loop, event) => { assert.equal(event.core_id, 'idle-core'); idle.notify(event.reason); },
    readPublicChangeToken: async () => ({ tasks: tasks.publicChangeToken('mission:a'), materials: context.publicChangeToken('mission:a'),
      workspace: await workspace.publicChangeToken({ workspaceId: 'public-wake' }) }),
  });
  t.after(() => controller.stop());
  const poll = async expectedSignals => {
    assert.equal((await controller.reconcile({ reason: 'repair-poll' })).signaled_loop_count, expectedSignals);
    await idle.runOnce();
  };
  await poll(1); await poll(0); assert.equal(discoveries, 1);
  const save = () => workspace.save({ workspaceId: 'public-wake', baseRevision: '0.1', requestId: 'public-save', files: { 'note.txt': 'shared new result' } });
  await save(); await poll(1); assert.equal(discoveries, 2);
  await save(); await poll(0);
  tasks.dispatch('heartbeat', {}, producer.envelope('private-heartbeat')); await poll(0);
  const a = publish(producer, 'wake-material').material;
  await poll(1); assert.equal(discoveries, 3);
  context.dispatch('dispute_material', { material_id: a.material_id, reason: 'A claim requires rechecking' }, producer.envelope('wake-dispute'));
  await poll(1); assert.equal(discoveries, 4);
  const b = publish(producer, 'wake-successor').material;
  const relation = context.dispatch('supersede_material', { material_id: a.material_id, replacement_material_id: b.material_id, reason: 'Complete replacement' }, producer.envelope('wake-supersede')).relation;
  await poll(1); assert.equal(discoveries, 5);
  const revoke = () => context.dispatch('unsupersede_material', { material_id: a.material_id, replacement_material_id: b.material_id,
    expected_version: relation.version, reason: 'Replacement was mistaken' }, producer.envelope('wake-unsupersede'));
  revoke(); await poll(1); assert.equal(discoveries, 6);
  revoke(); await poll(0);
  tasks.createTask({ mission_id: 'mission:a', summary: 'Inspect a new responsibility dependent on existing research', expected_output: 'A follow-up conclusion',
    acceptance_conditions: ['Use the prerequisite result'], depends_on: [producer.execution.task_id] }, producer.envelope('blocked-proposal'));
  assert.deepEqual(tasks.listEligibleTasks({ missionId: 'mission:a' }), []);
  await poll(1); assert.equal(discoveries, 7);
});

test('a public commit during discovery survives an in-flight repair poll and wakes once after no-work', async t => {
  const { tasks, context, actor, publish } = fixture(t);
  const producer = actor('inflight-producer', 'mission:a');
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let discoveries = 0;
  const loop = new IdentityTaskLoop({ coreId: 'inflight-core', listEligibleTasks: () => [], takeTask: async () => {
    discoveries += 1;
    if (discoveries === 1) { entered(); await held; }
    return { no_work: true };
  } });
  const controller = new TaskController({ taskService: tasks, sweepIntervalMs: 0,
    listEligibleTasks: () => [], listIdentityLoops: () => [loop.snapshot()],
    signalIdleIdentity: (_loop, event) => loop.notify(event.reason),
    readPublicChangeToken: () => context.publicChangeToken('mission:a') });
  t.after(() => controller.stop());
  assert.equal((await controller.reconcile()).signaled_loop_count, 1);
  const active = loop.runOnce();
  await started;
  publish(producer, 'during-discovery');
  assert.equal(loop.snapshot().state, 'TAKING'); // This state includes the asynchronous Bot discovery/take callback.
  assert.equal((await controller.reconcile()).signaled_loop_count, 0);
  release(); await active;
  assert.equal((await controller.reconcile()).signaled_loop_count, 1);
  await loop.runOnce();
  assert.equal(discoveries, 2);
  assert.equal((await controller.reconcile()).signaled_loop_count, 0);
  await loop.runOnce(); assert.equal(discoveries, 2);
});
