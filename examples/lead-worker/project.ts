import {
  createSandbox, type CreateRuntimeOptions, type SandboxConfig, type Harness,
  ProjectPreflightError, checkGitProject, observeProjectRuntime, projectConfiguration,
} from '@luna-shi/murm';
import { runLeadWorker } from './harness/index.js';
import { deployDynamicContainer } from './dynamic-container.js';
import { leadWorkerConfig } from './project-config.js';

type Config = Omit<ReturnType<typeof leadWorkerConfig>, 'models' | 'sandbox'> &
  Pick<CreateRuntimeOptions, 'executor' | 'models' | 'filePolicy'> & { sandbox: SandboxConfig; team?: 'static' | 'dynamic'; checkingImage?: string };

export async function defaultConfiguration() {
  return {
    ...leadWorkerConfig(),
    team: process.env.MURM_LEAD_WORKER_TEAM,
    checkingImage: process.env.MURM_LEAD_WORKER_CHECKING_IMAGE,
  };
}

const leadWorker = {
  id: 'lead-worker', apiVersion: 1,
  async run(context) {
    const config = await projectConfiguration<Config>(context, async () => ({ default: await defaultConfiguration() }));
    const { team = 'static' } = config;
    if ((team !== 'static' && team !== 'dynamic') ||
        (team === 'dynamic' && config.helperCount !== undefined && config.helperCount !== 2)) {
      throw new ProjectPreflightError('INVALID_RUN_CONFIGURATION', 'Choose a static team or a dynamic team with two initial workers');
    }
    if (config.closeTimeoutMs !== undefined && (!Number.isSafeInteger(config.closeTimeoutMs) ||
        config.closeTimeoutMs < 1 || config.closeTimeoutMs > 60_000)) {
      throw new ProjectPreflightError('INVALID_RUN_CONFIGURATION', 'Lead–Worker requires a close wait of up to 60 seconds');
    }
    if (Buffer.byteLength(context.input.prompt) > 64 * 1024) {
      throw new ProjectPreflightError('INVALID_HARNESS_INPUT', 'Lead–Worker supports up to 64 KiB of prompt text');
    }
    checkGitProject(context.initial.files);
    let sandbox;
    let deploy: ReturnType<typeof deployDynamicContainer> | undefined;
    try {
      sandbox = createSandbox(config.sandbox);
      if (team === 'dynamic') deploy = deployDynamicContainer(config.checkingImage ?? config.image);
    } catch {
      throw new ProjectPreflightError('INVALID_RUN_CONFIGURATION', 'Invalid Lead–Worker Sandbox or dynamic checker image');
    }
    let observation: ReturnType<typeof observeProjectRuntime> | undefined;
    let unsubscribeBoard: (() => void) | undefined;
    try {
      const result = await runLeadWorker({
        ...config, sandbox, runId: context.runId.replaceAll('-', '').slice(0, 24), outputDir: context.outputDir,
        signal: context.signal, projectFiles: context.initial.files, initialDigest: context.initial.digest,
        dynamic: deploy ? { goal: context.input.prompt, projectFiles: context.initial.files, deploy } : undefined,
        onRuntime: (runtime: Parameters<typeof observeProjectRuntime>[0], snapshot: () => unknown, subscribeBoard: (listener: () => void) => () => void) => {
          observation = observeProjectRuntime(runtime, context, snapshot);
          unsubscribeBoard = subscribeBoard(() => { void observation?.refresh(); });
        },
        beforeInitialDispatch: () => context.markRunning(),
      }, { goal: context.input.prompt, signal: context.signal },
      options => context.runWithRuntime({ ...options, detail: () => ({ team }) }));
      return { ...result, acceptance: { status: 'not-run' } };
    } finally {
      unsubscribeBoard?.();
      observation?.close();
    }
  },
} satisfies Harness;

export default leadWorker;
