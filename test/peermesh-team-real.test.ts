import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPeerMeshTeam } from '../src/harnesses/peermesh/team.js';
import { preparePeerMeshFacilities } from '../src/harnesses/peermesh/provision.js';
import { createPeerMeshDelivery } from '../src/harnesses/peermesh/delivery.js';
import { createPiOpenSandboxBackend } from '../src/core/backends/pi-opensandbox.js';
import { httpClient } from '../src/harnesses/peermesh/http.js';
import { createLocalPeerMeshStack } from './fixtures/peermesh-local-stack.js';
import { createTeamUpstream, teamInputs, teamFact, eightPeerKeys, latePeerInput } from './fixtures/peermesh-team-upstream.js';
import { createWorkGate, createCleanupBudget } from './fixtures/peermesh-deadline.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { sessionEvidence } from './fixtures/core-session-evidence.js';
const execute = promisify(execFile);

for (const [peerKeys, optIn] of [[['a', 'b'], 'MURM_PEERMESH_TEAM_REAL_TEST'], [eightPeerKeys, 'MURM_PEERMESH_EIGHT_REAL_TEST']])
test(`${peerKeys.length} native Agensh peers negotiate claims and merge adopted contributions in one Core`, {
  skip: process.env[optIn] !== '1' && 'Requires two independent source/image/fixture reviews', timeout: 480_000,
}, async () => {
  const image = process.env.MURM_CORE_TEST_IMAGE; assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  const host = process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const runId = `team-${randomBytes(6).toString('hex')}`, directory = join(process.cwd(), 'experiments', `agensh-${runId}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const cleanup = createCleanupBudget(100_000), stack = await createLocalPeerMeshStack({ directory: join(directory, 'facilities'), advertiseHost: host });
  const report = { failure: true, hosted: 0, image, limits: { setupMs: 180_000, workMs: 180_000, cleanupMs: 100_000, agents: peerKeys.length, inputs: peerKeys.length === 8 ? 12 : 5, arrivals: peerKeys.length === 8 ? 24 : 10, outputTokens: 128 } };
  let work, upstream, harness, environmentCleanup, facilities, delivery, cleanupPhase = false, ownershipUnknown = false;
  const budget = () => cleanupPhase ? cleanup : work;
  const command = (name, args) => budget().step(({ timeoutMs, signal }) => execute(name, args, { timeout: Math.min(timeoutMs, 10_000), signal, maxBuffer: 2 * 1024 ** 2 }));
  const containers = () => budget().step(({ timeoutMs, signal }) => ownedContainers(harness.id, { timeoutMs: Math.min(timeoutMs, 5000), signal }));
  try {
    const configuration = await stack.start();
    work = createWorkGate(180_000, 'ACTUAL_TEAM_WORK_EXPIRED', cleanup);
    upstream = await createTeamUpstream({ deadlineAt: work.deadlineAt, peerKeys, peerNames: { a: `peer-${runId}-a`, b: `peer-${runId}-b` }, onFailure: () => work.abort() });
    harness = await work.create(() => createPeerMeshTeam({ ...configuration, runId, image, peerKeys, signal: work.signal, outputDir: join(directory, 'core'),
      prepare: async options => { facilities = await preparePeerMeshFacilities(options); return facilities; },
      router: { workTimeoutMs: work.remaining(), turnTimeoutMs: 80_000, maxBatches: 8, maxNudges: 0, events: { pollIntervalMs: 1000, maxPolls: 180 } },
      backend: createPiOpenSandboxBackend({ sandbox: { lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1', endpointHost: process.env.MURM_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', apiKey: process.env.MURM_CORE_TEST_API_KEY, commandTimeoutMs: 20_000, resourceLimits: { cpu: '1', memory: '1Gi' } },
        bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` }, modelGateway: { host: '0.0.0.0', advertiseHost: host, maxOutputTokens: 128, requestTimeoutMs: 85_000 },
        models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: upstream.url, headers: {} } } }, isolation: { network: 'local-docker', disk: { bytes: 128 * 1024 ** 2, inodes: 8192 } } }) }));
    report.runtimeId = harness.id; report.initial = harness.snapshot();
    const owned = await containers(); assert.equal(owned.length, peerKeys.length); report.containers = owned;
    assert.deepEqual(report.initial.peers.map(peer => peer.key), peerKeys);
    assert.ok(report.initial.peers.every(peer => peer.router.ready && peer.subscription.ready));
    assert.equal(new Set(report.initial.peers.map(peer => peer.agentId)).size, peerKeys.length);
    for (const service of ['gitea', 'message', 'board']) {
      assert.equal(new Set(report.initial.identities.map(identity => identity[service].binding)).size, peerKeys.length);
    }
    assert.equal(new Set(facilities.peers.map(peer => peer.branch)).size, peerKeys.length);
    for (const id of owned) { assert.equal((await command('docker', ['exec', id, 'pi', '--version'])).stdout.trim(), '1.3.0'); assert.equal((await command('docker', ['inspect', '--format', '{{.Image}}', id])).stdout.trim(), image); }
    const wait = (key, batch) => work.step(({ timeoutMs, signal }) => harness.wait(key, batch.batchId, { timeoutMs: Math.min(timeoutMs, 80_000), signal }));
    const a = harness.kickoff('a', teamInputs[0]), b = harness.kickoff('b', teamInputs[1]);
    assert.equal((await wait('a', a)).state, 'completed'); assert.equal((await wait('b', b)).state, 'completed');
    for (const key of peerKeys.slice(2)) {
      const batch = harness.kickoff(key, `T15_KICK_${key.toUpperCase()}`);
      assert.equal((await wait(key, batch)).state, 'completed');
    }
    report.sessionsInitial = await Promise.all(owned.map(id => sessionEvidence(id, command)));
    async function findCompleted(key, marker) {
      return work.step(async () => {
        while (true) {
          work.remaining(); await harness.poll();
          const batch = harness.snapshot().peers.find(peer => peer.key === key).router.batches.find(row => row.text.includes(marker));
          if (batch) return wait(key, batch);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      });
    }
    assert.equal((await findCompleted('a', teamInputs[2])).state, 'completed');
    assert.equal((await findCompleted('b', teamInputs[3])).state, 'completed');
    delivery = createPeerMeshDelivery({ facilities, adminToken: configuration.gitea.adminToken });
    for (const key of ['a', 'b']) {
      const result = upstream.receipt().evidence.find(row => row.stage === `${key}-contribution`); assert.ok(result);
      await work.step(({ signal }) => delivery.merge({ peerKey: key, number: result.prNumber, headSha: result.head, signal }));
    }
    for (const [path, expected] of [['left.txt', 'T15_LEFT_ACCEPTED\n'], ['right.txt', `T15_RIGHT_ADOPTED ${teamFact}\n`]]) {
      const result = await work.step(({ signal }) => delivery.readMainFile(path, { signal })); assert.equal(result.data.toString(), expected);
    }
    report.delivery = delivery.snapshot(); assert.ok(report.delivery.every(row => row.state === 'merged'));
    const git = httpClient(configuration.gitea.origin, `token ${configuration.gitea.adminToken}`);
    const comment = await work.step(({ signal }) => git('POST', `/api/v1/repos/run-owner/run-${runId}/issues/${facilities.issueNumber}/comments`, { body: `@peer-${runId}-a ${teamInputs[4]}` }, { signal }));
    assert.ok(Number.isSafeInteger(comment.id)); assert.equal((await findCompleted('a', teamInputs[4])).state, 'completed');
    if (peerKeys.length === 8) {
      const late = await work.step(({ signal }) => git('POST', `/api/v1/repos/run-owner/run-${runId}/issues/${facilities.issueNumber}/comments`, { body: `@peer-${runId}-h ${latePeerInput}` }, { signal }));
      assert.ok(Number.isSafeInteger(late.id));
      assert.equal((await findCompleted('h', latePeerInput)).state, 'completed');
      const result = upstream.receipt().evidence.find(row => row.stage === 'h-contribution'); assert.ok(result);
      await work.step(({ signal }) => delivery.merge({ peerKey: 'h', number: result.prNumber, headSha: result.head, signal }));
      const adopted = await work.step(({ signal }) => delivery.readMainFile('eight-h.txt', { signal }));
      assert.equal(adopted.data.toString(), `T15_EIGHT_ADOPTED ${teamFact}\n`);
      report.latePeer = { key: 'h', eventId: `comment:${late.id}`, head: result.head, prNumber: result.prNumber };
    }
    await work.step(() => harness.poll()); await work.step(() => harness.poll());
    report.harness = harness.snapshot();
    assert.equal(report.harness.peers[0].router.batches.length, 3); assert.equal(report.harness.peers[1].router.batches.length, 2);
    assert.equal(report.harness.peers[1].subscription.records.some(row => row.eventId === `comment:${comment.id}`), false);
    if (peerKeys.length === 8) {
      assert.deepEqual(report.harness.peers.map(peer => peer.router.batches.length), [3, 2, 1, 1, 1, 1, 1, 2]);
      assert.ok(report.harness.peers.slice(0, -1).every(peer => !peer.subscription.records.some(row => row.eventId === report.latePeer.eventId)));
      const h = report.harness.peers.at(-1);
      assert.equal(h.subscription.records.filter(row => row.eventId === report.latePeer.eventId).length, 1);
    }
    report.sessionsFinal = await Promise.all(owned.map(id => sessionEvidence(id, command))); assert.deepEqual(report.sessionsFinal, report.sessionsInitial);
    const evidence = upstream.receipt().evidence;
    assert.equal(new Set(report.sessionsInitial.map(row => row.sessionId)).size, peerKeys.length);
    for (const key of peerKeys) { const rounds = evidence.filter(row => row.stage.startsWith(`${key}-`)); assert.ok(rounds.every(row => row.cwd === rounds[0].cwd && row.branch === rounds[0].branch && JSON.stringify(row.pi) === JSON.stringify(rounds[0].pi))); }
    assert.equal(new Set(evidence.map(row => row.branch)).size, peerKeys.length);
    work.remaining(); work.finish(); cleanupPhase = true;
    environmentCleanup = await cleanup.step(({ timeoutMs }) => harness.close({ timeoutMs }), 60_000);
    assert.equal(environmentCleanup.cleanup, 'complete'); assert.equal(environmentCleanup.agents.length, peerKeys.length);
    assert.ok(environmentCleanup.agents.every(agent => agent.execution === 'stopped' && agent.cleanup === 'complete'));
    assert.deepEqual(await containers(), []);
    const aAgent = report.harness.peers.find(peer => peer.key === 'a').agentId;
    const files = environmentCleanup.agents.find(agent => agent.agentId === aAgent).artifacts.find(path => path.endsWith('/artifacts/files'));
    assert.deepEqual(await cleanup.step(() => readFile(join(files, 'untracked.bin'))), Buffer.from([0, 255, 65, 10]));
    assert.equal(await cleanup.step(() => readFile(join(files, 'left.txt'), 'utf8')), 'T15_DIRTY_PRIVATE\n');
    const event = JSON.parse(await cleanup.step(() => readFile(join(files, 'user-event.json'), 'utf8'))); assert.equal(event.event.eventId, `comment:${comment.id}`);
    await command('git', ['-C', files, 'fsck', '--full']);
    assert.equal((await command('git', ['-C', files, 'rev-parse', 'HEAD'])).stdout.trim(), event.privateHead);
    assert.equal((await command('git', ['-C', files, 'rev-parse', `origin/${event.branch}`])).stdout.trim(), event.publicHead);
    const boardRead = await cleanup.step(({ signal }) => httpClient(facilities.endpoints.board)('GET', `/board/${facilities.boardId}/read?viewer=${facilities.peers[1].board.workerId}`, undefined, { signal }));
    assert.ok(boardRead.rendered.includes(teamFact));
    const messages = await cleanup.step(({ signal }) => httpClient(configuration.mattermost.origin, `Bearer ${configuration.mattermost.adminToken}`)('GET', `/api/v4/channels/${facilities.channelId}/posts?page=0&per_page=50`, undefined, { signal }));
    assert.ok(Object.values(messages.posts).some(row => row.message.includes(teamInputs[2])));
    assert.ok(Object.values(messages.posts).some(row => row.message.includes(teamInputs[3])));
    const publicRead = await cleanup.step(({ signal }) => delivery.readMainFile('right.txt', { signal })); assert.equal(publicRead.data.toString(), `T15_RIGHT_ADOPTED ${teamFact}\n`);
    for (const peer of report.harness.peers) {
      const archived = environmentCleanup.agents.find(agent => agent.agentId === peer.agentId).artifacts.find(path => path.endsWith('/artifacts/files'));
      const initial = JSON.parse(await cleanup.step(() => readFile(join(archived, '.team-state.json'), 'utf8')));
      assert.deepEqual(initial, evidence.find(row => row.stage === `${peer.key}-initial`));
      assert.equal(initial.branch, facilities.peers.find(row => row.key === peer.key).branch);
      if (peer.key === 'h') {
        const result = JSON.parse(await cleanup.step(() => readFile(join(archived, 'contribution.json'), 'utf8')));
        assert.deepEqual(result, evidence.find(row => row.stage === 'h-contribution'));
        assert.equal(result.content, `T15_EIGHT_ADOPTED ${teamFact}\n`);
        assert.equal(result.event.eventId, report.latePeer.eventId);
      }
    }
    assert.ok(harness.snapshot().peers.every(peer => peer.subscription.closed));
    assert.equal(upstream.receipt().arrivals, report.limits.arrivals); assert.equal(upstream.receipt().accepted, report.limits.arrivals); assert.equal(upstream.receipt().failure, undefined);
    report.archived = { binaryVerified: true, dirtyVerified: true, gitVerified: true, targetedEventVerified: true }; report.failure = false;
  } catch (error) {
    cleanup.start(); ownershipUnknown = error.cleanup === 'pending';
    const fixtureFailure = upstream?.receipt().failure;
    report.businessFailure = { code: fixtureFailure?.code ?? (typeof error.code === 'string' ? error.code : 'ACTUAL_TEAM_FAILED'),
      ...(fixtureFailure ? { fixtureFailure } : {}), cleanup: error.cleanup };
  }
  finally {
    report.delivery = delivery?.snapshot();
    cleanup.start(); cleanupPhase = true; report.workExpired = work?.expired() ?? false; work?.finish();
    const hostCleanup = cleanup.step(() => upstream?.close()).then(() => { report.hostCleanup = 'complete'; }, () => { report.hostCleanup = 'pending'; });
    if (work) { const creation = await work.awaitCreation(); report.creation = work.ownership(); if (creation.state === 'owned') harness ??= creation.harness; ownershipUnknown ||= creation.state === 'pending' || creation.error?.cleanup === 'pending'; }
    try { if (harness && environmentCleanup?.cleanup !== 'complete') environmentCleanup = await cleanup.step(({ timeoutMs }) => harness.close({ timeoutMs }), 60_000); } catch { report.cleanupFailure = { code: 'TEAM_CLEANUP_PENDING' }; }
    report.environmentCleanup = environmentCleanup;
    if ((!harness && !ownershipUnknown) || environmentCleanup?.cleanup === 'complete') { try { report.facilityCleanup = await cleanup.step(() => stack.close(cleanup)); } catch { report.facilityCleanup = { cleanup: 'pending' }; } }
    else report.facilityCleanup = { cleanup: 'pending', dependenciesRetained: true };
    await hostCleanup; report.cleanupBudget = cleanup.receipt(); report.facilities = stack.receipt(); report.upstream = upstream?.receipt();
    report.failure ||= report.workExpired || report.cleanupBudget.expired || report.facilityCleanup?.cleanup !== 'complete' || report.hostCleanup !== 'complete' || Boolean(report.cleanupFailure);
    cleanup.dispose(); work?.dispose(); let body = JSON.stringify(harness ? harness.redact(report) : report, null, 2);
    for (const secret of stack.secrets) body = body.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]');
    await writeFile(join(directory, 'acceptance.json'), body + '\n', { mode: 0o600 });
  }
  assert.equal(report.failure, false); assert.equal(report.environmentCleanup.cleanup, 'complete'); assert.equal(report.facilityCleanup.cleanup, 'complete');
});
