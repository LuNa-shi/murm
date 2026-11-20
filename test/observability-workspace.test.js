import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ObservationStore } from '../src/observability/observation-store.js';
import { ObservabilityServer } from '../src/observability/observability-server.js';
import { TaskService } from '../src/task/task-service.js';
import { MissionWorkspace } from '../src/runtime/mission-workspace.js';
import { WorkspaceManager } from '../src/runtime/workspace-manager.js';
import { makeEnvelope } from '../src/protocol/envelope.js';

test('ObservabilityServer exposes the selected Execution Workspace files and revisions', async t => {
  const root = await mkdtemp('/tmp/swarmenv-observability-workspace-');
  const database = new DatabaseSync(join(root, 'state.sqlite'));
  const taskService = new TaskService(database);
  const mission = taskService.createMission({
    mission_id: 'mission:observability-workspace', goal: 'Inspect Workspace', acceptance_conditions: {}, created_by: 'owner:test',
  }, makeEnvelope({ operationId: 'mission:observability-workspace', actorRef: 'owner:test' })).mission;
  const task = taskService.createTask({
    mission_id: mission.mission_id, summary: 'Inspect the selected Workspace and record one bounded observation', goal: 'Inspect Workspace', expected_output: 'notes',
    acceptance_conditions: { workspace: 'test' }, owner_ref: 'owner:test', workspace: { project: 'test' },
  }, makeEnvelope({ operationId: 'task:observability-workspace', actorRef: 'owner:test' })).task;
  const taken = taskService.takeTask(task.task_id, { take_key: 'take-workspace', owner_ref: 'agent:test' }, makeEnvelope({ operationId: 'take-workspace', actorRef: 'agent:test', taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version }));
  const workspaceManager = new WorkspaceManager({ rootDir: join(root, 'workspaces') });
  const publicStore = new MissionWorkspace({ rootDir: join(root, 'public') });
  await publicStore.create({ missionId: mission.mission_id, workspaceId: 'workspace-observer', initialFiles: { 'notes.md': 'observable' } });
  await workspaceManager.createWorkspace({
    executionId: taken.execution.execution_id,
    fencingVersion: taken.execution.fencing_version,
    task,
    publicSnapshot: await publicStore.exportRevision({ workspaceId: 'workspace-observer' }),
  });
  const observations = new ObservationStore(database);
  observations.registerExperiment({ experimentId: 'run-workspace' });
  observations.append({ experimentId: 'run-workspace', source: 'runtime', kind: 'execution_assigned', coreId: 'core-1', taskId: task.task_id, executionId: taken.execution.execution_id, payload: {} });
  const password = 'test-observer-password';
  const server = new ObservabilityServer({ observationStore: observations, taskService, workspaceManager, operatorPassword: password });
  const { url } = await server.start();
  t.after(async () => { await server.stop(); taskService.close(); await rm(root, { recursive: true, force: true }); });
  const endpoint = `${url}/api/executions/${taken.execution.execution_id}/workspace?experiment_id=run-workspace`;
  const restore = workspaceManager.restoreWorkspace.bind(workspaceManager);
  let restores = 0;
  workspaceManager.restoreWorkspace = input => { restores += 1; return restore(input); };
  for (const authorization of ['', 'Bearer guest-token', `Basic ${Buffer.from('operator:incorrect').toString('base64')}`]) {
    const denied = await fetch(endpoint, { headers: { authorization } });
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('www-authenticate'), /^Basic /);
    assert.doesNotMatch(await denied.text(), /notes\.md|observable/);
  }
  assert.equal(restores, 0);
  assert.equal((await fetch(`${url}/api/experiments/run-workspace/events`)).status, 401);
  assert.equal((await fetch(`${url}/health`)).status, 200);
  const result = await fetch(endpoint, { headers: {
    authorization: `Basic ${Buffer.from(`operator:${password}`).toString('base64')}`,
  } }).then(response => response.json());
  assert.ok(restores > 0);
  assert.equal(result.workspace.workspace_revision, 1);
  assert.ok(result.files.some((file) => file.path === 'notes.md'));
  assert.equal(result.revisions.length, 1);
});
