import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ObservationStore } from '../src/observability/observation-store.js';
import { ObservabilityServer } from '../src/observability/observability-server.js';
import { TaskService } from '../src/task/task-service.js';
import { WorkspaceManager } from '../src/runtime/workspace-manager.js';
import { makeEnvelope } from '../src/protocol/envelope.js';

test('ObservabilityServer exposes the selected Execution Workspace files and revisions', async () => {
  const root = await mkdtemp('/tmp/swarmenv-observability-workspace-');
  const database = new DatabaseSync(join(root, 'state.sqlite'));
  const taskService = new TaskService(database);
  const mission = taskService.createMission({
    mission_id: 'mission:observability-workspace', goal: 'Inspect Workspace', acceptance_conditions: {}, created_by: 'owner:test',
  }, makeEnvelope({ operationId: 'mission:observability-workspace', actorRef: 'owner:test' })).mission;
  const task = taskService.createTask({
    mission_id: mission.mission_id, summary: 'Inspect the selected Workspace and record one bounded observation', task_type: 'research', goal: 'Inspect Workspace', expected_output: 'notes',
    acceptance_conditions: { workspace: 'test' }, owner_ref: 'owner:test', workspace: { project: 'test' },
  }, makeEnvelope({ operationId: 'task:observability-workspace', actorRef: 'owner:test' })).task;
  const taken = taskService.taskTake(task.task_id, { request_key: 'take-workspace', owner_ref: 'agent:test', workspace_mode: 'clean' }, makeEnvelope({ operationId: 'take-workspace', actorRef: 'agent:test', taskId: task.task_id, specVersion: task.spec_version, stateVersion: task.state_version }));
  const workspaceManager = new WorkspaceManager({ rootDir: join(root, 'workspaces') });
  const workspace = await workspaceManager.createWorkspace({
    executionId: taken.execution.execution_id,
    fencingVersion: taken.execution.fencing_version,
    task,
    workspaceManifest: {},
    inputSnapshotManifest: {},
  });
  await workspaceManager.saveWorkspaceRevision({
    workspaceRef: workspace.workspace_ref,
    executionId: taken.execution.execution_id,
    fencingVersion: taken.execution.fencing_version,
    files: { 'notes.md': 'observable' },
  });
  const observations = new ObservationStore(database);
  observations.registerExperiment({ experimentId: 'run-workspace', rootTaskId: task.task_id });
  observations.append({ experimentId: 'run-workspace', source: 'runtime', kind: 'execution_assigned', coreId: 'core-1', taskId: task.task_id, executionId: taken.execution.execution_id, payload: {} });
  const server = new ObservabilityServer({ observationStore: observations, taskService, workspaceManager });
  const { url } = await server.start();
  const result = await fetch(`${url}/api/executions/${taken.execution.execution_id}/workspace?experiment_id=run-workspace`).then((response) => response.json());
  assert.equal(result.workspace.workspace_revision, 2);
  assert.ok(result.files.some((file) => file.path === 'notes.md'));
  assert.equal(result.revisions.length, 2);
  await server.stop();
  taskService.close();
  await rm(root, { recursive: true, force: true });
});
