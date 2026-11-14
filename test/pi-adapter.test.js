import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
    'pi', '--account', 'local-account',
    '--', '--mode', 'rpc', '--session-dir', '/tmp/swarmenv-test-sessions', '--session-id', 'execution-42',
    '--no-builtin-tools', '--no-skills', '--no-prompt-templates', '--no-context-files',
    '--provider', 'openai', '--model', 'gpt-test',
  ]);
  assert.equal(session.manifest.pi_version, '1.3.0');
  assert.equal(session.manifest.nurouter_version, '0.2.12');
  assert.equal(session.manifest.node_version, process.versions.node);
  session.stop();
  assert.deepEqual(await session.wait(), { code: 0, signal: null, stdout: '{"type":"ready"}\n', stderr: '' });
});

test('adapter injects the stable identity contract as a system-role addendum', async () => {
  const sessionDir = await mkdtemp('/tmp/swarmenv-system-prompt-');
  let args;
  const identity = 'You are a continuous SwarmEnv research identity.\nNever invent a commit.';
  const adapter = new AgentCoreAdapter({
    provider: 'openai', model: 'gpt-test', sessionDir,
    systemPrompt: identity,
    spawnProcess: (...values) => {
      [, args] = values;
      return fakeChild();
    },
  });
  try {
    const session = await adapter.start({ executionId: 'execution-system-prompt', sessionDir });
    const flag = args.indexOf('--append-system-prompt');
    assert.ok(flag > 0, 'launch args must carry the system-role addendum');
    const promptPath = args[flag + 1];
    assert.ok(promptPath.startsWith(sessionDir));
    assert.equal(await readFile(promptPath, 'utf8'), identity);
    assert.ok(!args.includes(identity), 'identity text must come from a file, not argv');
    session.stop();
    await session.wait();
  } finally {
    await rm(sessionDir, { recursive: true, force: true });
  }
});

test('adapter keeps managed Kimi routing in the NuRouter argument segment', async () => {
  let args;
  const adapter = new AgentCoreAdapter({
    provider: 'kimi',
    model: 'k3',
    account: 'local-account',
    group: 'research',
    sessionDir: '/tmp/swarmenv-kimi-session',
    spawnProcess: (...values) => {
      [, args] = values;
      return fakeChild();
    },
    manifestVersions: { piVersion: '1.3.0', nurouterVersion: '0.2.12' },
  });

  const session = await adapter.start({ executionId: 'execution-kimi' });
  assert.deepEqual(args, [
    'pi', '--provider', 'kimi', '--model', 'k3', '--account', 'local-account', '--group', 'research',
    '--', '--mode', 'rpc', '--session-dir', '/tmp/swarmenv-kimi-session', '--session-id', 'execution-kimi',
    '--no-builtin-tools', '--no-skills', '--no-prompt-templates', '--no-context-files',
  ]);
  session.stop();
  await session.wait();
});

test('adapter allows route defaults when account and group are omitted', async () => {
  let args;
  const adapter = new AgentCoreAdapter({
    provider: 'openai',
    model: 'gpt-6.1-sol',
    sessionDir: '/tmp/swarmenv-default-route-session',
    spawnProcess: (...values) => {
      [, args] = values;
      return fakeChild();
    },
    manifestVersions: { piVersion: '1.3.0', nurouterVersion: '0.2.12' },
  });

  const session = await adapter.start({ executionId: 'execution-default-route' });
  assert.deepEqual(args, [
    'pi', '--', '--mode', 'rpc', '--session-dir', '/tmp/swarmenv-default-route-session',
    '--session-id', 'execution-default-route', '--no-builtin-tools', '--no-skills', '--no-prompt-templates', '--no-context-files', '--provider', 'openai', '--model', 'gpt-6.1-sol',
  ]);
  session.stop();
  await session.wait();
});

test('adapter rejects unsupported providers and conflicting OpenAI selectors before spawning', () => {
  const conflicting = new AgentCoreAdapter({
    provider: 'openai', model: 'gpt-test', account: '1', group: 'research', sessionDir: '/tmp/swarmenv-invalid-route',
  });
  assert.throws(() => conflicting.buildLaunchArgs({ executionId: 'execution-invalid-route' }), (error) => {
    assert.ok(error instanceof SwarmEnvError);
    assert.equal(error.code, ERROR_CODES.INVALID_CONTRACT);
    assert.match(error.message, /both account and group/);
    return true;
  });

  const unsupported = new AgentCoreAdapter({ provider: 'anthropic', model: 'claude', sessionDir: '/tmp/swarmenv-unsupported-route' });
  assert.throws(() => unsupported.buildLaunchArgs({ executionId: 'execution-unsupported-route' }), (error) => {
    assert.ok(error instanceof SwarmEnvError);
    assert.equal(error.code, ERROR_CODES.INVALID_CONTRACT);
    assert.match(error.message, /unsupported NuRouter\/Pi provider/);
    return true;
  });

  const prototypeProperty = new AgentCoreAdapter({ provider: '__proto__', model: 'unexpected', sessionDir: '/tmp/swarmenv-prototype-route' });
  assert.throws(() => prototypeProperty.buildLaunchArgs({ executionId: 'execution-prototype-route' }), (error) => {
    assert.ok(error instanceof SwarmEnvError);
    assert.equal(error.code, ERROR_CODES.INVALID_CONTRACT);
    assert.match(error.message, /unsupported NuRouter\/Pi provider/);
    return true;
  });
});

