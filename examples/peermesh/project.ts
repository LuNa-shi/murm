import {
  createSandbox, type CreateRuntimeOptions, type SandboxConfig, type HarnessJson, type ProjectHarness,
  ProjectPreflightError, checkGitProject, observeProjectRuntime, projectConfiguration,
  projectResult,
} from '@luna-shi/murm';
import { addAbortListener } from 'node:events';
import { runPeerMeshTeam, type createPeerMeshTeam } from './harness/team.js';
import { peerMeshConfig } from './project-config.js';

type Config = Omit<ReturnType<typeof peerMeshConfig>, 'models' | 'sandbox'> &
  Pick<CreateRuntimeOptions, 'executor' | 'models' | 'filePolicy'> & { sandbox: SandboxConfig };

const userBatchDescription = {
  description: 'Queue a user batch for one peer. The peer reads current shared context before the batch starts.',
  schema: { type: 'object', required: ['recipient', 'input'], additionalProperties: false, properties: {
    recipient: { type: 'string' }, input: { type: 'string' },
  } },
} as const;

function batchInput(payload: HarnessJson) {
  if (!payload || typeof payload !== 'object' || !('recipient' in payload) || !('input' in payload) ||
      typeof payload.recipient !== 'string' || !payload.recipient || typeof payload.input !== 'string' || !payload.input.trim() ||
      Object.keys(payload).some(key => key !== 'recipient' && key !== 'input')) {
    throw Object.assign(new TypeError('Expected one recipient and nonblank input'), { code: 'INVALID_HARNESS_INPUT' });
  }
  return { recipient: payload.recipient, input: payload.input };
}

const peerMesh = {
  id: 'peermesh', apiVersion: 1, input: true, inputDescriptor: userBatchDescription,
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
    let team: Awaited<ReturnType<typeof createPeerMeshTeam>> | undefined;
    let observation: ReturnType<typeof observeProjectRuntime> | undefined;
    let statusRefresh: ReturnType<typeof setInterval> | undefined;
    let cancelStatusRefresh: ReturnType<typeof addAbortListener> | undefined;
    try {
      const report = await runPeerMeshTeam({
        ...config, sandbox, runId: context.runId.replaceAll('-', '').slice(0, 24),
        outputDir: context.outputDir, signal: context.signal,
        projectFiles: context.initial.files, initialDigest: context.initial.digest,
        project: { title: 'Project task', body: context.input.prompt, durationMs },
        exportLimit: 64 * 1024 ** 2,
        onRuntime: (runtime: Parameters<typeof observeProjectRuntime>[0], snapshot: () => unknown) => {
          observation = observeProjectRuntime(runtime, context, snapshot, {
            fence: () => team?.halt(),
            async reconcile(operation, agentId) {
              const peer = team?.currentPeers().peers.find((entry: { agentId: string }) => entry.agentId === agentId);
              if (operation !== 'stop' || !peer) return { status: 'unknown' };
              try {
                const core = await team!.stopPeer(peer.key);
                return { core, harnessEffects: { status: core.cleanup === 'complete' ? 'complete' : 'pending',
                  routerStopped: true, sourceStopped: true } };
              } catch (error) {
                if ((error as { code?: string }).code !== 'SOURCE_STOP_PENDING') throw error;
                return { core: null, harnessEffects: { status: 'pending', routerStopped: true, sourceStopped: false } };
              } finally { void observation?.refresh(); }
            },
            capabilities: agentId => {
              const peer = team?.currentPeers().peers.find((entry: { agentId: string }) => entry.agentId === agentId);
              return { stop: { supported: true, available: !!peer && !peer.stopped, reason: peer?.stopped ? 'peer-closed' : undefined } };
            },
            handlers: {
              async stop(agentId, _payload, { signal }) {
                signal.throwIfAborted();
                const peer = team?.currentPeers().peers.find((entry: { agentId: string }) => entry.agentId === agentId);
                if (!peer) throw Object.assign(new Error('Unknown peer Agent'), { code: 'UNKNOWN_RECIPIENT' });
                try {
                  const receipt = await team!.stopPeer(peer.key);
                  return { core: receipt, harnessEffects: { status: receipt.cleanup === 'complete' ? 'complete' : 'pending', routerStopped: true, sourceStopped: true } };
                } catch (error) {
                  if ((error as { code?: string }).code !== 'SOURCE_STOP_PENDING') throw error;
                  return { core: null, harnessEffects: { status: 'pending', routerStopped: true, sourceStopped: false } };
                } finally {
                  void observation?.refresh();
                }
              },
            },
          });
        },
        beforeInitialDispatch: (ready: Awaited<ReturnType<typeof createPeerMeshTeam>>) => {
          team = ready;
          context.registerInput((payload, { requestId, signal }) => {
            signal.throwIfAborted();
            const receipt = ready.input({ ...batchInput(payload), requestId });
            void observation?.refresh();
            return ready.redact({ batchId: receipt.batchId, requestId: receipt.requestId,
              state: receipt.state, ...(receipt.inputId ? { inputId: receipt.inputId } : {}) });
          }, userBatchDescription);
          // Router completion, source polling and Board delivery can change
          // after the last Core event. Bound their public snapshot lag without
          // triggering router.wait/poll or other business dispatch from reads.
          statusRefresh = setInterval(() => { void observation?.refresh(); }, 250);
          statusRefresh.unref();
          cancelStatusRefresh = addAbortListener(context.signal, () => clearInterval(statusRefresh));
          context.markRunning();
        },
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
      clearInterval(statusRefresh);
      cancelStatusRefresh?.[Symbol.dispose]();
      observation?.close();
    }
  },
} satisfies ProjectHarness;

export default peerMesh;
