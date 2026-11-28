import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { execute, installNotesExample, stageInstalledTestFixtures } from './fixtures/notes-installed-package.js';

// Run the same fixed scenario through the installed headless host. Keeping this
// function self-contained lets the outside-checkout process import only shipped
// modules; it does not use the checkout's module resolver or transport state.
async function headlessScenario(configuration, runForegroundHarness) {
  const records = [];
  const report = await runForegroundHarness(configuration, async host => {
    records.push({ type: 'ready', status: await host.status() });
    const command = async (id, operation, input) => {
      try {
        const result = await host[operation](input);
        records.push({ type: 'reply', id, result });
        return result;
      } catch (error) {
        records.push({ type: 'error', id, code: error.code });
      }
    };
    try {
      const a = await command('kick-a', 'kickoff', { recipient: 'a', input: 'PRIVATE_KICKOFF_A' });
      const b = await command('kick-b', 'kickoff', { recipient: 'b', input: 'PRIVATE_KICKOFF_B' });
      await command('wait-kick-a', 'wait', { recipient: 'a', batchId: a.batchId, timeoutMs: 1000 });
      await command('wait-kick-b', 'wait', { recipient: 'b', batchId: b.batchId, timeoutMs: 1000 });
      const feedback = { recipient: 'b', requestId: 'shared-user-request', input: 'PRIVATE_DIRECTED_FEEDBACK' };
      const first = await command('feedback-b', 'input', feedback);
      await command('wait-feedback-b', 'wait', { recipient: 'b', batchId: first.batchId, timeoutMs: 1000 });
      await command('replay-b', 'input', feedback);
      await command('conflict-b', 'input', { ...feedback, input: 'PRIVATE_CHANGED_FEEDBACK' });
      const other = await command('feedback-a', 'input', { ...feedback, recipient: 'a' });
      await command('wait-feedback-a', 'wait', { recipient: 'a', batchId: other.batchId, timeoutMs: 1000 });
      await command('status', 'status');
    } finally {
      await command('stop', 'stop');
    }
  });
  return {
    records,
    runtimeId: report.runtimeId,
    reportPath: report.reportPath,
    businessFailure: report.businessFailure,
    cleanupFailure: report.cleanupFailure,
    reportSaveFailure: report.reportSaveFailure,
  };
}

function observableStatus(status) {
  return {
    mode: status.mode,
    closing: status.closing,
    peers: status.peers.map(peer => ({
      key: peer.key,
      status: peer.status,
      ready: peer.ready,
      accepting: peer.accepting,
      fenced: peer.fenced,
      batches: peer.batches.map(batch => ({
        state: batch.state,
        status: batch.status,
        code: batch.code,
      })),
    })),
  };
}

async function durableScenario(runDirectory, runtimeId) {
  const core = JSON.parse(await readFile(join(runDirectory, 'runtime.json'), 'utf8'));
  const harness = JSON.parse(await readFile(join(runDirectory, 'harness-report.json'), 'utf8'));
  assert.equal(core.runtimeId, runtimeId);
  assert.equal(harness.runtimeId, runtimeId);
  return {
    configuration: core.config,
    coreStatus: core.status,
    businessFailure: harness.businessFailure,
    cleanupFailure: harness.cleanupFailure,
    reportSaveFailure: harness.reportSaveFailure,
    cleanup: harness.cleanup.cleanup,
    pending: harness.cleanup.pending,
    peers: harness.harness.peers.map(peer => ({
      key: peer.key,
      batches: peer.router.batches.map(batch => ({
        source: batch.source,
        state: batch.state,
        targetWorker: batch.targetWorker,
        eventId: batch.eventId,
        text: batch.text,
      })),
    })),
  };
}

