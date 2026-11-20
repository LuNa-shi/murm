import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskService, ContextService, makeEnvelope } from '../src/index.js';

function fixture(t) {
  const tasks = new TaskService();
  const context = new ContextService(tasks.db, { taskService: tasks });
  tasks.contextService = context;
  t.after(() => tasks.close());
  tasks.createMission({ mission_id: 'content', goal: 'Check shared claims' }, makeEnvelope({ actorRef: 'operator:test' }));
  const actor = id => {
    tasks.registerBot({ botId: id, coreId: id, missionId: 'content', selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
    tasks.recordBotSandbox(id, { provider: 'controlled', sandboxId: id }); tasks.markBotReady(id);
    const task = tasks.createTask({ mission_id: 'content', summary: `Check ${id}`, gap: `Evidence needed for ${id}`, priority: 'medium', expected_output: 'Evidence', acceptance_conditions: ['Evidence is reproducible'] }, makeEnvelope({ actorRef: id })).task;
    const { execution } = tasks.takeTask(task.task_id, { owner_ref: id, core_id: id, take_key: id });
    const envelope = operationId => {
      const e = tasks.getExecution(execution.execution_id);
      return makeEnvelope({ operationId, actorRef: id, taskId: task.task_id, executionId: e.execution_id,
        specVersion: e.spec_version, stateVersion: e.state_version, fencingVersion: e.fencing_version });
    };
    tasks.dispatch('start_execution', {}, envelope(`start:${id}`));
    return (operation, payload, request) => context.dispatch(operation, payload, envelope(request));
  };
  return { tasks, context, actor };
}

test('another registered Execution reads immutable published content and producer identity', t => {
  const { context, actor } = fixture(t); const one = actor('one'); const two = actor('two');
  const first = one('context_publish_material', { material_id: 'first', content: { claim: 'fixed' } }, 'first').material;
  assert.match(first.content_hash, /^[0-9a-f]{64}$/);
  assert.equal(first.producer_bot_id, 'one');
  const second = one('context_publish_material', { content: { claim: 'later' } }, 'second').material;
  assert.notEqual(first.content_hash, second.content_hash);
  assert.deepEqual(two('context_get_material', { material_id: first.material_id }, 'read').material.content, { claim: 'fixed' });
  assert.deepEqual(context.getMaterial(first.material_id).content, { claim: 'fixed' });
});

test('publication names only exact consumed Materials from the active Execution', t => {
  const { context, actor } = fixture(t); const one = actor('one'); const two = actor('two');
  const source = one('context_publish_material', { content: 'A reproducible boundary example' }, 'source').material;
  const output = { content: 'The example changes this conclusion', used_material_ids: [source.material_id] };
  assert.throws(() => two('context_publish_material', output, 'before'), { code: 'INVALID_CONTRACT' });
  const input = { material_ids: [source.material_id], action: 'integration', impact: 'The boundary example refutes the original premise' };
  const consumed = two('consume_materials', input, 'consume');
  assert.deepEqual(two('consume_materials', input, 'consume'), consumed);
  const result = two('context_publish_material', output, 'after').material;
  assert.equal(result.provenance.used_materials[0].content_hash, source.content_hash);
  assert.equal(context.listMaterialConsumptions({ material_id: source.material_id }).length, 1);
});

test('one committed publication emits one dependency event and its retry remains exact', t => {
  const { tasks, actor } = fixture(t); const one = actor('one'); const events = [];
  tasks.onDependencyEvent(event => events.push(event));
  const payload = { content: 'A public result' };
  const first = one('context_publish_material', payload, 'publish');
  assert.deepEqual(one('context_publish_material', payload, 'publish'), first);
  assert.equal(events.filter(event => event.kind === 'material_published').length, 1);
});

test('canonical publication rejects removed metadata and secret-bearing data', t => {
  const { actor } = fixture(t); const one = actor('one');
  for (const field of ['kind', 'scope', 'role', 'evidence_state', 'evidence', 'content_ref']) {
    assert.throws(() => one('context_publish_material', { content: 'Result', [field]: 'unsupported' }, field), { code: 'INVALID_CONTRACT' });
  }
  assert.throws(() => one('context_publish_material', { content: { api_key: 'do-not-store' } }, 'secret'), { code: 'INVALID_CONTRACT' });
});
