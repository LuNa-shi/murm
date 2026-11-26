import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ContextService } from '../src/context/context-service.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
import { TaskService } from '../src/task/task-service.js';

function fixture(t) {
  const taskService = new TaskService();
  t.after(() => taskService.close());
  const context = new ContextService(taskService.db, { taskService });
  const actor = (name, mission, active = true) => {
    if (!taskService.getMission(mission)) {
      taskService.createMission({ mission_id: mission, goal: 'Study a shared claim' }, makeEnvelope({ actorRef: 'operator:test' }));
    }
    taskService.registerAgent({ agentId: name, coreId: name, missionId: mission, selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
    taskService.recordAgentSandbox(name, { provider: 'controlled', sandboxId: name });
    taskService.markAgentReady(name);
    if (!active) return () => makeEnvelope({ actorRef: name });
    const task = taskService.createTask({ mission_id: mission, summary: 'Inspect a research claim', gap: 'The Mission needs reproducible evidence for the shared claim', priority: 'medium', expected_output: 'Evidence',
      acceptance_conditions: ['Reproducible explanation'] }, makeEnvelope({ actorRef: name })).task;
    const taken = taskService.takeTask(task.task_id, { owner_ref: name, core_id: name, take_key: name }).execution;
    const envelope = () => {
      const current = taskService.getExecution(taken.execution_id);
      return makeEnvelope({ actorRef: name, taskId: task.task_id, executionId: current.execution_id,
        specVersion: current.spec_version, stateVersion: current.state_version, fencingVersion: current.fencing_version });
    };
    taskService.dispatch('start_execution', {}, envelope());
    return envelope;
  };
  return { context, actor, taskService };
}

test('modern Material stores immutable metadata and attachment bytes with scoped exact download', t => {
  const { context, actor } = fixture(t);
  const producer = actor('producer', 'mission');
  const reader = actor('reader', 'mission', false);
  const foreign = actor('foreign', 'other-mission', false);
  const bytes = Buffer.from([0, 255, 64, 5]);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const payload = { material_id: 'evidence', content: 'Evidence\nThe input reproduces a boundary issue.',
    title: 'Boundary issue', summary: 'A reproducible failure', media_type: 'text/plain',
    attachments: [{ name: 'input.bin', content_base64: bytes.toString('base64'), content_hash: digest }] };
  const { material } = context.dispatch('context_publish_material', payload, producer());
  assert.equal(material.title, payload.title);
  assert.equal(material.summary, payload.summary);
  assert.equal(material.media_type, 'text/plain');
  assert.equal(material.producer_agent_id, 'producer');
  assert.ok(!['kind', 'role', 'evidence_state', 'evidence', 'content_json'].some(key => Object.hasOwn(material, key)));
  assert.deepEqual(material.attachments, [{ name: 'input.bin', media_type: 'application/octet-stream', content_hash: digest, size_bytes: bytes.length }]);
  const input = { material_id: 'evidence', attachment_name: 'input.bin' };
  assert.deepEqual(Buffer.from(context.dispatch('context_get_material', input, reader()).attachment.content_base64, 'base64'), bytes);
  assert.throws(() => context.dispatch('context_get_material', input, foreign()), { code: 'NOT_ALLOWED' });
  assert.throws(() => context.dispatch('context_publish_material', { ...payload, title: 'Changed' }, producer()), { code: 'CONFLICT' });
  assert.throws(() => context.dispatch('context_publish_material', { ...payload, material_id: 'invalid',
    attachments: [{ ...payload.attachments[0], content_base64: 'broken' }] }, producer()), { code: 'INVALID_CONTRACT' });
  assert.equal(context.getMaterial('invalid'), null);
  assert.throws(() => context.dispatch('context_publish_material', { ...payload, material_id: 'wrong-hash',
    attachments: [{ ...payload.attachments[0], content_hash: 'a'.repeat(64) }] }, producer()), { code: 'INVALID_CONTRACT' });
  assert.throws(() => context.dispatch('context_publish_material', { ...payload, material_id: 'private-path',
    attachments: [{ name: 'input.bin', path: '/private/sandbox/input.bin' }] }, producer()), { code: 'INVALID_CONTRACT' });
  const copied = context.dispatch('context_publish_material', { material_id: 'copied', content: 'Equivalent complete contents',
    attachments: [{ name: 'copy.bin', content_hash: digest, source: input }] }, producer()).material;
  assert.equal(context.dispatch('context_get_material', { material_id: copied.material_id, attachment_name: 'copy.bin' }, reader())
    .attachment.content_hash, digest);
  context.db.prepare("UPDATE material_attachments SET bytes = ? WHERE material_id = 'copied'").run(Buffer.from('damaged'));
  assert.throws(() => context.dispatch('material_supersede', { material_id: 'evidence', replacement_material_id: 'copied',
    expected_version: 0, reason: 'Proposed replacement' }, producer()), { code: 'CONFLICT' });
  assert.equal(context.getMaterial('evidence').relation_version, 0);
});

test('registered search paginates a fixed creation window and consumption records exact identity and impact', t => {
  const { context, actor, taskService } = fixture(t);
  const producer = actor('producer', 'mission');
  const reader = actor('reader', 'mission');
  const publish = (id, content) => context.dispatch('context_publish_material', { material_id: id, content }, producer()).material;
  const first = publish('first', { conclusion: 'shared needle' });
  const second = publish('second', 'Another finding with needle');
  assert.equal(first.media_type, 'application/json');
  assert.equal(second.title, 'Another finding with needle');
  const filters = { query: 'needle', limit: 1 };
  const page = context.dispatch('context_search_materials', filters, reader());
  assert.equal(page.materials[0].material_id, first.material_id);
  assert.equal(page.materials[0].content, undefined);
  assert.equal(page.truncated, true);
  publish('late', 'found needle after first page');
  const next = context.dispatch('context_search_materials', { ...filters, cursor: page.next_cursor }, reader());
  assert.equal(next.materials[0].material_id, second.material_id);
  assert.equal(next.next_cursor, null);
  assert.throws(() => context.dispatch('context_search_materials', { ...filters, query: 'changed', cursor: page.next_cursor }, reader()), { code: 'INVALID_CONTRACT' });
  assert.equal(taskService.db.prepare('SELECT COUNT(*) AS n FROM material_consumptions').get().n, 0);
  assert.throws(() => context.dispatch('consume_materials', { material_ids: [first.material_id], action: 'route' }, reader()), { code: 'INVALID_CONTRACT' });
  const use = { material_ids: [first.material_id], action: 'route', impact: 'The counterexample ruled out the first branch of the proof' };
  const envelope = reader();
  const recorded = context.dispatch('consume_materials', use, envelope);
  assert.equal(recorded.consumptions[0].impact, use.impact);
  assert.equal(recorded.consumptions[0].material_version, first.version);
  assert.equal(recorded.consumptions[0].content_hash, first.content_hash);
  assert.deepEqual(context.dispatch('consume_materials', use, envelope), recorded);
  context.dispatch('consume_materials', { ...use, impact: 'Used the result independently to choose a test input' }, reader());
  const readUsage = fields => context.dispatch('context_get_material', { material_id: first.material_id, usage_limit: 1, ...fields }, reader()).usage;
  const usage = readUsage({});
  assert.equal(usage.consumptions[0].impact, use.impact);
  assert.equal(readUsage({ usage_cursor: usage.next_cursor }).consumptions.length, 1);
  const derived = context.dispatch('context_publish_material', { content: 'Result of applying the first argument',
    used_material_ids: [first.material_id] }, reader()).material;
  assert.deepEqual(derived.provenance.used_materials, [{ material_id: first.material_id,
    material_version: first.version, content_hash: first.content_hash }]);
  assert.throws(() => context.dispatch('context_publish_material', { content: 'Unsupported reuse claim',
    used_material_ids: [second.material_id] }, reader()), { code: 'INVALID_CONTRACT' });
});

test('Material search ranks titles before content and labels a superseding result', t => {
  const { context, actor } = fixture(t);
  const producer = actor('producer', 'mission');
  context.dispatch('context_publish_material', { material_id: 'old', title: 'Old finding', summary: 'Old account',
    content: 'The needle appears in the body' }, producer());
  context.dispatch('context_publish_material', { material_id: 'new', title: 'Needle correction', content: 'The complete revised account' }, producer());
  const first = context.dispatch('context_search_materials', { query: 'needle', limit: 1 }, producer());
  assert.equal(first.materials[0].material_id, 'new');
  const next = context.dispatch('context_search_materials', { query: 'needle', limit: 1, cursor: first.next_cursor }, producer());
  assert.equal(next.materials[0].material_id, 'old');
  context.dispatch('material_supersede', { material_id: 'old', replacement_material_id: 'new', expected_version: 0, reason: 'Corrects the older account' }, producer());
  const searched = context.dispatch('context_search_materials', { related_material_id: 'old', relation_kind: 'supersede' }, producer());
  assert.deepEqual(searched.materials.map(row => row.material_id), ['new']);
  assert.equal(searched.materials[0].supersedes[0].material_id, 'old');
});

test('sparse Material queries keep a continuation after scanning an empty bounded page', t => {
  const { context, actor, taskService } = fixture(t);
  const producer = actor('producer', 'mission');
  const reader = actor('reader', 'mission', false);
  context.dispatch('context_publish_material', { material_id: 'initial', content: 'irrelevant' }, producer());
  taskService.db.exec(`WITH RECURSIVE numbers(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM numbers WHERE i < 500)
    INSERT INTO materials (material_id, mission_id, content_hash, content_json,
      version, producer_task_id, producer_execution_id, producer_agent_id, provenance_json, created_at)
    SELECT 'filler-' || i, mission_id, content_hash, content_json,
      version, producer_task_id, producer_execution_id, producer_agent_id, provenance_json, created_at FROM materials, numbers WHERE material_id='initial'`);
  context.dispatch('context_publish_material', { material_id: 'match', content: 'Matching keyword' }, producer());
  const input = { query: 'keyword' };
  const first = context.dispatch('context_search_materials', input, reader());
  assert.equal(first.scanned, 500);
  assert.deepEqual(first.materials, []);
  assert.ok(first.next_cursor);
  const later = context.dispatch('context_search_materials', { ...input, cursor: first.next_cursor }, reader());
  assert.deepEqual(later.materials.map(row => row.material_id), ['match']);
  assert.equal(later.next_cursor, null);
});
