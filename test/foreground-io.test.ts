import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function runWithStreamFailure(t, failure, cleanupFailure) {
  const root = await mkdtemp(join(tmpdir(), 'foreground-io-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'configuration.mjs');
  await writeFile(path, `
import configuration from ${JSON.stringify(new URL('./fixtures/foreground-host-configuration.js', import.meta.url).href)};
import { PassThrough, Writable } from 'node:stream';
const original = process.stdout;
const input = new PassThrough();
const error = () => Object.assign(new Error('PRIVATE_STREAM_FAILURE'), { code: ${JSON.stringify(['input', 'both'].includes(failure) ? 'EIO' : 'EPIPE')} });
const send = (id, operation, value) => input.write(JSON.stringify({ id, operation, input: value }) + '\\n');
const output = new Writable({ write(bytes, encoding, callback) {
  const record = JSON.parse(bytes.toString());
  if (${JSON.stringify(failure)} === 'final' && record.type === 'result') { setImmediate(() => callback(error())); return; }
  original.write(bytes);
  callback();
  if (record.type === 'ready') {
    if (${JSON.stringify(failure)} === 'final') input.end();
    else send('start', 'kickoff', { recipient: 'a', input: 'held work' });
  }
  if (record.id === 'start') {
    send('waiting', 'wait', { recipient: 'a', batchId: record.result.batchId, timeoutMs: 4000 });
    send('queued', 'input', { recipient: 'b', requestId: 'queued', input: 'must never dispatch' });
    setImmediate(() => {
      (${JSON.stringify(['input', 'both'].includes(failure))} ? input : output).destroy(error());
      if (${JSON.stringify(failure === 'both')}) output.destroy(Object.assign(new Error('PRIVATE_SECOND_FAILURE'), { code: 'EPIPE' }));
      setImmediate(() => input.emit('data', Buffer.from(JSON.stringify({ id: 'late', operation: 'kickoff', input: { recipient: 'b', input: 'late' } }) + '\\n')));
    });
  }
} });
Object.defineProperty(process, 'stdin', { value: input });
Object.defineProperty(process, 'stdout', { value: output });
export default configuration;
`);
  // Keep native runtime warnings available without mixing them into application diagnostics.
  const child = spawn(process.execPath, [`--redirect-warnings=${join(root, 'node-warnings.log')}`, '--import', path, 'dist/scripts/run-harness.js', '--config', path], {
    env: { ...process.env, FOREGROUND_TEST_OUTPUT: root, FOREGROUND_TEST_HOLD: '1', ...(cleanupFailure ? { FOREGROUND_TEST_CLEANUP_FAILURE: cleanupFailure } : {}) }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  const stdout = [], stderr = [];
  child.stdout.on('data', value => stdout.push(value)); child.stderr.on('data', value => stderr.push(value));
  const started = performance.now();
  const [exit, signal] = await once(child, 'exit');
  assert.equal(signal, null);
  assert.equal(exit, 1);
  assert.ok(performance.now() - started < 3000, 'stream failure must bypass the four-second wait');
  const errors = Buffer.concat(stderr).toString();
  assert.ok(!errors.includes('PRIVATE_'), errors);
  const directories = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory());
  assert.equal(directories.length, 1, 'a run directory and saved receipt must survive stream failure');
  const runDirectory = join(root, directories[0].name);
  const files = await readdir(runDirectory);
  const reportFile = files.find(name => name.endsWith('report.json'));
  assert.ok(reportFile, JSON.stringify(files));
  const saved = JSON.parse(await readFile(join(runDirectory, reportFile), 'utf8'));
  const records = Buffer.concat(stdout).toString().trim().split('\n').filter(Boolean).map(JSON.parse);
  return { saved, records, errors };
}

test('foreground input EIO preserves its first safe failure, seals commands and saves bounded cleanup', { timeout: 10_000 }, async t => {
  const { saved, records } = await runWithStreamFailure(t, 'input');
  assert.equal(saved.businessFailure.code, 'HOST_INPUT_FAILED');
  assert.equal(saved.cleanup.cleanup, 'complete');
  assert.ok(saved.cleanup.bots.every(bot => bot.execution === 'stopped' && bot.cleanup === 'complete'));
  assert.equal(saved.environment.peers[0].router.batches.length, 1);
  assert.equal(saved.environment.peers[1].router.batches.length, 0);
  assert.ok(!records.some(row => ['waiting', 'queued', 'late'].includes(row.id)));
  assert.equal(records.at(-1).businessFailureCode, 'HOST_INPUT_FAILED');
});

test('foreground asynchronous output EPIPE seals commands and retains its saved failure and close receipt', { timeout: 10_000 }, async t => {
  const { saved, records } = await runWithStreamFailure(t, 'output');
  assert.equal(saved.businessFailure.code, 'HOST_OUTPUT_FAILED');
  assert.equal(saved.cleanup.cleanup, 'complete');
  assert.ok(saved.cleanup.bots.every(bot => bot.execution === 'stopped' && bot.cleanup === 'complete'));
  assert.equal(saved.environment.peers[0].router.batches.length, 1);
  assert.equal(saved.environment.peers[1].router.batches.length, 0);
  assert.ok(!records.some(row => ['waiting', 'queued', 'late'].includes(row.id)));
});

test('foreground final-result EPIPE exits safely after preserving the completed saved receipt', { timeout: 10_000 }, async t => {
  const { saved, records, errors } = await runWithStreamFailure(t, 'final');
  assert.equal(saved.businessFailure, null);
  assert.equal(saved.cleanup.cleanup, 'complete');
  assert.ok(saved.cleanup.bots.every(bot => bot.execution === 'stopped' && bot.cleanup === 'complete'));
  assert.deepEqual(records.map(row => row.type), ['ready']);
  assert.deepEqual(errors.trim().split('\n').map(JSON.parse), [{ code: 'HOST_OUTPUT_FAILED' }]);
});


test('foreground input failure remains first when output and execution cleanup also fail', { timeout: 10_000 }, async t => {
  const { saved, records, errors } = await runWithStreamFailure(t, 'both', 'stop-execution');
  assert.equal(saved.businessFailure.code, 'HOST_INPUT_FAILED');
  assert.equal(saved.cleanupFailure.code, 'CLEANUP_PENDING');
  assert.equal(saved.cleanup.cleanup, 'pending');
  assert.ok(saved.cleanup.bots.every(bot => bot.execution === 'unknown' && bot.cleanup === 'pending'));
  assert.equal(saved.environment.peers[1].router.batches.length, 0);
  assert.ok(!records.some(row => ['waiting', 'queued', 'late'].includes(row.id)));
  assert.deepEqual(errors.trim().split('\n').map(JSON.parse), [{ code: 'HOST_OUTPUT_FAILED' }]);
});

for (const stream of ['stdin', 'stdout']) {
  for (const { mode, stage } of [{ mode: 'agensh', stage: 'configuration' }, { mode: 'agensh', stage: 'first Bot startup' }, { mode: 'flat', stage: 'configuration' }]) {
    test(`foreground ${mode} ${stream} failure during ${stage} saves its safe failure and closes admitted resources`, { timeout: 10_000 }, async t => {
      const root = await mkdtemp(join(tmpdir(), 'foreground-startup-io-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const path = join(root, 'configuration.mjs');
      const expectedCode = stream === 'stdin' ? 'HOST_INPUT_FAILED' : 'HOST_OUTPUT_FAILED';
      const fail = `process.${stream}.emit('error', Object.assign(new Error('PRIVATE_STARTUP_IO'), { code: '${stream === 'stdin' ? 'EIO' : 'EPIPE'}' }));`;
      await writeFile(path, `
import configuration from ${JSON.stringify(new URL('./fixtures/foreground-host-configuration.js', import.meta.url).href)};
import { transport } from ${JSON.stringify(new URL('./fixtures/core-bot-service-backend.js', import.meta.url).href)};
${stage === 'configuration' ? `setTimeout(() => { ${fail} }, 5); await new Promise(resolve => setTimeout(resolve, 25));`
  : `transport.onSpawn = async () => { ${fail} await new Promise(resolve => setTimeout(resolve, 25)); };`}
export default { ...configuration, mode: ${JSON.stringify(mode)} };
`);
      const child = spawn(process.execPath, [`--redirect-warnings=${join(root, 'node-warnings.log')}`, 'dist/scripts/run-harness.js', '--config', path], {
        env: { ...process.env, FOREGROUND_TEST_OUTPUT: root }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      t.after(() => child.kill('SIGKILL'));
      const stdout = [], stderr = [];
      child.stdout.on('data', value => stdout.push(value)); child.stderr.on('data', value => stderr.push(value));
      const [exit, signal] = await once(child, 'exit');
      assert.equal(signal, null); assert.equal(exit, 1);
      const diagnostic = Buffer.concat(stderr).toString();
      assert.ok(!diagnostic.includes('PRIVATE_STARTUP_IO'), diagnostic);
      const directories = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory());
      assert.equal(directories.length, 1, 'startup failure must retain one saved run');
      const directory = join(root, directories[0].name);
      const saved = JSON.parse(await readFile(join(directory, 'environment-report.json'), 'utf8'));
      assert.equal(saved.businessFailure.code, expectedCode);
      assert.equal(saved.cleanupFailure, null);
      assert.ok(!JSON.stringify(saved).includes('PRIVATE_STARTUP_IO'));
      if (stream === 'stdin') {
        assert.equal(diagnostic, '');
        const records = Buffer.concat(stdout).toString().trim().split('\n').map(JSON.parse);
        assert.equal(records.length, 1); assert.equal(records[0].type, 'result');
        assert.equal(records[0].businessFailureCode, expectedCode);
        assert.equal(records[0].runtimeId, saved.runtimeId);
        assert.equal(records[0].reportPath, join(directory, 'environment-report.json'));
      } else {
        assert.equal(Buffer.concat(stdout).toString(), '');
        assert.deepEqual(diagnostic.trim().split('\n').map(JSON.parse), [{ code: expectedCode }]);
      }
      if (stage === 'configuration') {
        assert.ok(!(await readdir(directory)).includes('runtime.json'));
      } else {
        const core = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'));
        assert.equal(core.runtimeId, saved.runtimeId); assert.equal(core.status, 'closed');
        assert.equal(core.cleanup, 'complete'); assert.equal(core.bots.length, 1);
        assert.deepEqual(core.bots.map(bot => [bot.execution, bot.cleanup]), [['stopped', 'complete']]);
      }
    });
  }
}
