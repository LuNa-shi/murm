import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBoard } from '../src/harnesses/lead-worker/board.js';
import { ServiceRegistry, snapshotServiceRegistry, invokeService } from '../src/core/services.js';

async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lead-helper-board-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const board = createBoard({ path: join(directory, 'board.sqlite'), runId: 'test', verifyDelivery: options.verifyDelivery ?? (async ({ delivery }) => ({ ...delivery, verified: true })) });
  t.after(() => board.close());
  const services = new ServiceRegistry(); board.register(services);
  board.bindTeam('runtime', { lead: 'lead', helper1: 'one', helper2: 'two' });
  const registration = snapshotServiceRegistry(services).get('board');
  let serial = 0;
  const call = (agentId, operation, input = {}, operationId = `op-${++serial}`) => invokeService(registration, { operation, input, envelope: { operation_id: operationId }, caller: { runtimeId: 'runtime', agentId, profile: agentId === 'lead' ? 'lead' : agentId === 'one' ? 'helper1' : 'helper2', binding: 'test:board' } });
  await call('lead', 'announce', { text: 'Initial direction', feedback_ids: [] });
  await call('lead', 'assign', { helper_id: 'one', text: 'Validate inputs' });
  await call('lead', 'assign', { helper_id: 'two', text: 'Authenticate callers' });
  await call('lead', 'create_subtask', { id: 'task', title: 'Implement', path: 'result.txt' });
  return { board, call, directory };
}

test('transactional claim has one owner, exact replay and revision fencing preserve public state', async t => {
  const { board, call } = await setup(t);
  const outcomes = await Promise.allSettled([call('one', 'claim', { subtask_id: 'task', expected_revision: 0 }, 'claim-one'), call('two', 'claim', { subtask_id: 'task', expected_revision: 0 }, 'claim-two')]);
  assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1);
  const owned = outcomes.find(row => row.status === 'fulfilled').value; assert.equal(owned.owner, 'one');
  assert.deepEqual(await call('one', 'claim', { subtask_id: 'task', expected_revision: 0 }, 'claim-one'), owned);
  const before = board.snapshot();
  await assert.rejects(call('two', 'update_subtask', { subtask_id: 'task', expected_revision: 1, text: 'stolen' }), { code: 'NOT_ALLOWED' });
  await assert.rejects(call('lead', 'update_subtask', { subtask_id: 'task', expected_revision: 1, text: 'reset owner' }), { code: 'NOT_ALLOWED' });
  await assert.rejects(call('one', 'claim', { subtask_id: 'task', expected_revision: 1 }, 'claim-one'), { code: 'CONFLICT' });
  assert.deepEqual(board.snapshot(), before);
  board.fence({ agentId: 'one', code: 'input_unknown', execution: 'unknown' });
  assert.equal(board.snapshot().subtasks[0].owner, 'one');
  await assert.rejects(call('two', 'claim', { subtask_id: 'task', expected_revision: 1 }), { code: 'BOARD_FENCED' });
  assert.equal(board.snapshot().subtasks[0].failure.execution, 'unknown');
});

test('public read provenance connects feedback and user direction to verified later owner delivery', async t => {
  const { board, call } = await setup(t);
  await call('one', 'claim', { subtask_id: 'task', expected_revision: 0 });
  const feedback = await call('one', 'note', { text: 'Need stricter validation', subtask_id: 'task' });
  const before = board.snapshot();
  await assert.rejects(call('lead', 'announce', { text: 'Changed', feedback_ids: [feedback.seq] }), { code: 'FEEDBACK_NOT_READ' });
  assert.deepEqual(board.snapshot(), before);
  await call('lead', 'read');
  board.registerUserInput('supplement-1', 'Require evidence');
  const direction = await call('lead', 'announce', { text: 'Stricter validation and evidence', feedback_ids: [feedback.seq], user_input_id: 'supplement-1' });
  const delivery = { commit: 'a'.repeat(40), path: 'result.txt', sha256: 'b'.repeat(64), bytes: 10 };
  await assert.rejects(call('one', 'complete', { subtask_id: 'task', expected_revision: 1, direction_id: direction.seq, delivery }), { code: 'DIRECTION_NOT_READ' });
  await call('one', 'read');
  const result = await call('one', 'complete', { subtask_id: 'task', expected_revision: 1, direction_id: direction.seq, delivery });
  assert.equal(result.owner, 'one'); assert.equal(result.state, 'complete'); assert.equal(result.delivery.verified, true);
  assert.equal(result.directionId, direction.seq); assert.deepEqual(board.snapshot().directions[1].feedback_ids, [feedback.seq]);
});

