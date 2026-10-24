import test from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_CODES, LocalServiceDouble, ServicesSDK, SwarmEnvError } from '../src/index.js';

function fixture() {
  const service = new LocalServiceDouble({
    tasks: [{ task_id: 'task-1', spec_version: 1 }],
    executions: [{ execution_id: 'execution-1', task_id: 'task-1', spec_version: 1, state_version: 4, fencing_version: 2 }],
  });
  const sdk = new ServicesSDK(service, {
    actorRef: 'agent:one',
    taskId: 'task-1',
    executionId: 'execution-1',
    specVersion: 1,
    stateVersion: 4,
    fencingVersion: 2,
  });
  return { service, sdk };
}

test('SDK carries the operation envelope and material publication is idempotent', () => {
  const { service, sdk } = fixture();
  const options = { operationId: 'publish-1' };
  const first = sdk.publishMaterial({
    kind: 'experience',
    scope: 'operational',
    evidence_state: 'accepted',
    content: { observation: 'retry is safe' },
  }, options);
  const replay = sdk.publishMaterial({
    kind: 'experience',
    scope: 'operational',
    evidence_state: 'accepted',
    content: { observation: 'retry is safe' },
  }, options);

  assert.deepEqual(replay, first);
  assert.equal(service.calls[0].envelope.operation_id, 'publish-1');
  assert.equal(service.calls[0].envelope.actor_ref, 'agent:one');
  assert.equal(service.calls[0].envelope.task_id, 'task-1');
  assert.equal(service.calls[0].envelope.execution_id, 'execution-1');
  assert.equal(first.evidence_state, 'proposed', 'an Agent cannot self-promote evidence');
  assert.equal(service.materials.size, 1);
});

test('SDK maps stale state and fencing errors to stable protocol codes', () => {
  const { sdk } = fixture();
  assert.throws(
    () => sdk.withContext({ stateVersion: 3 }).heartbeat({}, { operationId: 'heartbeat-stale' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.STALE_VERSION,
  );
  assert.throws(
    () => sdk.withContext({ fencingVersion: 1 }).abort({}, { operationId: 'abort-fenced' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.FENCED,
  );
});

test('Agent SDK has no Workspace Manager methods', () => {
  const { sdk } = fixture();
  for (const method of ['createWorkspace', 'saveWorkspaceRevision', 'restoreWorkspace', 'saveCheckpoint', 'fenceWorkspace']) {
    assert.equal(method in sdk, false, `${method} must remain Runtime-internal`);
  }
});

test('Task structure SDK methods expose semantic operations with the normal envelope', () => {
  const calls = [];
  const service = {
    dispatch(operation, payload, envelope) {
      calls.push({ operation, payload: structuredClone(payload), envelope: structuredClone(envelope) });
      return { operation, payload };
    },
  };
  const sdk = new ServicesSDK(service, {
    actorRef: 'agent:one',
    taskId: 'task-1',
    executionId: 'execution-1',
    specVersion: 1,
    stateVersion: 4,
    fencingVersion: 2,
  });
  const branchTasks = [{ task_type: 'research', goal: 'try route A' }, { task_type: 'research', goal: 'try route B' }];
  const structureChange = { kind: 'add_required_subtask', owner_task_id: 'task-1', subtask: { goal: 'check route' } };

  sdk.createBranchGroup({ parent_task_id: 'task-1', branch_tasks: branchTasks }, { operationId: 'structure-branch' });
  sdk.addRequiredSubtask({ owner_task_id: 'task-1', subtask: { goal: 'check route' } }, { operationId: 'structure-subtask' });
  sdk.getTaskStructure('task-1');
  sdk.proposeStructureChange({ task_id: 'task-1', expected_structural_version: 2, change: structureChange }, { operationId: 'structure-change' });
  sdk.explainTaskReadiness({ task_id: 'task-1' });
  sdk.createReworkTask({ prior_task_id: 'task-1', instruction: 'address the missing check' }, { operationId: 'structure-rework' });

  assert.deepEqual(calls.map(({ operation, payload }) => ({ operation, payload })), [
    { operation: 'create_branch_group', payload: { parent_task_id: 'task-1', branch_tasks: branchTasks } },
    { operation: 'add_required_subtask', payload: { owner_task_id: 'task-1', subtask: { goal: 'check route' } } },
    { operation: 'get_task_structure', payload: { task_id: 'task-1' } },
    { operation: 'propose_structure_change', payload: { task_id: 'task-1', expected_structural_version: 2, change: structureChange } },
    { operation: 'explain_task_readiness', payload: { task_id: 'task-1' } },
    { operation: 'create_rework_task', payload: { prior_task_id: 'task-1', instruction: 'address the missing check' } },
  ]);
  for (const call of calls) {
    assert.equal(call.envelope.actor_ref, 'agent:one');
    assert.equal(call.envelope.task_id, 'task-1');
    assert.equal(call.envelope.execution_id, 'execution-1');
  }
  assert.equal(calls[0].envelope.operation_id, 'structure-branch');
  assert.equal(calls[3].envelope.operation_id, 'structure-change');
  assert.equal(calls[5].envelope.operation_id, 'structure-rework');
});
