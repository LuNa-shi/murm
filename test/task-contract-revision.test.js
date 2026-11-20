import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskService, makeEnvelope } from '../src/index.js';

function fixture(t, path = ':memory:') {
  const service = new TaskService(path);
  t.after(() => service.close());
  service.createMission({ mission_id: 'mission', goal: 'Resolve the fixed research objective' });
  for (const id of ['author', 'editor', 'worker']) {
    service.registerBot({ botId: id, missionId: 'mission', coreId: id, selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
    service.recordBotSandbox(id, { provider: 'controlled', sandboxId: id });
    service.markBotReady(id);
  }
  const envelope = (actor = 'author', fields = {}) => makeEnvelope({ actorRef: actor, ...fields });
  const create = (fields = {}) => service.createTask({ mission_id: 'mission', summary: 'Find bridge', gap: 'The fixed objective needs the missing bridge implication',
    expected_output: 'A bridge lemma and its evidence', acceptance_conditions: ['Explain how the bridge discharges the missing premise'], priority: 'high', ...fields }, envelope()).task;
  const revise = (task, changes, fields = {}) => service.dispatch('task_revise', { task_id: task.task_id, expected_spec_version: task.spec_version,
    expected_state_version: task.state_version, reason: 'New evidence narrows the responsibility', changes, ...fields }, envelope('editor'));
  return { service, create, revise, envelope };
}

test('Bot proposals require a gap and explicit priority and retain each version of the contract', t => {
  const { service, create, revise, envelope } = fixture(t);
  for (const fields of [{ gap: undefined }, { gap: ' ' }, { priority: undefined }, { priority: 9 }]) {
    assert.throws(() => create(fields), { code: 'INVALID_CONTRACT' });
  }
  const first = create();
  assert.equal(first.priority_level, 'high');
  assert.equal(first.contract_format, 'mission-gap-v1');
  const second = revise(first, { priority: 'low', gap: 'A concrete alternative now covers the urgent bridge' }).task;
  assert.equal(second.spec_version, first.spec_version + 1);
  assert.notEqual(second.spec_hash, first.spec_hash);
  assert.equal(second.priority_level, 'low');
  assert.throws(() => revise(first, { priority: 'medium' }), { code: 'STALE_VERSION' });
  const viewed = service.dispatch('task_view', { task_id: first.task_id }, envelope('editor'));
  assert.deepEqual(viewed.contract_history.map(row => row.contract.priority_level), ['high', 'low']);
  assert.equal(viewed.contract_history[1].reason, 'New evidence narrows the responsibility');
});

test('contract text bounds apply to normalized values in creation and revisions', t => {
  const { service, create, revise } = fixture(t);
  const original = create({ responsibility_key: 'normalized-contract', summary: `  ${'s'.repeat(240)}  `, gap: `  ${'g'.repeat(4000)}  `,
    expected_output: `  ${'o'.repeat(4000)}  ` });
  assert.equal(original.summary, 's'.repeat(240));
  assert.equal(original.gap, 'g'.repeat(4000));
  assert.equal(original.expected_output, 'o'.repeat(4000));
  assert.equal(create({ responsibility_key: 'normalized-contract', summary: 's'.repeat(240), gap: 'g'.repeat(4000),
    expected_output: 'o'.repeat(4000) }).task_id, original.task_id);
  assert.throws(() => create({ summary: 's'.repeat(241) }), { code: 'INVALID_CONTRACT' });
  assert.throws(() => create({ gap: 'g'.repeat(4001) }), { code: 'INVALID_CONTRACT' });
  assert.throws(() => create({ expected_output: 'o'.repeat(4001) }), { code: 'INVALID_CONTRACT' });
  const updated = revise(original, { summary: '  Revised title  ', gap: '  Resolve the remaining premise  ',
    expected_output: '  Explicit evidence  ' }).task;
  assert.equal(updated.summary, 'Revised title');
  assert.equal(updated.gap, 'Resolve the remaining premise');
  assert.equal(updated.expected_output, 'Explicit evidence');
  assert.throws(() => revise(updated, { summary: ' \t ' }), { code: 'INVALID_CONTRACT' });
  const history = service.viewTaskRecord(original.task_id).contract_history;
  assert.equal(history[0].contract.summary, original.summary);
  assert.equal(history[1].contract.summary, updated.summary);
});

test('revision and cancellation race against take through fixed versions and preserve old executions', t => {
  const { service, create, revise, envelope } = fixture(t);
  const original = create();
  const taken = service.takeTask(original.task_id, { owner_ref: 'legacy-worker', core_id: 'legacy-core', take_key: 'first' });
  assert.throws(() => revise(service.getTask(original.task_id), { priority: 'low' }), { code: 'NOT_ALLOWED' });
  const execution = taken.execution;
  const finish = service.dispatch('task_finish', { outcome: 'incomplete', reason: 'Publish evidence for a narrower next attempt' }, makeEnvelope({
    actorRef: execution.owner_ref, taskId: execution.task_id, executionId: execution.execution_id,
    specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version,
  }));
  assert.throws(() => revise(service.getTask(original.task_id), { priority: 'low' }), { code: 'NOT_ALLOWED' });
  service.finalizeExecutionFinish(execution.execution_id, { fencingVersion: finish.execution.fencing_version });
  const reopened = service.getTask(original.task_id);
  assert.equal(reopened.state, 'OPEN');
  const updated = revise(reopened, { priority: 'low' }).task;
  assert.equal(service.getExecution(execution.execution_id).spec_version, original.spec_version);
  assert.equal(service.getExecution(execution.execution_id).spec_hash, original.spec_hash);
  assert.throws(() => service.dispatch('task_take', { task_id: original.task_id, take_key: 'stale' }, envelope('worker', {
    taskId: original.task_id, specVersion: reopened.spec_version, stateVersion: reopened.state_version,
  })), { code: 'STALE_VERSION' });
  const cancelled = service.dispatch('task_cancel', { task_id: updated.task_id, expected_spec_version: updated.spec_version,
    expected_state_version: updated.state_version, reason: 'The alternative now covers this responsibility' }, envelope('editor'));
  assert.equal(cancelled.task.state, 'CANCELED');
  assert.throws(() => revise(cancelled.task, { priority: 'medium' }), { code: 'NOT_ALLOWED' });
});

test('revisions preserve dependencies, reject cycles and retain paged immutable contracts', t => {
  const { service, create, revise, envelope } = fixture(t);
  const first = create();
  const downstream = create({ depends_on: [first.task_id] });
  assert.throws(() => revise(first, { depends_on: [downstream.task_id] }), { code: 'INVALID_CONTRACT' });
  const changed = revise(first, { priority: 'medium' }).task;
  const input = { task_id: changed.task_id, expected_spec_version: changed.spec_version, expected_state_version: changed.state_version,
    reason: 'Replace an obsolete responsibility' };
  service.dispatch('task_cancel', input, envelope('editor'));
  const blocked = service.getTask(downstream.task_id);
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.blockers[0].invalid_prerequisite, true);
  const reprioritized = revise(blocked, { priority: 'low' }).task;
  assert.equal(reprioritized.state, 'BLOCKED');
  assert.equal(reprioritized.blockers[0].invalid_prerequisite, true);
  const page = service.dispatch('task_view', { task_id: first.task_id, contract_history_limit: 1 }, envelope('editor'));
  assert.equal(page.contract_history.length, 1);
  assert.equal(page.contract_history_page.next_after_version, 1);
  const next = service.dispatch('task_view', { task_id: first.task_id, contract_history_after_version: 1 }, envelope('editor'));
  assert.equal(next.contract_history[0].spec_version, 2);
  assert.equal(next.contract_history_page.complete, true);
});

test('UNBOUND authors can publish several responsibilities and ACTIVE authors can propose but cannot revise', t => {
  const { service, create, revise, envelope } = fixture(t);
  const first = create();
  const second = create({ summary: 'Analyze an alternative' });
  assert.notEqual(first.task_id, second.task_id);
  const { execution } = service.takeTask(first.task_id, { owner_ref: 'author', core_id: 'author', take_key: 'active' });
  const bound = () => {
    const current = service.getExecution(execution.execution_id);
    return envelope('author', { taskId: current.task_id, executionId: current.execution_id, specVersion: current.spec_version,
      stateVersion: current.state_version, fencingVersion: current.fencing_version });
  };
  service.dispatch('start_execution', {}, bound());
  const proposal = service.createTask({ summary: 'Independent follow-up', gap: 'Resolve the alternative premise to unblock integration',
    expected_output: 'Evidence for the premise', acceptance_conditions: ['State the premise and justify its use'], priority: 'medium' }, bound());
  assert.equal(proposal.task.mission_id, 'mission');
  assert.equal(proposal.task.creation.execution_id, execution.execution_id);
  assert.throws(() => service.dispatch('task_revise', { task_id: second.task_id, expected_spec_version: second.spec_version,
    expected_state_version: second.state_version, changes: { priority: 'high' }, reason: 'Prefer this route' }, bound()), { code: 'NOT_ALLOWED' });
  assert.throws(() => revise(service.getTask(first.task_id), { priority: 'low' }), { code: 'NOT_ALLOWED' });
});

test('contract updates replay exactly, detect conflicting payloads and cannot cross Missions', t => {
  const { service, create, envelope } = fixture(t);
  const original = create();
  const payload = { task_id: original.task_id, expected_spec_version: original.spec_version, expected_state_version: original.state_version,
    reason: 'New evidence favors this direction', changes: { priority: 'medium' } };
  const request = envelope('editor', { operationId: 'revision-request' });
  const result = service.dispatch('task_revise', payload, request);
  assert.deepEqual(service.dispatch('task_revise', payload, request), result);
  assert.throws(() => service.dispatch('task_revise', { ...payload, reason: 'Different input' }, request), { code: 'CONFLICT' });
  service.createMission({ mission_id: 'other', goal: 'A separate objective' });
  const foreign = service.createTask({ mission_id: 'other', summary: 'Foreign obligation', expected_output: 'Note', acceptance_conditions: ['Evidence'] }).task;
  assert.throws(() => service.dispatch('task_view', { task_id: foreign.task_id }, envelope('editor')), { code: 'NOT_ALLOWED' });
  assert.throws(() => service.dispatch('task_revise', { ...payload, task_id: foreign.task_id,
    expected_spec_version: foreign.spec_version, expected_state_version: foreign.state_version }, envelope('editor')), { code: 'NOT_ALLOWED' });
  assert.throws(() => service.dispatch('task_revise', { ...payload, expected_spec_version: result.task.spec_version,
    expected_state_version: result.task.state_version, changes: { depends_on: [foreign.task_id] } }, envelope('editor')), { code: 'INVALID_CONTRACT' });
});

test('responsibility-key deduplication compares the current revised contract', t => {
  const { create, revise } = fixture(t);
  const original = create({ responsibility_key: 'bridge' });
  const current = revise(original, { gap: 'The new orientation premise is the remaining bridge', priority: 'low' }).task;
  assert.throws(() => create({ responsibility_key: 'bridge' }), { code: 'CONFLICT' });
  const matching = create({ responsibility_key: 'bridge', gap: current.gap, priority: 'low' });
  assert.equal(matching.task_id, current.task_id);
  assert.equal(matching.spec_version, current.spec_version);
});

test('a take that wins admission prevents revision and cancellation using either old or fresh observations', t => {
  const { service, create, revise, envelope } = fixture(t);
  const original = create();
  const taken = service.takeTask(original.task_id, { owner_ref: 'worker', core_id: 'worker', take_key: 'claim-first' });
  assert.equal(taken.execution.state, 'CREATED');
  assert.throws(() => revise(original, { priority: 'low' }), { code: 'STALE_VERSION' });
  const claimed = service.getTask(original.task_id);
  assert.throws(() => service.dispatch('task_cancel', { task_id: original.task_id, expected_spec_version: claimed.spec_version,
    expected_state_version: claimed.state_version, reason: 'Remove duplicate' }, envelope('editor')), { code: 'NOT_ALLOWED' });
});

test('independent connections resolve competing contract revisions and retain history across restart', t => {
  const directory = mkdtempSync(join(tmpdir(), 'task-contract-'));
  const path = join(directory, 'project.sqlite');
  const { service, create, envelope } = fixture(t, path);
  const peer = new TaskService(path);
  t.after(() => { peer.close(); rmSync(directory, { recursive: true, force: true }); });
  const original = create();
  const input = { task_id: original.task_id, expected_spec_version: original.spec_version, expected_state_version: original.state_version,
    reason: 'Use fresh evidence to narrow the contract', changes: { priority: 'medium' } };
  const winner = peer.dispatch('task_revise', input, envelope('editor'));
  assert.throws(() => service.dispatch('task_revise', { ...input, changes: { priority: 'low' } }, envelope('author')), { code: 'STALE_VERSION' });
  const reopened = new TaskService(path);
  try {
    const view = reopened.viewTaskRecord(original.task_id);
    assert.equal(view.task.spec_version, winner.task.spec_version);
    assert.deepEqual(view.contract_history.map(row => row.contract.priority_level), ['high', 'medium']);
  } finally { reopened.close(); }
});
