import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createRuntime, createSandbox, ServiceRegistry, type RuntimeEvent, type CloseReceipt,
  type FilePolicy, type ModelConfig, type PendingCleanup, type Runtime, type RuntimeConnectionOptions, type SandboxConfig } from '../src/core/index.js';
import { createLocalSetupUpstream, SETUP_CONTINUATION, SETUP_CONTINUED, SETUP_MARKER, SETUP_READ, SETUP_RESULT } from './local-setup-upstream.js';
import { selectExecutorDriver } from '../src/core/sandbox/executor-driver.js';
import type { ExecutorSelection } from '../src/core/executor-adapter.js';
import type { ModelProtocol } from '../src/core/model/model-transport.js';

export interface LocalSmokeOptions {
  image: string;
  executor?: ExecutorSelection;
  modelProtocol?: ModelProtocol;
  modelConfig?: ModelConfig;
  filePolicy?: FilePolicy;
  lifecycleBaseUrl: string;
  publicUrl?: string;
  useServerProxy?: boolean;
  egressMode?: 'dns+nft';
  apiKey?: string;
  advertiseHost?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  sandbox?: SandboxConfig;
  connection?: RuntimeConnectionOptions;
}

export interface LocalSmokeCheck {
  id: string;
  status: 'passed' | 'failed';
  message: string;
  remedy?: string;
}

export interface LocalSmokeReceipt {
  ok: boolean;
  runtimeId?: string;
  outputDir?: string;
  checks: LocalSmokeCheck[];
  cleanup: 'complete' | 'pending';
  pending: readonly PendingCleanup[];
  interrupted: boolean;
  durationMs: number;
}

export const SETUP_PROFILE_PROMPT = 'Perform the fixed local infrastructure probe.';
export const SETUP_FOLLOW_UP = 'Verify the local Service, write and read setup-smoke.txt, and return the confirmed result.';


