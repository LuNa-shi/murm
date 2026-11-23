import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAgenshTeam } from '../src/environments/agensh/team.js';
import { prepareAgenshFacilities } from '../src/environments/agensh/provision.js';
import { createAgenshDelivery } from '../src/environments/agensh/delivery.js';
import { createAgenshEventSubscription } from '../src/environments/agensh/event-source.js';
import { createPiOpenSandboxBackend } from '../src/core/backends/pi-opensandbox.js';
import { httpClient } from '../src/environments/agensh/http.js';
import { createLocalAgenshStack } from './fixtures/agensh-local-stack.js';
import { createCappedUpstream } from './fixtures/core-capped-upstream.js';
import { parsePrivateUpstreamHeaders } from './fixtures/flat-model-acceptance.js';
import { liveTeamLimits, liveTeamInputs, liveMarkers, deriveLivePins, verifyLiveCooperation, verifyLiveBudget, checkLiveFile, createLiveIngress } from './fixtures/agensh-team-kimi.js';
import { createWorkGate, createCleanupBudget } from './fixtures/agensh-deadline.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { sessionEvidence } from './fixtures/core-session-evidence.js';
import { observeNativeIdentity } from './fixtures/agensh-native-identity.js';
const execute = promisify(execFile);

test('two real Kimi K3 peers negotiate and adopt an A-only Board seed in one Core', {
  skip: process.env.SWARMENV_AGENSH_TEAM_LIVE_KIMI_TEST !== '1' && 'Requires two independent source/image/fixture reviews', timeout: 480_000,
}, async () => {
  const image = process.env.SWARMENV_CORE_TEST_IMAGE; assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  const headers = parsePrivateUpstreamHeaders(process.env.SWARMENV_CORE_LIVE_UPSTREAM_HEADERS_JSON);
  const upstreamUrl = process.env.SWARMENV_CORE_LIVE_UPSTREAM_URL;
  assert.ok(typeof upstreamUrl === 'string' && upstreamUrl.endsWith('/responses'));
  const host = process.env.SWARMENV_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const runId = `kimi-${randomBytes(6).toString('hex')}`, directory = join(process.cwd(), 'experiments', `agensh-${runId}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const cleanup = createCleanupBudget(100_000), stack = await createLocalAgenshStack({ directory: join(directory, 'facilities'), advertiseHost: host });
  const seed = randomBytes(12).toString('hex');
  const peerNames = { a: `peer-${runId}-a`, b: `peer-${runId}-b` };
  const inputs = liveTeamInputs({ seed, peerNames });
  const report = { failure: true, mode: 'hosted-kimi-k3', image, limits: liveTeamLimits };
  const credentialValues = Object.values(headers).filter(value => typeof value === 'string' && value);
  let stage = 'start';
  let work, upstream, environment, environmentCleanup, facilities, delivery, ingress, cleanupPhase = false, ownershipUnknown = false;
  const budget = () => cleanupPhase ? cleanup : work;
  const command = (name, args) => budget().step(({ timeoutMs, signal }) => execute(name, args, { timeout: Math.min(timeoutMs, 10_000), signal, maxBuffer: 2 * 1024 ** 2 }));
  const containers = () => budget().step(({ timeoutMs, signal }) => ownedContainers(environment.id, { timeoutMs: Math.min(timeoutMs, 5000), signal }));
  try {
    const configuration = await stack.start();
    stage = 'work';
    work = createWorkGate(180_000, 'ACTUAL_TEAM_WORK_EXPIRED', cleanup);
    upstream = await createCappedUpstream({ upstreamUrl, upstreamHeaders: headers, deadlineAt: work.deadlineAt,
      maxRequests: 20, maxConcurrent: 2, maxOutputTokens: 768, maxAggregateOutputTokens: 15360, maxInputBytes: 128 * 1024, maxAggregateInputBytes: 512 * 1024,
      filename: 'unused-live-observation', marker: 'unused-live-marker', failFast: true, recordGeometry: true, onFailure: () => work.abort() });
    environment = await work.create(() => createAgenshTeam({ ...configuration, runId, image, secretValues: credentialValues, signal: work.signal, outputDir: join(directory, 'core'),
      prepare: async options => { facilities = await prepareAgenshFacilities(options); ingress = createLiveIngress(facilities.peers); return facilities; },
      router: { subscribe: options => createAgenshEventSubscription({ ...options, ingest: event => ingress.ingest(options.facilities.peer.key, event, options.ingest) }),
        readContext: async () => 'Read the current Board through your authenticated board_read/board_grep Service. Seed values are not supplied in injected context.', workTimeoutMs: work.remaining(), turnTimeoutMs: 80_000, maxBatches: 3, maxNudges: 0, events: { pollIntervalMs: 1000, maxPolls: 180 } },
      backend: createPiOpenSandboxBackend({ sandbox: { lifecycleBaseUrl: process.env.SWARMENV_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1', endpointHost: process.env.SWARMENV_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', apiKey: process.env.SWARMENV_CORE_TEST_API_KEY, commandTimeoutMs: 20_000, resourceLimits: { cpu: '1', memory: '1Gi' } },
        bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` }, modelGateway: { host: '0.0.0.0', advertiseHost: host, maxOutputTokens: 768, requestTimeoutMs: 85_000 },
        models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: upstream.url, headers: {} } } }, isolation: { network: 'local-docker', disk: { bytes: 128 * 1024 ** 2, inodes: 8192 } } }) }));
    report.runtimeId = environment.id; report.initial = environment.snapshot();
    stage = 'identity';
    const owned = await containers(); assert.equal(owned.length, 2); report.containers = owned;
    for (const id of owned) { assert.equal((await command('docker', ['exec', id, 'pi', '--version'])).stdout.trim(), '1.3.0'); assert.equal((await command('docker', ['inspect', '--format', '{{.Image}}', id])).stdout.trim(), image); }
    const wait = (key, batch) => work.step(({ timeoutMs, signal }) => environment.wait(key, batch.batchId, { timeoutMs: Math.min(timeoutMs, 80_000), signal }));
    stage = 'first';
    const a = environment.kickoff('a', inputs[0]), b = environment.kickoff('b', inputs[1]);
    assert.equal((await wait('a', a)).state, 'completed'); assert.equal((await wait('b', b)).state, 'completed');
    report.sessionsInitial = await Promise.all(owned.map(id => sessionEvidence(id, command)));
    const identity = id => observeNativeIdentity(id, command, { stage, branches: facilities.peers.map(peer => peer.branch) });
    stage = 'identity-initial';
    report.identitiesInitial = await Promise.all(owned.map(identity));
    assert.ok(report.identitiesInitial.every(row => row.cwd === '/workspace/project'));
    assert.deepEqual(new Set(report.identitiesInitial.map(row => row.branch)), new Set(facilities.peers.map(peer => peer.branch)));
    async function findCompleted(key, marker) {
      return work.step(async () => {
        while (true) {
          work.remaining(); await environment.poll();
          const source = marker === liveMarkers[4] ? 'gitea' : 'mattermost';
          const batch = environment.snapshot().peers.find(peer => peer.key === key).router.batches.find(row => row.source === source && row.text.includes(marker));
          if (batch) return wait(key, batch);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      });
    }
    stage = 'negotiation';
    assert.equal((await findCompleted('a', liveMarkers[2])).state, 'completed');
    assert.equal((await findCompleted('b', liveMarkers[3])).state, 'completed');
    stage = 'pins';
    const gitHost = httpClient(configuration.gitea.origin, `token ${configuration.gitea.adminToken}`);
    const repo = `/api/v1/repos/${facilities.repository.owner}/${facilities.repository.name}`;
    const pullRequests = await work.step(({ signal }) => gitHost('GET', `${repo}/pulls?state=open&limit=10`, undefined, { signal }));
    assert.ok(Array.isArray(pullRequests) && pullRequests.length === 2);
    const branchHeads = {};
    for (const peer of facilities.peers) {
      const branch = await work.step(({ signal }) => gitHost('GET', `${repo}/branches/${peer.branch}`, undefined, { signal }));
      assert.equal(branch.name, peer.branch); branchHeads[peer.key] = branch.commit.id;
    }
    const pins = deriveLivePins({ peers: facilities.peers, pullRequests, branchHeads });
    for (const [index, path] of ['left.txt', 'right.txt'].entries()) {
      const contents = await work.step(({ signal }) => gitHost('GET', `${repo}/contents/${path}?ref=${pins[index].headSha}`, undefined, { signal }));
      checkLiveFile(contents, path, index === 0 ? 'LIVE_T15_LEFT_ACCEPTED\n' : `LIVE_T15_RIGHT_ADOPTED ${seed}\n`);
    }
    stage = 'merge';
    delivery = createAgenshDelivery({ facilities, adminToken: configuration.gitea.adminToken });
    for (const pin of pins) await work.step(({ signal }) => delivery.merge({ ...pin, signal }));
    stage = 'verification';
    const mainFiles = {};
    for (const path of ['left.txt', 'right.txt']) mainFiles[path] = (await work.step(({ signal }) => delivery.readMainFile(path, { signal }))).data.toString();
    const board = await work.step(({ signal }) => httpClient(facilities.endpoints.board)('GET', `/board/${facilities.boardId}/grep?viewer=${facilities.peers[0].board.workerId}&types=FACT,CLAIM,PATCH_SUMMARY&limit=30`, undefined, { signal }));
    const channel = await work.step(({ signal }) => httpClient(configuration.mattermost.origin, `Bearer ${configuration.mattermost.adminToken}`)('GET', `/api/v4/channels/${facilities.channelId}/posts?page=0&per_page=50`, undefined, { signal }));
    const evidencePath = join(directory, 'core', environment.id, 'evidence.jsonl');
    const coreEvidence = (await work.step(() => readFile(evidencePath, 'utf8'))).trim().split('\n').map(JSON.parse);
    const confirmation = environment.snapshot().peers.find(peer => peer.key === 'b').router.batches.find(row => row.source === 'mattermost' && row.text.includes(liveMarkers[3]));
    const inputRows = coreEvidence.filter(row => row.type === 'input' && row.inputId === confirmation.inputId);
    assert.ok(inputRows.length > 0); const confirmationSeq = Math.min(...inputRows.map(row => row.seq));
    const services = coreEvidence.filter(row => row.type === 'service')
      .map(row => ({ ...row, peerKey: row.profile?.replace('peer-', ''), afterConfirmation: row.seq > confirmationSeq, confirmationInputId: confirmation.inputId }));
    report.cooperation = verifyLiveCooperation({ seed, peers: facilities.peers, boardEntries: board.entries, messages: Object.values(channel.posts), pullRequests, branchHeads, mainFiles, services });
    report.delivery = delivery.snapshot(); assert.ok(report.delivery.every(row => row.state === 'merged'));
    stage = 'target';
    const git = httpClient(configuration.gitea.origin, `token ${configuration.gitea.adminToken}`);
    const comment = await work.step(({ signal }) => git('POST', `/api/v1/repos/run-owner/run-${runId}/issues/${facilities.issueNumber}/comments`, { body: `@${peerNames.a} ${inputs[2]}` }, { signal }));
    assert.ok(Number.isSafeInteger(comment.id)); assert.equal((await findCompleted('a', liveMarkers[4])).state, 'completed');
    await work.step(() => environment.poll()); await work.step(() => environment.poll());
    report.environment = environment.snapshot();
    assert.equal(report.environment.peers[0].router.batches.length, 3); assert.equal(report.environment.peers[1].router.batches.length, 2);
    assert.equal(report.environment.peers[1].subscription.records.some(row => row.eventId === `comment:${comment.id}`), false);
    assert.deepEqual(ingress.snapshot().counts, { a: 2, b: 1 }); assert.equal(ingress.snapshot().rejected, 0);
    report.sessionsFinal = await Promise.all(owned.map(id => sessionEvidence(id, command))); assert.deepEqual(report.sessionsFinal, report.sessionsInitial);
    stage = 'identity-final';
    report.identitiesFinal = await Promise.all(owned.map(identity)); assert.deepEqual(report.identitiesFinal, report.identitiesInitial);
    stage = 'usage'; report.modelUsage = verifyLiveBudget(upstream.receipt());
    stage = 'archive';
    work.remaining(); work.finish(); cleanupPhase = true;
    await cleanup.step(() => upstream.close());
    environmentCleanup = await cleanup.step(({ timeoutMs }) => environment.close({ timeoutMs }), 60_000);
    assert.equal(environmentCleanup.cleanup, 'complete'); assert.deepEqual(await containers(), []);
    const aBot = report.environment.peers.find(peer => peer.key === 'a').botId;
    const files = environmentCleanup.bots.find(bot => bot.botId === aBot).artifacts.find(path => path.endsWith('/artifacts/files'));
    assert.deepEqual(await cleanup.step(() => readFile(join(files, 'untracked.bin'))), Buffer.from([0, 255, 65, 10]));
    assert.equal(await cleanup.step(() => readFile(join(files, 'left.txt'), 'utf8')), 'LIVE_T15_DIRTY\n');
    assert.equal(await cleanup.step(() => readFile(join(files, 'checkpoint.txt'), 'utf8')), 'LIVE_T15_PRIVATE\n');
    await command('git', ['-C', files, 'fsck', '--full']);
    const aPin = pins.find(pin => pin.peerKey === 'a');
    const privateHead = (await command('git', ['-C', files, 'rev-parse', 'HEAD'])).stdout.trim();
    assert.notEqual(privateHead, aPin.headSha);
    assert.equal((await command('git', ['-C', files, 'rev-parse', 'HEAD^'])).stdout.trim(), aPin.headSha);
    assert.equal((await command('git', ['-C', files, 'rev-parse', `origin/${facilities.peers[0].branch}`])).stdout.trim(), aPin.headSha);
    const secrets = [...stack.secrets, ...credentialValues, ...facilities.peers.flatMap(peer => [peer.gitea.token, peer.message.token])];
    let scanned = 0;
    async function scan(root) {
      for (const entry of await cleanup.step(() => readdir(root, { withFileTypes: true }))) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) await scan(path);
        else if (entry.isFile()) {
          const bytes = await cleanup.step(() => readFile(path)); scanned += bytes.length; assert.ok(scanned <= 16 * 1024 ** 2);
          assert.ok(secrets.every(secret => !bytes.includes(Buffer.from(secret))), 'No credential may be archived');
        }
      }
    }
    for (const bot of environmentCleanup.bots) {
      const archive = bot.artifacts.find(path => path.endsWith('/artifacts/files')); assert.ok(archive); await scan(archive);
      await command('git', ['-C', archive, 'fsck', '--full']);
      const peer = report.environment.peers.find(peer => peer.botId === bot.botId);
      if (peer.key === 'b') {
        const pin = pins.find(pin => pin.peerKey === 'b');
        assert.equal((await command('git', ['-C', archive, 'rev-parse', 'HEAD'])).stdout.trim(), pin.headSha);
        assert.equal((await command('git', ['-C', archive, 'rev-parse', `origin/${facilities.peers[1].branch}`])).stdout.trim(), pin.headSha);
      }
    }
    const boardRead = await cleanup.step(({ signal }) => httpClient(facilities.endpoints.board)('GET', `/board/${facilities.boardId}/read?viewer=${facilities.peers[1].board.workerId}`, undefined, { signal }));
    assert.ok(boardRead.rendered.includes(`LIVE_T15_SEED=${seed}`));
    const messages = await cleanup.step(({ signal }) => httpClient(configuration.mattermost.origin, `Bearer ${configuration.mattermost.adminToken}`)('GET', `/api/v4/channels/${facilities.channelId}/posts?page=0&per_page=50`, undefined, { signal }));
    assert.ok(Object.values(messages.posts).some(row => row.message.includes(liveMarkers[2])));
    assert.ok(Object.values(messages.posts).some(row => row.message.includes(liveMarkers[3])));
    const publicRead = await cleanup.step(({ signal }) => delivery.readMainFile('right.txt', { signal })); assert.equal(publicRead.data.toString(), `LIVE_T15_RIGHT_ADOPTED ${seed}\n`);
    report.archived = { binaryVerified: true, dirtyVerified: true, gitVerified: true, targetedEventVerified: true }; report.failure = false;
  } catch (error) {
    cleanup.start(); ownershipUnknown = error.cleanup === 'pending';
    const fixtureFailure = upstream?.receipt().failure;
    report.businessFailure = { stage, code: fixtureFailure?.code ?? (typeof error.code === 'string' ? error.code : 'ACTUAL_TEAM_FAILED'),
      ...(fixtureFailure ? { fixtureFailure } : {}), ...(error.identityDiagnostic ? { identityDiagnostic: error.identityDiagnostic } : {}), cleanup: error.cleanup };
  }
  finally {
    report.delivery = delivery?.snapshot();
    report.ingress = ingress?.snapshot();
    cleanup.start(); cleanupPhase = true; report.workExpired = work?.expired() ?? false; work?.finish();
    const hostCleanup = cleanup.step(() => upstream?.close()).then(() => { report.hostCleanup = 'complete'; }, () => { report.hostCleanup = 'pending'; });
    if (work) { const creation = await work.awaitCreation(); report.creation = work.ownership(); if (creation.state === 'owned') environment ??= creation.environment; ownershipUnknown ||= creation.state === 'pending' || creation.error?.cleanup === 'pending'; }
    try { if (environment && environmentCleanup?.cleanup !== 'complete') environmentCleanup = await cleanup.step(({ timeoutMs }) => environment.close({ timeoutMs }), 60_000); } catch { report.cleanupFailure = { code: 'TEAM_CLEANUP_PENDING' }; }
    report.environmentCleanup = environmentCleanup;
    report.environment = environment?.snapshot();
    if ((!environment && !ownershipUnknown) || environmentCleanup?.cleanup === 'complete') { try { report.facilityCleanup = await cleanup.step(() => stack.close(cleanup)); } catch { report.facilityCleanup = { cleanup: 'pending' }; } }
    else report.facilityCleanup = { cleanup: 'pending', dependenciesRetained: true };
    await hostCleanup; report.cleanupBudget = cleanup.receipt(); report.facilities = stack.receipt(); report.upstream = upstream?.receipt();
    report.failure ||= report.workExpired || report.cleanupBudget.expired || report.facilityCleanup?.cleanup !== 'complete' || report.hostCleanup !== 'complete' || Boolean(report.cleanupFailure);
    cleanup.dispose(); work?.dispose(); let body = JSON.stringify(environment ? environment.redact(report) : report, null, 2);
    for (const secret of [...stack.secrets, ...credentialValues]) body = body.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]');
    await writeFile(join(directory, 'acceptance.json'), body + '\n', { mode: 0o600 });
  }
  assert.equal(report.failure, false); assert.equal(report.environmentCleanup.cleanup, 'complete'); assert.equal(report.facilityCleanup.cleanup, 'complete');
});
