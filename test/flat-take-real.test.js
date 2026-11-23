import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntime } from '@swarmenv/core';
import { createPiOpenSandboxBackend } from '@swarmenv/core/backends/pi-opensandbox';
import { ServiceRegistry } from '@swarmenv/core/services';
import { createFlatTaskService, flatResearcherProfile } from '../src/environments/flat/task-service.js';
import { createFlatBotCoordinator } from '../src/environments/flat/bot-coordinator.js';
import { createFlatModelAccessPolicy } from '../src/environments/flat/model-access-policy.js';
import { executionEnvelope } from '../src/environments/flat/prepare-inputs.js';
import { createFlatTaskStores } from './fixtures/flat-task-stores.js';
import { createFlatTakeUpstream } from './fixtures/flat-task-upstream.js';
import { createAcceptanceDeadline } from './fixtures/flat-model-acceptance.js';
import { cleanupRuntimes } from './fixtures/core-runtime-cleanup.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';

test('actual flat readonly discovery competes for one Task and continues the same native Bash through grant', {
  skip: process.env.SWARMENV_FLAT_TAKE_REAL_TEST !== '1' && 'Exact pin and bounded local harness require two independent reviews', timeout: 220_000,
}, async t => {
  const startedAt = Date.now(), deadlineAt = startedAt + 180_000;
  const outputDir = join(process.cwd(), 'experiments', `flat-take-${startedAt}`);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const stores = await createFlatTaskStores(outputDir);
  let runtime, service, upstream;
  const bots = [], resources = {}, waiters = new Set();
  const report = { failure: true, requestCap: 4, fixedInputs: 2, workloadLimitMs: 180_000, cleanupLimitMs: 30_000, resources };
  const deadline = createAcceptanceDeadline(deadlineAt, () => {
    for (const resolve of waiters) resolve({ outcome: 'timeout' });
    void runtime?.close({ timeoutMs: 1 }).catch(() => {});
  });
  t.after(async () => {
    try {
      const [flat, cleanup] = await Promise.all([service?.close({ timeoutMs: 25_000 }), cleanupRuntimes(runtime ? [runtime] : [], { resources, inspect: ownedContainers })]);
      report.flat = flat; report.cleanup = cleanup;
      const stopped = cleanup[0]?.bots ?? [];
      report.domainCleanup = [];
      for (const bot of bots) {
        const receipt = stopped.find(row => row.botId === bot.id);
        stores.tasks.requestBotStop(bot.id, 'fixed-acceptance-end', { terminalState: 'CANCELLED' });
        const owner = stores.tasks.getBot(bot.id);
        if (receipt?.execution === 'stopped') {
          const execution = owner.execution_id && stores.tasks.getExecution(owner.execution_id);
          if (execution && ['CREATED', 'RUNNING'].includes(execution.state)) stores.tasks.dispatch('stop_execution', { terminal_state: 'CANCELLED', terminal_reason: 'fixed-acceptance-end' }, executionEnvelope(execution, `fixed-end:${bot.id}`));
          if (receipt.cleanup === 'complete') stores.tasks.finalizeBotClose(bot.id);
        }
        report.domainCleanup.push({ botId: bot.id, state: stores.tasks.getBot(bot.id).state });
      }
      report.upstream = upstream?.receipt(); report.deadlineExpired = deadline.expired();
      report.failure ||= report.deadlineExpired || report.upstream?.failure !== undefined || report.upstream?.arrivals !== 4 ||
        !cleanup.length || cleanup.some(row => row.cleanup !== 'complete') || !resources[runtime?.id]?.empty ||
        report.domainCleanup.length !== 2 || report.domainCleanup.some(row => row.state !== 'CLOSED');
      await writeFile(join(outputDir, 'acceptance.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
      assert.equal(report.failure, false, 'Bounded acceptance and physical/domain cleanup must all succeed');
    } finally { deadline.stop(); await upstream?.close(); stores.close(); }
  });
  const image = process.env.SWARMENV_CORE_TEST_IMAGE; assert.ok(image);
  report.image = image;
  upstream = await createFlatTakeUpstream(stores.task.task_id, deadlineAt);
  const host = process.env.SWARMENV_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  service = createFlatTaskService({ runtime: () => runtime, taskService: stores.tasks, missionId: stores.missionId,
    missionWorkspace: stores.workspace, workspaceId: stores.workspaceId, workspaceManager: stores.manager, contextService: stores.context,
    missionDeadline: () => deadlineAt, executionTimeoutMs: 120_000 });
  // Both real Bash processes reach take before either transactional reservation.
  const barrier = Promise.withResolvers(); let takeCalls = 0;
  const services = new ServiceRegistry();
  services.registerService({ manifest: service.manifest, adapter: { async invoke(request) {
    if (request.capability.operation === 'task_take') {
      assert.ok(++takeCalls <= 2);
      if (takeCalls === 2) barrier.resolve();
      let timer;
      try { await Promise.race([barrier.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixed take barrier expired')), 10_000); })]); }
      finally { clearTimeout(timer); }
    }
    return service.adapter.invoke(request);
  } } });
  const policy = createFlatModelAccessPolicy({ runtimeId: () => runtime?.id, taskService: stores.tasks, missionId: stores.missionId, deadline: () => deadlineAt });
  runtime = await createRuntime({ backend: createPiOpenSandboxBackend({ sandbox: {
    lifecycleBaseUrl: process.env.SWARMENV_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1', endpointHost: process.env.SWARMENV_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1',
    apiKey: process.env.SWARMENV_CORE_TEST_API_KEY, resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000 },
    bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` }, modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 30_000, maxOutputTokens: 2048 },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: upstream.url, headers: {} } } },
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } } }),
    profiles: { researcher: flatResearcherProfile({ prompt: 'Execute the fixed discovery and take check.', model: 'default', image }) },
    services, maxBots: 2, outputDir, modelAccessPolicy: policy });
  report.runtimeId = runtime.id;
  assert.deepEqual(await ownedContainers(runtime.id), []);
  const coordinator = createFlatBotCoordinator({ runtime, taskService: stores.tasks, missionId: stores.missionId });
  for (const name of ['A', 'B']) bots.push(await coordinator.spawn({ profile: 'researcher', requestId: `fixed-${name}`, legacySlotId: `slot:${name}`, writable: false,
    selectionDeadline: new Date(deadlineAt).toISOString(), hardDeadline: new Date(deadlineAt).toISOString() }));
  assert.equal((await ownedContainers(runtime.id)).length, 2);
  const settled = bots.map(bot => new Promise(resolve => {
    waiters.add(resolve);
    const unsubscribe = runtime.onEvent(event => { if (event.botId === bot.id && event.type === 'settled') { unsubscribe(); waiters.delete(resolve); resolve(event); } });
    t.after(unsubscribe);
  }));
  await Promise.all(bots.map((bot, index) => runtime.send(bot.id, `FLAT_T11_${index ? 'B' : 'A'}`, { requestId: `fixed-input-${index}`, mode: 'followUp' }).then(receipt => assert.equal(receipt.status, 'accepted'))));
  const outcomes = await Promise.all(settled);
  assert.ok(outcomes.every(row => row.outcome === 'completed'));
  const evidence = Object.values(upstream.receipt().evidence);
  assert.equal(evidence.length, 2); assert.equal(evidence.filter(row => row.role === 'winner').length, 1);
  assert.equal(new Set(evidence.map(row => row.session_digest)).size, 2);
  const executions = stores.tasks.listExecutions(stores.task.task_id);
  assert.equal(executions.length, 1); assert.equal(executions[0].state, 'RUNNING');
  const owner = stores.tasks.getBot(executions[0].owner_ref); assert.equal(owner.state, 'ACTIVE');
  report.task = { taskId: stores.task.task_id, state: stores.tasks.getTask(stores.task.task_id).state, specVersion: stores.task.spec_version };
  report.execution = { executionId: executions[0].execution_id, state: executions[0].state, fence: executions[0].fencing_version, workspaceRevision: executions[0].workspace_input.revision };
  report.outcomes = outcomes.map(row => ({ botId: row.botId, outcome: row.outcome }));
  report.failure = false;
});