function untilAborted<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void task.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Performs fixed local work through the same Worker, Bridge, gateway and export paths as a user Run. */
export async function runLocalSmoke(options: LocalSmokeOptions): Promise<LocalSmokeReceipt> {
  const startedAt = Date.now();
  const receipt: LocalSmokeReceipt = { ok: false, checks: [], cleanup: 'complete', pending: [],
    interrupted: false, durationMs: 0 };
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 100_000)]);
  let runtime: Runtime | undefined;
  let upstream: Awaited<ReturnType<typeof createLocalSetupUpstream>> | undefined;
  let temporary: string | undefined;
  let stage = 'probe-start';
  let close: CloseReceipt | undefined;
  const passed = (id: string, message: string) => receipt.checks.push({ id, status: 'passed', message });
  let unsubscribe: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    temporary = await mkdtemp(join(tmpdir(), 'murm-setup-smoke-'));
    const driver = selectExecutorDriver(options.executor);
    const protocol = options.modelProtocol ?? 'responses';
    if (!driver.adapter) upstream = await createLocalSetupUpstream(driver.kind === 'codex' ? 'codex' : 'pi', protocol);
    const model = driver.adapter ? options.modelConfig : { provider: driver.kind === 'codex' ? 'openai' : 'kimi_proxy',
      model: driver.kind === 'codex' ? 'gpt-5.4' : 'k3', protocol, upstream: { url: upstream!.url, headers: {} } };
    if (!model) throw Object.assign(new Error('An external executor probe requires its configured model alias'), { code: 'INVALID_CONTRACT' });
    signal.throwIfAborted();
    const services = new ServiceRegistry();
    let serviceCaller: string | undefined;
    services.registerService({ manifest: {
      id: 'setup-probe', title: 'Local setup probe', purpose: 'Verify the local Agent Bridge',
      provider_version: '1', contract_version: '2', endpoint: { transport: 'in-process' },
      capabilities: [{ name: 'verify', operation: 'verify', description: 'Verify a fixed local probe',
        side_effect: 'read', idempotent: true, help: { when: 'During local infrastructure setup' }, errors: [],
        input_schema: { type: 'object', properties: { key: { const: 'smoke' } }, required: ['key'], additionalProperties: false },
        output_schema: { type: 'object', properties: { verified: { const: true } }, required: ['verified'], additionalProperties: false } }],
    }, adapter: { invoke(request) { request.assertAuthorized(); serviceCaller = request.caller.agentId; return { verified: true }; } } });
    runtime = await createRuntime({
      sandbox: createSandbox({
        commandTimeoutMs: 20_000, resourceLimits: { cpu: '1', memory: '1Gi' },
        ...options.sandbox,
        lifecycleBaseUrl: options.lifecycleBaseUrl, apiKey: options.apiKey,
        useServerProxy: options.useServerProxy, egressMode: options.egressMode,
      }),
      executor: options.executor,
      connection: {
        advertiseHost: options.advertiseHost, publicUrl: options.publicUrl, ...options.connection,
        modelGateway: { requestTimeoutMs: 20_000, maxOutputTokens: 128, ...options.connection?.modelGateway },
      },
      models: { default: model }, filePolicy: options.filePolicy,
      profiles: { probe: { prompt: SETUP_PROFILE_PROMPT, model: 'default', image: options.image,
        writable: true, services: { 'setup-probe': ['verify'] } } },
      services, maxAgents: 1, outputDir: temporary,
    });
    receipt.runtimeId = runtime.id;
    receipt.cleanup = 'pending';
    stage = 'host-worker';
    const agent = await untilAborted(runtime.spawn({ profile: 'probe', requestId: 'setup-smoke-spawn',
      ...(driver.adapter ? { files: { [SETUP_READ]: { encoding: 'utf8', data: `${SETUP_MARKER}\n` } } } : {}),
      collect: { paths: ['.'], includeGit: false, maxBytes: 4096, required: true } }), signal);
    signal.throwIfAborted();
    if (agent.status !== 'idle') throw new Error('worker');
    passed(stage, `Controller reached the real Worker and verified ${driver.kind} ${driver.version}`);
    if (upstream) {
      stage = 'agent-bridge-gateway';
      async function turn(message: string, requestId: string, expected: string) {
        const settled = new Promise<RuntimeEvent>(resolve => {
          unsubscribe = runtime!.onEvent(event => {
            if ((event.type === 'settled' || event.type === 'exit') && event.agentId === agent.id) resolve(event);
          });
        });
        try {
          const input = await untilAborted(runtime!.send(agent.id, message, { requestId, mode: 'followUp' }), signal);
          if (input.status !== 'accepted') throw new Error('input');
          const outcome = await untilAborted(settled, signal);
          if (outcome.type !== 'settled' || outcome.outcome !== 'completed' || outcome.output?.trim() !== expected) {
            throw new Error('roundtrip');
          }
        } finally {
          unsubscribe?.();
          unsubscribe = undefined;
        }
      }
      await turn(SETUP_FOLLOW_UP, 'setup-smoke-input', SETUP_RESULT);
      if (protocol === 'chat-completions') await turn(SETUP_CONTINUATION, 'setup-smoke-continuation', SETUP_CONTINUED);
      const observed = upstream.receipt();
      const expectedRequests = protocol === 'chat-completions' ? 4 : 3;
      if (serviceCaller !== agent.id || observed.failure || observed.arrivals !== expectedRequests || !observed.verifiedRead) {
        throw new Error('gateway');
      }
      passed(stage, `Real ${driver.kind} called the authenticated Bridge Service and controlled ${protocol} gateway`);
      passed('file-write-read', 'Executor tools wrote and read the saved bytes');
    }
    signal.throwIfAborted();
    stage = 'artifact-export';
    const stopped = await untilAborted(runtime.stop(agent.id, { timeoutMs: 25_000 }), signal);
    if (stopped.execution !== 'stopped' || stopped.cleanup !== 'complete') throw new Error('stop');
    const directory = stopped.artifacts.find(path => basename(path) === 'files');
    if (!directory || await readFile(join(directory, SETUP_READ), 'utf8') !== `${SETUP_MARKER}\n`) throw new Error('export');
    passed(stage, 'Stopped Agent export delivered the independently checked file bytes to the host');
  } catch (error) {
    receipt.interrupted = options.signal?.aborted ?? false;
    receipt.checks.push({ id: stage, status: 'failed', message: signal.aborted
      ? (receipt.interrupted ? 'Local probe interrupted' : 'Local probe deadline exceeded')
      : error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code)
        ? `Infrastructure probe failed (${error.code}). Check the configured Worker and network routes.`
        : 'Infrastructure probe failed. Check doctor diagnostics and retained resource identities',
      ...(stage === 'agent-bridge-gateway' && !receipt.interrupted ? {
        remedy: 'Check that the Sandbox can reach connection.publicUrl, the Runtime listener port, and the Bridge and Model Gateway proxy routes. Rerun murm doctor --smoke.',
      } : {}),
    });
  } finally {
    unsubscribe?.();
    if (runtime) {
      try {
        close = await runtime.close({ timeoutMs: 30_000 });
        receipt.cleanup = close.cleanup;
        receipt.pending = close.pending;
      } catch {
        receipt.cleanup = 'pending';
        receipt.pending = [{ kind: 'backend', id: runtime.id, action: 'close' }];
      }
      receipt.checks.push({ id: 'sandbox-deletion', status: receipt.cleanup === 'complete' ? 'passed' : 'failed',
        message: receipt.cleanup === 'complete' ? 'Runtime close confirmed deletion through the Sandbox Provider API'
          : 'Probe cleanup is pending. Retained runtime, Sandbox and evidence identities require recovery' });
    }
    try { await upstream?.close(); } catch {
      receipt.checks.push({ id: 'probe-upstream-close', status: 'failed', message: 'Local upstream close could not be confirmed' });
    }
    if (temporary) {
      if (receipt.cleanup === 'complete') await rm(temporary, { recursive: true, force: true }).catch(() => {
        receipt.checks.push({ id: 'probe-files-cleanup', status: 'failed', message: 'Temporary probe files could not be removed' });
        receipt.outputDir = temporary;
      });
      else receipt.outputDir = close?.outputDir ?? temporary;
    }
    receipt.durationMs = Date.now() - startedAt;
    receipt.ok = receipt.checks.every(check => check.status === 'passed') && receipt.cleanup === 'complete';
  }
  return receipt;
}