test('unverified or stale proof cannot complete an owner claim, and unsafe paths fail schema before effects', async t => {
  const { board, call } = await setup(t);
  const before = board.snapshot();
  await assert.rejects(call('lead', 'create_subtask', { id: 'escape', title: 'escape', path: 'root/../escape.txt' }), { code: 'SERVICE_INPUT_INVALID' });
  await assert.rejects(call('lead', 'create_subtask', { id: 'forged', title: 'forged', path: 'safe.txt', owner: 'one' }), { code: 'SERVICE_INPUT_INVALID' });
  assert.deepEqual(board.snapshot(), before);
  await call('one', 'claim', { subtask_id: 'task', expected_revision: 0 }); await call('one', 'read');
  await assert.rejects(call('one', 'complete', { subtask_id: 'task', expected_revision: 0, direction_id: 1, delivery: { commit: 'a'.repeat(40), path: 'result.txt', bytes: 1, sha256: 'b'.repeat(64) } }), { code: 'CONFLICT' });
  assert.equal(board.snapshot().subtasks[0].state, 'claimed');
});

test('separate SQLite connections arbitrate the same durable claim and preserve receipts after reopening', async t => {
  const { board, call, directory } = await setup(t);
  const second = createBoard({ path: join(directory, 'board.sqlite'), runId: 'test', verifyDelivery: async () => { throw new Error('Unused'); } }); t.after(() => second.close());
  const services = new ServiceRegistry(); second.register(services); const registration = snapshotServiceRegistry(services).get('board');
  await call('one', 'claim', { subtask_id: 'task', expected_revision: 0 }, 'durable-claim');
  await assert.rejects(invokeService(registration, { operation: 'claim', input: { subtask_id: 'task', expected_revision: 0 }, envelope: { operation_id: 'second-connection' }, caller: { runtimeId: 'runtime', agentId: 'two', profile: 'helper2', binding: 'test:board' } }), { code: 'CONFLICT' });
  assert.equal(second.snapshot().subtasks[0].owner, 'one');
  assert.deepEqual(second.snapshot(), board.snapshot());
});


test('proof reads outside transaction cannot commit over a newer owner revision', async t => {
  let enter; const entered = new Promise(resolve => { enter = resolve; }); let resume;
  const { board, call } = await setup(t, { verifyDelivery: async ({ delivery }) => { enter(); await new Promise(resolve => { resume = resolve; }); return { ...delivery, verified: true }; } });
  await call('one', 'claim', { subtask_id: 'task', expected_revision: 0 }); await call('one', 'read');
  const pending = call('one', 'complete', { subtask_id: 'task', expected_revision: 1, direction_id: 1, delivery: { commit: 'a'.repeat(40), path: 'result.txt', sha256: 'b'.repeat(64), bytes: 1 } });
  const rejected = assert.rejects(pending, { code: 'CONFLICT' });
  await entered; await call('one', 'update_subtask', { subtask_id: 'task', expected_revision: 1, text: 'new owner revision' }); resume(); await rejected;
  assert.equal(board.snapshot().subtasks[0].revision, 2); assert.equal(board.snapshot().subtasks[0].state, 'claimed');
});
