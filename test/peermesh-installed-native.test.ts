import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createNativeEvidenceDirectory, installNativeNotesExample, execute } from './fixtures/notes-installed-package.js';
import { createTeamUpstream, teamInputs, teamFact, foregroundInput } from './fixtures/peermesh-team-upstream.js';
import { createDeadline, createCleanupBudget } from './fixtures/peermesh-deadline.js';
import { httpClient } from '../src/harnesses/peermesh/http.js';
import { createPeerMeshDelivery } from '../src/harnesses/peermesh/delivery.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { closeInstalledForeground } from './fixtures/peermesh-installed-cleanup.js';
import { sessionEvidence } from './fixtures/core-session-evidence.js';

test('installed foreground Agensh CLI preserves native fixed collaboration and archives', {
  skip: process.env.MURM_PEERMESH_INSTALLED_REAL_TEST !== '1' && 'Requires independent source/archive/image/fixture reviews',
  timeout: 600_000
}, async () => {
  const image = process.env.MURM_CORE_TEST_IMAGE;
  assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  const directory = await createNativeEvidenceDirectory('agensh-installed');

  const installed = await installNativeNotesExample();
  const root = join(installed.directory, 'node_modules/@luna-shi/murm');
  const runId = `cli-${randomBytes(6).toString('hex')}`;
  const host = process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const cleanup = createCleanupBudget(100_000);
  let work, child, upstream, configuration, ready, terminal, facilityCleanup, exited = false, protocolFailure;

  const report = {
    failure: true,
    package: installed.metadata,
    image,
    hosted: 0,

    limits: {
      setupMs: 180_000,
      workMs: 180_000,
      cleanupMs: 100_000,
      agents: 2,
      inputs: 6,
      arrivals: 12,
      outputTokens: 128
    }
  };

  const messages = [], rows = [];
  let serial = 0, bytes = 0;

  const waitFor = async (list, predicate, budget) => budget.step(async ({ signal }) => {
    while (true) {
      const found = list.find(predicate);

      if (found) return found;

      if (protocolFailure) throw Object.assign(new Error(protocolFailure), {
        code: protocolFailure
      });

      if (exited) throw Object.assign(new Error('Installed CLI ended before expected receipt'), {
        code: 'INSTALLED_CLI_ENDED'
      });

      await new Promise(resolve => setTimeout(resolve, 20));
      signal.throwIfAborted();
    }
  });

  const command = async (operation, input, errorCode) => {
    const id = `cli-${++serial}`;

    child.stdin.write(JSON.stringify({
      id,
      operation,
      input
    }) + '\n');

    const row = await waitFor(rows, row => row.id === id, work);
    assert.equal(row.type, errorCode ? 'error' : 'reply', row.code);
    if (errorCode) { assert.equal(row.code, errorCode); return { code: row.code }; }
    return row.result;
  };

  const shell = (name, args) => {
    const budget = work && !cleanup.started() ? work : cleanup;
    return budget.step(({ timeoutMs, signal }) => execute(name, args, {
      timeout: Math.min(timeoutMs, 10_000),
      signal,
      maxBuffer: 2 * 1024 ** 2
    }));
  };

  try {
    // This source is a trusted fixture config. Backend consumption is through the public package export.
    // Stack ownership stays in this child, whose private IPC accepts cleanup only after terminal proof.
    await copyFile(join(root, 'dist/test/fixtures/peermesh-installed-host.js'), join(installed.directory, 'host-config.mjs'));

    // The upstream deadline includes setup; its per-request work gate starts at facilities readiness.
    upstream = await createTeamUpstream({
      foregroundInput: true,
      deadlineAt: Date.now() + 360_000,

      peerNames: {
        a: `peer-${runId}-a`,
        b: `peer-${runId}-b`
      },

      onFailure: () => child?.kill('SIGTERM')
    });

    await writeFile(join(directory, 'host-input.json'), JSON.stringify({
      directory: join(directory, 'facilities'),
      host,
      runId,
      image,
      outputDir: join(directory, 'core'),
      upstream: upstream.url,
      lifecycle: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
      endpointHost: process.env.MURM_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1',
      apiKey: process.env.MURM_CORE_TEST_API_KEY
    }), {
      mode: 0o600
    });

    child = spawn(
      process.execPath,
      [join(root, 'dist/scripts/run-harness.js'), '--config', join(installed.directory, 'host-config.mjs')],
      {
        cwd: installed.directory,

        env: {
          ...installed.env,
          MURM_PEERMESH_HOST_INPUT: join(directory, 'host-input.json')
        },

        stdio: ['pipe', 'pipe', 'pipe', 'ipc']
      }
    );

    child.stdin.on('error', () => {
      protocolFailure = 'INSTALLED_INPUT_FAILED';
    });

    child.on('error', () => {
      exited = true;
    });

    child.on('exit', code => {
      exited = true;
      report.exitCode = code;
    });

    child.on('message', message => {
      messages.push(message);
    });

    const lines = createInterface({
      input: child.stdout
    });

    lines.on('line', line => {
      bytes += Buffer.byteLength(line);

      if (bytes > 2 * 1024 ** 2) {
        protocolFailure = 'INSTALLED_OUTPUT_LIMIT';
        child.kill('SIGTERM');
      } else {
        try {
          const row = JSON.parse(line);
          rows.push(row);

          if (row.type === 'result') terminal = row;
        } catch {
          protocolFailure = 'INSTALLED_OUTPUT_INVALID';
          child.kill('SIGTERM');
        }
      }
    });

    child.stderr.on('data', chunk => {
      bytes += chunk.length;

      if (bytes > 2 * 1024 ** 2) {
        protocolFailure = 'INSTALLED_OUTPUT_LIMIT';
        child.kill('SIGTERM');
      }
    });

    const setup = createDeadline(180_000, 'INSTALLED_SETUP_EXPIRED');

    try {
      const setupReceipt = await waitFor(
        messages,
        row => row.type === 'facilities' || row.type === 'setup-failed',
        setup
      );
      configuration = setupReceipt.configuration;
      assert.ok(configuration);
    } finally {
      setup.dispose();
    }

    work = createDeadline(180_000, 'INSTALLED_WORK_EXPIRED');
    ready = (await waitFor(rows, row => row.type === 'ready', work)).status;
    report.runtimeId = ready.runtimeId;
    assert.deepEqual(ready.peers.map(peer => peer.key), ['a', 'b']);
    assert.ok(ready.peers.every(peer => peer.ready));
    assert.equal(new Set(ready.peers.map(peer => peer.agentId)).size, 2);

    const owned = await work.step(({ timeoutMs, signal }) => ownedContainers(ready.runtimeId, {
      timeoutMs,
      signal
    }));

    assert.equal(owned.length, 2);

    for (const id of owned) {
      assert.equal((await shell('docker', ['exec', id, 'pi', '--version'])).stdout.trim(), '1.3.0');
      assert.equal((await shell('docker', ['inspect', '--format', '{{.Image}}', id])).stdout.trim(), image);
    }

    const wait = (recipient, batchId) => command('wait', {
      recipient,
      batchId,
      timeoutMs: 80_000
    });

    const a = await command('kickoff', {
      recipient: 'a',
      input: teamInputs[0]
    });

    const b = await command('kickoff', {
      recipient: 'b',
      input: teamInputs[1]
    });

    assert.equal((await wait('a', a.batchId)).state, 'completed');
    assert.equal((await wait('b', b.batchId)).state, 'completed');
    const sessions = await Promise.all(owned.map(id => sessionEvidence(id, shell)));
    assert.equal(new Set(sessions.map(row => row.sessionId)).size, 2);

    async function complete(recipient, count) {
      while (true) {
        work.remaining();
        const view = await command('status');
        const batches = view.peers.find(peer => peer.key === recipient).batches;
        assert.ok(batches.length <= count);

        if (batches.length === count) {
          assert.equal((await wait(recipient, batches.at(-1).batchId)).state, 'completed');
          return;
        }

        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    await complete('a', 2);
    await complete('b', 2);
    const git = httpClient(configuration.gitea.origin, `token ${configuration.gitea.adminToken}`);
    const repo = `/api/v1/repos/run-owner/run-${runId}`;

    const peers = await Promise.all(['a', 'b'].map(async key => {
      const user = await work.step(({ signal }) => git('GET', `/api/v1/users/peer-${runId}-${key}`, undefined, {
        signal
      }));

      return {
        key,
        branch: `peer-${runId}-${key}`,

        gitea: {
          accountId: String(user.id)
        }
      };
    }));

    const delivery = createPeerMeshDelivery({
      facilities: {
        peers,

        endpoints: {
          gitea: configuration.gitea.origin
        },

        repository: {
          owner: 'run-owner',
          name: `run-${runId}`
        }
      },

      adminToken: configuration.gitea.adminToken
    });

    for (const key of ['a', 'b']) {
      const proof = upstream.receipt().evidence.find(row => row.stage === `${key}-contribution`);
      assert.ok(proof);

      await work.step(({ signal }) => delivery.merge({
        peerKey: key,
        number: proof.prNumber,
        headSha: proof.head,
        signal
      }));
    }

    const expectedMainFiles = [
      ['left.txt', 'T15_LEFT_ACCEPTED\n'],
      ['right.txt', `T15_RIGHT_ADOPTED ${teamFact}\n`]
    ];
    for (const [path, expected] of expectedMainFiles) {
      const mainFile = await work.step(({ signal }) => delivery.readMainFile(path, { signal }));
      assert.equal(mainFile.data.toString(), expected);
    }

    const issues = await work.step(({ signal }) => git('GET', `${repo}/issues?state=open&limit=10`, undefined, {
      signal
    }));

    assert.ok(Array.isArray(issues) && issues.length < 10);
    const matches = issues.filter(row => row.title === 'Fixed peer collaboration acceptance' && !row.pull_request);
    assert.equal(matches.length, 1);
    assert.ok(Number.isSafeInteger(matches[0].number));

    const comment = await work.step(({ signal }) => git('POST', `${repo}/issues/${matches[0].number}/comments`, {
      body: `@peer-${runId}-a ${teamInputs[4]}`
    }, {
      signal
    }));

    assert.ok(Number.isSafeInteger(comment.id));
    await complete('a', 3);
    report.lastStatus = await command('status');
    assert.deepEqual(report.lastStatus.peers.map(peer => peer.batches.length), [3, 2]);
    const direct = { recipient: 'a', input: foregroundInput, requestId: 'installed-user-fixed' };
    const beforeDirect = upstream.receipt().arrivals;
    const admitted = await command('input', direct);
    assert.equal((await wait('a', admitted.batchId)).state, 'completed');
    const replay = await command('input', direct);
    assert.equal(replay.batchId, admitted.batchId);
    assert.equal(replay.requestId, admitted.requestId);
    const conflict = await command('input', { ...direct, input: 'Changed foreground direction' }, 'BATCH_CONFLICT');
    assert.equal(upstream.receipt().arrivals, beforeDirect + 2);
    report.lastStatus = await command('status');
    assert.deepEqual(report.lastStatus.peers.map(peer => peer.batches.length), [4, 2]);
    assert.deepEqual(report.lastStatus.peers.map(peer => peer.agentId), ready.peers.map(peer => peer.agentId));
    const userBatch = report.lastStatus.peers[0].batches.find(row => row.batchId === admitted.batchId);
    assert.equal(userBatch.state, 'completed');
    assert.equal(report.lastStatus.peers[1].batches.some(row => row.batchId === admitted.batchId), false);
    report.foregroundInput = { recipient: 'a', eventId: direct.requestId, batchId: admitted.batchId, requestId: admitted.requestId, replayBatchId: replay.batchId, conflictCode: conflict.code, extraArrivals: upstream.receipt().arrivals - beforeDirect };
    assert.deepEqual(await Promise.all(owned.map(id => sessionEvidence(id, shell))), sessions);

    for (const key of ['a', 'b']) {
      const rounds = upstream.receipt().evidence.filter(row => row.stage.startsWith(`${key}-`));

      assert.ok(rounds.every(
        row => row.cwd === rounds[0].cwd
          && row.branch === rounds[0].branch
          && JSON.stringify(row.pi) === JSON.stringify(rounds[0].pi)
      ));
    }

    work.remaining();
    work.dispose();
    cleanup.start();

    child.stdin.write(JSON.stringify({
      id: 'stop',
      operation: 'stop'
    }) + '\n');

    terminal = await waitFor(rows, row => row.type === 'result', cleanup);
    assert.equal(terminal.runtimeId, ready.runtimeId);
    assert.deepEqual(terminal.agents.map(agent => agent.agentId).sort(), ready.peers.map(peer => peer.agentId).sort());
    assert.equal(terminal.cleanup, 'complete');
    assert.equal(terminal.businessFailureCode, null);
    assert.equal(terminal.cleanupFailureCode, null);
    assert.equal(terminal.reportSaveFailureCode, null);
    assert.equal(terminal.pendingCount, 0);

    assert.ok(
      terminal.agents.length === 2 && terminal.agents.every(agent => agent.execution === 'stopped' && agent.cleanup === 'complete')
    );

    assert.deepEqual(await cleanup.step(({ timeoutMs, signal }) => ownedContainers(ready.runtimeId, {
      timeoutMs,
      signal
    })), []);

    const saved = JSON.parse(await cleanup.step(() => readFile(terminal.reportPath, 'utf8')));
    assert.equal(saved.runtimeId, ready.runtimeId);
    assert.deepEqual(saved.harness.peers.map(peer => peer.router.batches.length), [4, 2]);
    assert.ok(saved.harness.peers.every(peer => peer.subscription.closed));
    const savedDirect = saved.harness.peers[0].router.batches.filter(row => row.batchId === report.foregroundInput.batchId);
    assert.equal(savedDirect.length, 1);
    assert.equal(savedDirect[0].source, 'user');
    assert.equal(savedDirect[0].eventId, report.foregroundInput.eventId);
    assert.equal(savedDirect[0].requestId, report.foregroundInput.requestId);
    assert.equal(savedDirect[0].state, 'completed');
    assert.equal(saved.harness.peers[1].router.batches.some(row => row.eventId === report.foregroundInput.eventId), false);

    assert.equal(
      saved.harness.peers[1].subscription.records.some(row => row.eventId === `comment:${comment.id}`),
      false
    );

    for (const peer of saved.harness.peers) {
      const agentReceipt = saved.cleanup.agents.find(agent => agent.agentId === peer.agentId);
      const files = agentReceipt.artifacts.find(path => path.endsWith('/artifacts/files'));
      assert.ok(files);
      const initial = JSON.parse(await cleanup.step(() => readFile(join(files, '.team-state.json'), 'utf8')));
      assert.deepEqual(initial, upstream.receipt().evidence.find(row => row.stage === `${peer.key}-initial`));
      assert.equal(initial.branch, `peer-${runId}-${peer.key}`);

      if (peer.key === 'b') await assert.rejects(cleanup.step(() => readFile(join(files, 'foreground-event.json'))), { code: 'ENOENT' });

      if (peer.key === 'a') {
        assert.deepEqual(await cleanup.step(() => readFile(join(files, 'untracked.bin'))), Buffer.from([0, 255, 65, 10]));
        assert.equal(await cleanup.step(() => readFile(join(files, 'left.txt'), 'utf8')), 'T15_DIRTY_PRIVATE\n');
        const event = JSON.parse(await cleanup.step(() => readFile(join(files, 'user-event.json'), 'utf8')));
        assert.equal(event.event.eventId, `comment:${comment.id}`);
        const directEvent = JSON.parse(await cleanup.step(() => readFile(join(files, 'foreground-event.json'), 'utf8')));
        assert.deepEqual(directEvent, upstream.receipt().evidence.find(row => row.stage === 'a-foreground'));
        assert.equal(directEvent.event.eventId, report.foregroundInput.eventId);
        assert.equal(directEvent.event.batchId, report.foregroundInput.batchId);
        assert.equal(directEvent.event.source, 'user');
        assert.deepEqual(directEvent.pi, initial.pi);
        assert.equal(directEvent.privateHead, event.privateHead);
        assert.equal(directEvent.publicHead, event.publicHead);
        await shell('git', ['-C', files, 'fsck', '--full']);
        assert.equal((await shell('git', ['-C', files, 'rev-parse', 'HEAD'])).stdout.trim(), event.privateHead);

        assert.equal(
          (await shell('git', ['-C', files, 'rev-parse', `origin/${event.branch}`])).stdout.trim(),
          event.publicHead
        );
      }
    }

    const read = JSON.parse((await shell(process.execPath, [
      join(root, 'dist/scripts/read-harness-result.js'),
      '--run-directory',
      ready.runDirectory,
      '--runtime-id',
      ready.runtimeId
    ])).stdout);

    assert.equal(read.harness.state, 'read');
    assert.equal(read.core.state, 'read');
    assert.equal(read.harness.cleanup, 'complete');
    assert.equal(read.core.cleanup, 'complete');

    child.send({
      type: 'verify-facilities',
      deadlineAt: Date.now() + cleanup.remaining()
    });

    const verification = await waitFor(
      messages,
      row => row.type === 'facilities-verified' || row.type === 'facilities-verification-failed',
      cleanup
    );

    assert.deepEqual(verification.proof, {
      boardFact: true,
      negotiation: true,
      confirmation: true
    });

    const postStopMain = await cleanup.step(({ signal }) => delivery.readMainFile('right.txt', {
      signal
    }));

    assert.equal(postStopMain.data.toString(), `T15_RIGHT_ADOPTED ${teamFact}\n`);
    report.postStopFacilities = verification.proof;
    report.reader = read;
    report.delivery = delivery.snapshot();
    report.upstream = upstream.receipt();
    assert.equal(report.upstream.arrivals, 12);
    assert.equal(report.upstream.accepted, 12);
    assert.equal(report.upstream.failure, undefined);
    assert.deepEqual(report.upstream.evidence.map(row => row.stage).sort(), ['a-initial', 'b-initial', 'a-contribution', 'b-contribution', 'a-user', 'a-foreground'].sort());
    report.failure = false;
  } catch (error) {
    report.error = {
      code: /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code ?? '') ? error.code : 'INSTALLED_ACCEPTANCE_FAILED'
    };
  } finally {
    work?.dispose();
    cleanup.start();

    try {
      if (child) {
        const closed = await closeInstalledForeground({
          child,
          rows,
          messages,
          cleanup,
          terminal,
          isExited: () => exited
        });

        terminal = closed.terminal;
        facilityCleanup = closed.facilityCleanup;
        report.facilities = closed.facilities;
      }
    } catch {
      facilityCleanup ??= {
        cleanup: 'pending',
        dependenciesRetained: true
      };
    }

    if (child && !exited) {
      if (child.connected) child.disconnect();

      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }

    try {
      await cleanup.step(() => upstream?.close());
    } catch {
      report.upstreamCleanup = 'pending';
    }

    report.terminal = terminal;
    report.facilityCleanup = facilityCleanup;
    report.failure ||= facilityCleanup?.cleanup !== 'complete'
      || report.exitCode !== 0
      || report.upstreamCleanup === 'pending'
      || cleanup.receipt().expired;

    // Preserve installation/configuration on pending cleanup so reconciliation can use their exact paths.
    report.installation = installed.directory;

    report.cleanupBudget = cleanup.receipt();

    await writeFile(join(directory, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600
    });

    cleanup.dispose();

    if (!report.failure) await installed.close();
  }

  assert.equal(report.failure, false, report.error?.code);
  assert.equal(facilityCleanup.cleanup, 'complete');
});
