import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('Flat recovers exact binary workDir bytes through Core after a lost snapshot response', { timeout: 15000 }, async t => {
  const { createLifecycleProvider } = await import('./fixtures/core-lifecycle-provider.js');
  const { decodeFileSeed } = await import('../scripts/core-file-seed.js');
  const seed = { 'lemma.lean': { encoding: 'utf8', data: '-- actual guest λ\n' }, 'sample.bin': { encoding: 'base64', data: 'AP+A' } };
  let snapshotRequests = 0;
  let receipt;
  const provider = await createLifecycleProvider(t, { async fileOperation(action, input) {
    assert.equal(action, 'snapshot');
    snapshotRequests++;
    receipt ??= { requestId: input.requestId, version: 91, digest: decodeFileSeed(seed).digest, files: structuredClone(seed) };
    if (snapshotRequests === 1) return { disconnect: true };
    assert.equal(input.requestId, receipt.requestId);
    return { body: { result: receipt } };
  }, allowHostGit: true });
  const { createRuntime } = await import('../src/core/index.js');
  const { createPiOpenSandboxBackend } = await import('../src/core/backends/pi-opensandbox.js');
  const { ServiceRegistry, snapshotServiceRegistry, invokeService } = await import('../src/core/services.js');
  const { createFlatTaskStores } = await import('./fixtures/flat-task-stores.js');
  const { prepareTaskPoolInputs } = await import('../src/harnesses/taskpool/prepare-inputs.js');
  const { createTaskPoolPublicationServices } = await import('../src/harnesses/taskpool/publication-services.js');
  const { makeEnvelope } = await import('../src/protocol/envelope.js');
  provider.allowDeletion();
  const outputDir = await mkdtemp(join(tmpdir(), 'flat-core-capture-'));
  const runtime = await createRuntime({ backend: createPiOpenSandboxBackend({
    sandbox: { lifecycleBaseUrl: provider.url },
    bridge: { host: '127.0.0.1', publicUrl: 'http://192.0.2.1:{port}' },
    modelGateway: { host: '127.0.0.1', advertiseHost: '192.0.2.1' },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } },
    isolation: { network: 'local-docker', disk: { bytes: 32 * 1024 ** 2, inodes: 2048 } },
  }), profiles: { researcher: { image: 'fixture-image', model: 'default', prompt: 'fixture', writable: false, services: {} } },
  services: new ServiceRegistry(), maxBots: 1, outputDir });
  try {
    const bot = await runtime.spawn({ profile: 'researcher', requestId: 'guest', writable: true });
    const stores = await createFlatTaskStores(outputDir);
    t.after(() => stores.close());
    stores.tasks.contextService = stores.context;
    stores.tasks.registerBot({ botId: bot.id, missionId: stores.missionId, legacySlotId: 'slot:A', selectionDeadline: new Date(Date.now() + 60000).toISOString() });
    stores.tasks.markCoreBotReady(bot.id);
    let execution = stores.tasks.takeTask(stores.task.task_id, { owner_ref: bot.id, core_id: 'slot:A', take_key: 'take' }).execution;
    await prepareTaskPoolInputs({ execution, taskService: stores.tasks, missionWorkspace: stores.workspace, workspaceId: stores.workspaceId, workspaceManager: stores.manager, contextService: stores.context, check() {} });
    execution = stores.tasks.getExecution(execution.execution_id);
    stores.tasks.dispatch('start_execution', { core_id: 'slot:A' }, makeEnvelope({ actorRef: bot.id, taskId: execution.task_id, executionId: execution.execution_id, specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version }));
    const publication = createTaskPoolPublicationServices({ runtime, taskService: stores.tasks, contextService: stores.context, missionWorkspace: stores.workspace, missionId: stores.missionId, workspaceId: stores.workspaceId, workspaceCapture: 'core', deadline: () => Date.now() + 60000 });
    const registry = new ServiceRegistry();
    for (const service of publication.registrations) registry.registerService(service);
    const services = snapshotServiceRegistry(registry);
    const f = { ...stores, call: (service, operation, input, requestId) => invokeService(services.get(service), { operation, input, envelope: { operation_id: requestId }, caller: { runtimeId: runtime.id, botId: bot.id, profile: 'researcher' } }) };
    await assert.rejects(f.call('workspace', 'workspace_save', {}, 'guest-save'), { code: 'WORKSPACE_RESULT_UNKNOWN' });
    seed['lemma.lean'].data = '-- later edit';
    const saved = await f.call('workspace', 'workspace_save', {}, 'guest-save');
    const exported = await f.workspace.exportRevision({ workspaceId: f.workspaceId, revision: saved.revision });
    assert.deepEqual(Buffer.from(exported.files['sample.bin']), Buffer.from([0, 255, 128]));
    assert.equal(Buffer.from(exported.files['lemma.lean']).toString(), '-- actual guest λ\n');
    assert.deepEqual(await f.call('workspace', 'workspace_save', {}, 'guest-save'), saved);
    assert.equal(snapshotRequests, 2);
    assert.equal((await runtime.get(bot.id)).status, 'idle');
  } finally {
    assert.equal((await runtime.close()).cleanup, 'complete');
    await rm(outputDir, { recursive: true, force: true });
  }
});
