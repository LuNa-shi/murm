import { join } from 'node:path';
import { setInterval } from 'node:timers/promises';
import { ContextService } from '../../dist/src/context/context-service.js';
import { runFlatEnvironment } from '../../dist/src/environments/flat/environment.js';
import { makeEnvelope } from '../../dist/src/protocol/envelope.js';
import { MissionWorkspace } from '../../dist/src/runtime/mission-workspace.js';
import { WorkspaceManager } from '../../dist/src/runtime/workspace-manager.js';
import { TaskService } from '../../dist/src/task/task-service.js';
import { checkpointSource } from './source-checkpoint.mjs';
import { sha256 } from './local-integration.mjs';

const instructions = `Use swarm task list --state ready to find ready work and swarm task take to claim it. Read the complete Task before writing.
Publish source as Material attachments with relative names and base64 content. Use swarm material publish --help and --stdin.
When integrating, read both earlier Materials and their attachments, use their components in the candidate, and record swarm material consume with action integration and the actual impact. Include the Material IDs in used_material_ids on your new Material.
Publish the complete candidate tree as attachments, including compile.sh, before closing your Task. Close with swarm task finish and the actual Material IDs and outcome.`;

function attachments(context, materialId) {
  if (!context.getMaterial(materialId, { verifyIntegrity: true })) throw new Error('Material is unavailable');
  const stored = context.db.prepare('SELECT name, bytes, content_hash FROM material_attachments WHERE material_id = ? ORDER BY name')
    .all(materialId);
  return Object.fromEntries(stored.map(({ name, bytes, content_hash }) => {
    const contents = Buffer.from(bytes);
    if (sha256(contents) !== content_hash) throw new Error('Material attachment digest mismatch');
    return [name, contents];
  }));
}

function adoptedMaterials(context, candidate, files, producerTaskIds) {
  const adoption = [];
  for (const item of candidate.provenance.used_materials) {
    const source = context.getMaterial(item.material_id, { verifyIntegrity: true });
    if (!source?.producer_bot_id || source.producer_bot_id === candidate.producer_bot_id ||
        !producerTaskIds.includes(source.producer_task_id) || source.content_hash !== item.content_hash) continue;
    const used = context.listMaterialConsumptions({ material_id: source.material_id,
      reader_execution: candidate.producer_execution_id, action: 'integration' })
      .find(row => row.content_hash === source.content_hash);
    if (!used) continue;
    for (const [name, bytes] of Object.entries(attachments(context, source.material_id))) {
      if (files[name]?.equals(bytes)) adoption.push({ botId: source.producer_bot_id, materialId: source.material_id,
        contentHash: source.content_hash, executionId: source.producer_execution_id, file: name, sha256: sha256(bytes),
        consumedBy: candidate.producer_bot_id, consumerExecutionId: candidate.producer_execution_id });
    }
  }
  return adoption;
}

export async function runOpenFlat({ state, task, outputDir, backend, image, window, start, deadline, durationMs, capacity }) {
  const table = new TaskService(join(outputDir, 'tasks.sqlite'));
  const context = new ContextService(join(outputDir, 'context.sqlite'), { taskService: table });
  const workspace = new MissionWorkspace({ rootDir: join(outputDir, 'public') });
  const manager = new WorkspaceManager({ rootDir: join(outputDir, 'private') });
  const missionId = 'mission:pastel-open', workspaceId = 'pastel-open';
  const operator = () => makeEnvelope({ actorRef: 'host' });
  state.stage = 'flat-startup';
  try {
    table.createMission({ mission_id: missionId, goal: task }, operator());
    await workspace.create({ missionId, workspaceId, initialFiles: { 'task.txt': task } });
    function createTask(summary, gap, depends_on = []) {
      return table.createTask({ mission_id: missionId, priority: 'medium', summary, gap, depends_on,
        expected_output: 'Material with source attachments',
        acceptance_conditions: ['Attach the produced source and record checks against the Pastel reference.'],
        workspace: { workspace_id: workspaceId, revision: '0.1' } }, operator()).task.task_id;
    }
    const parser = createTask('Implement Pastel color parsing',
      'Probe reference color input and publish a reusable named-color or hex parser with source attachments, interface and observations. Publish an early useful increment. If no language has been agreed, use Python 3 standard library.');
    const formatter = createTask('Implement Pastel output formatting',
      'Probe reference format output and publish an independent formatting or conversion component with source attachments, interface and observations. Publish an early useful increment. If no language has been agreed, use Python 3 standard library.');
    const producers = [parser, formatter];
    const integrator = createTask('Integrate and submit a Pastel candidate',
      'Read and integrate the two source Materials, implement a CLI with offline compile.sh, and publish an early runnable full source tree as Material attachments before extending behavior.', producers);
    state.taskIds = { parser, formatter, integrator };
    const observed = new Set();
    const capture = async () => {
      const materials = context.readMaterials({ mission_id: missionId }).filter(row => row.producer_task_id === integrator);
      for (const material of materials) {
        if (!window.remainingMs()) break;
        if (observed.has(material.material_id)) continue;
        const files = attachments(context, material.material_id);
        if (!Object.hasOwn(files, 'compile.sh')) continue;
        const adopted = adoptedMaterials(context, material, files, producers);
        const checkpoint = await checkpointSource({ window, outputDir, files,
          sourceRevision: `material:${material.material_id}:${material.content_hash}` });
        observed.add(material.material_id);
        state.evidence.push({ candidateSha256: checkpoint.sha256, by: material.producer_bot_id,
          executionId: material.producer_execution_id, materialId: material.material_id, adopted });
      }
    };
    let started = false;
    const result = await runFlatEnvironment({ backend, model: 'default', image, outputDir,
      taskService: table, contextService: context, missionWorkspace: workspace, workspaceManager: manager,
      missionId, workspaceId, capacity, signal: window.signal, deadlineAt: Date.now() + durationMs + 120_000,
      handoff: { executionTimeoutMs: durationMs },
      controller: { discoveryPrompt: `${task}\n\n${instructions}`, refillWhenNoReadyTask: false,
        selectionMs: durationMs, hardBudgetMs: durationMs + 60_000, stallMs: durationMs,
        heartbeatMs: 1_000, beforeInitialDispatch({ runtime, signal }) {
          signal.throwIfAborted();
          state.runtimeId = runtime.id;
          if (!started) { start(); started = true; state.stage = 'flat-work'; }
        } },
      async drive(controller) {
        const complete = new AbortController();
        const finished = controller.wait().finally(() => complete.abort());
        try {
          const signal = AbortSignal.any([window.signal, complete.signal]);
          for await (const _ of setInterval(400, undefined, { signal })) await capture();
        } catch (error) {
          if (error.name !== 'AbortError' && !window.signal.aborted) throw error;
        }
        const final = await finished;
        await capture();
        if (final.completion === 'all-tasks-terminal') await deadline;
      },
    });
    state.runtimeId ??= result.runtimeId;
    state.cleanup = result.cleanup?.cleanup;
    state.completion = result.result?.completion;
    state.taskStates = Object.fromEntries(Object.entries(state.taskIds).map(([key, id]) => [key, table.getTask(id).state]));
    if (result.cleanupFailure || result.reportSaveFailure) throw new Error('Flat closeout failed');
    if (result.businessFailure && !window.signal.aborted) throw new Error('Flat run failed');
  } finally {
    context.close();
    table.close();
  }
}