test('installed headless and CLI share configuration, directed input provenance and durable results', {
  timeout: 180_000,
}, async t => {
  const installed = await installNotesExample();
  t.after(() => installed.close());
  const root = join(installed.directory, 'node_modules/@luna-shi/murm');
  const outputDir = join(installed.directory, 'controlled-output');
  await mkdir(outputDir);
  const entry = join(root, 'dist/scripts/run-harness.js');
  await stageInstalledTestFixtures(root);
  const configuration = join(root, 'dist/test/fixtures/foreground-host-configuration.js');
  // This fixture substitutes the backend, while the installed CLI, host, router,
  // Core input ledger, report writer and result reader execute normally.
  const child = spawn(process.execPath, [`--redirect-warnings=${join(installed.directory, 'cli-node-warnings.log')}`, entry, '--config', configuration], {
    cwd: installed.directory,
    env: { ...installed.env, FOREGROUND_TEST_OUTPUT: outputDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  const closed = once(child, 'close');
  const records = [];
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  const lines = createInterface({ input: child.stdout });
  t.after(() => lines.close());
  const send = (id, operation, input) => {
    child.stdin.write(JSON.stringify({ id, operation, input }) + '\n');
  };
  const requestId = 'shared-user-request';
  const feedback = { recipient: 'b', requestId, input: 'PRIVATE_DIRECTED_FEEDBACK' };
  lines.on('line', line => {
    const record = JSON.parse(line);
    records.push(record);
    if (record.type === 'ready') {
      send('kick-a', 'kickoff', { recipient: 'a', input: 'PRIVATE_KICKOFF_A' });
      send('kick-b', 'kickoff', { recipient: 'b', input: 'PRIVATE_KICKOFF_B' });
    }
    if (record.id === 'kick-b') {
      const a = records.find(row => row.id === 'kick-a');
      send('wait-kick-a', 'wait', { recipient: 'a', batchId: a.result.batchId, timeoutMs: 1000 });
      send('wait-kick-b', 'wait', { recipient: 'b', batchId: record.result.batchId, timeoutMs: 1000 });
    }
    if (record.id === 'wait-kick-b') send('feedback-b', 'input', feedback);
    if (record.id === 'feedback-b') {
      send('wait-feedback-b', 'wait', { recipient: 'b', batchId: record.result.batchId, timeoutMs: 1000 });
    }
    if (record.id === 'wait-feedback-b') {
      send('replay-b', 'input', feedback);
      send('conflict-b', 'input', { ...feedback, input: 'PRIVATE_CHANGED_FEEDBACK' });
      send('feedback-a', 'input', { ...feedback, recipient: 'a' });
    }
    if (record.id === 'feedback-a') {
      send('wait-feedback-a', 'wait', { recipient: 'a', batchId: record.result.batchId, timeoutMs: 1000 });
    }
    if (record.id === 'wait-feedback-a') send('status', 'status');
    if (record.id === 'status') send('stop', 'stop');
  });
  const [exitCode, signal] = await closed;
  assert.equal(signal, null);
  assert.equal(exitCode, 0, stderr);
  assert.equal(stderr, '');
  const reply = id => records.find(row => row.id === id);
  const ready = records.find(row => row.type === 'ready').status;
  const first = reply('feedback-b').result;
  assert.equal(reply('wait-feedback-b').result.state, 'completed');
  assert.equal(reply('wait-feedback-a').result.state, 'completed');
  assert.equal(reply('replay-b').result.batchId, first.batchId);
  assert.equal(reply('replay-b').result.inputId, reply('wait-feedback-b').result.inputId);
  assert.notEqual(reply('feedback-a').result.batchId, first.batchId);
  assert.deepEqual(reply('conflict-b'), { type: 'error', id: 'conflict-b', code: 'BATCH_CONFLICT' });
  assert.deepEqual(records.filter(row => row.type === 'error').map(row => row.code), ['BATCH_CONFLICT']);
  const status = reply('status').result;
  assert.deepEqual(status.peers.map(peer => peer.batches.length), [2, 2]);
  assert.deepEqual(status.peers.map(peer => peer.status), ['idle', 'idle']);
  assert.deepEqual(status.peers.map(peer => peer.agentId), ready.peers.map(peer => peer.agentId));
  const terminal = records.at(-1);
  assert.equal(terminal.type, 'result');
  assert.equal(terminal.runtimeId, ready.runtimeId);
  assert.equal(terminal.cleanup, 'complete');
  assert.equal(terminal.pendingCount, 0);
  assert.equal(terminal.businessFailureCode, null);
  assert.equal(terminal.cleanupFailureCode, null);
  assert.equal(terminal.reportSaveFailureCode, null);
  assert.deepEqual(terminal.agents.map(agent => agent.agentId).sort(), ready.peers.map(peer => peer.agentId).sort());
  assert.ok(terminal.agents.every(agent => agent.execution === 'stopped' && agent.cleanup === 'complete'));

  const saved = JSON.parse(await readFile(terminal.reportPath, 'utf8'));
  assert.equal(saved.runtimeId, ready.runtimeId);
  assert.deepEqual(saved.harness.peers.map(peer => peer.router.batches.length), [2, 2]);
  for (const peer of saved.harness.peers) {
    const batches = peer.router.batches;
    assert.deepEqual(batches.map(batch => batch.source), ['kickoff', 'user']);
    assert.ok(batches.every(batch => batch.state === 'completed' && batch.targetWorker === `worker-${peer.key}`));
    assert.equal(batches[1].eventId, requestId);
    assert.equal(batches[1].text, feedback.input);
    assert.equal(batches[1].batchId, reply(`feedback-${peer.key}`).result.batchId);
    assert.equal(new Set(batches.map(batch => batch.inputId)).size, 2);
  }
  const readEntry = join(root, 'dist/scripts/read-harness-result.js');
  const reader = JSON.parse((await execute(process.execPath, [
    readEntry, '--run-directory', ready.runDirectory, '--runtime-id', ready.runtimeId,
  ], { cwd: installed.directory, env: installed.env, timeout: 10_000 })).stdout);
  assert.equal(reader.runtimeId, ready.runtimeId);
  assert.equal(reader.harness.state, 'read');
  assert.equal(reader.core.state, 'read');
  assert.equal(reader.harness.business, 'returned');
  assert.equal(reader.harness.acceptance, 'not-interpreted');
  for (const receipt of [reader.harness, reader.core]) {
    assert.equal(receipt.cleanup, 'complete');
    assert.equal(receipt.pendingCount, 0);
    assert.deepEqual(receipt.agents, terminal.agents);
  }
  assert.doesNotMatch(JSON.stringify({ records, reader }), /PRIVATE_|private-git|private-mm/);

  const headlessOutput = join(installed.directory, 'headless-output');
  await mkdir(headlessOutput);
  const headlessEntry = join(installed.directory, 'headless.mjs');
  const hostModule = pathToFileURL(join(root, 'dist/src/cli/foreground-harnesses.js')).href;
  await writeFile(headlessEntry, [
    `import configuration from ${JSON.stringify(pathToFileURL(configuration).href)};`,
    `const { runForegroundHarness } = await import(${JSON.stringify(hostModule)});`,
    `const scenario = ${headlessScenario.toString()};`,
    'console.log(JSON.stringify(await scenario(configuration, runForegroundHarness)));',
  ].join('\n'));
  const headlessProcess = await execute(process.execPath, [`--redirect-warnings=${join(installed.directory, 'headless-node-warnings.log')}`, headlessEntry], {
    cwd: installed.directory,
    env: { ...installed.env, FOREGROUND_TEST_OUTPUT: headlessOutput },
    timeout: 15_000,
  });
  assert.equal(headlessProcess.stderr, '');
  const headless = JSON.parse(headlessProcess.stdout);
  assert.equal(headless.businessFailure, null);
  assert.equal(headless.cleanupFailure, null);
  assert.equal(headless.reportSaveFailure, null);
  const headlessReady = headless.records.find(row => row.type === 'ready').status;
  assert.notEqual(headless.runtimeId, ready.runtimeId);
  assert.equal(headless.runtimeId, headlessReady.runtimeId);
  assert.equal(headlessReady.runDirectory, join(headlessOutput, headless.runtimeId));
  assert.equal(headless.reportPath, join(headlessReady.runDirectory, 'harness-report.json'));
  assert.notEqual(headlessReady.runDirectory, ready.runDirectory);
  assert.deepEqual(observableStatus(headlessReady), observableStatus(ready));
  assert.deepEqual(ready.peers.map(peer => [peer.status, peer.ready, peer.accepting, peer.fenced]), [
    ['idle', true, true, false], ['idle', true, true, false],
  ]);
  const headlessStatus = headless.records.find(row => row.id === 'status').result;
  assert.deepEqual(headlessStatus.peers.map(peer => peer.agentId), headlessReady.peers.map(peer => peer.agentId));
  assert.ok(headlessReady.peers.every(peer => !ready.peers.some(other => other.agentId === peer.agentId)));
  assert.deepEqual(observableStatus(headlessStatus), observableStatus(status));
  assert.deepEqual(headless.records.filter(row => row.type === 'error').map(row => row.code), ['BATCH_CONFLICT']);
  const headlessReply = id => headless.records.find(row => row.id === id).result;
  assert.equal(headlessReply('replay-b').batchId, headlessReply('feedback-b').batchId);
  assert.equal(headlessReply('replay-b').inputId, headlessReply('wait-feedback-b').inputId);
  assert.notEqual(headlessReply('feedback-a').batchId, headlessReply('feedback-b').batchId);
  for (const id of ['wait-kick-a', 'wait-kick-b', 'wait-feedback-a', 'wait-feedback-b']) {
    assert.equal(headlessReply(id).state, 'completed');
  }
  const cliDurable = await durableScenario(ready.runDirectory, ready.runtimeId);
  const headlessDurable = await durableScenario(headlessReady.runDirectory, headless.runtimeId);
  assert.deepEqual(headlessDurable, cliDurable);
  assert.equal(cliDurable.configuration.maxAgents, 2);
  assert.equal(cliDurable.configuration.backend.piVersion, '1.3.0');
  assert.deepEqual(Object.keys(cliDurable.configuration.profiles).sort(), ['peer-a', 'peer-b']);
  for (const profile of Object.values(cliDurable.configuration.profiles)) {
    assert.equal(profile.image, 'fixture');
    assert.equal(profile.model, 'default');
  }
  assert.equal(cliDurable.coreStatus, 'closed');
  assert.equal(cliDurable.cleanup, 'complete');
  assert.deepEqual(cliDurable.pending, []);
  const headlessReader = JSON.parse((await execute(process.execPath, [
    readEntry, '--run-directory', headlessReady.runDirectory, '--runtime-id', headless.runtimeId,
  ], { cwd: installed.directory, env: installed.env, timeout: 10_000 })).stdout);
  assert.equal(headlessReader.runtimeId, headless.runtimeId);
  assert.equal(headlessReader.harness.state, 'read');
  assert.equal(headlessReader.core.state, 'read');
  for (const receipt of [headlessReader.harness, headlessReader.core]) {
    assert.equal(receipt.cleanup, 'complete');
    assert.equal(receipt.pendingCount, 0);
    assert.deepEqual(receipt.agents.map(agent => agent.agentId).sort(), headlessReady.peers.map(peer => peer.agentId).sort());
    assert.ok(receipt.agents.every(agent => agent.execution === 'stopped' && agent.cleanup === 'complete'));
  }
  assert.equal(headlessReader.harness.business, reader.harness.business);
  assert.equal(headlessReader.harness.acceptance, reader.harness.acceptance);
  assert.doesNotMatch(JSON.stringify({ headless, headlessReader }), /PRIVATE_|private-git|private-mm/);
});
