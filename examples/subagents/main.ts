import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createRuntime, type CollectionSpec, type FileSeed, type SpawnOptions } from '@murm/core';
import { ServiceRegistry } from '@murm/core/services';
import { createPiOpenSandboxBackend } from '@murm/core/backends/pi-opensandbox';
import { collaborationOperations, createCollaborationService } from './collaboration-service.js';
import { createSubagentsController } from './controller.js';
import { childPrompt, rootPrompt } from './prompts.js';
import { runWithReport } from './run-report.js';

interface Config {
  backend: Parameters<typeof createPiOpenSandboxBackend>[0];
  model?: string;
  rootModel?: string;
  childModel?: string;
  image: string;
  outputDir: string;
  goal?: string;
  maxAgents?: number;
  maxDepth?: number;
  workTimeoutMs?: number;
  closeTimeoutMs?: number;
  files?: FileSeed;
  collect?: CollectionSpec;
  workspace?: { root: SpawnOptions['workspace']; child: SpawnOptions['workspace'] };
  interactive?: boolean;
}

function deadline(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new TypeError(`${name} must be a finite positive integer`);
  }
  return value;
}

export async function createSubagentsHarness(config: Config) {
  const { maxAgents = 4, maxDepth = 3, model = 'default', rootModel = model, childModel = model,
    closeTimeoutMs = 30_000, outputDir, image, files, collect, workspace } = config;
  if (!Number.isSafeInteger(maxAgents) || maxAgents < 1 || maxAgents > 64 ||
      !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 16) {
    throw new TypeError('Use maxAgents from 1 to 64 (including Root) and maxDepth from 0 to 16');
  }
  deadline(closeTimeoutMs, 'closeTimeoutMs');
  const services = new ServiceRegistry();
  let team: ReturnType<typeof createSubagentsController>;
  services.registerService(createCollaborationService(request => team.invoke(request), () => team.exportState()));
  const common = { image, writable: true, services: { collaboration: collaborationOperations },
    spawnProfiles: ['child'], allowContextFork: true };
  const runtime = await createRuntime({
    backend: createPiOpenSandboxBackend(config.backend), outputDir, services, maxAgents: maxAgents,
    profiles: {
      root: { ...common, model: rootModel, prompt: rootPrompt },
      child: { ...common, model: childModel, prompt: childPrompt },
    },
  });
  team = createSubagentsController(runtime, { maxDepth, childWorkspace: workspace?.child });
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
    root = await runtime.spawn({ profile: 'root', requestId: 'root', files, collect, workspace: workspace?.root });
    team.attachRoot(root.id);
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }

  return {
    id: runtime.id,
    rootId: root.id,
    input: (text: string, requestId: string = randomUUID()) => team.submitUser(text, requestId),
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

function reportRedactor(backend: Config['backend']) {
  const secrets = [backend?.sandbox?.apiKey, backend?.sandbox?.execdToken,
    ...Object.values(backend?.models ?? {}).flatMap(model => Object.values(model?.upstream?.headers ?? {}))]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .flatMap(value => [value, value.replace(/^(?:Bearer|Basic)\s+/i, '')])
    .filter(Boolean).sort((left, right) => right.length - left.length);
  return (report: unknown) => JSON.parse(JSON.stringify(report, (_key, value) => typeof value === 'string'
    ? secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value) : value));
}

type Harness = Awaited<ReturnType<typeof createSubagentsHarness>>;

export async function runSubagentsHarness(config: Config, signal?: AbortSignal,
  interact?: (harness: Harness, signal: AbortSignal) => Promise<unknown>) {
  const timeout = AbortSignal.timeout(deadline(config.workTimeoutMs ?? 120_000, 'workTimeoutMs'));
  const work = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let harness: Harness | undefined;
  const redact = reportRedactor(config.backend);
  return runWithReport({
    outputDir: config.outputDir, closeTimeoutMs: config.closeTimeoutMs ?? 30_000,
    redact: (report: object) => redact({ ...report, collaboration: harness?.collaborationState() ?? null }),
    createRuntime: async () => {
      work.throwIfAborted();
      if (!interact && !config.goal?.trim()) throw new TypeError('Supply a task in config.goal or use interactive input');
      harness = await createSubagentsHarness(config);
      return harness;
    },
    afterClose: () => harness?.afterClose(),
    async run(env: Harness) {
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

async function readInteraction(env: Harness, signal: AbortSignal) {
  const input = createInterface({ input: process.stdin, terminal: false });
  const done = () => input.close();
  let rootFailure: unknown;
  const showReply: Parameters<Harness['onReply']>[0] = reply => {
    if (reply.type === 'settled' && reply.output) process.stdout.write(`${reply.output}\n`);
    if (reply.type === 'exit' || (reply.type === 'settled' && reply.outcome === 'failed')) {
      rootFailure = Object.assign(new Error('Root did not complete the task'), { code: 'ROOT_FAILED', event: reply });
      done();
    }
  };
  const stopReply = env.onReply(showReply);
  const last = env.lastReply();
  if (last) showReply(last);
  if (signal.aborted) done();
  else signal.addEventListener('abort', done, { once: true });
  try {
    for await (const line of input) {
      if (line === '/exit') break;
      if (!line.trim()) continue;
      const work = line === '/status' ? env.status().then(value => { process.stdout.write(`${JSON.stringify(value)}\n`); })
        : env.input(line).then(value => { process.stderr.write(`${JSON.stringify(value)}\n`); });
      void work.catch(error => {
        process.stderr.write(`${error.code ?? 'INPUT_ERROR'}\n`);
      });
    }
  } finally {
    input.close();
    signal.removeEventListener('abort', done);
    stopReply();
  }
  if (rootFailure) throw rootFailure;
  signal.throwIfAborted();
  return { rootId: env.rootId, interaction: 'closed' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , filename, task] = process.argv;
  if (!filename || filename === '--help') {
    process.stdout.write('Usage: node main.js <config.js> ["task" | --interactive]\n');
  } else {
    const interrupt = new AbortController();
    const stop = () => interrupt.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      const config: Config = (await import(pathToFileURL(resolve(filename)).href)).default;
      const report = await runSubagentsHarness(
        task && task !== '--interactive' ? { ...config, goal: task } : config,
        interrupt.signal, task === '--interactive' || config.interactive ? readInteraction : undefined);
      process.stdout.write(`${JSON.stringify(report)}\n`);
      process.exitCode = report.businessFailure || report.cleanupFailure || report.reportSaveFailure ? 1 : 0;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }
}
