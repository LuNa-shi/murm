import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { installNativeNotesExample, execute } from './fixtures/notes-installed-package.js';
import { createTeamUpstream, teamInputs, teamFact } from './fixtures/agensh-team-upstream.js';
import { createDeadline, createCleanupBudget } from './fixtures/agensh-deadline.js';
import { httpClient } from '../src/environments/agensh/http.js';
import { createAgenshDelivery } from '../src/environments/agensh/delivery.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { sessionEvidence } from './fixtures/core-session-evidence.js';

test('installed foreground Agensh CLI preserves native fixed collaboration and archives', {
  skip: process.env.SWARMENV_AGENSH_INSTALLED_REAL_TEST !== '1' && 'Requires independent source/archive/image/fixture reviews', timeout: 600_000,
}, async () => {
  const image = process.env.SWARMENV_CORE_TEST_IMAGE; assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  const directory = join(process.cwd(), 'experiments', `agensh-installed-${randomBytes(8).toString('hex')}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const installed = await installNativeNotesExample();
  const root = join(installed.directory, 'node_modules/@swarmenv/core');
  const runId = `cli-${randomBytes(6).toString('hex')}`, host = process.env.SWARMENV_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const cleanup = createCleanupBudget(100_000);
  let work, child, upstream, configuration, ready, terminal, facilityCleanup, exited = false, protocolFailure;
  const report = { failure: true, package: installed.metadata, image, hosted: 0,
    limits: { setupMs: 180_000, workMs: 180_000, cleanupMs: 100_000, bots: 2, inputs: 5, arrivals: 10, outputTokens: 128 } };
  const messages = [], rows = []; let serial = 0, bytes = 0;
  const waitFor = async (list, predicate, budget) => budget.step(async ({ signal }) => {
    while (true) {
      const found = list.find(predicate); if (found) return found;
      if (protocolFailure) throw Object.assign(new Error(protocolFailure), { code: protocolFailure });
      if (exited) throw Object.assign(new Error('Installed CLI ended before expected receipt'), { code: 'INSTALLED_CLI_ENDED' });
      await new Promise(resolve => setTimeout(resolve, 20)); signal.throwIfAborted();
    }
  });
  const command = async (operation, input) => {
    const id = `cli-${++serial}`;
    child.stdin.write(JSON.stringify({ id, operation, input }) + '\n');
    const row = await waitFor(rows, row => row.id === id, work);
    assert.equal(row.type, 'reply', row.code); return row.result;
  };
  const shell = (name, args) => (work && !cleanup.started() ? work : cleanup).step(({ timeoutMs, signal }) =>
    execute(name, args, { timeout: Math.min(timeoutMs, 10_000), signal, maxBuffer: 2 * 1024 ** 2 }));
  try {
    // This source is a trusted fixture config. Backend consumption is through the public package export.
    // Stack ownership stays in this child, whose private IPC accepts cleanup only after terminal proof.
    await copyFile(join(root, 'test/fixtures/agensh-installed-host.mjs'), join(installed.directory, 'host-config.mjs'));
    // The upstream deadline includes setup; its per-request work gate starts at facilities readiness.
    upstream = await createTeamUpstream({ deadlineAt: Date.now() + 360_000, peerNames: { a: `peer-${runId}-a`, b: `peer-${runId}-b` }, onFailure: () => child?.kill('SIGTERM') });
    await writeFile(join(directory, 'host-input.json'), JSON.stringify({ directory: join(directory, 'facilities'), host, runId, image,
      outputDir: join(directory, 'core'), upstream: upstream.url, lifecycle: process.env.SWARMENV_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
      endpointHost: process.env.SWARMENV_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', apiKey: process.env.SWARMENV_CORE_TEST_API_KEY }), { mode: 0o600 });
    child = spawn(process.execPath, [join(root, 'scripts/run-environment.mjs'), '--config', join(installed.directory, 'host-config.mjs')], {
      cwd: installed.directory, env: { ...installed.env, SWARMENV_AGENSH_HOST_INPUT: join(directory, 'host-input.json') }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    child.stdin.on('error', () => { protocolFailure = 'INSTALLED_INPUT_FAILED'; });
    child.on('error', () => { exited = true; }); child.on('exit', code => { exited = true; report.exitCode = code; });
    child.on('message', message => { messages.push(message); });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => { bytes += Buffer.byteLength(line); if (bytes > 2 * 1024 ** 2) { protocolFailure = 'INSTALLED_OUTPUT_LIMIT'; child.kill('SIGTERM'); } else { try { const row = JSON.parse(line); rows.push(row); if (row.type === 'result') terminal = row; } catch { protocolFailure = 'INSTALLED_OUTPUT_INVALID'; child.kill('SIGTERM'); } } });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 ** 2) { protocolFailure = 'INSTALLED_OUTPUT_LIMIT'; child.kill('SIGTERM'); } });
    const setup = createDeadline(180_000, 'INSTALLED_SETUP_EXPIRED');
    try { configuration = (await waitFor(messages, row => row.type === 'facilities' || row.type === 'setup-failed', setup)).configuration; assert.ok(configuration); }
    finally { setup.dispose(); }
    work = createDeadline(180_000, 'INSTALLED_WORK_EXPIRED');
    ready = (await waitFor(rows, row => row.type === 'ready', work)).status;
    report.runtimeId = ready.runtimeId;
    assert.deepEqual(ready.peers.map(peer => peer.key), ['a', 'b']); assert.ok(ready.peers.every(peer => peer.ready));
    assert.equal(new Set(ready.peers.map(peer => peer.botId)).size, 2);
    const owned = await work.step(({ timeoutMs, signal }) => ownedContainers(ready.runtimeId, { timeoutMs, signal })); assert.equal(owned.length, 2);
    for (const id of owned) { assert.equal((await shell('docker', ['exec', id, 'pi', '--version'])).stdout.trim(), '1.3.0'); assert.equal((await shell('docker', ['inspect', '--format', '{{.Image}}', id])).stdout.trim(), image); }
    const wait = (recipient, batchId) => command('wait', { recipient, batchId, timeoutMs: 80_000 });
    const a = await command('kickoff', { recipient: 'a', input: teamInputs[0] });
    const b = await command('kickoff', { recipient: 'b', input: teamInputs[1] });
    assert.equal((await wait('a', a.batchId)).state, 'completed'); assert.equal((await wait('b', b.batchId)).state, 'completed');
    const sessions = await Promise.all(owned.map(id => sessionEvidence(id, shell)));
    assert.equal(new Set(sessions.map(row => row.sessionId)).size, 2);
    async function complete(recipient, count) {
      while (true) {
        work.remaining(); const view = await command('status'); const batches = view.peers.find(peer => peer.key === recipient).batches;
        assert.ok(batches.length <= count);
        if (batches.length === count) { assert.equal((await wait(recipient, batches.at(-1).batchId)).state, 'completed'); return; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    await complete('a', 2); await complete('b', 2);
    const git = httpClient(configuration.gitea.origin, `token ${configuration.gitea.adminToken}`);
    const repo = `/api/v1/repos/run-owner/run-${runId}`;
    const peers = await Promise.all(['a', 'b'].map(async key => {
      const user = await work.step(({ signal }) => git('GET', `/api/v1/users/peer-${runId}-${key}`, undefined, { signal }));
      return { key, branch: `peer-${runId}-${key}`, gitea: { accountId: String(user.id) } };
    }));
    const delivery = createAgenshDelivery({ facilities: { peers, endpoints: { gitea: configuration.gitea.origin }, repository: { owner: 'run-owner', name: `run-${runId}` } }, adminToken: configuration.gitea.adminToken });
    for (const key of ['a', 'b']) { const proof = upstream.receipt().evidence.find(row => row.stage === `${key}-contribution`); assert.ok(proof); await work.step(({ signal }) => delivery.merge({ peerKey: key, number: proof.prNumber, headSha: proof.head, signal })); }
    for (const [path, expected] of [['left.txt', 'T15_LEFT_ACCEPTED\n'], ['right.txt', `T15_RIGHT_ADOPTED ${teamFact}\n`]]) assert.equal((await work.step(({ signal }) => delivery.readMainFile(path, { signal }))).data.toString(), expected);
    const issues = await work.step(({ signal }) => git('GET', `${repo}/issues?state=open&limit=10`, undefined, { signal })); assert.ok(Array.isArray(issues) && issues.length < 10);
    const matches = issues.filter(row => row.title === 'Fixed peer collaboration acceptance' && !row.pull_request); assert.equal(matches.length, 1); assert.ok(Number.isSafeInteger(matches[0].number));
    const comment = await work.step(({ signal }) => git('POST', `${repo}/issues/${matches[0].number}/comments`, { body: `@peer-${runId}-a ${teamInputs[4]}` }, { signal })); assert.ok(Number.isSafeInteger(comment.id));
    await complete('a', 3); report.lastStatus = await command('status'); assert.deepEqual(report.lastStatus.peers.map(peer => peer.batches.length), [3, 2]);
    assert.deepEqual(await Promise.all(owned.map(id => sessionEvidence(id, shell))), sessions);
    for (const key of ['a', 'b']) { const rounds = upstream.receipt().evidence.filter(row => row.stage.startsWith(`${key}-`)); assert.ok(rounds.every(row => row.cwd === rounds[0].cwd && row.branch === rounds[0].branch && JSON.stringify(row.pi) === JSON.stringify(rounds[0].pi))); }
    work.remaining(); work.dispose(); cleanup.start();
    child.stdin.write(JSON.stringify({ id: 'stop', operation: 'stop' }) + '\n');
    terminal = await waitFor(rows, row => row.type === 'result', cleanup);
    assert.equal(terminal.cleanup, 'complete'); assert.equal(terminal.businessFailureCode, null); assert.equal(terminal.cleanupFailureCode, null); assert.equal(terminal.reportSaveFailureCode, null); assert.equal(terminal.pendingCount, 0);
    assert.ok(terminal.bots.length === 2 && terminal.bots.every(bot => bot.execution === 'stopped' && bot.cleanup === 'complete'));
    assert.deepEqual(await cleanup.step(({ timeoutMs, signal }) => ownedContainers(ready.runtimeId, { timeoutMs, signal })), []);
    const saved = JSON.parse(await cleanup.step(() => readFile(terminal.reportPath, 'utf8'))); assert.equal(saved.runtimeId, ready.runtimeId);
    assert.deepEqual(saved.environment.peers.map(peer => peer.router.batches.length), [3, 2]); assert.ok(saved.environment.peers.every(peer => peer.subscription.closed));
    assert.equal(saved.environment.peers[1].subscription.records.some(row => row.eventId === `comment:${comment.id}`), false);
    for (const peer of saved.environment.peers) {
      const files = saved.cleanup.bots.find(bot => bot.botId === peer.botId).artifacts.find(path => path.endsWith('/artifacts/files')); assert.ok(files);
      const initial = JSON.parse(await cleanup.step(() => readFile(join(files, '.team-state.json'), 'utf8'))); assert.deepEqual(initial, upstream.receipt().evidence.find(row => row.stage === `${peer.key}-initial`));
      if (peer.key === 'a') {
        assert.deepEqual(await cleanup.step(() => readFile(join(files, 'untracked.bin'))), Buffer.from([0, 255, 65, 10]));
        assert.equal(await cleanup.step(() => readFile(join(files, 'left.txt'), 'utf8')), 'T15_DIRTY_PRIVATE\n');
        const event = JSON.parse(await cleanup.step(() => readFile(join(files, 'user-event.json'), 'utf8'))); assert.equal(event.event.eventId, `comment:${comment.id}`);
        await shell('git', ['-C', files, 'fsck', '--full']);
        assert.equal((await shell('git', ['-C', files, 'rev-parse', 'HEAD'])).stdout.trim(), event.privateHead);
        assert.equal((await shell('git', ['-C', files, 'rev-parse', `origin/${event.branch}`])).stdout.trim(), event.publicHead);
      }
    }
    const read = JSON.parse((await shell(process.execPath, [join(root, 'scripts/read-environment-result.mjs'), '--run-directory', ready.runDirectory, '--runtime-id', ready.runtimeId])).stdout);
    assert.equal(read.environment.state, 'read'); assert.equal(read.core.state, 'read'); assert.equal(read.environment.cleanup, 'complete'); assert.equal(read.core.cleanup, 'complete');
    report.reader = read; report.delivery = delivery.snapshot(); report.upstream = upstream.receipt();
    assert.equal(report.upstream.arrivals, 10); assert.equal(report.upstream.accepted, 10); assert.equal(report.upstream.failure, undefined);
    report.failure = false;
  } catch (error) { report.error = { code: /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code ?? '') ? error.code : 'INSTALLED_ACCEPTANCE_FAILED' }; }
  finally {
    work?.dispose(); cleanup.start();
    try {
      if (child && !terminal && !exited) { child.kill('SIGTERM'); terminal = await waitFor(rows, row => row.type === 'result', cleanup); }
      // Never remove shared dependencies while execution/creation ownership is unknown.
      if (child?.connected && (terminal?.cleanup === 'complete' || messages.some(row => row.type === 'setup-failed'))) {
        child.send({ type: 'close-facilities', deadlineAt: Date.now() + cleanup.remaining() });
        const closed = await waitFor(messages, row => row.type === 'facilities-closed', cleanup); facilityCleanup = closed.receipt; report.facilities = closed.resources;
      } else facilityCleanup = { cleanup: 'pending', dependenciesRetained: true };
      if (child) await cleanup.step(async () => { while (!exited) await new Promise(resolve => setTimeout(resolve, 20)); });
    } catch { facilityCleanup ??= { cleanup: 'pending', dependenciesRetained: true }; }
    if (child && !exited) { if (child.connected) child.disconnect(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
    try { await cleanup.step(() => upstream?.close()); } catch { report.upstreamCleanup = 'pending'; }
    report.terminal = terminal; report.facilityCleanup = facilityCleanup;
    report.failure ||= facilityCleanup?.cleanup !== 'complete' || report.exitCode !== 0 || report.upstreamCleanup === 'pending' || cleanup.receipt().expired;
    // Preserve installation/configuration on pending cleanup so reconciliation can use their exact paths.
    report.installation = installed.directory; report.cleanupBudget = cleanup.receipt();
    await writeFile(join(directory, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    cleanup.dispose();
    if (!report.failure) await installed.close();
  }
  assert.equal(report.failure, false, report.error?.code); assert.equal(facilityCleanup.cleanup, 'complete');
});
