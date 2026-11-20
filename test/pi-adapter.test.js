import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { AgentCoreSession, validatePiProvider, ERROR_CODES, SwarmEnvError } from '../src/index.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => queueMicrotask(() => child.emit('close', 0, null));
  return child;
}

test('Pi provider validation accepts configured providers and rejects unsupported routes', () => {
  for (const provider of ['openai', 'openai-codex', 'gpt_proxy', 'kimi_proxy']) {
    assert.doesNotThrow(() => validatePiProvider(provider));
  }
  for (const provider of ['kimi', 'anthropic', '__proto__', undefined]) {
    assert.throws(() => validatePiProvider(provider), error => error.code === ERROR_CODES.INVALID_CONTRACT);
  }
});

test('Session reads and releases a real child transport', async t => {
  const child = spawn(process.execPath, [resolve('test/fixtures/fake-pi')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const session = new AgentCoreSession(child, { executionId: 'execution-real-child' });
  t.after(() => session.stop());
  await session.waitForReady();
  await session.stop();
  const result = await session.wait();
  assert.ok(result.code === 0 || result.signal === 'SIGTERM');
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
  const session = new AgentCoreSession(spawnProcess(), { executionId: 'execution-recovery' });
  await session.waitForReady();
  await session.setAutoCompaction(true);
  await session.setAutoRetry(true);
  await session.prompt('continue');
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
  const child = fakeChild();
  const session = new AgentCoreSession(child, { executionId: 'execution-rpc' });
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


test('session stop waits for exit and escalates when SIGTERM is ignored', async () => {
  const child = fakeChild();
  const signals = [];
  child.kill = signal => {
    signals.push(signal);
    if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', 137, 'SIGKILL'));
  };
  const session = new AgentCoreSession(child, { executionId: 'execution-stubborn' });
  const result = await session.stop('SIGTERM', { timeoutMs: 10 });

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(session.closed, true);
});


test('unexpected non-zero process exit is mapped to PROCESS_EXITED', async () => {
  const child = fakeChild();
  const session = new AgentCoreSession(child, { executionId: 'execution-crashes' });
  child.kill = () => queueMicrotask(() => child.emit('close', 9, null));
  child.kill();
  await assert.rejects(() => session.wait(), (error) => {
    assert.ok(error instanceof SwarmEnvError);
    assert.equal(error.code, ERROR_CODES.PROCESS_EXITED);
    return true;
  });
});
