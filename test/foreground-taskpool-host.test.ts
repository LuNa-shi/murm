import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { transport, controls } from './fixtures/taskpool-controller-backend.js';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './sandbox/opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return { url: new URL('./fixtures/taskpool-controller-backend.js', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
const { createTaskPoolStores } = await import('./fixtures/taskpool-task-stores.js');
const { runForegroundHarness } = await import('../src/cli/foreground-harnesses.js'); hooks.deregister();

test('flat foreground input uses the current controller Task binding and stops with domain reconciliation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'foreground-taskpool-'));
  const stores = await createTaskPoolStores(root);
  t.after(async () => { stores.close(); await rm(root, { recursive: true, force: true }); });
  transport.reset(); controls.credentials.clear(); controls.stopError = null; controls.destroyError = null;
  transport.next = function accept(id) { transport.confirm(id, 'started'); transport.next = accept; };
  let snapshot;
  const report = await runForegroundHarness({ mode: 'taskpool', timeoutMs: 10_000, options: {
    ...stores, taskService: stores.tasks, contextService: stores.context, missionWorkspace: stores.workspace,
    workspaceManager: stores.manager, outputDir: root, sandbox: {}, model: 'default', image: 'fixture', capacity: 1,
    deadlineAt: Date.now() + 10_000, closeTimeoutMs: 1000,
    // Trusted fixture only. Production live Workspace capture remains unavailable.
    snapshotProject: async () => { throw new Error('No capture is needed for this feedback check'); },
  } }, async host => {
    const initial = await host.status();
    const agent = initial.agents[0];
    assert.equal(agent.status, 'running');
    assert.equal(initial.runDirectory, join(root, initial.runtimeId));
    const credentials = controls.credentials.get(agent.agentId);
    const env = { ...process.env, ...credentials.environment, ...credentials.secretEnvironment };
    const bridge = new URL(env.MURM_BRIDGE_URL); bridge.hostname = '127.0.0.1'; env.MURM_BRIDGE_URL = bridge.origin;
    await promisify(execFile)(process.execPath, ['dist/scripts/swarm.js', 'task', 'take', stores.task.task_id, '--request-id', 'host-take'], { env, timeout: 5000 });
    const input = { taskId: stores.task.task_id, input: 'fixed host direction', requestId: 'host-direction', mode: 'steer' };
    const accepted = await host.input(input);
    assert.equal(accepted.status, 'accepted'); assert.equal(accepted.requestId, 'host-direction');
    assert.deepEqual(await host.input(input), accepted);
    await assert.rejects(host.input({ ...input, input: 'changed' }), { code: 'CONFLICT' });
    snapshot = await host.status(); assert.equal(snapshot.inputs.filter(row => row.requestId === 'host-direction').length, 1);
    assert.ok(!JSON.stringify(snapshot).includes('fixed host direction'));
    host.stop();
  });
  assert.equal(report.cleanup.cleanup, 'complete');
  assert.ok(report.cleanup.agents.every(agent => agent.execution === 'stopped'));
  assert.equal(report.businessFailure.code, 'TASKPOOL_BUSINESS_FAILED');
  assert.equal(stores.tasks.getTask(stores.task.task_id).state, 'OPEN');
});
