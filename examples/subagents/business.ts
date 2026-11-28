import { randomUUID } from 'node:crypto';
import { createRuntime, createSandbox, getExecutorCapabilities, runWithReport, ServiceRegistry, type CollectionSpec,
  type AgentSessionConfig, type CreateRuntimeOptions, type FileTree, type Runtime, type SandboxConfig,
  type SendOptions, type ServiceRegistration, type SpawnOptions } from '@luna-shi/murm';
import { collaborationOperations, createCollaborationService } from './services/collaboration-service.js';
import { createSubagentsController } from './harness/controller.js';
import { childPrompt, profileQuestionGuide, rootPrompt } from './prompts/prompts.js';

export interface Config extends Pick<CreateRuntimeOptions, 'connection' | 'executor' | 'models' | 'filePolicy' | 'hooks'> {
  sandbox: SandboxConfig;
  model?: string;
  rootModel?: string;
  childModel?: string;
  rootSession?: AgentSessionConfig;
  childSession?: AgentSessionConfig;
  image: string;
  outputDir: string;
  goal?: string;
  maxAgents?: number;
  maxDepth?: number;
  workTimeoutMs?: number;
  closeTimeoutMs?: number;
  questionTimeoutMs?: number;
  files?: FileTree;
  collect?: CollectionSpec;
  workspace?: { root: SpawnOptions['workspace']; child: SpawnOptions['workspace'] };
  interactive?: boolean;
}

function deadline(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw Object.assign(new TypeError(`${name} must be a finite positive integer`), { code: 'INVALID_RUN_CONFIGURATION' });
  }
  return value;
}

type ProjectControls = {
  signal?: AbortSignal;
  childFiles?: FileTree;
  onRuntime?: (runtime: Runtime, team: ReturnType<typeof createSubagentsController>) => void;
  userQuestions?: ServiceRegistration;
  onChange?: () => void;
  onDeadline?: (deadlineAt: number) => void;
};

export async function createSubagentsHarness(config: Config, controls: ProjectControls = {}) {
  controls.signal?.throwIfAborted();
  const { maxAgents = 4, maxDepth = 3, model = 'default', rootModel = model, childModel = model,
    closeTimeoutMs = 30_000, outputDir, image, files, collect, workspace } = config;
  if (!Number.isSafeInteger(maxAgents) || maxAgents < 1 || maxAgents > 64 ||
      !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 16) {
    throw Object.assign(new TypeError('Use maxAgents from 1 to 64 (including Root) and maxDepth from 0 to 16'), { code: 'INVALID_RUN_CONFIGURATION' });
  }
  deadline(closeTimeoutMs, 'closeTimeoutMs');
  const questionGuidance = controls.userQuestions ? '\n\n' + profileQuestionGuide : '';
  const services = new ServiceRegistry();
  let team: ReturnType<typeof createSubagentsController>;
  const { contextFork: allowContextFork } = getExecutorCapabilities(config.executor ?? 'pi');
  services.registerService(createCollaborationService(request => team.invoke(request), () => team.exportState(), { allowContextFork }));
  if (controls.userQuestions) services.registerService(controls.userQuestions);
  const common = { image, writable: true, services: { collaboration: collaborationOperations,
    ...(controls.userQuestions ? { 'user-interaction': ['ask'] } : {}),
  },
    spawnProfiles: ['child'], allowContextFork };
  const runtime = await createRuntime({
    sandbox: createSandbox(config.sandbox), executor: config.executor, models: config.models,
    connection: config.connection, filePolicy: config.filePolicy, hooks: config.hooks, outputDir, services, maxAgents,
    profiles: {
      root: { ...common, model: rootModel, prompt: rootPrompt + questionGuidance, session: config.rootSession },
      child: { ...common, model: childModel, prompt: childPrompt + questionGuidance, session: config.childSession },
    },
  });
  team = createSubagentsController(runtime, {
    maxDepth, childWorkspace: workspace?.child, childFiles: controls.childFiles, startupSignal: controls.signal, onChange: controls.onChange,
  });
  const closing = new AbortController();
  const sharedWriters = workspace?.root && 'id' in workspace.root &&
    workspace.child?.mode === 'read-write' && workspace.child.id === workspace.root.id;
  let closingWork: ReturnType<typeof runtime.close> | undefined;
  let sharedDeliveryUnverified = false;
  function close(options = { timeoutMs: closeTimeoutMs }) {
    closingWork ??= closeTeam(options.timeoutMs).finally(() => { closingWork = undefined; });
    return closingWork;
  }
  async function closeTeam(timeoutMs: number) {
    closing.abort(new Error('The team is closing'));
    team.beginClose();
    try {
      const deadlineAt = Date.now() + timeoutMs;
      if (sharedWriters && collect && !sharedDeliveryUnverified) {
        const children = (await runtime.list()).filter(agent => agent.parentId && agent.status !== 'closed');
        const stops = await Promise.allSettled(children.map(agent => runtime.stop(agent.id, {
          timeoutMs: Math.max(1, Math.floor((deadlineAt - Date.now()) * 2 / 3)),
        })));
        sharedDeliveryUnverified = stops.some(stop => stop.status === 'rejected' || stop.value.execution !== 'stopped');
      }
      const receipt = await runtime.close({ timeoutMs: Math.max(1, deadlineAt - Date.now()) });
      if (sharedDeliveryUnverified) {
        const error = { code: 'SHARED_WRITERS_UNCONFIRMED', message: 'Some shared writers were still unconfirmed before collection', retryable: false };
        return { ...receipt, cleanup: 'pending' as const, errors: [...receipt.errors, error] };
      }
      return receipt;
    } finally {
      team.dispose();
    }
  }
  let root;
  try {
    controls.onRuntime?.(runtime, team);
    controls.signal?.throwIfAborted();
    root = await runtime.spawn({ profile: 'root', requestId: 'root', files, collect, workspace: workspace?.root });
    controls.signal?.throwIfAborted();
    team.attachRoot(root.id);
  } catch (error) {
    const receipt = await close().catch(() => undefined);
    if (!controls.signal) throw error;
    const cause = error as { code?: string; cleanup?: string; message?: string };
    throw Object.assign(new Error(cause?.message ?? 'Subagents startup failed', { cause: error }), {
      code: cause?.code ?? 'SUBAGENTS_START_FAILED',
      cleanup: receipt?.cleanup ?? 'pending', runtimeId: runtime.id, receipt,
    });
  }

  return {
    id: runtime.id,
    rootId: root.id,
    input: (text: string, request: string | { operationId: string } = randomUUID(), options?: Omit<SendOptions, 'requestId'>,
      signal?: AbortSignal, epoch?: number) => team.submitUser(text, request, options, signal, epoch),
    inputFence: team.rootEpoch,
    reconcileInput: team.reconcileRootInput,
    status: team.list,
    onReply: team.onReply,
    lastReply: team.lastReply,
    waitForReply({ after = 0, signal }: { after?: number; signal?: AbortSignal } = {}) {
      const abort = signal ? AbortSignal.any([signal, closing.signal]) : closing.signal;
      abort.throwIfAborted();
      return new Promise<NonNullable<ReturnType<typeof team.lastReply>>>((resolveReply, rejectReply) => {
        const cancel = () => finish(() => rejectReply(abort.reason));
        const unsubscribe = team.onReply(reply => {
          if (reply.seq > after) finish(() => resolveReply(reply));
        });
        function finish(callback: () => void) {
          unsubscribe();
          abort.removeEventListener('abort', cancel);
          callback();
        }
        abort.addEventListener('abort', cancel, { once: true });
        const latest = team.lastReply();
        if (latest && latest.seq > after) finish(() => resolveReply(latest));
      });
    },
    close,
    afterClose: team.drain,
    collaborationState: team.exportState,
  };
}

