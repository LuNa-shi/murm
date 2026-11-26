import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskService } from '../src/task/task-service.js';
import { startIndependentServices } from '../src/sdk/independent-services.js';
import { makeEnvelope } from '../src/protocol/envelope.js';

test('owned independent deployment stops checker descendants even after Judge is killed', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'peer-crash-cleanup-'));
  const tasks = new TaskService(join(root, 'task.sqlite'));
  const source = 'example : True := by trivial';
  await writeFile(join(root, 'input.lean'), source);
  const command = join(root, 'slow-checker');
  await writeFile(command, '#!/bin/sh\nsleep 20\n', { mode: 0o700 });
  const services = await startIndependentServices({ taskService: tasks, projectDir: root, logRoot: join(root, 'logs'),
    checkerTimeoutMs: 25000, leanCommand: command,
    fixtureManifest: { fixture_id: 'crash', putnambench_commit: 'a'.repeat(40), problem_file: 'input.lean',
      problem_file_hash: createHash('sha256').update(source).digest('hex'), project_root: root,
      lean_toolchain: 'leanprover/lean4:v4.33.1', mathlib_version: 'controlled',
      checker_ref: 'lean', checker_version: 'mvp-1', environment_ref: 'controlled' } });
  t.after(async () => { await services.close(); tasks.close(); await rm(root, { recursive: true, force: true }); });
  tasks.createMission({ mission_id: 'mission:one', goal: 'Investigate one question' }, makeEnvelope({ actorRef: 'operator:test' }));
  tasks.registerAgent({ agentId: 'agent:one', missionId: 'mission:one', coreId: 'core:one', selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
  tasks.recordAgentSandbox('agent:one', { provider: 'controlled', sandboxId: 'sandbox:one' });
  tasks.markAgentReady('agent:one');
  const task = tasks.createTask({ mission_id: 'mission:one', summary: 'Investigate a bounded question', gap: 'The Mission needs scoped evidence for this bounded question', priority: 'medium', expected_output: 'A Material with evidence', acceptance_conditions: ['Explain the finding'] }, makeEnvelope({ actorRef: 'agent:one' })).task;
  const taken = tasks.takeTask(task.task_id, { owner_ref: 'agent:one', core_id: 'core:one', take_key: 'take:one' });
  const env = id => {
    const e = tasks.getExecution(taken.execution.execution_id);
    return makeEnvelope({ operationId: id, actorRef: 'agent:one', taskId: task.task_id, executionId: e.execution_id,
      specVersion: e.spec_version, stateVersion: e.state_version, fencingVersion: e.fencing_version });
  };
  tasks.dispatch('start_execution', {}, env('start'));
  const checking = services.judge.dispatch('workspace_check', { request_key: 'check', source: {
    workspace_id: 'workspace', revision: '0.1', path: 'Main.lean', git_commit: 'c'.repeat(40), git_tree: 'd'.repeat(40), content: source,
  } }, env('check')).catch(error => error);
  for (let attempt = 0; services.judge.getMissionCheckBudget('mission:one').preflight_process_starts !== 1; attempt++) {
    assert.ok(attempt < 100); await delay(10);
  }
  const pid = services.evidence.judge_pid;
  const children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/).map(Number);
  assert.ok(children.some(child => child > 0));
  process.kill(pid, 'SIGKILL');
  await checking;
  await services.close();
  for (const child of children) {
    const stat = await readFile(`/proc/${child}/stat`, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    assert.ok(stat === null || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z '), 'checker descendant must no longer execute');
  }
});
