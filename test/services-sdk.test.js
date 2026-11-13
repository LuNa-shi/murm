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
    () => sdk.withContext({ fencingVersion: 1 }).finishTask({ outcome: 'cancelled' }, { operationId: 'finish-fenced' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.FENCED,
  );
});

test('Local service double preserves durable consumption edges and root integration provenance', () => {
  const { service, sdk } = fixture();
  const source = sdk.publishMaterial({ kind: 'fact', scope: 'proof_relevant', content: { fact: 'source' } }, { operationId: 'local-source' });
  const consumed = sdk.consumeMaterials({ material_ids: [source.material_id], action: 'integration', action_ref: 'root' }, { operationId: 'local-consume' });
  assert.equal(consumed.consumptions.length, 1);
  assert.equal(service.consumptions.length, 1);
  const integration = sdk.publishMaterial({ kind: 'experience', scope: 'root_integration', content: { summary: 'integrated' }, provenance: { consumed_material_ids: [source.material_id] } }, { operationId: 'local-integration' });
  assert.deepEqual(integration.provenance.consumed_material_ids, [source.material_id]);
  assert.deepEqual(sdk.listMaterialConsumptions({ action: 'integration' }).map((row) => row.material_id), [source.material_id]);
});

test('Agent SDK has no Workspace Manager methods', () => {
  const { sdk } = fixture();
  for (const method of ['createWorkspace', 'saveWorkspaceRevision', 'restoreWorkspace', 'saveCheckpoint', 'fenceWorkspace']) {
    assert.equal(method in sdk, false, `${method} must remain Runtime-internal`);
  }
});
