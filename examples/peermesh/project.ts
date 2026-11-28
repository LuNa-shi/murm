import { createSandbox, type CreateRuntimeOptions, type SandboxConfig } from '@luna-shi/murm';
import { addAbortListener } from 'node:events';
import { runPeerMeshTeam } from './harness/team.js';
import type { ProjectHarness } from '../../src/harness/project-harness.js';
import { ProjectPreflightError } from '../../src/harness/project-input.js';
import { checkGitProject } from '../../src/harness/project-git.js';
import { observeProjectRuntime, projectConfiguration, projectResult } from '../../src/harness/project-runtime.js';
import { peerMeshConfig } from './project-config.js';

type Config = Omit<ReturnType<typeof peerMeshConfig>, 'models' | 'sandbox'> &
  Pick<CreateRuntimeOptions, 'executor' | 'models' | 'filePolicy'> & { sandbox: SandboxConfig };

const peerMesh = {
  id: 'peermesh', apiVersion: 1,
  async run(context) {
    const config = await projectConfiguration<Config>(context, async () => ({ default: peerMeshConfig() }));
    const { durationMs = 120_000 } = config;
    if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 86_400_000) {
      throw new ProjectPreflightError('INVALID_RUN_CONFIGURATION', 'Invalid PeerMesh work window');
    }
    if (Buffer.byteLength(context.input.prompt) > 16_000) {
      throw new ProjectPreflightError('INVALID_HARNESS_INPUT', 'PeerMesh project issues support up to 16,000 prompt bytes');
    }
    checkGitProject(context.initial.files);
    let sandbox;
    try { sandbox = createSandbox(config.sandbox); }
    catch { throw new ProjectPreflightError('INVALID_RUN_CONFIGURATION', 'Invalid PeerMesh sandbox configuration'); }
    let observation: ReturnType<typeof observeProjectRuntime> | undefined;
    try {
      const report = await runPeerMeshTeam({
        ...config, sandbox, runId: context.runId.replaceAll('-', '').slice(0, 24),
        outputDir: context.outputDir, signal: context.signal,
        projectFiles: context.initial.files, initialDigest: context.initial.digest,
        project: { title: 'Project task', body: context.input.prompt, durationMs },
        exportLimit: 64 * 1024 ** 2,
        onRuntime: (runtime: Parameters<typeof observeProjectRuntime>[0], snapshot: () => unknown) => {
          observation = observeProjectRuntime(runtime, context, snapshot);
        },
        beforeInitialDispatch: () => context.markRunning(),
      }, async (team: { signal: AbortSignal; snapshot(): unknown }) => {
        if (!team.signal.aborted) {
          await new Promise<void>(resolve => {
            const listener = addAbortListener(team.signal, () => {
              listener[Symbol.dispose]();
              resolve();
            });
          });
        }
        if (team.signal.reason?.code !== 'PEERMESH_PROJECT_DEADLINE') throw team.signal.reason;
        return { reason: 'deadline', harness: team.snapshot() };
      });
      const result = projectResult(report, context);
      const delivery = report.cleanup?.delivery;
      return {
        ...result, reason: result.outcome === 'completed' ? 'deadline' : result.reason,
        acceptance: { status: 'not-run' },
        ...(delivery ? {
          export: { status: delivery.state === 'complete' ? 'complete' as const : 'pending' as const, receipt: delivery },
          artifacts: [...result.artifacts, ...(delivery.archive ? [{ path: delivery.archive, commit: delivery.commit, sha256: delivery.sha256 }] : [])],
        } : {}),
      };
    } finally {
      observation?.close();
    }
  },
} satisfies ProjectHarness;

export default peerMesh;
