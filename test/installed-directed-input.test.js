import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { execute, installNotesExample } from './fixtures/notes-installed-package.js';

test('installed foreground input scopes replay by recipient and preserves provenance through saved results', {
  timeout: 180_000,
}, async t => {
  const installed = await installNotesExample();
  t.after(() => installed.close());
  const root = join(installed.directory, 'node_modules/@swarmenv/core');
  const outputDir = join(installed.directory, 'controlled-output');
  await mkdir(outputDir);
  const entry = join(root, 'scripts/run-environment.mjs');
  const configuration = join(root, 'test/fixtures/foreground-host-configuration.mjs');
  // This fixture substitutes the backend, while the installed CLI, host, router,
  // Core input ledger, report writer and result reader execute normally.
  const child = spawn(process.execPath, [entry, '--config', configuration], {
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
  assert.deepEqual(status.peers.map(peer => peer.botId), ready.peers.map(peer => peer.botId));
  const terminal = records.at(-1);
  assert.equal(terminal.type, 'result');
  assert.equal(terminal.runtimeId, ready.runtimeId);
  assert.equal(terminal.cleanup, 'complete');
  assert.equal(terminal.pendingCount, 0);
  assert.equal(terminal.businessFailureCode, null);
  assert.equal(terminal.cleanupFailureCode, null);
  assert.equal(terminal.reportSaveFailureCode, null);
  assert.deepEqual(terminal.bots.map(bot => bot.botId).sort(), ready.peers.map(peer => peer.botId).sort());
  assert.ok(terminal.bots.every(bot => bot.execution === 'stopped' && bot.cleanup === 'complete'));

  const saved = JSON.parse(await readFile(terminal.reportPath, 'utf8'));
  assert.equal(saved.runtimeId, ready.runtimeId);
  assert.deepEqual(saved.environment.peers.map(peer => peer.router.batches.length), [2, 2]);
  for (const peer of saved.environment.peers) {
    const batches = peer.router.batches;
    assert.deepEqual(batches.map(batch => batch.source), ['kickoff', 'user']);
    assert.ok(batches.every(batch => batch.state === 'completed' && batch.targetWorker === `worker-${peer.key}`));
    assert.equal(batches[1].eventId, requestId);
    assert.equal(batches[1].text, feedback.input);
    assert.equal(batches[1].batchId, reply(`feedback-${peer.key}`).result.batchId);
    assert.equal(new Set(batches.map(batch => batch.inputId)).size, 2);
  }
  const readEntry = join(root, 'scripts/read-environment-result.mjs');
  const reader = JSON.parse((await execute(process.execPath, [
    readEntry, '--run-directory', ready.runDirectory, '--runtime-id', ready.runtimeId,
  ], { cwd: installed.directory, env: installed.env, timeout: 10_000 })).stdout);
  assert.equal(reader.runtimeId, ready.runtimeId);
  assert.equal(reader.environment.state, 'read');
  assert.equal(reader.core.state, 'read');
  assert.equal(reader.environment.business, 'returned');
  assert.equal(reader.environment.acceptance, 'not-interpreted');
  for (const receipt of [reader.environment, reader.core]) {
    assert.equal(receipt.cleanup, 'complete');
    assert.equal(receipt.pendingCount, 0);
    assert.deepEqual(receipt.bots, terminal.bots);
  }
  assert.doesNotMatch(JSON.stringify({ records, reader }), /PRIVATE_|private-git|private-mm/);
});