function reportRedactor(config: Config) {
  const secrets = [config?.sandbox?.apiKey, config?.sandbox?.execdToken,
    ...Object.values(config?.models ?? {}).flatMap(model => Object.values(model?.upstream?.headers ?? {}))]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .flatMap(value => [value, value.replace(/^(?:Bearer|Basic)\s+/i, '')])
    .filter(Boolean).sort((left, right) => right.length - left.length);
  return (report: unknown) => JSON.parse(JSON.stringify(report, (_key, value) => typeof value === 'string'
    ? secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value) : value));
}

export type SubagentsRun = Awaited<ReturnType<typeof createSubagentsHarness>>;

export async function runSubagentsHarness(config: Config, signal?: AbortSignal,
  interact?: (harness: SubagentsRun, signal: AbortSignal) => Promise<unknown>,
  controls?: Omit<ProjectControls, 'signal'> & { onReady?: (harness: SubagentsRun) => void }, run = runWithReport) {
  const workTimeoutMs = deadline(config.workTimeoutMs ?? 120_000, 'workTimeoutMs');
  const timeout = AbortSignal.timeout(workTimeoutMs);
  controls?.onDeadline?.(Date.now() + workTimeoutMs);
  const work = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let harness: SubagentsRun | undefined;
  const redact = reportRedactor(config);
  return run({
    outputDir: config.outputDir, closeTimeoutMs: config.closeTimeoutMs ?? 30_000,
    redact: (report: object) => redact({ ...report, collaboration: harness?.collaborationState() ?? null }),
    detail: () => harness?.collaborationState() ?? null,
    createRuntime: async () => {
      work.throwIfAborted();
      if (!interact && !config.goal?.trim()) throw new TypeError('Supply a task in config.goal or use interactive input');
      harness = await createSubagentsHarness(config, controls && { ...controls, signal: work });
      return harness;
    },
    afterClose: () => harness?.afterClose(),
    async run(env: SubagentsRun) {
      if (controls) {
        work.throwIfAborted();
        controls.onReady?.(env);
      }
      const initial = config.goal?.trim() ? await env.input(config.goal, 'initial-task') : undefined;
      if (initial && (typeof initial !== 'object' || !('status' in initial) || initial.status !== 'accepted')) {
        throw Object.assign(new Error('Root input was not confirmed'), { code: 'INPUT_UNKNOWN', receipt: initial });
      }
      if (interact) return await interact(env, work);
      const reply = await env.waitForReply({ signal: work });
      if (reply.type !== 'settled' || reply.outcome !== 'completed') {
        throw Object.assign(new Error('Root did not complete the task'), { code: 'ROOT_FAILED', event: reply });
      }
      return { rootId: env.rootId, eventSeq: reply.seq, output: reply.output };
    },
  });
}
