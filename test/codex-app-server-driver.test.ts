import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodexAppServerDriver } from '../scripts/codex-app-server-driver.js';

function fixture(isInputFenced?: () => boolean) {
  const writes: any[] = [];
  const records: any[] = [];
  const driver = createCodexAppServerDriver({
    model: 'test-model', cwd: '/workspace/project', systemPrompt: 'Role prompt',
    ...(isInputFenced ? { isInputFenced } : {}),
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

test('a completed Codex turn settles before a queued successor starts after a late steer acknowledgement', async t => {
  const f = fixture();
  t.after(() => f.driver.close());
  await f.reply('initialize', {});
  await f.reply('thread/start', { thread: { id: 'thread-one' } });
  await f.driver.ready;
  f.driver.write({ type: 'prompt', id: 'first', message: 'First' });
  await f.reply('turn/start', { turn: { id: 'turn-one' } });
  f.driver.write({ type: 'steer', id: 'late-steer', message: 'In flight' });
  await new Promise(resolve => setImmediate(resolve));
  f.driver.write({ type: 'prompt', id: 'successor', message: 'Next' });
  f.driver.observe({ method: 'turn/completed', params: { threadId: 'thread-one', turn: { id: 'turn-one', status: 'completed' } } });
  await f.reply('turn/steer', { turnId: 'turn-one' });
  // The old turn must have settled before the queued new start is acknowledged.
  assert.equal(f.records.filter(record => record.type === 'agent_settled').length, 1);
  await f.reply('turn/start', { turn: { id: 'turn-two' } });
  const transitions = f.records.filter(record => ['agent_start', 'agent_settled'].includes(record.type)).map(record => record.type);
  assert.deepEqual(transitions, ['agent_start', 'agent_settled', 'agent_start']);
  f.driver.close();
});

test('an accepted Codex start without an identity preserves input uncertainty', async t => {
  const f = fixture();
  t.after(() => f.driver.close());
  await f.reply('initialize', {});
  await f.reply('thread/start', { thread: { id: 'thread-one' } });
  await f.driver.ready;
  f.driver.write({ type: 'prompt', id: 'malformed-start', message: 'Potentially accepted' });
  await f.reply('turn/start', { turn: {} });
  assert.equal(f.records.some(record => record.type === 'response' && record.id === 'malformed-start'), false);
  assert.ok(f.records.some(record => record.type === 'worker_error'));
});

test('Codex readiness waits for the native thread and excludes verbose native payloads from Worker history', async t => {
  const f = fixture();
  t.after(() => f.driver.close());
  f.driver.write({ type: 'get_state', id: 'ready' });
  await f.reply('initialize', {});
  assert.equal(f.records.some(record => record.id === 'ready'), false);
  await f.reply('thread/start', { thread: { id: 'thread-one' } });
  assert.ok(f.records.some(record => record.id === 'ready' && record.success && record.data.sessionId === 'thread-one'));
  f.driver.observe({ method: 'item/agentMessage/delta', params: { threadId: 'thread-one', delta: 'verbose private output' } });
  assert.equal(JSON.stringify(f.records).includes('verbose private output'), false);
});

test('a failed native thread startup cannot report a ready Codex Agent', async t => {
  const f = fixture();
  t.after(() => f.driver.close());
  f.driver.write({ type: 'get_state', id: 'ready' });
  await f.reply('initialize', {});
  const starting = f.writes.findLast(message => message.method === 'thread/start');
  f.driver.observe({ id: starting.id, error: { code: -32602, message: 'invalid configuration' } });
  await assert.rejects(f.driver.ready, /invalid configuration/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.records.some(record => record.id === 'ready' && record.success), false);
  assert.equal(f.writes.some(message => message.method === 'turn/start'), false);
});

for (const [name, acknowledgement] of [['missing', {}], ['foreign', { turnId: 'foreign' }]] as const) {
  test(`a ${name} Codex steer identity preserves the original input uncertainty`, async t => {
    const f = fixture();
    t.after(() => f.driver.close());
    await f.reply('initialize', {});
    await f.reply('thread/start', { thread: { id: 'thread-one' } });
    await f.driver.ready;
    f.driver.write({ type: 'prompt', id: 'first', message: 'First' });
    await f.reply('turn/start', { turn: { id: 'turn-one' } });
    f.driver.write({ type: 'steer', id: 'uncertain-steer', message: 'Change', onlyWhileActive: true });
    await f.reply('turn/steer', acknowledgement);
    assert.equal(f.records.some(record => record.type === 'response' && record.id === 'uncertain-steer'), false);
    assert.ok(f.records.some(record => record.type === 'worker_error'));
  });
}

test('the Worker interrupt fence preserves a followUp for clear_queue despite terminal priority', async t => {
  let fenced = false;
  const f = fixture(() => fenced);
  t.after(() => f.driver.close());
  await f.reply('initialize', {});
  await f.reply('thread/start', { thread: { id: 'thread-one' } });
  await f.driver.ready;
  f.driver.write({ type: 'prompt', id: 'first', message: 'First' });
  await f.reply('turn/start', { turn: { id: 'turn-one' } });
  f.driver.write({ type: 'follow_up', id: 'queued', message: 'Discard me' });
  await new Promise(resolve => setImmediate(resolve));
  f.driver.write({ type: 'steer', id: 'pending-ack', message: 'In flight' });
  await new Promise(resolve => setImmediate(resolve));
  // The Worker sets this fence before serializing its clear_queue and abort.
  fenced = true;
  f.driver.write({ type: 'prompt', id: 'old-pending-input', message: 'Old pending input' });
  f.driver.write({ type: 'clear_queue', id: 'clear' });
  f.driver.write({ type: 'abort', id: 'abort' });
  f.driver.observe({ method: 'turn/completed', params: { threadId: 'thread-one', turn: { id: 'turn-one', status: 'completed' } } });
  await f.reply('turn/steer', { turnId: 'turn-one' });
  assert.equal(f.writes.filter(message => message.method === 'turn/start').length, 1);
  assert.deepEqual(f.records.find(record => record.id === 'clear')?.data, { steering: [], followUp: ['Discard me'] });
  assert.ok(f.records.some(record => record.id === 'abort' && record.success));
  assert.ok(f.records.some(record => record.id === 'old-pending-input' && record.success === false && record.code === 'NOT_ALLOWED'));
  f.driver.write({ type: 'get_state', id: 'drain' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.records.some(record => record.id === 'drain' && record.success));
  fenced = false;
  f.driver.write({ type: 'prompt', id: 'after-fence', message: 'Next' });
  await f.reply('turn/start', { turn: { id: 'turn-two' } });
  assert.equal(f.writes.filter(message => message.method === 'turn/start').length, 2);
});

for (const completed of [false, true]) {
  test(`conditional native steer rejection reports idle only with observed terminal evidence (${completed})`, async t => {
    const f = fixture();
    t.after(() => f.driver.close());
    await f.reply('initialize', {});
    await f.reply('thread/start', { thread: { id: 'thread-one' } });
    await f.driver.ready;
    f.driver.write({ type: 'prompt', id: 'first', message: 'First' });
    await f.reply('turn/start', { turn: { id: 'turn-one' } });
    f.driver.write({ type: 'steer', id: 'conditional', message: 'Change', onlyWhileActive: true });
    await new Promise(resolve => setImmediate(resolve));
    const steering = f.writes.findLast(message => message.method === 'turn/steer');
    if (completed) f.driver.observe({ method: 'turn/completed', params: { threadId: 'thread-one', turn: { id: 'turn-one', status: 'completed' } } });
    f.driver.observe({ id: steering.id, error: { code: -32602, message: 'native request rejected' } });
    await new Promise(resolve => setImmediate(resolve));
    const response = f.records.find(record => record.type === 'response' && record.id === 'conditional');
    assert.equal(response.success, false);
    assert.equal(response.code, completed ? 'NO_ACTIVE_EXECUTION' : 'NOT_ALLOWED');
  });
}

test('terminal evidence cannot turn a malformed steer success into an idle rejection', async t => {
  const f = fixture();
  t.after(() => f.driver.close());
  await f.reply('initialize', {});
  await f.reply('thread/start', { thread: { id: 'thread-one' } });
  await f.driver.ready;
  f.driver.write({ type: 'prompt', id: 'first', message: 'First' });
  await f.reply('turn/start', { turn: { id: 'turn-one' } });
  f.driver.write({ type: 'steer', id: 'uncertain', message: 'Change', onlyWhileActive: true });
  await new Promise(resolve => setImmediate(resolve));
  f.driver.observe({ method: 'turn/completed', params: { threadId: 'thread-one', turn: { id: 'turn-one', status: 'completed' } } });
  await f.reply('turn/steer', {});
  assert.equal(f.records.some(record => record.type === 'response' && record.id === 'uncertain'), false);
  assert.ok(f.records.some(record => record.type === 'worker_error'));
});
