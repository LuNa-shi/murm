import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  ContextService,
  ERROR_CODES,
  ServicesSDK,
  ServicesRouter,
  SwarmEnvError,
} from '../src/index.js';

function fixture() {
  // These content-storage unit tests use a controlled authority double. The
  // actual Bot/E lifecycle and Mission checks live in material-authority.test.
  const context = new ContextService(new DatabaseSync(':memory:'), { taskService: {
    withServiceLifecycleWrite: commit => commit(),
    materialScope: envelope => ({ mission_id: 'mission:content-fixture', task_id: envelope.task_id, execution_id: envelope.execution_id, bot_id: null }),
    materialOriginMission: () => 'mission:content-fixture',
  } });
  const router = new ServicesRouter({ contextService: context, taskService: { dispatch() { throw new Error('task service not needed'); } } });
  const sdk = new ServicesSDK(router, { actorRef: 'agent:one', taskId: 'task-1', executionId: 'execution-1', specVersion: 1, stateVersion: 0, fencingVersion: 1 });
  return { context, sdk };
}

test('Agent can publish and another Execution can read immutable Material with source and hash', () => {
  const { context, sdk } = fixture();
  const published = sdk.publishMaterial({ kind: 'experience', scope: 'operational', evidence_state: 'accepted', content: { observation: 'retry is safe' } }, { operationId: 'material-1' });
  assert.match(published.material.content_hash, /^[0-9a-f]{64}$/);
  assert.equal(published.material.source_task, 'task-1');
  assert.equal(published.material.source_execution, 'execution-1');
  assert.equal(published.material.evidence_state, 'proposed');
  const other = sdk.withContext({ actorRef: 'agent:two', taskId: 'task-2', executionId: 'execution-2', fencingVersion: 1 });
  const read = other.readMaterials({ material_id: published.material.material_id });
  assert.deepEqual(read[0].content, { observation: 'retry is safe' });
  assert.equal(read[0].content_hash, published.material.content_hash);
  context.close();
});

test('Material revisions create a new immutable version and preserve supersedes', () => {
  const { context, sdk } = fixture();
  const first = sdk.publishMaterial({ kind: 'conjecture', scope: 'proof_relevant', content: { claim: 'v1' } }, { operationId: 'material-v1' }).material;
  const second = sdk.publishMaterial({ kind: 'conjecture', scope: 'proof_relevant', content: { claim: 'v2' }, supersedes: first.material_id, expected_version: 0, supersede_reason: 'Complete revised claim' }, { operationId: 'material-v2' }).material;
  assert.notEqual(second.material_id, first.material_id);
  assert.equal(second.version, 2);
  assert.equal(second.supersedes, first.material_id);
  assert.equal(context.getMaterial(first.material_id).content.claim, 'v1');
  assert.equal(context.getMaterial(second.material_id).content.claim, 'v2');
  context.close();
});

test('Context Service keeps shared Materials immutable after later publication', () => {
  const { context, sdk } = fixture();
  const material = sdk.publishMaterial({ kind: 'fact', scope: 'proof_relevant', content: { fact: 'fixed' } }, { operationId: 'freeze-material' }).material;
  const later = sdk.publishMaterial({ kind: 'fact', scope: 'proof_relevant', content: { fact: 'later' } }, { operationId: 'later-material' });
  assert.notEqual(later.material.content_hash, material.content_hash);
  assert.deepEqual(context.getMaterial(material.material_id).content, { fact: 'fixed' });
  context.close();
});

