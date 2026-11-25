import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPeerMeshRouterHarness } from '../src/harnesses/peermesh/routed.js';
import { createPiOpenSandboxBackend } from '../src/core/backends/pi-opensandbox.js';
import { httpClient } from '../src/harnesses/peermesh/http.js';
import { createLocalAgenshStack } from './fixtures/agensh-local-stack.js';
import { createRouterUpstream, routerInputs } from './fixtures/agensh-router-upstream.js';
import { createWorkGate, createCleanupBudget } from './fixtures/agensh-deadline.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { sessionEvidence } from './fixtures/core-session-evidence.js';
const execute = promisify(execFile);

test('actual Agensh PR comment and targeted user input cross one serial router into the original peer Session', {
  skip: process.env.SWARMENV_AGENSH_ROUTER_REAL_TEST !== '1' && 'Two independent exact source/image reviews required; owned local facilities only', timeout: 420_000,
}, async () => {
  const image = process.env.SWARMENV_CORE_TEST_IMAGE; assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  const host = process.env.SWARMENV_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const runId = `router-${randomBytes(6).toString('hex')}`, directory = join(process.cwd(), 'experiments', `agensh-${runId}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const cleanup = createCleanupBudget(80_000), stack = await createLocalAgenshStack({ directory: join(directory, 'facilities'), advertiseHost: host });
  const report = { failure: true, limits: { setupMs: 180_000, workMs: 120_000, cleanupMs: 80_000, bots: 1, inputs: 3, arrivals: 6, outputTokens: 128 }, image, hosted: null };
  let work, upstream, environment, environmentCleanup, denied, ownershipUnknown = false, cleanupPhase = false, deniedArrivals = 0;
  const budget = () => cleanupPhase ? cleanup : work;
  const step = fn => budget().step(fn);
  const containers = id => step(({ timeoutMs, signal }) => ownedContainers(id, { timeoutMs: Math.min(timeoutMs, 5000), signal }));
  const command = (name, args) => step(({ timeoutMs, signal }) => execute(name, args, { timeout: Math.min(timeoutMs, 5000), signal, maxBuffer: 1024 ** 2 }));
  try {
    const configuration = await stack.start();
    denied = createServer((request, response) => { deniedArrivals++; request.resume(); response.end('denied'); }); denied.listen(0, '0.0.0.0'); await once(denied, 'listening');
    work = createWorkGate(120_000, 'ACTUAL_ROUTER_WORK_EXPIRED', cleanup);
    upstream = await createRouterUpstream({ deadlineAt: work.deadlineAt, deniedOrigin: `http://${host}:${denied.address().port}`, onFailure: () => work.abort() });
    environment = await work.create(() => createPeerMeshRouterHarness({ ...configuration, runId, image, signal: work.signal, exportLimit: 8 * 1024 ** 2, outputDir: join(directory, 'core'),
      router: { workTimeoutMs: work.remaining(), turnTimeoutMs: 75_000, maxNudges: 0, maxBatches: 8, events: { pollIntervalMs: 1000, maxPolls: 120 } },
      backend: createPiOpenSandboxBackend({ sandbox: { lifecycleBaseUrl: process.env.SWARMENV_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1', endpointHost: process.env.SWARMENV_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', apiKey: process.env.SWARMENV_CORE_TEST_API_KEY, commandTimeoutMs: 20_000, resourceLimits: { cpu: '1', memory: '1Gi' } },
        bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` }, modelGateway: { host: '0.0.0.0', advertiseHost: host, maxOutputTokens: 128, requestTimeoutMs: 80_000 },
        models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: upstream.url, headers: {} } } }, isolation: { network: 'local-docker', disk: { bytes: 128 * 1024 ** 2, inodes: 8192 } } }) }));
    report.runtimeId = environment.id; report.botId = environment.peer.id; report.initial = environment.snapshot();
    const initial = await containers(environment.id); assert.equal(initial.length, 1); report.containerId = initial[0];
    assert.equal((await command('docker', ['exec', initial[0], 'pi', '--version'])).stdout.trim(), '1.3.0');
    report.agentImageId = (await command('docker', ['inspect', '--format', '{{.Image}}', initial[0]])).stdout.trim(); assert.equal(report.agentImageId, image);
    const wait = row => work.step(({ timeoutMs, signal }) => environment.wait(row.batchId, { timeoutMs: Math.min(timeoutMs, 75_000), signal }));
    const first = await wait(environment.kickoff(routerInputs[0])); assert.equal(first.settled.output, 'ROUTER_1_OK');
    const sessions = [await sessionEvidence(initial[0], command)];
    const git = httpClient(configuration.gitea.origin, `token ${configuration.gitea.adminToken}`), repo = `/api/v1/repos/run-owner/run-${runId}`;
    const pr = upstream.receipt().evidence[0].prNumber;
    const comment = await work.step(({ signal }) => git('POST', `${repo}/issues/${pr}/comments`, { body: routerInputs[1] }, { signal })); assert.ok(Number.isSafeInteger(comment.id));
    await work.step(() => environment.poll());
    const eventId = `comment:${comment.id}`;
    const external = environment.snapshot().router.batches.find(row => row.source === 'gitea' && row.eventId === eventId); assert.ok(external);
    assert.equal((await wait(external)).settled.output, 'ROUTER_2_OK'); sessions.push(await sessionEvidence(initial[0], command));
    await work.step(() => environment.poll());
    assert.equal(environment.snapshot().router.batches.filter(row => row.eventId === eventId).length, 1);
    const mm = httpClient(configuration.mattermost.origin, `Bearer ${configuration.mattermost.adminToken}`);
    const channel = environment.snapshot().identities.message.channelId;
    const post = await work.step(({ signal }) => mm('POST', '/api/v4/posts', { channel_id: channel, message: `@peer-${runId} ${routerInputs[2]}` }, { signal }));
    assert.equal(typeof post.id, 'string'); await work.step(() => environment.poll());
    const user = environment.snapshot().router.batches.find(row => row.source === 'mattermost' && row.eventId === `post:${post.id}`);
    assert.ok(user); assert.equal(user.kind, 'mention'); assert.equal(user.targetWorker, environment.snapshot().router.mapping.workerId);
    report.user = { eventId: user.eventId, batchId: user.batchId, targetWorker: user.targetWorker, deliveredThroughSubscription: environment.snapshot().subscription.records.some(row => row.eventId === user.eventId && row.batchId === user.batchId) };
    assert.equal(report.user.deliveredThroughSubscription, true);
    assert.equal((await wait(user)).settled.output, 'ROUTER_3_OK'); sessions.push(await sessionEvidence(initial[0], command));
    assert.deepEqual(sessions, [sessions[0], sessions[0], sessions[0]]); assert.deepEqual(await containers(environment.id), initial); assert.equal(deniedArrivals, 0);
    report.sessions = sessions; report.external = { eventId, batchId: external.batchId, prNumber: pr, deliveredThroughSubscription: environment.snapshot().subscription.records.some(row => row.eventId === eventId && row.batchId === external.batchId) };
    assert.equal(report.external.deliveredThroughSubscription, true);
    report.environment = environment.snapshot(); assert.equal(report.environment.router.batches.length, 3);
    assert.ok(report.environment.router.batches.every(row => row.state === 'completed' && row.receipt.status === 'accepted' && row.receipt.disposition === 'started' && row.settled.outcome === 'completed'));
    work.remaining(); work.finish(); cleanupPhase = true;
    environmentCleanup = await cleanup.step(({ timeoutMs }) => environment.close({ timeoutMs }), 30_000); assert.equal(environmentCleanup.cleanup, 'complete'); assert.deepEqual(await containers(environment.id), []);
    const files = environmentCleanup.bots[0].artifacts.find(path => path.endsWith('/artifacts/files'));
    const eventProof = JSON.parse(await step(() => readFile(join(files, 'router-event.json'), 'utf8'))); assert.equal(eventProof.event.eventId, eventId); assert.equal(eventProof.event.batchId, external.batchId);
    assert.deepEqual(await step(() => readFile(join(files, 'untracked.bin'))), Buffer.from([0, 255, 65, 10]));
    report.archivedEventVerified = true; assert.equal(upstream.receipt().arrivals, 6); assert.equal(upstream.receipt().accepted, 6); assert.equal(upstream.receipt().failure, undefined);
    assert.equal(work.expired(), false); report.failure = false;
  } catch (error) { cleanup.start(); ownershipUnknown = error.cleanup === 'pending'; report.businessFailure = { code: typeof error.code === 'string' ? error.code : 'ACTUAL_ROUTER_FAILED', cleanup: error.cleanup }; }
  finally {
    cleanup.start(); cleanupPhase = true; report.workExpired = work?.expired() ?? false; work?.finish();
    const hostCleanup = cleanup.step(() => Promise.all([upstream?.close(), denied ? new Promise(resolve => { denied.close(resolve); denied.closeAllConnections(); }) : undefined])).then(() => { report.hostCleanup = 'complete'; }, () => { report.hostCleanup = 'pending'; });
    if (work) { const creation = await work.awaitCreation(); report.creation = work.ownership(); if (creation.state === 'owned') environment ??= creation.environment; ownershipUnknown ||= creation.state === 'pending' || creation.error?.cleanup === 'pending'; }
    try { if (environment && environmentCleanup?.cleanup !== 'complete') environmentCleanup = await cleanup.step(({ timeoutMs }) => environment.close({ timeoutMs }), 30_000); } catch { report.cleanupFailure = { code: 'ROUTER_ENVIRONMENT_CLEANUP_PENDING' }; }
    report.environmentCleanup = environmentCleanup;
    if ((!environment && !ownershipUnknown) || environmentCleanup?.cleanup === 'complete') { try { report.facilityCleanup = await cleanup.step(() => stack.close(cleanup)); } catch { report.facilityCleanup = { cleanup: 'pending' }; } }
    else report.facilityCleanup = { cleanup: 'pending', dependenciesRetained: true };
    await hostCleanup; report.cleanupBudget = cleanup.receipt(); report.facilities = stack.receipt(); report.upstream = upstream?.receipt();
    report.failure ||= report.workExpired || report.cleanupBudget.expired || report.facilityCleanup?.cleanup !== 'complete' || report.hostCleanup !== 'complete' || Boolean(report.cleanupFailure);
    cleanup.dispose(); work?.dispose();
    let serialized = JSON.stringify(environment ? environment.redact(report) : report, null, 2);
    for (const secret of stack.secrets) serialized = serialized.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]');
    await writeFile(join(directory, 'acceptance.json'), serialized + '\n', { mode: 0o600 });
  }
  assert.equal(report.failure, false); assert.equal(report.workExpired, false); assert.equal(report.environmentCleanup.cleanup, 'complete'); assert.equal(report.facilityCleanup.cleanup, 'complete');
});
