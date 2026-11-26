import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodexAppServerDriver } from '../scripts/codex-app-server-driver.js';

function fixture() {
  const writes: any[] = [];
  const records: any[] = [];
  const driver = createCodexAppServerDriver({
    model: 'test-model', cwd: '/workspace/project', systemPrompt: 'Role prompt',
    write: message => writes.push(message), publish: record => records.push(record),
  });
  const reply = async (method: string, result: unknown) => {
    await new Promise(resolve => setImmediate(resolve));
    const message = writes.findLast(message => message.method === method);
    assert.ok(message, `missing ${method}`);
    driver.observe({ id: message.id, result });
    await new Promise(resolve => setImmediate(resolve));
  };
  return { driver, writes, records, reply };
}

test('Codex retains one thread across completed turns and normalizes native outcomes', async () => {
  const f = fixture();
  await f.reply('initialize', { userAgent: 'codex/0.172.0' });
  await f.reply('thread/start', { thread: { id: 'thread-one' } });
  await f.driver.ready;
  f.driver.write({ type: 'prompt', id: 'first-input', message: 'First turn', streamingBehavior: 'steer' });
  await f.reply('turn/start', { turn: { id: 'turn-one' } });
  assert.ok(f.records.some(record => record.type === 'response' && record.id === 'first-input' && record.data.disposition === 'started'));
  f.driver.observe({ method: 'item/completed', params: { threadId: 'thread-one', turnId: 'turn-one', item: { type: 'agentMessage', text: 'First output' } } });
  f.driver.observe({ method: 'turn/completed', params: { threadId: 'thread-one', turn: { id: 'turn-one', status: 'completed', error: null } } });
  await new Promise(resolve => setImmediate(resolve));
  f.driver.write({ type: 'prompt', id: 'second-input', message: 'Second turn', streamingBehavior: 'steer' });
  await f.reply('turn/start', { turn: { id: 'turn-two' } });
  assert.equal(f.writes.filter(message => message.method === 'thread/start').length, 1);
  assert.equal(f.writes.filter(message => message.method === 'turn/start').length, 2);
  assert.equal(f.writes.findLast(message => message.method === 'turn/start').params.threadId, 'thread-one');
  assert.equal(f.records.filter(record => record.type === 'agent_settled').length, 1);
  assert.ok(f.records.some(record => record.type === 'message_end' && record.message.content[0]?.text === 'First output'));
  f.driver.close(new Error('test ended'));
});

test('Codex steers the active turn, defers followUp, and rejects unsupported steering modes before sending', async () => {
  const f = fixture();
  await f.reply('initialize', {});
  await f.reply('thread/start', { thread: { id: 'thread-one' } });
  await f.driver.ready;
  f.driver.write({ type: 'prompt', id: 'start', message: 'Start' });
  await f.reply('turn/start', { turn: { id: 'turn-one' } });
  f.driver.write({ type: 'steer', id: 'steer', message: 'Change', onlyWhileActive: true });
  await f.reply('turn/steer', { turnId: 'turn-one' });
  assert.equal(f.writes.findLast(message => message.method === 'turn/steer').params.expectedTurnId, 'turn-one');
  f.driver.write({ type: 'follow_up', id: 'follow', message: 'Continue', onlyWhileActive: true });
  f.driver.write({ type: 'steer', id: 'bad-mode', message: 'Bad', steeringMode: 'one-at-a-time' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.writes.filter(message => message.method === 'turn/start').length, 1);
  assert.ok(f.records.some(record => record.id === 'follow' && record.data?.disposition === 'queued'));
  assert.ok(f.records.some(record => record.id === 'bad-mode' && record.success === false));
  assert.equal(f.writes.filter(message => message.method === 'turn/steer').length, 1);
  f.driver.observe({ method: 'turn/completed', params: { threadId: 'thread-one', turn: { id: 'turn-one', status: 'completed' } } });
  await f.reply('turn/start', { turn: { id: 'turn-followup' } });
  assert.equal(f.writes.findLast(message => message.method === 'turn/start').params.input[0].text, 'Continue');
  assert.equal(f.records.filter(record => record.type === 'agent_settled').length, 0);
  f.driver.observe({ method: 'turn/completed', params: { threadId: 'thread-one', turn: { id: 'turn-followup', status: 'completed' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.records.filter(record => record.type === 'agent_settled').length, 1);
  f.driver.write({ type: 'steer', id: 'idle', message: 'Conditional', onlyWhileActive: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.records.some(record => record.id === 'idle' && record.code === 'NO_ACTIVE_EXECUTION'));
  f.driver.close();
});

test('Codex interruption discards queued inputs, waits for terminal evidence, and retains the thread for reuse', async () => {
  const f = fixture();
  await f.reply('initialize', {});
  await f.reply('thread/start', { thread: { id: 'thread-one' } });
  await f.driver.ready;
  f.driver.write({ type: 'prompt', id: 'start', message: 'Start' });
  await f.reply('turn/start', { turn: { id: 'turn-one' } });
  f.driver.write({ type: 'follow_up', id: 'queued', message: 'Discard me' });
  f.driver.write({ type: 'clear_queue', id: 'clear' });
  f.driver.write({ type: 'abort', id: 'interrupt' });
  await f.reply('turn/interrupt', {});
  assert.deepEqual(f.records.find(record => record.id === 'clear').data, { steering: [], followUp: ['Discard me'] });
  assert.equal(f.records.some(record => record.id === 'interrupt'), false);
  f.driver.observe({ method: 'turn/completed', params: { threadId: 'thread-one', turn: { id: 'turn-one', status: 'interrupted' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.records.some(record => record.id === 'interrupt' && record.success));
  f.driver.write({ type: 'prompt', id: 'next', message: 'New turn' });
  await f.reply('turn/start', { turn: { id: 'turn-two' } });
  const settlements = f.records.filter(record => record.type === 'agent_settled').length;
  f.driver.observe({ method: 'turn/completed', params: { threadId: 'thread-one', turn: { id: 'turn-one', status: 'interrupted' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.records.filter(record => record.type === 'agent_settled').length, settlements);
  assert.equal(f.writes.filter(message => message.method === 'thread/start').length, 1);
  f.driver.close();
});

test('a lost Codex acknowledgement preserves the original input uncertainty', async () => {
  const f = fixture();
  await f.reply('initialize', {});
  await f.reply('thread/start', { thread: { id: 'thread-one' } });
  await f.driver.ready;
  f.driver.write({ type: 'prompt', id: 'unknown', message: 'Potentially accepted' });
  await new Promise(resolve => setImmediate(resolve));
  f.driver.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.records.some(record => record.type === 'response' && record.id === 'unknown'), false);
  assert.equal(f.writes.filter(message => message.method === 'turn/start').length, 1);
});
