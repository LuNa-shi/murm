import { runtimeSettings } from './fixtures/core-runtime-settings.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createPeerMeshHarness } from '../examples/peermesh/harness/index.js';
import { httpClient } from '../src/harness/http.js';
import { createLocalPeerMeshStack } from './fixtures/peermesh-local-stack.js';
import { createPeerUpstream, peerInputs } from './fixtures/peermesh-peer-upstream.js';
import { createWorkGate, createCleanupBudget } from './fixtures/peermesh-deadline.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';

const execute = promisify(execFile);
test('actual single Agensh peer uses trusted Services, native Git and one persistent Session, then exports private work', {
  skip: process.env.MURM_PEERMESH_PEER_REAL_TEST !== '1' && 'Two independent exact-pin reviews required before owned local facilities or Agent start', timeout: 420_000,
}, async () => {
  const image = process.env.MURM_CORE_TEST_IMAGE;
  assert.ok(typeof image === 'string' && image.length > 0, 'Pinned agent image required');
  const host = process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const runId = `accept-${randomBytes(6).toString('hex')}`;
  const directory = join(process.cwd(), 'experiments', `agensh-${runId}`); await mkdir(directory, { recursive: true, mode: 0o700 });
  const report = { schemaVersion: 1, failure: true, image, limits: { setupMs: 180_000, workMs: 120_000, cleanupMs: 80_000, arrivals: 4, agents: 1 }, businessFailure: null, cleanupFailure: null };
  const stack = await createLocalPeerMeshStack({ directory: join(directory, 'facilities'), advertiseHost: host });
  let harness; let upstream; let deniedServer; let work; let blocker; let workExpired = false; let deniedArrivals = 0;
  const cleanup = createCleanupBudget(80_000);
  let cleanupPhase = false;
  const budget = () => cleanupPhase ? cleanup : work;
  const step = operation => budget().step(operation);
  const containers = id => step(({ timeoutMs, signal }) => ownedContainers(id, { timeoutMs: Math.min(5000, timeoutMs), signal }));
  const request = (client, method, path) => step(({ signal }) => client(method, path, undefined, { signal }));
  let environmentCleanup;
  let coreOwnershipUnknown = false;
  const command = async (name, args) => {
    try { return await budget().step(async ({ timeoutMs, signal }) => (await execute(name, args, { timeout: timeoutMs, signal, maxBuffer: 4 * 1024 ** 2 })).stdout.trim(), 10_000); }
    catch { throw Object.assign(new Error('ACTUAL_LOCAL_COMMAND_FAILED'), { code: 'ACTUAL_LOCAL_COMMAND_FAILED' }); }
  };
  const guardedRead = (...args) => step(() => readFile(...args));
  const sessionIds = async container => (await command('docker', ['exec', container, 'find', '/workspace/runtime/pi-session', '-type', 'f', '-name', '*.jsonl', '-printf', '%f\n'])).split('\n').filter(Boolean).sort();
  try {
    const configuration = await stack.start();
    deniedServer = createServer((request, response) => { deniedArrivals++; request.resume(); response.end('must not reach'); });
    deniedServer.listen(0, '0.0.0.0'); await once(deniedServer, 'listening');
    work = createWorkGate(120_000, 'ACTUAL_PEER_WORK_EXPIRED', cleanup);
    upstream = await createPeerUpstream({ deniedOrigin: `http://${host}:${deniedServer.address().port}`, onFailure: () => work.abort() }); upstream.start();
    harness = await work.create(() => createPeerMeshHarness({ ...configuration, signal: work.signal, runId, image, outputDir: join(directory, 'core'), model: 'default', exportLimit: 8 * 1024 ** 2,
      ...runtimeSettings({ sandbox: { lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
        endpointHost: process.env.MURM_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', apiKey: process.env.MURM_CORE_TEST_API_KEY, commandTimeoutMs: 20_000, resourceLimits: { cpu: '1', memory: '1Gi' } },
        bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` }, modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 80_000, maxOutputTokens: 128 },
        models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: upstream.url, headers: {} } } },
        isolation: { network: 'local-docker', disk: { bytes: 128 * 1024 ** 2, inodes: 8192 } } }) }));
    report.runtimeId = harness.id; report.agentId = harness.peer.id;
    const initial = await containers(harness.id); assert.equal(initial.length, 1); report.containerId = initial[0];
    report.piVersion = await command('docker', ['exec', initial[0], 'pi', '--version']); assert.equal(report.piVersion, '1.3.0');
    report.agentImageId = await command('docker', ['inspect', '--format', '{{.Image}}', initial[0]]);
    const first = await work.runInput(peerInputs[0], { requestId: 'fixed-peer-first', timeoutMs: 75_000 }); assert.equal(first.settled.output, 'PEER_1_OK');
    const firstSessions = await sessionIds(initial[0]); assert.equal(firstSessions.length, 1);
    const second = await work.runInput(peerInputs[1], { requestId: 'fixed-peer-second', timeoutMs: 30_000 }); assert.equal(second.settled.output, 'PEER_2_OK');
    assert.deepEqual(await containers(harness.id), initial); assert.deepEqual(await sessionIds(initial[0]), firstSessions); report.sessionIds = firstSessions;
    assert.equal(deniedArrivals, 0);
    const evidence = upstream.receipt().evidence; assert.equal(evidence.length, 2);
    const git = httpClient(configuration.gitea.origin, `token ${configuration.gitea.adminToken}`);
    const mm = httpClient(configuration.mattermost.origin, `Bearer ${configuration.mattermost.adminToken}`);
    const repo = `/api/v1/repos/run-owner/run-${runId}`;
    const branch = await request(git, 'GET', `${repo}/branches/peer-${runId}`); assert.equal(branch.commit.id, evidence[0].pushedCommit);
    const pr = await request(git, 'GET', `${repo}/pulls/${evidence[0].prNumber}`); assert.equal(pr.head.sha, evidence[0].pushedCommit);
    assert.equal(String(pr.user.id), harness.snapshot().identities.gitea.accountId);
    const remote = await request(git, 'GET', `${repo}/contents/acceptance.txt?ref=peer-${runId}`); assert.equal(Buffer.from(remote.content, 'base64').toString(), 'LANDED\n');
    const post = await request(mm, 'GET', `/api/v4/posts/${evidence[0].messageId}`); assert.equal(post.user_id, harness.snapshot().identities.message.accountId);
    assert.equal(post.channel_id, harness.snapshot().identities.message.channelId);
    const board = await request(httpClient(stack.boardOrigin), 'GET', `/board/board-${runId}/grep?viewer=worker-${runId}&words=T13%20fixed%20fact`);
    assert.ok(board.entries.some(entry => entry.label === evidence[0].boardLabel && entry.thread_id === harness.snapshot().identities.board.workerId));
    work.remaining(); upstream.finish(); work.finish(); cleanupPhase = true;
    blocker = join(directory, 'core', harness.id, harness.peer.id); await step(() => writeFile(blocker, 'required export blocker', { flag: 'wx', mode: 0o600 }));
    const pending = await cleanup.step(({ timeoutMs }) => harness.close({ timeoutMs }), 20_000); assert.equal(pending.cleanup, 'pending'); assert.equal(pending.agents[0].execution, 'stopped');
    assert.ok(pending.agents[0].errors.some(error => error.code === 'ARTIFACT_WRITE_FAILED')); assert.deepEqual(await containers(harness.id), initial);
    report.requiredExportPending = { execution: pending.agents[0].execution, cleanup: pending.cleanup, containerRetained: true };
    await step(() => rm(blocker)); blocker = undefined;
    environmentCleanup = await cleanup.step(({ timeoutMs }) => harness.close({ timeoutMs }), 30_000); assert.equal(environmentCleanup.cleanup, 'complete');
    assert.deepEqual(await containers(harness.id), []);
    const artifact = environmentCleanup.agents[0].artifacts;
    const files = artifact.find(path => path.endsWith('/artifacts/files'));
    const manifest = JSON.parse(await guardedRead(artifact.find(path => path.endsWith('/artifacts/manifest.json')), 'utf8'));
    for (const entry of manifest.files) {
      const bytes = await guardedRead(join(files, entry.path)); assert.equal(bytes.length, entry.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
      assert.equal(harness.redact(bytes.toString('utf8')), bytes.toString('utf8'), 'Archive contains a known plaintext credential');
    }
    assert.equal(await guardedRead(join(files, 'acceptance.txt'), 'utf8'), 'DIRTY_PRIVATE\n'); assert.equal(await guardedRead(join(files, 'private.txt'), 'utf8'), 'PRIVATE_COMMIT\n');
    assert.deepEqual(await guardedRead(join(files, 'untracked.bin')), Buffer.from([0, 255, 65, 10]));
    assert.equal(await command('git', ['-C', files, 'rev-parse', 'HEAD']), evidence[1].privateCommit);
    await command('git', ['-C', files, 'fsck', '--no-reflogs']);
    assert.equal((await request(git, 'GET', `${repo}/branches/peer-${runId}`)).commit.id, evidence[0].pushedCommit);
    const coreReport = JSON.parse(await guardedRead(join(directory, 'core', harness.id, 'runtime.json'), 'utf8'));
    assert.equal(coreReport.evidence.lost, 0); assert.equal(coreReport.evidence.pending, 0);
    const rows = (await guardedRead(coreReport.evidence.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const serviceRows = rows.filter(row => row.type === 'service' && row.state === 'settled');
    assert.equal(serviceRows.length, 8); assert.ok(serviceRows.every(row => row.outcome === 'succeeded' && row.agentId === harness.peer.id && row.profile === 'peer'));
    report.operations = serviceRows.map(({ serviceId, operation, operationId, outcome, agentId }) => ({ serviceId, operation, operationId, outcome, agentId }));
    report.effectiveConfig = coreReport.config; report.modelLedgerIndexes = coreReport.modelLedgers;
    report.archive = { files: manifest.files.length, bytes: manifest.totalBytes, hashesVerified: true, gitVerified: true, plaintextSecretScan: true };
    report.harness = harness.snapshot(); report.git = { pushedCommit: evidence[0].pushedCommit, privateCommit: evidence[1].privateCommit, prNumber: pr.number };
    report.upstream = upstream.receipt(); assert.equal(report.upstream.arrivals, 4); assert.equal(report.upstream.accepted, 4); assert.equal(report.upstream.failure, undefined); assert.equal(report.upstream.deadlineReached, false);
    assert.equal(work.expired(), false); report.failure = false;
  } catch (error) { cleanup.start(); coreOwnershipUnknown = error?.cleanup === 'pending'; report.businessFailure = { code: typeof error?.code === 'string' ? error.code : 'ACTUAL_PEER_ACCEPTANCE_FAILED',
    ...(error.runtimeId ? { runtimeId: error.runtimeId } : {}), ...(error.reportPath ? { reportPath: error.reportPath } : {}), cleanup: error.cleanup }; }
  finally {
    cleanupPhase = true; cleanup.start(); upstream?.finish();
    const hostCleanup = cleanup.step(() => Promise.all([upstream?.close(), deniedServer ? new Promise(resolve => { deniedServer.close(resolve); deniedServer.closeAllConnections(); }) : undefined]))
      .then(() => { report.hostCleanup = 'complete'; }, () => { report.hostCleanup = 'pending'; });
    workExpired = work?.expired() ?? false; work?.finish();
    // Await only within the already-running cleanup window. A pending factory
    // may still own mutations/Core; its late completion never authorizes teardown.
    if (work) {
      const creation = await work.awaitCreation();
      report.creation = work.ownership();
      if (creation.state === 'owned') harness ??= creation.harness;
      coreOwnershipUnknown ||= creation.state === 'pending' || creation.error?.cleanup === 'pending';
    }
    try {
      if (blocker) await cleanup.step(() => rm(blocker));
      if (harness && environmentCleanup?.cleanup !== 'complete') environmentCleanup = await cleanup.step(({ timeoutMs }) => harness.close({ timeoutMs }), 30_000);
      report.environmentCleanup = environmentCleanup;
    } catch { report.cleanupFailure = { code: 'ENVIRONMENT_CLEANUP_PENDING' }; }
    // Unknown Core ownership retains facility dependencies for reconciliation.
    if ((!harness && !coreOwnershipUnknown) || environmentCleanup?.cleanup === 'complete') {
      try { report.facilityCleanup = await cleanup.step(() => stack.close(cleanup)); } catch { report.cleanupFailure = { code: 'FACILITY_CLEANUP_PENDING' }; report.facilityCleanup = { cleanup: 'pending', dependenciesRetained: true }; }
    } else report.facilityCleanup = { cleanup: 'pending', dependenciesRetained: true };
    await hostCleanup;
    report.cleanupBudget = cleanup.receipt();
    report.failure ||= report.cleanupBudget.expired || report.facilityCleanup?.cleanup !== 'complete' || Boolean(report.cleanupFailure) || report.hostCleanup !== 'complete';
    cleanup.dispose(); work?.dispose();
    report.workDeadlineExpired = workExpired; report.facilities = stack.receipt();
    if (upstream) report.upstream = upstream.receipt();
    let serialized = JSON.stringify(harness ? harness.redact(report) : report, null, 2);
    for (const secret of stack.secrets) serialized = serialized.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]');
    await writeFile(join(directory, 'acceptance.json'), serialized + '\n', { mode: 0o600 });
  }
  assert.equal(report.failure, false); assert.equal(report.workDeadlineExpired, false); assert.equal(report.businessFailure, null); assert.equal(report.cleanupFailure, null);
  assert.equal(report.environmentCleanup.cleanup, 'complete'); assert.equal(report.facilityCleanup.cleanup, 'complete');
  assert.equal(report.upstream.arrivals, 4); assert.equal(report.upstream.accepted, 4); assert.equal(report.upstream.failure, undefined); assert.equal(report.upstream.deadlineReached, false);
});
