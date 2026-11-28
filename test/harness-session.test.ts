import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHarnessSession, type ProjectHarness, type ProjectHarnessContext } from '../src/harness/project-harness.js';

test('a repeated start retains its admitted Run and a changed operation conflicts', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'murm-session-project-'));
  const outputRoot = await mkdtemp(join(tmpdir(), 'murm-session-output-'));
  const harness: ProjectHarness = { apiVersion: 1, id: 'test', async run(context) {
    context.markRunning();
    return { outcome: 'completed', reason: 'done', artifacts: [], cleanup: { status: 'complete' } };
  } };
  try {
    const session = createHarnessSession(harness, { outputRoot });
    const first = await session.start({ cwd, prompt: 'work' }, { requestId: 'start' });
    assert.deepEqual(await session.start({ cwd, prompt: 'work' }, { requestId: 'start' }), first);
    await assert.rejects(session.stop({ requestId: 'start' }), { code: 'REQUEST_ID_CONFLICT' });
    assert.equal((await session.completion)!.outcome, 'completed');
    assert.deepEqual(await session.start({ cwd, prompt: 'work' }, { requestId: 'start' }), first);
  } finally { await rm(cwd, { recursive: true, force: true }); await rm(outputRoot, { recursive: true, force: true }); }
});

test('answering an existing question and stopping bypass a stalled input', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'murm-session-project-'));
  const outputRoot = await mkdtemp(join(tmpdir(), 'murm-session-output-'));
  const ready = Promise.withResolvers<void>();
  let answer: unknown;
  const session = createHarnessSession({ apiVersion: 1, id: 'questions', input: true, questions: true, async run(context) {
    context.registerInput(async () => { await new Promise(() => {}); return null; });
    context.markRunning();
    const waiting = context.askUser({ requestId: 'question', questionId: 'q', kind: 'text', text: 'Continue?' }, { id: 'work', signal: context.signal });
    ready.resolve();
    answer = await waiting;
    await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
    return { outcome: 'cancelled', reason: 'stopped', artifacts: [], cleanup: { status: 'complete' } };
  } }, { outputRoot, clientCapabilities: { questions: true }, limits: { mutations: 2, handlerTimeoutMs: 100 } });
  try {
    await session.start({ cwd, prompt: 'work' }, { requestId: 'start' });
    await ready.promise;
    const stalled = session.input('wait', { requestId: 'input' });
    const reply = await session.respond('q', 'yes', { requestId: 'answer' });
    assert.equal(reply.status, 'answered');
    await assert.rejects(session.respond('q', 'different', { requestId: 'answer' }), { code: 'REQUEST_ID_CONFLICT' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(answer, 'yes');
    await session.stop({ requestId: 'stop' });
    assert.equal((await stalled).status, 'unknown');
    const completed = (await session.completion)!;
    assert.equal(completed.cleanup.status, 'complete');
    assert.equal(completed.operations?.find(operation => operation.requestId === 'input')?.status, 'unknown');
    const saved = JSON.parse(await readFile(completed.reportPath!, 'utf8'));
    assert.ok(['pending', 'unknown'].includes(saved.operations.find(operation => operation.requestId === 'input').status));
    assert.equal((await session.getState()).result?.snapshotTruncated, true);
    assert.equal((await session.getState()).questions[0].answer, 'yes');
  } finally { await rm(cwd, { recursive: true, force: true }); await rm(outputRoot, { recursive: true, force: true }); }
});

test('question identities isolate concurrent sources and cancellation rejects late answers', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'murm-session-project-'));
  const outputRoot = await mkdtemp(join(tmpdir(), 'murm-session-output-'));
  const ready = Promise.withResolvers<void>();
  const cancel = new AbortController();
  let first: Promise<unknown>;
  let second: Promise<unknown>;
  let authorized = true;
  const session = createHarnessSession({ apiVersion: 1, id: 'questions', questions: true, async run(context) {
    context.markRunning();
    first = context.askUser({ requestId: 'first', questionId: 'one', kind: 'choice', text: 'Pick', options: [{ id: 'left', label: 'Left' }, { id: 'right', label: 'Right' }] }, { id: 'source-one', signal: cancel.signal }).catch(error => error.code);
    second = context.askUser({ requestId: 'second', questionId: 'two', kind: 'confirm', text: 'Approve?' }, { id: 'source-two', signal: context.signal, assertAuthorized() { if (!authorized) throw new Error('revoked'); } }).catch(error => error.code);
    ready.resolve();
    await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
    return { outcome: 'cancelled', reason: 'stopped', artifacts: [], cleanup: { status: 'complete' } };
  } }, { outputRoot, clientCapabilities: { questions: true } });
  try {
    await session.start({ cwd, prompt: 'work' }, { requestId: 'start' }); await ready.promise;
    assert.equal((await session.getState()).questions.filter(question => question.status === 'pending').length, 2);
    cancel.abort();
    assert.equal(await first!, 'QUESTION_CANCELLED');
    await assert.rejects(session.respond('one', 'left', { requestId: 'late' }), { code: 'QUESTION_CLOSED' });
    authorized = false;
    assert.equal(await second!, 'QUESTION_CANCELLED');
    assert.equal((await session.getState()).questions.find(question => question.questionId === 'two')!.reason, 'source-unauthorized');
    await session.stop({ requestId: 'stop' }); await session.completion;
  } finally { await rm(cwd, { recursive: true, force: true }); await rm(outputRoot, { recursive: true, force: true }); }
});

