import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { ServicesBridge } from '../test-support/taskpool-legacy/services-bridge.js';
import { createBuiltinServiceRegistry } from '../examples/taskpool/services/builtin-registry.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskService } from '../examples/taskpool/services/task/task-service.js';
import { RemoteContextService } from '../examples/taskpool/deploy/service-hosts/remote-context-service.js';
import { makeEnvelope } from '../examples/taskpool/persistence/envelope.js';

async function startPeer(database) {
  const token = 'coordinator-test-credential-private';
  const child = spawn(process.execPath, ['dist/examples/taskpool/deploy/service-hosts/start-context-service-peer.js'], {
    env: { ...process.env, MURM_SERVICE_DATABASE: database, MURM_COORDINATOR_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('peer startup timeout: ' + stderr)); }, 5000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`peer exited ${code}: ${stderr}`)); });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.split('\n')[0])); }
    });
  });
  return { ...endpoint, token, async stop() { const exited = once(child, 'exit'); child.kill(); await exited; } };
}

test('independent Context preserves a pending Judge gate on reconciliation', t => {
  const tasks = new TaskService(':memory:');
  t.after(() => tasks.close());
  const context = new RemoteContextService({ taskService: tasks, url: 'http://127.0.0.1', token: 'test' });
  const pending = context.gate.acquire({ service: 'judge' });
  assert.throws(() => context.reconcile(), { code: 'SERVICE_NOT_READY' });
  assert.equal(context.gate.pending().gate_id, pending.gate_id);
});

for (const loseResponse of [false, true]) test(`independent Context preserves receipts and scope (lost response: ${loseResponse})`, { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'remote-context-'));
  const tasks = new TaskService(join(root, 'task.sqlite'));
  let peer = await startPeer(join(root, 'context.sqlite'));
  t.after(async () => { await peer.stop(); tasks.close(); await rm(root, { recursive: true, force: true }); });
  let proxy;
  let proxyUrl;
  if (loseResponse) {
    proxy = spawn(process.execPath, ['dist/test-support/drop-peer-response.js'], { env: { ...process.env, PEER_UPSTREAM: peer.url }, stdio: ['ignore', 'pipe', 'inherit'] });
    proxyUrl = await new Promise(resolve => proxy.stdout.once('data', chunk => resolve(JSON.parse(chunk.toString()).url)));
    t.after(async () => { const done = once(proxy, 'exit'); proxy.kill(); await done; });
  }
  const events = [];
  tasks.subscribeTaskEvents(event => { if (event.kind === 'material_published') events.push(event); });
  const connect = () => new RemoteContextService({ taskService: tasks, url: proxyUrl ?? peer.url, token: peer.token });
  let context = connect();
  tasks.contextService = context;
  tasks.createMission({ mission_id: 'mission:one', goal: 'Investigate one question' }, makeEnvelope({ actorRef: 'operator:test' }));
  tasks.registerAgent({ agentId: 'agent:one', missionId: 'mission:one', coreId: 'core:one', selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
  const registry = createBuiltinServiceRegistry({ taskService: tasks, contextService: context });
  const bridge = new ServicesBridge({ taskService: tasks, contextService: context, runtime: {}, coreId: 'core:one', registry });
  await bridge.start();
  const credentials = bridge.startAgentIdentity('agent:one');
  t.after(() => bridge.stop());
  tasks.recordAgentSandbox('agent:one', { provider: 'controlled', sandboxId: 'sandbox:one' });
  tasks.markAgentReady('agent:one');
  const task = tasks.createTask({ mission_id: 'mission:one', summary: 'Investigate a bounded question', gap: 'The Mission needs scoped evidence for this bounded question', priority: 'medium', expected_output: 'A Material with evidence', acceptance_conditions: ['Explain the finding'] }, makeEnvelope({ actorRef: 'agent:one' })).task;
  const taken = tasks.takeTask(task.task_id, { owner_ref: 'agent:one', core_id: 'core:one', take_key: 'take:one' });
  const env = id => {
    const e = tasks.getExecution(taken.execution.execution_id);
    return makeEnvelope({ operationId: id, actorRef: 'agent:one', taskId: task.task_id, executionId: e.execution_id,
      specVersion: e.spec_version, stateVersion: e.state_version, fencingVersion: e.fencing_version });
  };
  // Real public save admission can retain large initial Material manifests.
  // Context authority must not serialize those unrelated Workspace bytes.
  tasks.dispatch('save_workspace_revision', { workspace_ref: '/controlled/initial', workspace_revision: 1,
    workspace_content_hash: 'controlled-content', workspace_input: { workspace_id: 'workspace:one', mission_id: 'mission:one',
      revision: '0.1', git_commit: 'controlled-commit', content_hash: 'controlled-content',
      material_inputs: [{ material_id: 'material:historical', content_hash: 'x'.repeat(1_100_000) }] } }, env('initial-workspace'));
  tasks.dispatch('start_execution', {}, env('start'));
  const input = { content: 'A verified public observation' };
  if (loseResponse) {
    assert.throws(() => context.dispatch('context_publish_material', input, env('publish')), { code: 'SERVICE_UNAVAILABLE' });
    assert.throws(() => tasks.dispatch('task_finish', { outcome: 'incomplete' }, env('premature-finish')), { code: 'SERVICE_NOT_READY' });
    context.reconcile();
  }
  const material = context.dispatch('context_publish_material', input, env('publish'));
  assert.equal(material.material.mission_id, 'mission:one');
  assert.equal(context.dispatch('context_get_material', { material_id: material.material.material_id }, env('read')).material.content, input.content);

  try {
    await bridge.bindTake(taken);
    const result = await promisify(execFile)(process.execPath, ['dist/scripts/swarm.js', 'material', 'view', material.material.material_id, '--json'],
      { env: { ...process.env, ...credentials }, timeout: 5000 });
    assert.equal(JSON.parse(result.stdout).material.content, input.content);
    const denied = await fetch(`${credentials.MURM_BRIDGE_URL}/call`, { method: 'POST',
      headers: { authorization: 'Bearer invalid', 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'context_get_material', payload: { material_id: material.material.material_id } }) });
    assert.equal(denied.status, 401);
  } finally { await bridge.stop(); }

  tasks.dispatch('task_link_material', { material_id: material.material.material_id, role: 'experience' }, env('link'));
  assert.equal(tasks.getTask(task.task_id).task_id, task.task_id);
  proxyUrl = null;
  await peer.stop();
  peer = await startPeer(join(root, 'context.sqlite'));
  context = connect(); tasks.contextService = context;
  tasks.dispatch('task_finish', { outcome: 'incomplete' }, env('finish'));
  assert.deepEqual(context.dispatch('context_publish_material', input, env('publish')), material);
  assert.throws(() => context.dispatch('context_publish_material', input, env('late')), { code: 'NOT_ALLOWED' });
  assert.equal(context.readMaterials({}).length, 1);
  assert.equal(events.length, 1);
});
