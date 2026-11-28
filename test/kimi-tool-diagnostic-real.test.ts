import { runtimeSettings } from './fixtures/core-runtime-settings.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
import { createRuntime } from '../src/core/index.js';
import { ServiceRegistry } from '../src/core/services.js';
import { runInput } from '../src/harness/run-input.js';
import { parsePrivateUpstreamHeaders } from './fixtures/taskpool-model-acceptance.js';
import { createCappedUpstream } from './fixtures/core-capped-upstream.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { createWorkGate, createCleanupBudget } from './fixtures/peermesh-deadline.js';
import { classifyToolDiagnostic, verifyDiagnosticBounds, diagnosticInput, diagnosticFilename, diagnosticMarker } from './fixtures/kimi-tool-diagnostic.js';

// This test diagnoses the native tool-result boundary, not #179 cooperation.
test('one Kimi Agent diagnoses its actual Bash result continuation with at most two hosted forwards', {
  skip: process.env.MURM_CORE_LIVE_KIMI_TOOL_DIAGNOSTIC_TEST !== '1' && 'Requires independent exact source/image reviews', timeout: 190_000,
}, async () => {
  const image = process.env.MURM_CORE_TEST_IMAGE;
  if (!/^sha256:[a-f0-9]{64}$/.test(image ?? '')) throw new Error('DIAGNOSTIC_IMAGE_REQUIRED');
  const headers = parsePrivateUpstreamHeaders(process.env.MURM_CORE_LIVE_UPSTREAM_HEADERS_JSON);
  const directory = join(process.cwd(), 'experiments', `kimi-tool-diagnostic-${randomBytes(6).toString('hex')}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const cleanup = createCleanupBudget(60_000), work = createWorkGate(120_000, 'DIAGNOSTIC_WORK_EXPIRED', cleanup);
  const report = { failure: true, classification: { status: 'uninformative' }, image, provider: 'kimi_proxy', model: 'k3', requestId: 'diagnostic-input',
    limits: { agents: 1, inputs: 1, forwards: 2, concurrent: 1, output: 512, aggregateOutput: 1024, inputBytes: 128 * 1024, aggregateInputBytes: 256 * 1024, workMs: 120_000, cleanupMs: 60_000 } };
  let runtime, proxy, agent, close, unsubscribe, result;
  const events = [];
  try {
    proxy = await createCappedUpstream({ upstreamUrl: process.env.MURM_CORE_LIVE_UPSTREAM_URL, upstreamHeaders: headers,
      deadlineAt: work.deadlineAt, maxRequests: 2, maxConcurrent: 1, maxOutputTokens: 512, maxAggregateOutputTokens: 1024,
      maxInputBytes: 128 * 1024, maxAggregateInputBytes: 256 * 1024, filename: diagnosticFilename, marker: diagnosticMarker,
      recordGeometry: true, failFast: true, onFailure: () => work.abort() });
    const host = process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
    runtime = await work.create(() => createRuntime({ ...runtimeSettings({
      sandbox: { lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1', endpointHost: process.env.MURM_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1',
        apiKey: process.env.MURM_CORE_TEST_API_KEY, commandTimeoutMs: 20_000, resourceLimits: { cpu: '1', memory: '1Gi' } },
      bridge: { host: '0.0.0.0', publicUrl: process.env.MURM_CORE_TEST_BRIDGE_URL ?? `http://${host}:{port}` },
      modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 60_000, maxOutputTokens: 512 },
      models: { default: { provider: 'kimi_proxy', model: 'k3', requestId: 'diagnostic-input', upstream: { url: proxy.url, headers: {} } } },
      isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
    }), services: new ServiceRegistry(), profiles: { worker: { prompt: 'Use the one requested Bash call, then finish briefly. Never inspect credentials or configuration.', model: 'default', image, writable: true, services: {},
      collect: { paths: ['.'], includeGit: false, maxBytes: 64 * 1024, required: true } } }, maxAgents: 1, outputDir: join(directory, 'core') }));
    report.runtimeId = runtime.id;
    agent = await work.step(() => runtime.spawn({ requestId: 'diagnostic-spawn', profile: 'worker' })); report.agentId = agent.id;
    assert.equal(agent.status, 'idle');
    const active = await work.step(({ timeoutMs, signal }) => ownedContainers(runtime.id, { timeoutMs: Math.min(timeoutMs, 5000), signal }));
    assert.equal(active.length, 1); report.containerIds = active;
    const docker = args => work.step(({ timeoutMs, signal }) => execute('docker', args, { timeout: Math.min(timeoutMs, 5000), signal, maxBuffer: 4096 }));
    report.actualImage = (await docker(['inspect', '--format', '{{.Image}}', active[0]])).stdout.trim(); assert.equal(report.actualImage, image);
    report.piVersion = (await docker(['exec', active[0], 'pi', '--version'])).stdout.trim(); assert.equal(report.piVersion, '1.3.0');
    unsubscribe = runtime.onEvent(event => { if (event.agentId === agent.id) events.push({ type: event.type, seq: event.seq, ...(event.outcome ? { outcome: event.outcome } : {}) }); });
    try {
      const completed = await work.step(({ timeoutMs, signal }) => runInput(runtime, agent.id, diagnosticInput, { requestId: 'diagnostic-input', timeoutMs, signal }));
      result = { kind: 'completed', inputId: completed.inputId, receipt: completed.receipt, outcome: completed.settled.outcome };
    } catch (error) {
      result = { kind: 'failed', inputId: error.inputId, receipt: error.receipt, code: ['input_failed', 'input_aborted', 'input_timeout', 'input_wait_aborted'].includes(error.code) ? error.code : 'DIAGNOSTIC_INPUT_ENDED',
        ...(error.event?.type === 'settled' ? { outcome: error.event.outcome } : {}) };
    }
    report.result = result;
  } catch { report.hostFailure = { code: 'DIAGNOSTIC_HOST_FAILED' }; }
  finally {
    cleanup.start(); report.workExpired = work.expired(); work.finish();
    const hostClose = cleanup.step(() => proxy?.close()).then(() => { report.proxyCleanup = 'complete'; }, () => { report.proxyCleanup = 'pending'; });
    const creation = await work.awaitCreation(); report.creation = work.ownership();
    if (creation.state === 'owned') runtime ??= creation.environment;
    if (runtime) {
      try { close = await cleanup.step(({ timeoutMs }) => runtime.close({ timeoutMs })); report.close = close;
        report.physicallyEmpty = (await cleanup.step(({ timeoutMs, signal }) => ownedContainers(runtime.id, { timeoutMs: Math.min(timeoutMs, 5000), signal }))).length === 0;
        const receipt = close.agents.find(row => row.agentId === agent?.id);
        if (receipt?.execution === 'stopped' && receipt.cleanup === 'complete') {
          const files = receipt.artifacts.find(path => path.endsWith('/artifacts/files'));
          const bytes = await cleanup.step(() => readFile(join(files, diagnosticFilename)));
          report.fileVerified = bytes.equals(Buffer.from(`${diagnosticMarker}\n`));
        }
      } catch { report.cleanupFailure = { code: 'DIAGNOSTIC_CLEANUP_OR_FILE_PENDING' }; }
    }
    await hostClose; unsubscribe?.(); report.events = events; report.upstream = proxy?.receipt();
    report.boundsVerified = verifyDiagnosticBounds(report.upstream);
    report.classification = classifyToolDiagnostic({ receipt: report.upstream, result, fileVerified: report.fileVerified });
    report.cleanupBudget = cleanup.receipt();
    report.failure = Boolean(!report.boundsVerified || report.hostFailure || report.cleanupFailure || report.workExpired || report.cleanupBudget.expired || report.proxyCleanup !== 'complete' ||
      close?.cleanup !== 'complete' || close.agents.some(row => row.execution !== 'stopped' || row.cleanup !== 'complete') || !report.physicallyEmpty || report.classification.status === 'uninformative');
    cleanup.dispose(); work.dispose();
    const secrets = [process.env.MURM_CORE_TEST_API_KEY, ...Object.values(headers)].filter(value => typeof value === 'string' && value)
      .flatMap(value => [value, value.replace(/^(?:Bearer|Basic)\s+/i, '')]).filter(Boolean);
    let serialized = JSON.stringify(report, (_key, value) => typeof value === 'string' ? secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value) : value, 2);
    // Core receipts contain only resource identities/paths; never add raw tool/model text.
    await writeFile(join(directory, 'diagnostic.json'), serialized + '\n', { mode: 0o600 });
  }
  assert.equal(report.failure, false, 'Inspect the private sanitized diagnostic receipt; uninformative is not compatibility');
});
