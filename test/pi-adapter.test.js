import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { AgentCoreAdapter, ERROR_CODES, SwarmEnvError } from '../src/index.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => queueMicrotask(() => child.emit('close', 0, null));
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

test('adapter launches the required NuRouter Pi RPC shape and binds the session to execution', async () => {
  let command;
  let args;
  const adapter = new AgentCoreAdapter({
    provider: 'openai',
    model: 'gpt-test',
    account: 'local-account',
    group: 'research',
    sessionDir: '/tmp/swarmenv-test-sessions',
    spawnProcess: (...values) => {
      [command, args] = values;
      return fakeChild();
    },
    manifestVersions: { piVersion: '1.3.0', nurouterVersion: '0.2.12' },
  });

  const session = await adapter.start({ executionId: 'execution-42' });
  session.child.stdout.write('{"type":"ready"}\n');
  await session.waitForReady();
  session.sendRpc({ type: 'ping', execution_id: 'execution-42' });
  assert.equal(command, 'nurouter');
  assert.deepEqual(args, [
    'pi', '--provider', 'openai', '--model', 'gpt-test', '--account', 'local-account', '--group', 'research',
    '--', '--mode', 'rpc', '--session-dir', '/tmp/swarmenv-test-sessions', '--session-id', 'execution-42',
  ]);
  assert.equal(session.manifest.pi_version, '1.3.0');
  assert.equal(session.manifest.nurouter_version, '0.2.12');
  assert.equal(session.manifest.node_version, process.versions.node);
  session.stop();
  assert.deepEqual(await session.wait(), { code: 0, signal: null, stdout: '{"type":"ready"}\n', stderr: '' });
});

test('adapter reports a stable startup error', async () => {
  const adapter = new AgentCoreAdapter({
    provider: 'openai', model: 'gpt-test', account: 'account', group: 'group', sessionDir: '/tmp/swarmenv-test-sessions',
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => child.emit('error', new Error('missing nurouter')));
      return child;
    },
    manifestVersions: { piVersion: '1.3.0', nurouterVersion: '0.2.12' },
  });
  await assert.rejects(() => adapter.start({ executionId: 'execution-fails' }), (error) => {
    assert.ok(error instanceof SwarmEnvError);
    assert.equal(error.code, ERROR_CODES.START_FAILED);
    return true;
  });
});

test('adapter smoke test starts and releases a real child process', async () => {
  const adapter = new AgentCoreAdapter({
    command: resolve('test/fixtures/fake-nurouter'),
    provider: 'openai',
    model: 'gpt-test',
    account: 'local-account',
    group: 'research',
    sessionDir: '/tmp/swarmenv-real-child-session',
    manifestVersions: { piVersion: '1.3.0', nurouterVersion: '0.2.12' },
  });
  const session = await adapter.start({ executionId: 'execution-real-child' });
  await session.waitForReady();
  session.stop();
  const result = await session.wait();
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
});

test('unexpected non-zero process exit is mapped to PROCESS_EXITED', async () => {
  let child;
  const adapter = new AgentCoreAdapter({
    provider: 'openai', model: 'gpt-test', account: 'account', group: 'group', sessionDir: '/tmp/swarmenv-test-sessions',
    spawnProcess: () => {
      child = fakeChild();
      return child;
    },
    manifestVersions: { piVersion: '1.3.0', nurouterVersion: '0.2.12' },
  });
  const session = await adapter.start({ executionId: 'execution-crashes' });
  child.kill = () => queueMicrotask(() => child.emit('close', 9, null));
  child.kill();
  await assert.rejects(() => session.wait(), (error) => {
    assert.ok(error instanceof SwarmEnvError);
    assert.equal(error.code, ERROR_CODES.PROCESS_EXITED);
    return true;
  });
});
