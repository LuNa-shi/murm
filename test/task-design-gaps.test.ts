import assert from 'node:assert/strict';
import test from 'node:test';
import { makeEnvelope } from '../examples/taskpool/persistence/envelope.js';
import { TaskService } from '../examples/taskpool/services/task/task-service.js';

function fixture(t) {
  const service = new TaskService();
  t.after(() => service.close());
  const missionId = 'mission:task-design';
  service.createMission({ mission_id: missionId, goal: 'Resolve a shared research question' }, makeEnvelope({ actorRef: 'operator:test' }));
  const create = (id, fields = {}) => service.createTask({ mission_id: missionId,
    task_id: id, summary: `Investigate ${id}`, expected_output: 'Written finding',
    acceptance_conditions: ['Include supporting evidence'], ...fields,
  }, makeEnvelope({ actorRef: 'agent:test' })).task;
  const coordinator = (id, coordinationPermissions = [], scope = missionId) => {
    service.registerAgent({ agentId: id, missionId: scope, coreId: id, coordinationPermissions,
      selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
    service.recordAgentSandbox(id, { provider: 'controlled', sandboxId: id });
    service.markAgentReady(id);
    return operationId => makeEnvelope({ actorRef: id, operationId });
  };
  return { service, create, coordinator };
}

test('cancelling a prerequisite preserves blockers and surfaces its replacement without granting take', t => {
  const { service, create } = fixture(t);
  const prerequisite = create('task:prerequisite');
  const replacement = create('task:replacement');
  const independent = create('task:independent');
  const downstream = create('task:downstream', { depends_on: [prerequisite.task_id, independent.task_id] });
  const ownerRef = 'agent:owner';
  const taken = service.takeTask(prerequisite.task_id, { owner_ref: ownerRef, core_id: 'core-1', take_key: 'prerequisite' });
  const execution = taken.execution;
  service.dispatch('task_finish', { outcome: 'cancelled', reason: 'Use the narrower responsibility', replacement_task_id: replacement.task_id }, makeEnvelope({
    actorRef: ownerRef, taskId: prerequisite.task_id, executionId: execution.execution_id,
    specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version,
  }));
  service.finalizeExecutionFinish(execution.execution_id, { fencingVersion: execution.fencing_version });

  const blocked = service.getTask(downstream.task_id);
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.blockers.length, 2);
  const relationId = blocked.relations.depends_on.find(row => row.related_task_id === prerequisite.task_id).relation_id;
  assert.deepEqual(blocked.blockers.find(row => row.prerequisite_task_id === prerequisite.task_id), {
    relation_id: relationId,
    prerequisite_task_id: prerequisite.task_id, prerequisite_state: 'CANCELED',
    invalid_prerequisite: true, replacement_task_id: replacement.task_id,
  });
  assert.equal(blocked.blockers.find(row => row.prerequisite_task_id === independent.task_id).prerequisite_state, 'OPEN');
  assert.throws(() => service.takeTask(downstream.task_id, { owner_ref: ownerRef, core_id: 'core-1', take_key: 'blocked' }), error =>
    error.code === 'NOT_ALLOWED' && error.details.blockers.some(row => row.replacement_task_id === replacement.task_id));
  assert.throws(() => create('task:cannot-start', { depends_on: [prerequisite.task_id] }), error =>
    error.code === 'INVALID_CONTRACT' && error.details.prerequisite_task_id === prerequisite.task_id);
  assert.equal(service.getTask('task:cannot-start'), null);
});

function observed(task) {
  return { task_id: task.task_id, expected_spec_version: task.spec_version, expected_state_version: task.state_version };
}

test('Task cancellation needs UNBOUND Mission authority while other coordination retains narrow grants', t => {
  const { service, create, coordinator } = fixture(t);
  const ordinary = coordinator('ordinary');
  const granted = coordinator('granted', ['task_cancel', 'unsupersede']);
  const task = create('task:cancel-target');
  const input = { ...observed(task), reason: 'Withdraw obsolete responsibility' };
  const ordinaryTarget = create('task:ordinary-cancel');
  assert.equal(service.dispatch('task_cancel', { ...observed(ordinaryTarget), reason: input.reason }, ordinary('ordinary')).task.state, 'CANCELED');
  assert.throws(() => service.dispatch('task_cancel', input, makeEnvelope({ actorRef: 'operator:unverified' })), { code: 'NOT_ALLOWED' });
  service.createMission({ mission_id: 'foreign', goal: 'Separate Mission' }, makeEnvelope({ actorRef: 'operator:test' }));
  const foreign = coordinator('foreign-agent', ['task_cancel'], 'foreign');
  assert.throws(() => service.dispatch('task_cancel', input, foreign('cross-mission')), { code: 'NOT_ALLOWED' });
  assert.deepEqual(service.assertMissionCoordination(granted('inspect'), 'unsupersede'), {
    mission_id: task.mission_id, agent_id: 'granted', task_id: null, execution_id: null,
  });
  const cancellation = service.dispatch('task_cancel', input, granted('cancel'));
  assert.equal(cancellation.task.state, 'CANCELED');
  assert.equal(cancellation.cancellation.actor_ref, 'granted');
  assert.equal(service.dispatch('task_view', { task_id: task.task_id }, granted('view')).cancellation.reason, input.reason);
  service.requestAgentStop('granted', 'test');
  assert.throws(() => service.assertMissionCoordination(granted('close'), 'unsupersede'), { code: 'NOT_ALLOWED' });
  assert.deepEqual(service.dispatch('task_cancel', input, granted('cancel')), cancellation);
});

test('dependency repair checks observed versions, preserves other edges and retains original provenance', t => {
  const { service, create, coordinator } = fixture(t);
  const granted = coordinator('coordinator', ['task_cancel', 'task_dependency_replace']);
  const first = create('task:first');
  const second = create('task:second');
  const third = create('task:third');
  const dependent = create('task:dependent', { depends_on: [first.task_id, third.task_id] });
  const original = dependent.relations.depends_on.find(row => row.related_task_id === first.task_id);
  const cycle = create('task:cycle', { depends_on: [dependent.task_id] });
  service.dispatch('task_cancel', { ...observed(first), reason: 'Replace responsibility', replacement_task_id: second.task_id }, granted('cancel'));
  const target = service.getTask(dependent.task_id);
  assert.ok(target.blockers.some(blocker => blocker.replacement_task_id === second.task_id));
  const request = { ...observed(target), from_task_id: first.task_id, to_task_id: second.task_id, reason: 'New prerequisite supplies the same input' };
  assert.throws(() => service.dispatch('task_dependency_replace', { ...request, to_task_id: cycle.task_id }, granted('cycle')), { code: 'INVALID_CONTRACT' });
  const changed = service.dispatch('task_dependency_replace', request, granted('replace'));
  assert.equal(changed.task.state_version, target.state_version + 1);
  assert.equal(changed.task.spec_version, target.spec_version);
  assert.equal(changed.task.state, 'BLOCKED');
  assert.deepEqual(changed.task.relations.depends_on.map(row => row.related_task_id).sort(), [second.task_id, third.task_id]);
  assert.deepEqual(changed.task.relations.dependency_replacements[0].original_relation, original);
  assert.deepEqual(service.dispatch('task_dependency_replace', request, granted('replace')), changed);
  assert.throws(() => service.dispatch('task_dependency_replace', request, granted('competing')), { code: 'STALE_VERSION' });
});

test('the narrow repair cannot displace a current owner and reopens after a completed replacement', t => {
  const { service, create, coordinator } = fixture(t);
  const unbound = coordinator('coordinator', ['task_cancel', 'task_dependency_replace']);
  const first = create('task:first');
  const replacement = create('task:replacement');
  const blocked = create('task:blocked', { depends_on: [first.task_id] });
  const ownerTask = create('task:owner');
  const owner = service.takeTask(ownerTask.task_id, { owner_ref: 'agent:existing', core_id: 'core-existing', take_key: 'occupied' }).execution;
  assert.throws(() => service.dispatch('task_cancel', { ...observed(service.getTask(ownerTask.task_id)), reason: 'Attempt to displace owner' }, unbound('occupied')), { code: 'NOT_ALLOWED' });
  assert.equal(service.getExecution(owner.execution_id).state, 'CREATED');
  const done = service.takeTask(replacement.task_id, { owner_ref: 'agent:replacement', core_id: 'core-replacement', take_key: 'complete' }).execution;
  service.dispatch('task_finish', { outcome: 'done' }, makeEnvelope({ actorRef: done.owner_ref, taskId: done.task_id, executionId: done.execution_id,
    specVersion: done.spec_version, stateVersion: done.state_version, fencingVersion: done.fencing_version }));
  service.finalizeExecutionFinish(done.execution_id, { fencingVersion: done.fencing_version });
  service.dispatch('task_cancel', { ...observed(first), reason: 'Withdraw prerequisite' }, unbound('cancel'));
  const result = service.dispatch('task_dependency_replace', { ...observed(service.getTask(blocked.task_id)),
    from_task_id: first.task_id, to_task_id: replacement.task_id, reason: 'Replacement completed the prerequisite' }, unbound('reopen'));
  assert.equal(result.task.state, 'OPEN');
  assert.deepEqual(result.task.blockers, []);
});

test('Mission stop admission rejects fresh work but preserves existing Execution closeout', t => {
  const { service, create, coordinator } = fixture(t);
  const grant = coordinator('active-coordinator', ['mission_submit']);
  const task = create('task:owned');
  const untaken = create('task:untaken');
  const taken = service.takeTask(task.task_id, { owner_ref: 'active-coordinator', core_id: 'active-coordinator', take_key: 'held' }).execution;
  const bound = execution => makeEnvelope({ actorRef: execution.owner_ref, taskId: execution.task_id, executionId: execution.execution_id,
    specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version });
  service.dispatch('start_execution', {}, bound(taken));
  const active = service.getExecution(taken.execution_id);
  assert.throws(() => service.assertMissionCoordination(grant('unbound-shape'), 'mission_submit'), { code: 'NOT_ALLOWED' });
  assert.equal(service.assertMissionCoordination(bound(active), 'mission_submit').execution_id, active.execution_id);
  service.setMissionStopReader(id => id === task.mission_id);
  assert.throws(() => coordinator('late-start'), { code: 'NOT_ALLOWED' });
  assert.throws(() => create('task:late-proposal'), { code: 'NOT_ALLOWED' });
  assert.throws(() => service.takeTask(untaken.task_id, { owner_ref: 'agent:late', core_id: 'other', take_key: 'late-take' }), { code: 'NOT_ALLOWED' });
  assert.throws(() => service.assertMissionCoordination(bound(active), 'mission_submit'), { code: 'NOT_ALLOWED' });
  assert.equal(service.materialScope(bound(active), { write: true }).execution_id, active.execution_id);
  assert.equal(service.dispatch('task_finish', { outcome: 'incomplete' }, bound(active)).execution.state, 'CLOSING');
});