test('session exposes compaction and retry events and configures automatic recovery', async () => {
  let child;
  const commands = [];
  const spawnProcess = () => {
    child = fakeChild();
    child.stdin.on('data', (chunk) => {
      const command = JSON.parse(chunk.toString());
      commands.push(command);
      if (['get_state', 'set_auto_compaction', 'set_auto_retry'].includes(command.type)) {
        child.stdout.write(JSON.stringify({ type: 'response', id: command.id, success: true, data: { mode: 'rpc', model: { contextWindow: 500_000 } } }) + '\n');
      } else if (command.type === 'prompt') {
        child.stdout.write(JSON.stringify({ type: 'response', id: command.id, success: true, data: { disposition: 'started' } }) + '\n');
      }
    });
    return child;
  };
  const adapter = new AgentCoreAdapter({
    command: 'pi', provider: 'openai-codex', model: 'gpt-6.1-sol', sessionDir: '/tmp/swarmenv-rpc-recovery-session', spawnProcess,
    manifestVersions: { piVersion: '1.3.0', nurouterVersion: '0.2.12' },
  });
  const session = await adapter.start({ executionId: 'execution-recovery', agentPrompt: 'continue' });
  const events = [];
  session.on('rpc', (record) => events.push(record));
  child.stdout.write(JSON.stringify({ type: 'compaction_start', reason: 'threshold' }) + '\n');
  child.stdout.write(JSON.stringify({ type: 'compaction_end', reason: 'threshold', result: { tokensBefore: 100, estimatedTokensAfter: 20 }, willRetry: false }) + '\n');
  child.stdout.write(JSON.stringify({ type: 'auto_retry_end', success: false, attempt: 15, finalError: 'provider unavailable' }) + '\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(commands.filter((command) => ['set_auto_compaction', 'set_auto_retry'].includes(command.type)).map((command) => command.type), ['set_auto_compaction', 'set_auto_retry']);
  assert.equal(commands.find((command) => command.type === 'set_auto_compaction').enabled, true);
  assert.equal(commands.find((command) => command.type === 'set_auto_retry').enabled, true);
  assert.equal(session.contextWindow, 500_000);
  assert.deepEqual(events.map((event) => event.type), ['compaction_start', 'compaction_end', 'auto_retry_end']);
  session.stop();
  await session.wait();
});

test('session translates prompt and readiness into Pi RPC commands and observes settlement', async () => {
  let child;
  const adapter = new AgentCoreAdapter({
    provider: 'openai', model: 'gpt-test', account: 'local-account', sessionDir: '/tmp/swarmenv-rpc-session',
    spawnProcess: () => {
      child = fakeChild();
      return child;
    },
    manifestVersions: { piVersion: '1.3.0', nurouterVersion: '0.2.12' },
  });
  const session = await adapter.start({ executionId: 'execution-rpc' });
  const commands = [];
  child.stdin.on('data', (chunk) => {
    const command = JSON.parse(chunk.toString());
    commands.push(command);
    if (command.type === 'get_state') {
      child.stdout.write(JSON.stringify({ type: 'response', id: command.id, success: true, data: { mode: 'rpc' } }) + '\n');
    } else if (command.type === 'prompt') {
      child.stdout.write(JSON.stringify({ type: 'response', id: command.id, success: true, data: { disposition: 'started' } }) + '\n');
      child.stdout.write(JSON.stringify({ type: 'agent_settled', reason: 'idle' }) + '\n');
    }
  });

  await session.waitForReady();
  const sequence = session.rpcRecords.length;
  const response = await session.prompt('submit the candidate', { timeoutMs: 1_000 });
  const settled = await session.waitForSettled({ afterSequence: sequence });
  assert.equal(response.data.disposition, 'started');
  assert.equal(settled.type, 'agent_settled');
  assert.equal(commands.at(-1).message, 'submit the candidate');
  assert.equal('timeoutMs' in commands.at(-1), false);
  session.stop();
  await session.wait();
});

test('adapter reports a stable startup error', async () => {
  const adapter = new AgentCoreAdapter({
    provider: 'openai', model: 'gpt-test', account: 'account', sessionDir: '/tmp/swarmenv-test-sessions',
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
    sessionDir: '/tmp/swarmenv-real-child-session',
    manifestVersions: { piVersion: '1.3.0', nurouterVersion: '0.2.12' },
  });
  const session = await adapter.start({ executionId: 'execution-real-child' });
  await session.waitForReady();
  session.stop();
  const result = await session.wait();
  assert.ok(result.code === 0 || result.signal === 'SIGTERM');
});

test('session stop waits for exit and escalates when SIGTERM is ignored', async () => {
  let child;
  const signals = [];
  const adapter = new AgentCoreAdapter({
    provider: 'openai', model: 'gpt-test', sessionDir: '/tmp/swarmenv-stubborn-session',
    spawnProcess: () => {
      child = fakeChild();
      child.kill = (signal) => {
        signals.push(signal);
        if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', 137, 'SIGKILL'));
      };
      return child;
    },
  });

  const session = await adapter.start({ executionId: 'execution-stubborn' });
  const result = await session.stop('SIGTERM', { timeoutMs: 10 });

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(session.closed, true);
});

test('unexpected non-zero process exit is mapped to PROCESS_EXITED', async () => {
  let child;
  const adapter = new AgentCoreAdapter({
    provider: 'openai', model: 'gpt-test', account: 'account', sessionDir: '/tmp/swarmenv-test-sessions',
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
