import {
  createSandbox, type CreateRuntimeOptions, type SandboxConfig, decodeFileTree,
  type HarnessJson, type Harness, checkGitProject, ProjectPreflightError, observeProjectRuntime,
  projectConfiguration,
} from '@luna-shi/murm';
import { join } from 'node:path';
import { ContextService } from './services/material/context-service.js';
import { makeEnvelope } from './persistence/envelope.js';
import { MissionWorkspace } from './services/workspace/mission-workspace.js';
import { WorkspaceManager } from './services/workspace/workspace-manager.js';
import { TaskService } from './services/task/task-service.js';
import type { createTaskPoolController } from './harness/controller.js';
import { runTaskPoolHarness } from './harness/harness.js';

interface Configuration extends Pick<CreateRuntimeOptions, 'connection' | 'models' | 'executor' | 'filePolicy'> {
  sandbox: SandboxConfig;
  image: string;
  model?: string;
  capacity?: number;
  workTimeoutMs?: number;
  closeTimeoutMs?: number;
}

const feedbackDescription = {
  description: 'Deliver feedback to the current execution of a Task.',
  schema: { type: 'object', required: ['taskId', 'input'], additionalProperties: false, properties: {
    taskId: { type: 'string' }, input: { type: 'string' }, mode: { enum: ['steer', 'followUp'] },
  } },
} as const;

function feedbackInput(payload: HarnessJson) {
  if (!payload || typeof payload !== 'object' || !('taskId' in payload) || !('input' in payload) ||
      typeof payload.taskId !== 'string' || !payload.taskId || typeof payload.input !== 'string' || !payload.input.trim() ||
      Object.keys(payload).some(key => !['taskId', 'input', 'mode'].includes(key)) ||
      ('mode' in payload && payload.mode !== 'steer' && payload.mode !== 'followUp')) {
    throw Object.assign(new TypeError('Expected Task ID, feedback text and optional mode'), { code: 'INVALID_HARNESS_INPUT' });
  }
  return { taskId: payload.taskId, input: payload.input, mode: 'mode' in payload ? payload.mode : 'steer' };
}

