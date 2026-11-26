import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { createRuntime, type AgentEvent, type CloseReceipt, type PendingCleanup, type Runtime } from '../src/core/index.js';
import { ServiceRegistry } from '../src/core/public-services.js';
import { createPiOpenSandboxBackend } from '../src/core/backends/pi-opensandbox.js';
import { createLocalSetupUpstream, SETUP_MARKER, SETUP_READ, SETUP_RESULT } from './local-setup-upstream.js';

export interface LocalSmokeOptions {
  image: string;
  lifecycleBaseUrl: string;
  endpointHost?: string;
  apiKey?: string;
  advertiseHost: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface LocalSmokeCheck {
  id: string;
  status: 'passed' | 'failed';
  message: string;
}

export interface LocalSmokeReceipt {
  ok: boolean;
  runtimeId?: string;
  outputDir?: string;
  checks: LocalSmokeCheck[];
  cleanup: 'complete' | 'pending';
  pending: readonly PendingCleanup[];
  containerIds: string[];
  interrupted: boolean;
  durationMs: number;
}

export const SETUP_PROFILE_PROMPT = 'Perform the fixed local infrastructure probe.';
export const SETUP_FOLLOW_UP = 'Verify the local Service, write and read setup-smoke.txt, and return the confirmed result.';

const execute = promisify(execFile);

async function ownedContainers(runtimeId: string) {
  const hash = createHash('sha256').update(runtimeId).digest('hex').slice(0, 48);
  const { stdout } = await execute('docker', ['ps', '--all', '--quiet', '--no-trunc',
    '--filter', `label=runtime_key=r-${hash}`], { timeout: 5000, maxBuffer: 1024 * 1024 });
  return stdout.trim().split('\n').filter(Boolean);
}

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
    containerIds: [], interrupted: false, durationMs: 0 };
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
    upstream = await createLocalSetupUpstream();
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
      backend: createPiOpenSandboxBackend({
        sandbox: { lifecycleBaseUrl: options.lifecycleBaseUrl, endpointHost: options.endpointHost ?? '127.0.0.1',
          apiKey: options.apiKey, commandTimeoutMs: 20_000, resourceLimits: { cpu: '1', memory: '1Gi' } },
        bridge: { host: '0.0.0.0', publicUrl: `http://${options.advertiseHost}:{port}` },
        modelGateway: { host: '0.0.0.0', advertiseHost: options.advertiseHost, requestTimeoutMs: 20_000, maxOutputTokens: 128 },
        models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: upstream.url, headers: {} } } },
        isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
      }),
      profiles: { probe: { prompt: SETUP_PROFILE_PROMPT, model: 'default', image: options.image,
        writable: true, services: { 'setup-probe': ['verify'] } } },
      services, maxAgents: 1, outputDir: temporary,
    });
    receipt.runtimeId = runtime.id;
    receipt.cleanup = 'pending';
    stage = 'host-worker';
    const agent = await untilAborted(runtime.spawn({ profile: 'probe', requestId: 'setup-smoke-spawn',
      collect: { paths: ['.'], includeGit: false, maxBytes: 4096, required: true } }), signal);
    signal.throwIfAborted();
    if (agent.status !== 'idle') throw new Error('worker');
    passed(stage, 'Host reached the real Worker with murm-core-v1 and Pi 1.3.0 startup checks');
    stage = 'agent-bridge-gateway';
    let settle!: (event: AgentEvent) => void;
    const settled = new Promise<AgentEvent>(resolve => { settle = resolve; });
    unsubscribe = runtime.onEvent(event => {
      if (event.agentId === agent.id && (event.type === 'settled' || event.type === 'exit')) settle(event);
    });
    const input = await untilAborted(runtime.send(agent.id, SETUP_FOLLOW_UP,
      { requestId: 'setup-smoke-input', mode: 'followUp' }), signal);
    if (input.status !== 'accepted') throw new Error('input');
    const outcome = await untilAborted(settled, signal);
    if (outcome.type !== 'settled' || outcome.outcome !== 'completed' || outcome.output?.trim() !== SETUP_RESULT || serviceCaller !== agent.id) {
      throw new Error('roundtrip');
    }
    const observed = upstream.receipt();
    if (observed.failure || observed.arrivals !== 3 || !observed.verifiedRead) throw new Error('gateway');
    passed(stage, 'Real Pi called the authenticated Bridge Service and local controlled Responses gateway');
    passed('file-write-read', 'Worker Bash wrote the fixed file and the Pi read tool returned its exact contents');
    signal.throwIfAborted();
    stage = 'artifact-export';
    const stopped = await untilAborted(runtime.stop(agent.id, { timeoutMs: 25_000 }), signal);
    if (stopped.execution !== 'stopped' || stopped.cleanup !== 'complete') throw new Error('stop');
    const directory = stopped.artifacts.find(path => basename(path) === 'files');
    if (!directory || await readFile(join(directory, SETUP_READ), 'utf8') !== `${SETUP_MARKER}\n`) throw new Error('export');
    passed(stage, 'Stopped Agent export delivered the independently checked file bytes to the host');
  } catch {
    receipt.interrupted = options.signal?.aborted ?? false;
    receipt.checks.push({ id: stage, status: 'failed', message: signal.aborted
      ? (receipt.interrupted ? 'Local probe interrupted' : 'Local probe deadline exceeded')
      : 'Local infrastructure probe failed at this stage. Check doctor diagnostics and retained resource identities' });
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
      try {
        receipt.containerIds = await ownedContainers(runtime.id);
        if (receipt.containerIds.length) receipt.cleanup = 'pending';
      } catch {
        receipt.cleanup = 'pending';
        receipt.pending = [...receipt.pending, { kind: 'backend', id: runtime.id, action: 'delete-sandbox' }];
      }
      receipt.checks.push({ id: 'sandbox-deletion', status: receipt.cleanup === 'complete' ? 'passed' : 'failed',
        message: receipt.cleanup === 'complete' ? 'Runtime close and Docker confirm that this probe has no remaining Sandbox'
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
