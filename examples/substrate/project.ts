import {
  createSandbox, type CreateRuntimeOptions, type SandboxConfig, type ProjectHarness,
  ProjectPreflightError, observeProjectRuntime, projectConfiguration, projectResult,
} from '@luna-shi/murm';
import { runSubstrate } from './harness/index.js';
import type { substrateConfiguration } from './project-config.js';

type Configuration = Omit<ReturnType<typeof substrateConfiguration>, 'models' | 'sandbox'> &
  Pick<CreateRuntimeOptions, 'executor' | 'models' | 'filePolicy'> & { sandbox: SandboxConfig };

const substrate = {
  id: 'substrate',
  apiVersion: 1,
  async run(context) {
    const configuration = await projectConfiguration<Configuration>(context,
      async () => ({ default: (await import('./project-config.js')).substrateConfiguration() }));
    if (Buffer.byteLength(context.input.prompt) > 8192) {
      throw new ProjectPreflightError('INVALID_HARNESS_INPUT', 'Substrate supports up to 8 KiB of prompt text');
    }
    const { sandbox, connection, models, image, model, poolSize, maxRounds, workTimeoutMs, turnTimeoutMs, closeTimeoutMs } = configuration;
    let sandboxHandle;
    try {
      sandboxHandle = createSandbox(sandbox);
    } catch {
      throw new ProjectPreflightError('INVALID_RUN_CONFIGURATION', 'Invalid Substrate sandbox configuration');
    }
    let observation: ReturnType<typeof observeProjectRuntime> | undefined;
    let business: unknown = { stage: 'startup' };
    function progress(snapshot: unknown) {
      business = snapshot;
      void observation?.refresh();
    }
    try {
      const report = await runSubstrate({
        sandbox: sandboxHandle, executor: configuration.executor, connection, filePolicy: configuration.filePolicy, models, image, model, poolSize, maxRounds, workTimeoutMs, turnTimeoutMs, closeTimeoutMs,
        runId: context.runId, outputDir: context.outputDir, question: context.input.prompt, files: context.initial.files,
        onRuntime: (runtime: Parameters<typeof observeProjectRuntime>[0]) => { observation = observeProjectRuntime(runtime, context, () => business); },
        onReady: ({ peerIds, snapshot }: { peerIds: string[]; snapshot: unknown }) => {
          progress({ stage: 'running', peerIds, publication: snapshot });
          context.markRunning();
        },
        onCycle: ({ agentId, round, attempt, snapshot }: { agentId: string; round: number; attempt: number; snapshot: unknown }) =>
          progress({ stage: 'cycle', agentId, round, attempt, publication: snapshot }),
        onPeerStop: ({ agentId, receipt, snapshot }: { agentId: string; receipt: unknown; snapshot: unknown }) =>
          progress({ stage: 'peer-stopped', agentId, receipt, publication: snapshot }),
      }, context.signal);
      const result = projectResult(report, context, report.substrate);
      return { ...result, acceptance: { status: 'not-run' },
        cleanup: result.cleanup.status === 'complete' ? result.cleanup : { ...result.cleanup,
          retained: [{ kind: 'publication-store', path: report.databasePath }] } };
    } finally {
      observation?.close();
    }
  },
} satisfies ProjectHarness;

export default substrate;
