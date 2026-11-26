import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskService } from '../src/task/task-service.js';
import { makeEnvelope } from '../src/protocol/envelope.js';

function fixture(t) {
  const service = new TaskService(); t.after(() => service.close());
  const envelope = makeEnvelope({ actorRef: 'operator:discovery-test' });
  service.createMission({ mission_id: 'mission:pages', goal: 'Inspect existing independent responsibilities' }, envelope);
  const create = (id, priority = 0, extra = {}) => service.createTask({ mission_id: 'mission:pages', task_id: id, summary: `Inspect relevant responsibility ${id}`,
    expected_output: 'A reusable result', acceptance_conditions: ['Result is independently readable'], priority, ...extra }, makeEnvelope({ actorRef: envelope.actor_ref })).task;
  const list = input => service.dispatch('task_list', { mission_id: 'mission:pages', ...input }, envelope);
  return { service, create, list };
}

test('Task discovery continues beyond 500 matches without silently truncating older work', t => {
  const { create, list } = fixture(t);
  for (let i = 0; i < 505; i += 1) create(`task:${i}`, i === 504 ? 0 : 1);
  let cursor, pages = 0;
  const found = new Set();
  do {
    const result = list({ query: 'relevant', limit: 100, ...(cursor ? { cursor } : {}) });
    assert.ok(Array.isArray(result.tasks));
    assert.ok(result.tasks.length <= 100);
    for (const task of result.tasks) {
      assert.equal(found.has(task.task_id), false); found.add(task.task_id);
      assert.equal(task.materials, undefined); assert.equal(task.acceptance_conditions, undefined);
    }
    cursor = result.next_cursor;
    assert.equal(result.truncated, Boolean(cursor));
    pages += 1;
  } while (cursor);
  assert.equal(pages, 6); assert.equal(found.size, 505); assert.ok(found.has('task:504'));
});

test('Task cursor binds filters and excludes later creation while mutable state remains explicit', t => {
  const { service, create, list } = fixture(t);
  create('first'); create('second'); create('third');
  const first = list({ query: 'relevant', limit: 1 });
  create('later');
  service.db.prepare('UPDATE tasks SET priority = ? WHERE task_id = ?').run(999, 'third');
  assert.throws(() => list({ query: 'different', limit: 1, cursor: first.next_cursor }), { code: 'INVALID_CONTRACT' });
  assert.throws(() => list({ cursor: 'malformed' }), { code: 'INVALID_CONTRACT' });
  const rest = list({ query: 'relevant', limit: 10, cursor: first.next_cursor });
  assert.deepEqual(rest.tasks.map(task => task.task_id), ['second', 'third']);
  assert.equal(rest.next_cursor, null);
  assert.equal(rest.started_at, first.started_at);
  assert.equal(rest.membership, 'state-and-availability-at-page-read');
});

test('registered discovery cannot use a cursor or explicit scope to inspect another Mission', t => {
  const { service, create, list } = fixture(t);
  create('first'); create('second');
  const cursor = list({ limit: 1 }).next_cursor;
  service.createMission({ mission_id: 'mission:other', goal: 'Another independent project' }, makeEnvelope({ actorRef: 'operator:test' }));
  service.registerAgent({ agentId: 'reader', missionId: 'mission:other', coreId: 'core-reader', selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
  service.recordAgentSandbox('reader', { provider: 'controlled', sandboxId: 'reader' }); service.markAgentReady('reader');
  const envelope = makeEnvelope({ actorRef: 'reader' });
  assert.throws(() => service.dispatch('task_list', { mission_id: 'mission:pages' }, envelope), { code: 'NOT_ALLOWED' });
  assert.throws(() => service.dispatch('task_list', { cursor }, envelope), { code: 'INVALID_CONTRACT' });
});

test('an empty bounded availability scan retains continuation to eligible work after blocked matches', t => {
  const { create, list } = fixture(t);
  const prerequisite = create('prerequisite');
  for (let i = 0; i < 501; i += 1) create(`candidate:${i}`, 1, { depends_on: [prerequisite.task_id] });
  create('candidate:eligible', 0);
  const first = list({ query: 'candidate:', available_only: true, limit: 10 });
  assert.deepEqual(first.tasks, []);
  assert.equal(first.scanned, 500); assert.ok(first.next_cursor);
  const next = list({ query: 'candidate:', available_only: true, limit: 10, cursor: first.next_cursor });
  assert.deepEqual(next.tasks.map(task => task.task_id), ['candidate:eligible']);
  assert.equal(next.next_cursor, null);
});

test('state and text filters cannot consume an unbounded creation window', t => {
  const { service, create, list } = fixture(t);
  for (let i = 0; i < 501; i += 1) create(`unrelated:${i}`);
  create('needle');
  const first = list({ query: 'needle' });
  assert.equal(first.scanned, 500); assert.deepEqual(first.tasks, []); assert.ok(first.next_cursor);
  const second = list({ query: 'needle', cursor: first.next_cursor });
  assert.equal(second.scanned, 2); assert.deepEqual(second.tasks.map(task => task.task_id), ['needle']);
  const absent = list({ states: ['DONE'] });
  assert.equal(absent.scanned, 500); assert.deepEqual(absent.tasks, []); assert.ok(absent.next_cursor);
  const plan = service.db.prepare('EXPLAIN QUERY PLAN SELECT task_id, rowid FROM task_records WHERE mission_id = ? AND rowid > ? AND rowid <= ? ORDER BY rowid LIMIT 501').all('mission:pages', 0, 502);
  assert.ok(plan.some(row => row.detail.includes('task_records_mission_scan')));
  assert.ok(plan.every(row => !row.detail.includes('TEMP B-TREE')));
});

test('Task summaries include dependency, blocked and cancelled reasons without full contracts', t => {
  const { service, create, list } = fixture(t);
  create('prerequisite');
  create('blocked', 0, { depends_on: ['prerequisite'] });
  service.db.prepare("UPDATE tasks SET state = 'BLOCKED', block_reason = ? WHERE task_id = ?").run('dependency:prerequisite', 'blocked');
  create('open-unsatisfied', 0, { depends_on: ['prerequisite'] });
  const task = create('cancelled');
  let execution = service.takeTask(task.task_id, { owner_ref: 'cancel-owner', take_key: 'cancel-take' }).execution;
  const envelope = () => makeEnvelope({ actorRef: 'cancel-owner', taskId: task.task_id, executionId: execution.execution_id,
    specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version });
  execution = service.dispatch('start_execution', {}, envelope()).execution;
  service.dispatch('task_finish', { outcome: 'cancelled', reason: 'The responsibility was replaced' }, envelope());
  execution = service.getExecution(execution.execution_id);
  service.finalizeExecutionFinish(execution.execution_id, { fencingVersion: execution.fencing_version });
  const byId = Object.fromEntries(list({}).tasks.map(task => [task.task_id, task]));
  assert.deepEqual(byId.blocked.dependencies, { present: true, satisfied: false });
  assert.equal(byId.blocked.block_reason, 'dependency:prerequisite');
  assert.equal(byId['open-unsatisfied'].available, false);
  assert.deepEqual(byId.prerequisite.dependencies, { present: false, satisfied: true });
  assert.equal(byId.cancelled.state, 'CANCELED');
  assert.equal(byId.cancelled.cancellation_reason, 'The responsibility was replaced');
  assert.ok(byId.cancelled.updated_at);
});
