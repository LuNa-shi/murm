import { createSandbox, type CreateRuntimeOptions, type SandboxConfig } from '@luna-shi/murm';
import { join } from 'node:path';
import { decodeFileSeed } from '../../scripts/core-file-seed.js';
import { ContextService } from '../../src/context/context-service.js';
import { makeEnvelope } from '../../src/protocol/envelope.js';
import { MissionWorkspace } from '../../src/runtime/mission-workspace.js';
import { WorkspaceManager } from '../../src/runtime/workspace-manager.js';
import { TaskService } from '../../src/task/task-service.js';
import type { ProjectHarness } from '../../src/harnesses/shared/project-harness.js';
import { checkGitProject } from '../../src/harnesses/shared/project-git.js';
import { ProjectPreflightError } from '../../src/harnesses/shared/project-input.js';
import { observeProjectRuntime, projectConfiguration, projectResult } from '../../src/harnesses/shared/project-runtime.js';
import { runTaskPoolHarness } from './harness.js';

interface Configuration extends Pick<CreateRuntimeOptions, 'connection' | 'models' | 'executor'> {
  sandbox: SandboxConfig;
  image: string;
  model?: string;
  capacity?: number;
  workTimeoutMs?: number;
  closeTimeoutMs?: number;
}

const taskpool = {
  id: 'taskpool',
  apiVersion: 1,
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
    const entries = decodeFileSeed(context.initial.files).entries;
    const taskService = new TaskService(join(context.outputDir, 'tasks.sqlite'));
    let contextService: ContextService | undefined;
    let observation: ReturnType<typeof observeProjectRuntime> | undefined;
    let storeCleanupConfirmed = true;
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
      const report = await runTaskPoolHarness({
        sandbox, executor, models, connection, image, model, capacity, deadlineAt, closeTimeoutMs,
        taskService, contextService, missionWorkspace, workspaceManager, missionId, workspaceId,
        outputDir: context.outputDir, signal: context.signal, autonomousTasks: true, workspaceCapture: 'core', workspaceMergeEnabled: true,
        controller: {
          initialProject: { files: context.initial.files, digest: context.initial.digest, revision: workspace.main_revision },
          discoveryWorkflow: 'Keep Tasks small and coordinate via the public Task list. Save project changes as a Workspace revision and merge the result before marking implementation work done.',
          beforeInitialDispatch: () => context.markRunning(),
        },
        onRuntime: (runtime: Parameters<typeof observeProjectRuntime>[0], controller: { snapshot(): unknown }) => {
          observation = observeProjectRuntime(runtime, context, () => controller.snapshot());
        },
      });
      const result = projectResult(report, context, { missionId, workspaceId, initialRevision: workspace.main_revision });
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
      observation?.close();
      if (storeCleanupConfirmed) {
        try { contextService?.close(); } finally { taskService.close(); }
      }
    }
  },
} satisfies ProjectHarness;

export default taskpool;
