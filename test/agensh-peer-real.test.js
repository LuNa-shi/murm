import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createAgenshEnvironment } from '../src/environments/agensh/index.js';
import { createPiOpenSandboxBackend } from '../src/core/backends/pi-opensandbox.js';
import { httpClient } from '../src/environments/agensh/http.js';
import { createLocalAgenshStack } from './fixtures/agensh-local-stack.js';
import { createPeerUpstream, peerInputs } from './fixtures/agensh-peer-upstream.js';
import { createWorkGate } from './fixtures/agensh-deadline.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';

const execute = promisify(execFile);
async function bounded(work, milliseconds) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('CLEANUP_WAIT_EXPIRED'), { code: 'CLEANUP_WAIT_EXPIRED' })), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

test('actual single Agensh peer uses trusted Services, native Git and one persistent Session, then exports private work', {
  skip: process.env.SWARMENV_AGENSH_PEER_REAL_TEST !== '1' && 'Two independent exact-pin reviews required before owned local facilities or Bot start', timeout: 420_000,
}, async () => {
  const image = process.env.SWARMENV_CORE_TEST_IMAGE;
  assert.ok(typeof image === 'string' && image.length > 0, 'Pinned agent image required');
  const host = process.env.SWARMENV_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const runId = `accept-${randomBytes(6).toString('hex')}`;
  const directory = join(process.cwd(), 'experiments', `agensh-${runId}`); await mkdir(directory, { recursive: true, mode: 0o700 });
  const report = { schemaVersion: 1, failure: true, image, limits: { setupMs: 180_000, workMs: 120_000, cleanupMs: 80_000, arrivals: 4, bots: 1 }, businessFailure: null, cleanupFailure: null };
  const stack = await createLocalAgenshStack({ directory: join(directory, 'facilities'), advertiseHost: host });
  let environment; let upstream; let deniedServer; let work; let blocker; let workExpired = false; let deniedArrivals = 0;
  let environmentCleanup;
  let coreOwnershipUnknown = false;
  const command = async (name, args) => {
    try { return (await execute(name, args, { timeout: 10_000, maxBuffer: 4 * 1024 ** 2 })).stdout.trim(); }
    catch { throw Object.assign(new Error('ACTUAL_LOCAL_COMMAND_FAILED'), { code: 'ACTUAL_LOCAL_COMMAND_FAILED' }); }
  };
  const sessionIds = async container => (await command('docker', ['exec', container, 'find', '/workspace/runtime/pi-session', '-type', 'f', '-name', '*.jsonl', '-printf', '%f\n'])).split('\n').filter(Boolean).sort();
  try {
    const configuration = await stack.start();
    deniedServer = createServer((request, response) => { deniedArrivals++; request.resume(); response.end('must not reach'); });
    deniedServer.listen(0, '0.0.0.0'); await once(deniedServer, 'listening');
    work = createWorkGate(120_000);
    upstream = await createPeerUpstream({ deniedOrigin: `http://${host}:${deniedServer.address().port}`, onFailure: () => work.abort() }); upstream.start();
    environment = await work.create(() => createAgenshEnvironment({ ...configuration, runId, image, outputDir: join(directory, 'core'), model: 'default', exportLimit: 8 * 1024 ** 2,
      backend: createPiOpenSandboxBackend({ sandbox: { lifecycleBaseUrl: process.env.SWARMENV_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
        endpointHost: process.env.SWARMENV_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', apiKey: process.env.SWARMENV_CORE_TEST_API_KEY, commandTimeoutMs: 20_000, resourceLimits: { cpu: '1', memory: '1Gi' } },
        bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` }, modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 80_000, maxOutputTokens: 128 },
        models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: upstream.url, headers: {} } } },
        isolation: { network: 'local-docker', disk: { bytes: 128 * 1024 ** 2, inodes: 8192 } } }) }));
    report.runtimeId = environment.id; report.botId = environment.peer.id;
    const initial = await ownedContainers(environment.id); assert.equal(initial.length, 1); report.containerId = initial[0];
    report.piVersion = await command('docker', ['exec', initial[0], 'pi', '--version']); assert.equal(report.piVersion, '1.3.0');
    report.agentImageId = await command('docker', ['inspect', '--format', '{{.Image}}', initial[0]]);
    const first = await work.runInput(peerInputs[0], { requestId: 'fixed-peer-first', timeoutMs: 75_000 }); assert.equal(first.settled.output, 'PEER_1_OK');
    const firstSessions = await sessionIds(initial[0]); assert.equal(firstSessions.length, 1);
    const second = await work.runInput(peerInputs[1], { requestId: 'fixed-peer-second', timeoutMs: 30_000 }); assert.equal(second.settled.output, 'PEER_2_OK');
    assert.deepEqual(await ownedContainers(environment.id), initial); assert.deepEqual(await sessionIds(initial[0]), firstSessions); report.sessionIds = firstSessions;
    assert.equal(deniedArrivals, 0);
    const evidence = upstream.receipt().evidence; assert.equal(evidence.length, 2);
    const git = httpClient(configuration.gitea.origin, `token ${configuration.gitea.adminToken}`);
    const mm = httpClient(configuration.mattermost.origin, `Bearer ${configuration.mattermost.adminToken}`);
    const repo = `/api/v1/repos/run-owner/run-${runId}`;
    const branch = await git('GET', `${repo}/branches/peer-${runId}`); assert.equal(branch.commit.id, evidence[0].pushedCommit);
    const pr = await git('GET', `${repo}/pulls/${evidence[0].prNumber}`); assert.equal(pr.head.sha, evidence[0].pushedCommit);
    assert.equal(String(pr.user.id), environment.snapshot().identities.gitea.accountId);
    const remote = await git('GET', `${repo}/contents/acceptance.txt?ref=peer-${runId}`); assert.equal(Buffer.from(remote.content, 'base64').toString(), 'LANDED\n');
    const post = await mm('GET', `/api/v4/posts/${evidence[0].messageId}`); assert.equal(post.user_id, environment.snapshot().identities.message.accountId);
    assert.equal(post.channel_id, environment.snapshot().identities.message.channelId);
    const board = await httpClient(stack.boardOrigin)('GET', `/board/board-${runId}/grep?viewer=worker-${runId}&words=T13%20fixed%20fact`);
    assert.ok(board.entries.some(entry => entry.label === evidence[0].boardLabel && entry.thread_id === environment.snapshot().identities.board.workerId));
    blocker = join(directory, 'core', environment.id, environment.peer.id); await writeFile(blocker, 'required export blocker', { flag: 'wx', mode: 0o600 });
    const pending = await environment.close({ timeoutMs: 20_000 }); assert.equal(pending.cleanup, 'pending'); assert.equal(pending.bots[0].execution, 'stopped');
    assert.ok(pending.bots[0].errors.some(error => error.code === 'ARTIFACT_WRITE_FAILED')); assert.deepEqual(await ownedContainers(environment.id), initial);
    report.requiredExportPending = { execution: pending.bots[0].execution, cleanup: pending.cleanup, containerRetained: true };
    await rm(blocker); blocker = undefined;
    environmentCleanup = await environment.close({ timeoutMs: 30_000 }); assert.equal(environmentCleanup.cleanup, 'complete');
    assert.deepEqual(await ownedContainers(environment.id), []);
    const artifact = environmentCleanup.bots[0].artifacts;
    const files = artifact.find(path => path.endsWith('/artifacts/files'));
    const manifest = JSON.parse(await readFile(artifact.find(path => path.endsWith('/artifacts/manifest.json')), 'utf8'));
    for (const entry of manifest.files) {
      const bytes = await readFile(join(files, entry.path)); assert.equal(bytes.length, entry.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
      assert.equal(environment.redact(bytes.toString('utf8')), bytes.toString('utf8'), 'Archive contains a known plaintext credential');
    }
    assert.equal(await readFile(join(files, 'acceptance.txt'), 'utf8'), 'DIRTY_PRIVATE\n'); assert.equal(await readFile(join(files, 'private.txt'), 'utf8'), 'PRIVATE_COMMIT\n');
    assert.deepEqual(await readFile(join(files, 'untracked.bin')), Buffer.from([0, 255, 65, 10]));
    assert.equal(await command('git', ['-C', files, 'rev-parse', 'HEAD']), evidence[1].privateCommit);
    await command('git', ['-C', files, 'fsck', '--no-reflogs']);
    assert.equal((await git('GET', `${repo}/branches/peer-${runId}`)).commit.id, evidence[0].pushedCommit);
    const coreReport = JSON.parse(await readFile(join(directory, 'core', environment.id, 'runtime.json'), 'utf8'));
    assert.equal(coreReport.evidence.lost, 0); assert.equal(coreReport.evidence.pending, 0);
    const rows = (await readFile(coreReport.evidence.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const serviceRows = rows.filter(row => row.type === 'service' && row.state === 'settled');
    assert.equal(serviceRows.length, 8); assert.ok(serviceRows.every(row => row.outcome === 'succeeded' && row.botId === environment.peer.id && row.profile === 'peer'));
    report.operations = serviceRows.map(({ serviceId, operation, operationId, outcome, botId }) => ({ serviceId, operation, operationId, outcome, botId }));
    report.effectiveConfig = coreReport.config; report.modelLedgerIndexes = coreReport.modelLedgers;
    report.archive = { files: manifest.files.length, bytes: manifest.totalBytes, hashesVerified: true, gitVerified: true, plaintextSecretScan: true };
    report.environment = environment.snapshot(); report.git = { pushedCommit: evidence[0].pushedCommit, privateCommit: evidence[1].privateCommit, prNumber: pr.number };
    report.upstream = upstream.receipt(); assert.equal(report.upstream.arrivals, 4); assert.equal(report.upstream.accepted, 4); assert.equal(report.upstream.failure, undefined); assert.equal(report.upstream.deadlineReached, false);
    work.remaining(); assert.equal(work.expired(), false); work.dispose(); upstream.finish(); report.failure = false;
  } catch (error) { coreOwnershipUnknown = error?.cleanup === 'pending'; report.businessFailure = { code: typeof error?.code === 'string' ? error.code : 'ACTUAL_PEER_ACCEPTANCE_FAILED',
    ...(error.runtimeId ? { runtimeId: error.runtimeId } : {}), ...(error.reportPath ? { reportPath: error.reportPath } : {}), cleanup: error.cleanup }; }
  finally {
    environment ??= work?.environment();
    workExpired = work?.expired() ?? false; work?.dispose();
    try {
      if (blocker) await rm(blocker).catch(() => {});
      if (environment && environmentCleanup?.cleanup !== 'complete') environmentCleanup = await bounded(environment.close({ timeoutMs: 30_000 }), 35_000);
      report.environmentCleanup = environmentCleanup;
    } catch { report.cleanupFailure = { code: 'ENVIRONMENT_CLEANUP_PENDING' }; }
    // Unknown Core ownership retains facility dependencies for reconciliation.
    if ((!environment && !coreOwnershipUnknown) || environmentCleanup?.cleanup === 'complete') {
      try { report.facilityCleanup = await bounded(stack.close(), 45_000); } catch { report.cleanupFailure = { code: 'FACILITY_CLEANUP_PENDING' }; }
    } else report.facilityCleanup = { cleanup: 'pending', dependenciesRetained: true };
    await Promise.allSettled([upstream?.close(), deniedServer ? new Promise(resolve => { deniedServer.close(resolve); deniedServer.closeAllConnections(); }) : undefined]);
    report.workDeadlineExpired = workExpired; report.facilities = stack.receipt();
    if (upstream) report.upstream = upstream.receipt();
    let serialized = JSON.stringify(environment ? environment.redact(report) : report, null, 2);
    for (const secret of stack.secrets) serialized = serialized.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]');
    await writeFile(join(directory, 'acceptance.json'), serialized + '\n', { mode: 0o600 });
  }
  assert.equal(report.failure, false); assert.equal(report.workDeadlineExpired, false); assert.equal(report.businessFailure, null); assert.equal(report.cleanupFailure, null);
  assert.equal(report.environmentCleanup.cleanup, 'complete'); assert.equal(report.facilityCleanup.cleanup, 'complete');
  assert.equal(report.upstream.arrivals, 4); assert.equal(report.upstream.accepted, 4); assert.equal(report.upstream.failure, undefined); assert.equal(report.upstream.deadlineReached, false);
});
