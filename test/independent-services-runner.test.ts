import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskService } from '../examples/taskpool/services/task/task-service.js';
import { ServiceCommitGate } from '../examples/taskpool/deploy/service-hosts/service-commit-gate.js';
import { startIndependentServices } from '../examples/taskpool/deploy/service-hosts/independent-services.js';
import { makeEnvelope } from '../examples/taskpool/persistence/envelope.js';

test('independent Judge rejects an overflowing composed HTTP deadline before peer startup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'judge-http-deadline-'));
  const tasks = new TaskService();
  let services;
  t.after(async () => { await services?.close(); tasks.close(); await rm(root, { recursive: true, force: true }); });
  const logRoot = join(root, 'logs');
  await assert.rejects(async () => {
    services = await startIndependentServices({ taskService: tasks, projectDir: root, logRoot,
      fixtureManifest: { fixture_id: 'overflow', putnambench_commit: 'a'.repeat(40), problem_file: 'input.lean',
        problem_file_hash: 'b'.repeat(64), lean_toolchain: 'controlled', mathlib_version: 'controlled',
        checker_ref: 'controlled', checker_version: '1', environment_ref: 'controlled' },
      checkerTimeoutMs: 600_000, missionBudget: { queueWaitMs: 2_147_483_647 } });
  }, /Judge HTTP deadline must fit the timer range/);
  await assert.rejects(access(logRoot), { code: 'ENOENT' });
});

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
