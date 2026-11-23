import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { readEnvironmentResult } from '../src/environments/shared/read-result.js';
import { installNotesExample } from './fixtures/notes-installed-package.js';

const execute = promisify(execFile);
const repository = new URL('..', import.meta.url);

async function stoppedCli(t, failure, cwd) {
  const outputDir = await mkdtemp(join(tmpdir(), 'terminal-result-parity-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['scripts/run-environment.mjs', '--config', 'test/fixtures/foreground-host-configuration.mjs'], {
    cwd, env: { ...process.env, FOREGROUND_TEST_OUTPUT: outputDir, FOREGROUND_TEST_CLEANUP_FAILURE: failure },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  const records = [], stderr = [];
  child.stderr.on('data', bytes => stderr.push(bytes));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const record = JSON.parse(line); records.push(record);
    if (record.type === 'ready') child.stdin.end(`${JSON.stringify({ id: 'stop-original-run', operation: 'stop' })}\n`);
  });
  const [exit, signal] = await once(child, 'close');
  lines.close();
  assert.equal(signal, null);
  assert.equal(Buffer.concat(stderr).toString(), '');
  return { outputDir, records, exit };
}

async function assertReceiptParity(t, { failure, execution, action, failureCode }, cwd = repository) {
  const { outputDir, records, exit } = await stoppedCli(t, failure, cwd);
  const ready = records.find(record => record.type === 'ready').status;
  assert.ok(ready.peers.every(peer => peer.status === 'idle' && peer.batches.length === 0));
  const result = records.at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.cleanup, 'pending');
  assert.equal(exit, 1);
  assert.equal(result.businessFailureCode, null);
  assert.equal(result.cleanupFailureCode, 'CLEANUP_PENDING');
  assert.equal(result.reportSaveFailureCode, null);
  assert.deepEqual(records.find(record => record.id === 'stop-original-run'), { type: 'reply', id: 'stop-original-run', result: { status: 'stopping' } });
  assert.equal(result.runtimeId, ready.runtimeId);
  assert.equal(ready.runDirectory, join(outputDir, result.runtimeId));
  assert.equal(result.reportPath, join(ready.runDirectory, 'environment-report.json'));
  assert.equal(result.bots.length, 2);
  assert.deepEqual(result.bots.map(bot => bot.botId).sort(), ready.peers.map(peer => peer.botId).sort());
  assert.ok(result.bots.every(bot => bot.execution === execution && bot.cleanup === 'pending'));
  assert.deepEqual(result.pending.filter(item => item.kind === 'bot').map(item => [item.id, item.action]).sort(),
    result.bots.map(bot => [bot.botId, action]).sort());

  const saved = JSON.parse(await readFile(result.reportPath, 'utf8'));
  const core = JSON.parse(await readFile(join(ready.runDirectory, 'runtime.json'), 'utf8'));
  assert.equal(saved.runtimeId, result.runtimeId);
  assert.equal(core.runtimeId, result.runtimeId);
  for (const receipt of [saved.cleanup, core]) {
    assert.equal(receipt.cleanup, 'pending');
    assert.ok(receipt.bots.every(bot => bot.errors.some(error => error.code === failureCode)));
    assert.deepEqual(receipt.bots.map(({ botId, execution, cleanup }) => ({ botId, execution, cleanup })), result.bots);
    assert.equal(receipt.pending.length, result.pendingCount);
    for (const pending of result.pending) {
      assert.ok(receipt.pending.some(item => Object.entries(pending).every(([key, value]) => item[key] === value)));
    }
  }
  assert.equal(saved.businessFailure, null);
  assert.equal(saved.cleanupFailure.code, result.cleanupFailureCode);
  const input = { runDirectory: ready.runDirectory, runtimeId: result.runtimeId };
  const inspected = await readEnvironmentResult(input);
  for (const receipt of [inspected.environment, inspected.core]) {
    assert.equal(receipt.state, 'read');
    assert.equal(receipt.cleanup, 'pending');
    assert.deepEqual(receipt.bots, result.bots);
    assert.equal(receipt.pendingCount, result.pendingCount);
  }
  assert.equal(inspected.environment.business, 'returned');
  assert.equal(inspected.environment.acceptance, 'not-interpreted');
  assert.equal(inspected.core.recordedStatus, 'closing');
  const { stdout } = await execute(process.execPath, ['scripts/read-environment-result.mjs', '--run-directory', input.runDirectory, '--runtime-id', input.runtimeId], { cwd });
  assert.deepEqual(JSON.parse(stdout), inspected);
  assert.ok(!JSON.stringify({ records, inspected }).includes('PRIVATE_'));
}

test('terminal stop keeps unknown execution and pending cleanup identical to saved Core and Environment receipts', { timeout: 15_000 }, async t => {
  await assertReceiptParity(t, { failure: 'stop-execution', execution: 'unknown', action: 'stop-execution', failureCode: 'FIXTURE_STOP_FAILED' });
});

test('terminal stop preserves confirmed execution stop when required artifact export remains pending', { timeout: 15_000 }, async t => {
  await assertReceiptParity(t, { failure: 'collect-artifacts', execution: 'stopped', action: 'collect-artifacts', failureCode: 'ARTIFACT_WRITE_FAILED' });
});

test('installed terminal and saved-result entries preserve pending receipts without legacy browser sources or built assets', { timeout: 180_000 }, async t => {
  const installed = await installNotesExample();
  t.after(() => installed.close());
  const packageRoot = join(installed.directory, 'node_modules', '@swarmenv', 'core');
  for (const path of ['src/observability/client', 'src/observability/public', 'src/observability/vite.config.js']) {
    await rm(join(packageRoot, path), { recursive: true, force: true });
  }
  await assertReceiptParity(t, { failure: 'collect-artifacts', execution: 'stopped', action: 'collect-artifacts', failureCode: 'ARTIFACT_WRITE_FAILED' }, pathToFileURL(`${packageRoot}/`));
});
