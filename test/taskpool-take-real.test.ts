import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntime } from '@murm/core';
import { createPiOpenSandboxBackend } from '@murm/core/backends/pi-opensandbox';
import { ServiceRegistry } from '@murm/core/services';
import { createTaskPoolTaskService, taskPoolResearcherProfile } from '../examples/taskpool/task-service.js';
import { createTaskPoolAgentCoordinator } from '../examples/taskpool/agent-coordinator.js';
import { createTaskPoolModelAccessPolicy } from '../examples/taskpool/model-access-policy.js';
import { executionEnvelope } from '../examples/taskpool/prepare-inputs.js';
import { createTaskPoolStores } from './fixtures/taskpool-task-stores.js';
import { createTaskPoolTakeUpstream } from './fixtures/taskpool-task-upstream.js';
import { createAcceptanceDeadline } from './fixtures/taskpool-model-acceptance.js';
import { cleanupRuntimes } from './fixtures/core-runtime-cleanup.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { sessionEvidence } from './fixtures/core-session-evidence.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('actual flat readonly discovery competes for one Task and continues the same native Bash through grant', {
  skip: process.env.MURM_TASKPOOL_TAKE_REAL_TEST !== '1' && 'Exact pin and bounded local harness require two independent reviews', timeout: 220_000,
}, async t => {
  const startedAt = Date.now(), deadlineAt = startedAt + 180_000;
  const outputDir = join(process.cwd(), 'experiments', `taskpool-take-${startedAt}`);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const stores = await createTaskPoolStores(outputDir);
  let runtime, service, upstream;
  const agents = [], resources = {}, waiters = new Set();
  const report = { failure: true, requestCap: 4, fixedInputs: 2, workloadLimitMs: 180_000, cleanupLimitMs: 30_000, resources };
  const deadline = createAcceptanceDeadline(deadlineAt, () => {
    for (const resolve of waiters) resolve({ outcome: 'timeout' });
    void runtime?.close({ timeoutMs: 1 }).catch(() => {});
  });
  t.after(async () => {
    try {
      const [flat, cleanup] = await Promise.all([service?.close({ timeoutMs: 25_000 }), cleanupRuntimes(runtime ? [runtime] : [], { resources, inspect: ownedContainers })]);
      report.flat = flat; report.cleanup = cleanup;
      const stopped = cleanup[0]?.agents ?? [];
      report.domainCleanup = [];
      for (const agent of agents) {
        const receipt = stopped.find(row => row.agentId === agent.id);
        stores.tasks.requestAgentStop(agent.id, 'fixed-acceptance-end', { terminalState: 'CANCELLED' });
        const owner = stores.tasks.getAgent(agent.id);
        if (receipt?.execution === 'stopped') {
          const execution = owner.execution_id && stores.tasks.getExecution(owner.execution_id);
          if (execution && ['CREATED', 'RUNNING'].includes(execution.state)) stores.tasks.dispatch('stop_execution', { terminal_state: 'CANCELLED', terminal_reason: 'fixed-acceptance-end' }, executionEnvelope(execution, `fixed-end:${agent.id}`));
          if (receipt.cleanup === 'complete') stores.tasks.finalizeAgentClose(agent.id);
        }
        report.domainCleanup.push({ agentId: agent.id, state: stores.tasks.getAgent(agent.id).state });
      }
      report.upstream = upstream?.receipt(); report.deadlineExpired = deadline.expired();
      report.failure ||= report.deadlineExpired || report.upstream?.failure !== undefined || report.upstream?.arrivals !== 4 || report.upstream?.accepted !== 4 ||
        !cleanup.length || cleanup.some(row => row.cleanup !== 'complete') || !resources[runtime?.id]?.empty ||
        report.domainCleanup.length !== 2 || report.domainCleanup.some(row => row.state !== 'CLOSED');
      await writeFile(join(outputDir, 'acceptance.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
      assert.equal(report.failure, false, 'Bounded acceptance and physical/domain cleanup must all succeed');
    } finally { deadline.stop(); await upstream?.close(); stores.close(); }
  });
  const image = process.env.MURM_CORE_TEST_IMAGE; assert.ok(image);
  report.image = image;
  upstream = await createTaskPoolTakeUpstream(stores.task.task_id, deadlineAt);
  const host = process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  service = createTaskPoolTaskService({ runtime: () => runtime, taskService: stores.tasks, missionId: stores.missionId,
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
  const policy = createTaskPoolModelAccessPolicy({ runtimeId: () => runtime?.id, taskService: stores.tasks, missionId: stores.missionId, deadline: () => deadlineAt });
  runtime = await createRuntime({ backend: createPiOpenSandboxBackend({ sandbox: {
    lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1', endpointHost: process.env.MURM_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1',
    apiKey: process.env.MURM_CORE_TEST_API_KEY, resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000 },
    bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` }, modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 30_000, maxOutputTokens: 2048 },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: upstream.url, headers: {} } } },
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } } }),
    profiles: { researcher: taskPoolResearcherProfile({ prompt: 'Execute the fixed discovery and take check.', model: 'default', image }) },
    services, maxAgents: 2, outputDir, modelAccessPolicy: policy });
  report.runtimeId = runtime.id;
  assert.deepEqual(await ownedContainers(runtime.id), []);
  const coordinator = createTaskPoolAgentCoordinator({ runtime, taskService: stores.tasks, missionId: stores.missionId });
  for (const name of ['A', 'B']) agents.push(await coordinator.spawn({ profile: 'researcher', requestId: `fixed-${name}`, legacySlotId: `slot:${name}`, writable: false,
    selectionDeadline: new Date(deadlineAt).toISOString(), hardDeadline: new Date(deadlineAt).toISOString() }));
  assert.equal((await ownedContainers(runtime.id)).length, 2);
  const settled = agents.map(agent => new Promise(resolve => {
    waiters.add(resolve);
    const unsubscribe = runtime.onEvent(event => { if (event.agentId === agent.id && event.type === 'settled') { unsubscribe(); waiters.delete(resolve); resolve(event); } });
    t.after(unsubscribe);
  }));
  await Promise.all(agents.map((agent, index) => runtime.send(agent.id, `TASKPOOL_T11_${index ? 'B' : 'A'}`, { requestId: `fixed-input-${index}`, mode: 'followUp' }).then(receipt => assert.equal(receipt.status, 'accepted'))));
  const outcomes = await Promise.all(settled);
  assert.ok(outcomes.every(row => row.outcome === 'completed'));
  const evidence = Object.values(upstream.receipt().evidence);
  assert.equal(evidence.length, 2); assert.equal(evidence.filter(row => row.role === 'winner').length, 1);
  // Pi may defer creating its JSONL until the first completed turn. Observe
  // native Session names only now; the Bash checks already covered continuity
  // of the same live process and workDir through prepare/start/grant.
  report.sessions = await Promise.all((await ownedContainers(runtime.id)).map(container => sessionEvidence(container, promisify(execFile))));
  assert.equal(report.sessions.length, 2);
  assert.equal(new Set(report.sessions.map(row => row.sessionId)).size, 2);
  const executions = stores.tasks.listExecutions(stores.task.task_id);
  assert.equal(executions.length, 1); assert.equal(executions[0].state, 'RUNNING');
  const owner = stores.tasks.getAgent(executions[0].owner_ref); assert.equal(owner.state, 'ACTIVE');
  report.task = { taskId: stores.task.task_id, state: stores.tasks.getTask(stores.task.task_id).state, specVersion: stores.task.spec_version };
  report.execution = { executionId: executions[0].execution_id, state: executions[0].state, fence: executions[0].fencing_version, workspaceRevision: executions[0].workspace_input.revision };
  report.outcomes = outcomes.map(row => ({ agentId: row.agentId, outcome: row.outcome }));
  report.failure = false;
});