test('Context Service records durable Material consumption and requires it for root integration provenance', () => {
  const { context, sdk } = fixture();
  const source = sdk.publishMaterial({ kind: 'fact', scope: 'proof_relevant', content: { fact: 'bounded handoff' } }, { operationId: 'consume-source' }).material;
  assert.throws(
    () => sdk.publishMaterial({
      kind: 'experience', scope: 'root_integration', content: { summary: 'before consume' },
      provenance: { consumed_material_ids: [source.material_id] },
    }, { operationId: 'integration-before-consume' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.INVALID_CONTRACT,
  );
  const consumed = sdk.consumeMaterials({ material_ids: [source.material_id], action: 'integration', action_ref: 'root-integration' }, { operationId: 'consume-source-edge' });
  assert.deepEqual(consumed.material_ids, [source.material_id]);
  assert.equal(consumed.consumptions.length, 1);
  assert.deepEqual(context.listMaterialConsumptions({ reader_task: 'task-1', action: 'integration' }).map((row) => row.material_id), [source.material_id]);
  const integration = sdk.publishMaterial({
    kind: 'experience', scope: 'root_integration', content: { summary: 'bounded handoff' },
    provenance: { consumed_material_ids: [source.material_id] },
  }, { operationId: 'integration-after-consume' }).material;
  assert.deepEqual(integration.provenance.consumed_material_ids, [source.material_id]);
  const replay = sdk.consumeMaterials({ material_ids: [source.material_id], action: 'integration', action_ref: 'root-integration' }, { operationId: 'consume-source-edge' });
  assert.deepEqual(replay, consumed);
  context.close();
});

test('Context Service wakes Task reconciliation after a committed Material dependency fact', () => {
  const events = [];
  const taskService = { withServiceLifecycleWrite: commit => commit(), notifyDependencyEvent: (event) => events.push(event),
    materialScope: () => ({ mission_id: 'mission:notification-fixture', task_id: null, execution_id: null, bot_id: null }) };
  const context = new ContextService(new DatabaseSync(':memory:'), { taskService });
  const sdk = new ServicesSDK(context, { actorRef: 'agent:one' });
  const input = { kind: 'fact', scope: 'proof_relevant', content: { observation: 'ready' } };
  sdk.publishMaterial(input, { operationId: 'material-event-1' });
  sdk.publishMaterial(input, { operationId: 'material-event-1' });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'material_published');
  assert.equal(events[0].operation, 'publish_material');
  context.close();
});

test('secret-bearing data is rejected and Context Service has no Task or Workspace authority', () => {
  const { context, sdk } = fixture();
  assert.throws(
    () => sdk.publishMaterial({ kind: 'experience', scope: 'operational', content: { api_key: 'do-not-store' } }, { operationId: 'secret-material' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.INVALID_CONTRACT,
  );
  assert.equal('createWorkspace' in sdk, false);
  assert.throws(() => context.dispatch('task_take', {}, sdk.context), (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.INVALID_CONTRACT);
  assert.throws(() => context.dispatch('apply_check_result', {}, sdk.context), (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.INVALID_CONTRACT);
  context.close();
});

test('Material supports claim-scoped evidence, public terminology aliases, and relation CAS', () => {
  const { context, sdk } = fixture();
  const envelope = (operationId) => ({ operation_id: operationId, actor_ref: 'agent:one', task_id: 'task-1', execution_id: 'execution-1', spec_version: 1, state_version: 0, fencing_version: 1 });
  const first = context.dispatch('material.publish', {
    material_id: 'material:claim-v1', kind: 'fact', scope: 'mission',
    content: { claim: 'bounded' },
    evidence: [{ claim: 'bounded', explanation: 'reproduced with fixture v1' }],
  }, envelope('claim-v1')).material;
  assert.equal(first.evidence[0].claim, 'bounded');
  const second = context.dispatch('material.publish', {
    material_id: 'material:claim-v2', kind: 'fact', scope: 'mission',
    content: { claim: 'bounded and checked' },
    evidence: [{ claim: 'bounded', explanation: 'checker passed' }],
  }, envelope('claim-v2')).material;
  const relation = context.dispatch('material.supersede', {
    material_id: first.material_id, replacement_material_id: second.material_id, expected_version: 0, reason: 'additional check',
  }, envelope('claim-supersede')).relation;
  assert.equal(relation.active, true);
  assert.equal(context.dispatch('material.search', { mission_id: null }, envelope('claim-search')).some((row) => row.material_id === first.material_id), false);
  assert.equal(context.listMaterialRelations({ material_id: first.material_id })[0].relation_kind, 'supersede');
  context.dispatch('material.unsupersede', {
    material_id: first.material_id, replacement_material_id: second.material_id, expected_version: relation.version, reason: 'Restore the original pending verification',
  }, envelope('claim-unsupersede'));
  assert.equal(context.listMaterialRelations({ material_id: first.material_id, include_inactive: true })[0].active, false);
  assert.equal(context.dispatch('material.read', { material_id: first.material_id }, envelope('claim-read'))[0].material_id, first.material_id);
  context.close();
});
