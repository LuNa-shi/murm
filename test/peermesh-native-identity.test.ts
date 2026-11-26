import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { AGENT_UID, PROJECT_DIR } from '../scripts/sandbox-project.js';
import { nativeIdentityProgram, observeNativeIdentity } from './fixtures/peermesh-native-identity.js';

const execute = promisify(execFile);
const expected = { pid: 123, start: '456', cwd: PROJECT_DIR, branch: 'peer-fixed' };

test('Docker identity observation uses the Agent UID and preserves each argv value', async () => {
  const container = "owned-'$(never-execute)'", branches = ['peer-fixed', 'peer-other'];
  let argv;
  const result = await observeNativeIdentity(container, async (command, args) => {
    assert.equal(command, 'docker'); argv = args;
    return { stdout: JSON.stringify({ ok: true, identity: expected }) };
  }, { stage: 'identity-initial', branches });
  assert.deepEqual(argv, ['exec', '--user', `${AGENT_UID}:${AGENT_UID}`, container, 'node', '--input-type=module', '-e', nativeIdentityProgram,
    String(AGENT_UID), PROJECT_DIR, JSON.stringify(branches)]);
  assert.deepEqual(result, expected);
});

test('identity diagnostics retain only finite stage, code, exit and timeout fields', async () => {
  const stages = ['identity-initial', 'identity-final'];
  for (const stage of stages) {
    const error = Object.assign(new Error('private-stderr'), { code: 17, killed: true, stderr: 'private-stderr', stdout: 'private-stdout' });
    await assert.rejects(observeNativeIdentity('owned', async () => { throw error; }, { stage, branches: ['peer-fixed'] }), error => {
      assert.deepEqual(error.identityDiagnostic, { stage, code: 'LIVE_IDENTITY_COMMAND_FAILED', timeout: true, exitStatus: 17 });
      assert.equal(JSON.stringify(error).includes('private-'), false);
      return true;
    });
  }
  for (const stdout of ['null', 'true', '17', 'private-invalid-json', JSON.stringify({ ok: false, code: 'private-stderr' }),
    JSON.stringify({ ok: true, identity: { ...expected, cwd: '/private-path' } }), 'x'.repeat(4097)]) {
    await assert.rejects(observeNativeIdentity('owned', async () => ({ stdout }), { stage: stages[0], branches: ['peer-fixed'] }), error => {
      assert.equal(error.code, 'LIVE_IDENTITY_RESPONSE');
      assert.equal(JSON.stringify(error).includes('private-'), false);
      return true;
    });
  }
});

test('exact observer reads a real same-UID Pi process, stable start, cwd and Git branch', { skip: process.platform !== 'linux' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agensh-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await execute('git', ['init', '--quiet', '--initial-branch=peer-fixed', directory]);
  const children = new Set();
  t.after(async () => {
    await Promise.all([...children].map(async child => { const closed = once(child, 'close'); child.kill('SIGKILL'); await closed; }));
  });
  const start = async () => {
    const child = spawn(process.execPath, ['-e', "process.title='pi';process.stdout.write('ready');setInterval(()=>{},1000)"], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child); await once(child.stdout, 'data'); return child;
  };
  const stop = async child => { const closed = once(child, 'close'); child.kill('SIGKILL'); await closed; children.delete(child); };
  const observe = async (cwd = directory, branches = ['peer-fixed'], uid = process.getuid()) => {
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', nativeIdentityProgram, String(uid), cwd, JSON.stringify(branches)], { timeout: 5000, maxBuffer: 4096 });
    return JSON.parse(stdout);
  };
  assert.deepEqual(await observe(), { ok: false, code: 'LIVE_IDENTITY_COUNT' });
  const child = await start();
  const first = await observe();
  assert.equal(first.ok, true); assert.equal(first.identity.pid, child.pid);
  assert.match(first.identity.start, /^[1-9][0-9]*$/);
  assert.equal(first.identity.cwd, directory); assert.equal(first.identity.branch, 'peer-fixed');
  assert.deepEqual(await observe(), first);
  assert.deepEqual(await observe(directory, ['wrong-branch']), { ok: false, code: 'LIVE_IDENTITY_BRANCH' });
  assert.deepEqual(await observe('/wrong-cwd'), { ok: false, code: 'LIVE_IDENTITY_CWD' });
  assert.deepEqual(await observe(directory, ['peer-fixed'], process.getuid() + 1), { ok: false, code: 'LIVE_IDENTITY_OBSERVER_UID' });
  const second = await start();
  assert.deepEqual(await observe(), { ok: false, code: 'LIVE_IDENTITY_COUNT' });
  await stop(second);
  assert.deepEqual(await observe(), first);
  await stop(child);
  assert.deepEqual(await observe(), { ok: false, code: 'LIVE_IDENTITY_COUNT' });
});
