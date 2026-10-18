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
  const context = new ContextService(new DatabaseSync(':memory:'));
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
  const second = sdk.publishMaterial({ kind: 'conjecture', scope: 'proof_relevant', content: { claim: 'v2' }, supersedes: first.material_id }, { operationId: 'material-v2' }).material;
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

test('secret-bearing data is rejected and Context Service has no Task or Workspace authority', () => {
  const { context, sdk } = fixture();
  assert.throws(
    () => sdk.publishMaterial({ kind: 'experience', scope: 'operational', content: { api_key: 'do-not-store' } }, { operationId: 'secret-material' }),
    (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.INVALID_CONTRACT,
  );
  assert.equal('createWorkspace' in sdk, false);
  assert.throws(() => context.dispatch('claim', {}, sdk.context), (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.INVALID_CONTRACT);
  assert.throws(() => context.dispatch('apply_check_result', {}, sdk.context), (error) => error instanceof SwarmEnvError && error.code === ERROR_CODES.INVALID_CONTRACT);
  context.close();
});