test('a timed-out input reconciles its original late receipt without invoking the handler twice', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'murm-session-project-'));
  const outputRoot = await mkdtemp(join(tmpdir(), 'murm-session-output-'));
  const ready = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<string>();
  let received = 0;
  const session = createHarnessSession({ apiVersion: 1, id: 'input', input: true, async run(context) {
    context.registerInput(async () => { received++; return finish.promise; }); context.markRunning(); ready.resolve();
    await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
    return { outcome: 'cancelled', reason: 'stopped', artifacts: [], cleanup: { status: 'complete' } };
  } }, { outputRoot, limits: { handlerTimeoutMs: 10 } });
  try {
    await session.start({ cwd, prompt: 'work' }, { requestId: 'start' }); await ready.promise;
    assert.equal((await session.input('work', { requestId: 'work' })).status, 'unknown');
    finish.resolve('delivered'); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await session.input('work', { requestId: 'work' }), { status: 'accepted', requestId: 'work', result: 'delivered' });
    assert.equal(received, 1);
    await session.stop({ requestId: 'stop' }); await session.completion;
  } finally { await rm(cwd, { recursive: true, force: true }); await rm(outputRoot, { recursive: true, force: true }); }
});

test('initial snapshots precede reentrant state changes and live output replaces its accumulated delta', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'murm-session-project-'));
  const outputRoot = await mkdtemp(join(tmpdir(), 'murm-session-output-'));
  const ready = Promise.withResolvers<import('../src/harness/project-harness.js').ProjectHarnessContext>();
  const session = createHarnessSession({ apiVersion: 1, id: 'observe', async run(context) {
    context.markRunning(); ready.resolve(context);
    await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
    return { outcome: 'cancelled', reason: 'stopped', artifacts: [], cleanup: { status: 'complete' } };
  } }, { outputRoot });
  try {
    await session.start({ cwd, prompt: 'work' }, { requestId: 'start' }); const context = await ready.promise;
    const phases: string[] = [];
    const detachBroken = session.onEvent(async () => { throw new Error('A subscriber rejected'); }, { initialSnapshot: true });
    const detachSlow = session.onEvent(async () => { await new Promise(() => {}); });
    const unsubscribe = session.onEvent(event => {
      phases.push(event.type);
      if (event.type === 'snapshot') context.updateStatus({ business: { work: 'new' } });
    }, { initialSnapshot: true });
    assert.deepEqual(phases.slice(0, 2), ['snapshot', 'state']);
    context.emit({ kind: 'agent', event: { type: 'session', agentId: 'a', event: { type: 'textDelta', messageId: 'message', delta: 'hello' } } });
    assert.equal((await session.getState()).output[0]!.text, 'hello');
    context.emit({ kind: 'agent', event: { type: 'session', agentId: 'a', event: { type: 'messageEnd', messageId: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'hello world' }] } } } });
    const output = (await session.getState()).output;
    assert.equal(output.length, 1); assert.equal(output[0]!.complete, true); assert.equal('text' in output[0]!, false);
    unsubscribe(); assert.equal((await session.getState()).phase, 'running');
    await session.stop({ requestId: 'stop' }); await session.completion;
    detachSlow(); detachBroken();
  } finally { await rm(cwd, { recursive: true, force: true }); await rm(outputRoot, { recursive: true, force: true }); }
});