const taskpool = {
  id: 'taskpool',
  apiVersion: 1,
  input: true,
  inputDescriptor: feedbackDescription,
  async run(context) {
    const configuration = await projectConfiguration<Configuration>(context, () => import('./config.js'));
    const { executor, models, connection, image, model = 'default', capacity = 2, workTimeoutMs = 120_000,
      closeTimeoutMs = 30_000 } = configuration;
    if (![workTimeoutMs, closeTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647) ||
        !Number.isSafeInteger(capacity) || capacity < 1 || typeof image !== 'string' || !image) {
      throw new ProjectPreflightError('INVALID_RUN_CONFIGURATION', 'TaskPool requires finite work and close time limits, image and capacity');
    }
    let sandbox;
    try {
      sandbox = createSandbox(configuration.sandbox);
    } catch {
      throw new ProjectPreflightError('INVALID_RUN_CONFIGURATION', 'Invalid TaskPool sandbox configuration');
    }
    checkGitProject(context.initial.files);
    const entries = decodeFileTree(context.initial.files).entries;
    const taskService = new TaskService(join(context.outputDir, 'tasks.sqlite'));
    let contextService: ContextService | undefined;
    let observation: ReturnType<typeof observeProjectRuntime> | undefined;
    let storeCleanupConfirmed = true;
    const unsubscribe: (() => void)[] = [];
    try {
      contextService = new ContextService(join(context.outputDir, 'context.sqlite'), { taskService });
      const workspaceRoot = join(context.outputDir, 'workspace');
      const missionWorkspace = new MissionWorkspace({ rootDir: workspaceRoot, projectFileTree: true });
      const workspaceManager = new WorkspaceManager({ rootDir: join(context.outputDir, 'agents'), projectFileTree: true });
      const missionId = `mission:${context.runId}`;
      const workspaceId = context.runId;
      taskService.createMission({ mission_id: missionId, goal: context.input.prompt }, makeEnvelope({ actorRef: 'host' }));
      const workspace = await missionWorkspace.create({
        missionId, workspaceId,
        initialFiles: Object.fromEntries(entries.map(({ path, bytes }) => [path, bytes])),
        initialFileModes: Object.fromEntries(entries.map(({ path, mode }) => [path, mode])),
        metadata: { project_input_digest: context.initial.digest },
      });
      context.signal.throwIfAborted();
      const deadlineAt = Date.now() + workTimeoutMs;
      storeCleanupConfirmed = false;
      const result = await runTaskPoolHarness({
        sandbox, executor, models, connection, filePolicy: configuration.filePolicy, image, model, capacity, deadlineAt, closeTimeoutMs,
        taskService, contextService, missionWorkspace, workspaceManager, missionId, workspaceId,
        outputDir: context.outputDir, signal: context.signal, autonomousTasks: true, workspaceCapture: 'core', workspaceMergeEnabled: true,
        controller: {
          initialProject: { files: context.initial.files, digest: context.initial.digest, revision: workspace.main_revision },
          discoveryWorkflow: 'Keep Tasks small and coordinate via the public Task list. Save project changes as a Workspace revision and merge the result before marking implementation work done.',
          beforeInitialDispatch: () => context.markRunning(),
        },
        onRuntime: (runtime: Parameters<typeof observeProjectRuntime>[0], controller: ReturnType<typeof createTaskPoolController>) => {
          const state = async () => {
            const view = controller.snapshot();
            const current = await missionWorkspace.get({ workspaceId, signal: context.signal });
            const tasks = taskService.listTasks({ missionId, availableOnly: false, scanAll: true, limit: 100,
              states: ['OPEN', 'RUNNING', 'BLOCKED', 'DONE', 'CANCELED'] });
            return {
              missionId, workspaceId, workspaceRevision: current.main_revision, closing: view.closing,
              completion: view.completion, agents: view.agents, inputs: view.inputs.slice(-32),
              tasks: tasks.map((task: { task_id: string; state: string }) => ({
                taskId: task.task_id, state: task.state,
                executions: taskService.listExecutions(task.task_id, { includeTerminal: false }).map((execution: {
                  execution_id: string; owner_ref: string; fencing_version: number; state: string;
                }) => ({
                  executionId: execution.execution_id, owner: execution.owner_ref, fence: execution.fencing_version, state: execution.state,
                })),
              })),
            };
          };
          observation = observeProjectRuntime(runtime, context, state, { fence: () => controller.halt() });
          const refresh = () => { void observation?.refresh(); };
          unsubscribe.push(taskService.subscribeTaskEvents(refresh), taskService.subscribeExecutionState(refresh));
          const refreshWorkspace = setInterval(refresh, 1000);
          refreshWorkspace.unref();
          unsubscribe.push(() => clearInterval(refreshWorkspace));
          context.registerInput(
            async (payload, { requestId, operationId, binding, signal }) => {
              signal.throwIfAborted();
              const feedback = feedbackInput(payload);
              const receipt = await controller.feedback({ ...feedback, requestId, operationId },
                binding as unknown as ReturnType<typeof controller.captureFeedback>);
              refresh();
              return receipt;
            },
            feedbackDescription,
            payload => controller.captureFeedback(feedbackInput(payload).taskId),
            (_payload, { requestId }) => controller.reconcileFeedback(requestId,
              (agentId, originalId) => observation!.reconcile(agentId, 'send', originalId)),
          );
        },
      }, options => context.runWithRuntime({ ...options,
        detail: () => ({ missionId, workspaceId, initialRevision: workspace.main_revision }),
      }));
      storeCleanupConfirmed = result.cleanup.status === 'complete';
      try {
        const main = await missionWorkspace.get({ workspaceId });
        return {
          ...result,
          cleanup: storeCleanupConfirmed ? result.cleanup : { ...result.cleanup,
            retained: [{ kind: 'task-store', path: join(context.outputDir, 'tasks.sqlite') },
              { kind: 'context-store', path: join(context.outputDir, 'context.sqlite') }] },
          acceptance: { status: 'not-run' },
          artifacts: [...result.artifacts, {
            kind: 'mission-workspace', path: missionWorkspace.workspacePath(workspaceId),
            revision: main.main_revision, commit: main.main_commit,
          }],
        };
      } catch {
        return { ...result, acceptance: { status: 'not-run' }, export: { status: 'pending',
          receipt: { code: 'MISSION_WORKSPACE_READ_FAILED', workspaceId } } };
      }
    } finally {
      for (const stop of unsubscribe) stop();
      observation?.close();
      if (storeCleanupConfirmed) {
        try { contextService?.close(); } finally { taskService.close(); }
      }
    }
  },
} satisfies Harness;

export default taskpool;
