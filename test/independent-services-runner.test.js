import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runBenchmarkProject } from '../src/benchmark/putnam-runner.js';

test('benchmark composes independent stores and HTTP peers and cleans their processes without a model call', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'independent-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = createServer((request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ items: [] })); });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
  const problem = { id: 'independent_services_fixture', problem_file: 'input.lean', source: 'example : True := by trivial', source_hash: 'a'.repeat(64) };
  const config = { lean_project_root: root, putnam_bench_root: root, putnambench_commit: 'b'.repeat(40), lean_toolchain: 'controlled',
    mathlib_version: 'controlled', checker_ref: 'controlled', checker_version: '1', environment_ref: 'controlled' };
  const report = await runBenchmarkProject(problem, config, { experimentDir: root, reportDir: join(root, 'reports'),
    timeboxMs: 0, botMaxMs: 60_000, serviceDeployment: 'independent',
    sandbox: { enabled: true, provider: 'opensandbox', lifecycleBaseUrl: `http://127.0.0.1:${provider.address().port}`, image: 'controlled:test' },
    prepareProject: ({ taskService, contextService }) => {
      assert.equal(contextService.taskService, taskService);
      assert.equal(contextService.readMaterials({}).length, 0);
    },
  });
  assert.equal(report.project.service_deployment.deployment, 'independent');
  assert.equal(report.run.solved, false);
  assert.equal(report.project.task_count, 0);
  for (const name of ['context_pid', 'judge_pid']) {
    const pid = report.project.service_deployment[name];
    assert.notEqual(pid, process.pid);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
});

import { TaskService } from '../src/task/task-service.js';
import { ServiceCommitGate } from '../src/sdk/service-commit-gate.js';
import { startIndependentServices } from '../src/sdk/independent-services.js';
import { makeEnvelope } from '../src/protocol/envelope.js';

test('startup routes an interrupted Judge gate to the new locked Judge generation', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'independent-recovery-'));
  const tasks = new TaskService(join(root, 'task.sqlite'));
  t.after(async () => { tasks.close(); await rm(root, { recursive: true, force: true }); });
  new ServiceCommitGate(tasks).acquire({ service: 'judge', generation: 'terminated-instance', call_id: 'old-call', phase: 'source' });
  const services = await startIndependentServices({ taskService: tasks, projectDir: root, logRoot: join(root, 'logs'),
    fixtureManifest: { fixture_id: 'recovery', putnambench_commit: 'a'.repeat(40), problem_file: 'input.lean',
      problem_file_hash: 'b'.repeat(64), lean_toolchain: 'controlled', mathlib_version: 'controlled',
      checker_ref: 'controlled', checker_version: '1', environment_ref: 'controlled' }, checkerTimeoutMs: 1000 });
  try {
    const created = tasks.createMission({ mission_id: 'recovered', goal: 'Continue after proven peer termination' }, makeEnvelope({ actorRef: 'operator:test' }));
    assert.equal(created.mission.mission_id, 'recovered');
  } finally { await services.close(); }
});