test('input reconciliation keeps its captured binding and publishes changed receipts without stale overwrite', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'murm-input-reconcile-'));
  const outputRoot = await mkdtemp(join(tmpdir(), 'murm-input-reconcile-output-'));
  const ready = Promise.withResolvers<void>();
  const original = Promise.withResolvers<any>();
  const captured = { executionId: 'original-execution', owner: 'original-agent', fence: 4 };
  let calls = 0;
  const receipts: any[] = [];
  const session = createHarnessSession({ id: 'input-receipts', apiVersion: 1, input: true, async run(context) {
    context.registerInput(async () => { calls++; return original.promise; }, undefined, () => ({ ...captured }),
      async (_input, request) => {
        assert.deepEqual(request.binding, { executionId: 'original-execution', owner: 'original-agent', fence: 4 });
        return { status: 'accepted', inputId: 'original-input' };
      });
    context.markRunning(); ready.resolve();
    await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
    return { outcome: 'cancelled', reason: 'stopped', artifacts: [], cleanup: { status: 'complete' } };
  } }, { outputRoot, limits: { handlerTimeoutMs: 10 } });
  session.onEvent(event => { if (event.type === 'operation' && event.operation === 'input') receipts.push(event.result); });
  try {
    await session.start({ cwd, prompt: 'work' }, { requestId: 'start' }); await ready.promise;
    assert.equal((await session.input('feedback', { requestId: 'feedback' })).status, 'unknown');
    captured.fence = 5;
    const accepted = await session.input('feedback', { requestId: 'feedback' });
    assert.equal(accepted.result.inputId, 'original-input');
    original.resolve({ status: 'unknown' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await session.input('feedback', { requestId: 'feedback' }), accepted);
    assert.equal(calls, 1);
    assert.deepEqual(receipts.map(receipt => receipt.status), ['unknown', 'accepted']);
    await session.stop({ requestId: 'stop' }); await session.completion;
  } finally {
    original.resolve({ status: 'unknown' });
    await rm(cwd, { recursive: true, force: true }); await rm(outputRoot, { recursive: true, force: true });
  }
});

test('question channel, deadline and capacity remain explicit through natural completion', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'murm-question-project-'));
  const outputRoot = await mkdtemp(join(tmpdir(), 'murm-question-output-'));
  const complete = Promise.withResolvers<void>();
  const waiting = Promise.withResolvers<ProjectHarnessContext>();
  const harness: ProjectHarness = { apiVersion: 1, id: 'question-deadline', questions: true, async run(context) {
    context.markRunning();
    waiting.resolve(context);
    await complete.promise;
    return { outcome: 'completed', reason: 'done', artifacts: [], cleanup: { status: 'complete' } };
  } };
  const blocked = createHarnessSession({ ...harness, async run(context) {
    await assert.rejects(context.askUser({ requestId: 'disabled', kind: 'text', text: 'Unavailable?' },
      { id: 'work', signal: context.signal }), { code: 'OPERATION_UNSUPPORTED' });
    return { outcome: 'completed', reason: 'checked', artifacts: [], cleanup: { status: 'complete' } };
  } }, { outputRoot });
  const session = createHarnessSession(harness, { outputRoot, clientCapabilities: { questions: true }, limits: { questions: 2 } });
  try {
    await blocked.start({ cwd, prompt: 'work' }, { requestId: 'disabled-start' });
    assert.equal((await blocked.completion)!.outcome, 'completed');
    await session.start({ cwd, prompt: 'work' }, { requestId: 'start' });
    const context = await waiting.promise;
    const source = { id: 'work', signal: context.signal };
    const expiry = assert.rejects(context.askUser({ requestId: 'short', questionId: 'short', kind: 'confirm', text: 'Expire?', timeoutMs: 20 }, source),
      { code: 'QUESTION_EXPIRED' });
    const pending = assert.rejects(context.askUser({ requestId: 'finish', questionId: 'finish', kind: 'text', text: 'Still running?' }, source),
      { code: 'QUESTION_CANCELLED' });
    await assert.rejects(context.askUser({ requestId: 'overflow', kind: 'text', text: 'Over capacity?' }, source), { code: 'QUESTION_LIMIT' });
    await expiry;
    await assert.rejects(session.respond('short', true, { requestId: 'late-expiry' }), { code: 'QUESTION_CLOSED' });
    complete.resolve();
    const result = await session.completion;
    await pending;
    assert.deepEqual(result?.questions?.map(question => question.status), ['expired', 'cancelled']);
    await assert.rejects(session.respond('finish', 'late', { requestId: 'late-completion' }), { code: 'QUESTION_CLOSED' });
  } finally {
    complete.resolve();
    await session.completion;
    await rm(cwd, { recursive: true, force: true });
    await rm(outputRoot, { recursive: true, force: true });
  }
});
