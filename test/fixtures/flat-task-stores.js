import { join } from 'node:path';
import { TaskService } from '../../src/task/task-service.js';
import { ContextService } from '../../src/context/context-service.js';
import { MissionWorkspace } from '../../src/runtime/mission-workspace.js';
import { WorkspaceManager } from '../../src/runtime/workspace-manager.js';
import { makeEnvelope } from '../../src/protocol/envelope.js';

export async function createFlatTaskStores(root) {
  const tasks = new TaskService();
  const context = new ContextService(':memory:', { taskService: tasks });
  const missionId = 'mission:flat-take';
  tasks.createMission({ mission_id: missionId, goal: 'Verify fixed flat handoff' }, makeEnvelope({ actorRef: 'host' }));
  const producer = tasks.createTask({ mission_id: missionId, gap: 'Provide fixed immutable input', priority: 'medium', summary: 'Fixture Material producer', expected_output: 'Fixed Material', acceptance_conditions: ['fixed content'] }, makeEnvelope({ actorRef: 'host' })).task;
  let produced = tasks.takeTask(producer.task_id, { owner_ref: 'producer', take_key: 'producer' }).execution;
  const envelope = () => makeEnvelope({ actorRef: 'producer', taskId: producer.task_id, executionId: produced.execution_id,
    specVersion: produced.spec_version, stateVersion: produced.state_version, fencingVersion: produced.fencing_version });
  produced = tasks.dispatch('start_execution', {}, envelope()).execution;
  const material = context.dispatch('context_publish_material', { material_id: 'fixed-material', content: { text: 'fixed material bytes' } }, envelope()).material;
  tasks.dispatch('stop_execution', { terminal_state: 'CANCELLED' }, envelope());
  const workspace = new MissionWorkspace({ rootDir: join(root, 'public') });
  const created = await workspace.create({ missionId, workspaceId: 'flat-fixed', initialFiles: { 'input.txt': 'fixed λ\n' } });
  const manager = new WorkspaceManager({ rootDir: join(root, 'private') });
  const task = tasks.createTask({ mission_id: missionId, gap: 'Verify exclusive controlled handoff', priority: 'medium', summary: 'Fixed handoff', expected_output: 'A fixed file', acceptance_conditions: ['fixed file verified'], input_material_refs: [material.material_id], workspace: { workspace_id: created.workspace_id, revision: '0.1' } }, makeEnvelope({ actorRef: 'host' })).task;
  return { tasks, context, workspace, manager, task, material, missionId, workspaceId: created.workspace_id,
    close() { context.close(); tasks.close(); } };
}
