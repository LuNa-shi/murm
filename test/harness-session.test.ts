import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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

test('an exceptional Run fences new work before cancelling questions and saving its terminal record', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'murm-session-project-'));
  const outputRoot = await mkdtemp(join(tmpdir(), 'murm-session-output-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(outputRoot, { recursive: true, force: true });
  });
  const afterCancellation = Promise.withResolvers<readonly [boolean, unknown, unknown]>();
  const observedQuestions: string[] = [];
  const credential = 'configured-terminal-test-token';
  let finalEvent: unknown;
  const session = createHarnessSession({ apiVersion: 1, id: 'exception', input: true, questions: true, async run(context) {
    context.registerInput(() => null);
    context.markRunning();
    const source = { id: 'work', signal: context.signal };
    void context.askUser({ requestId: 'first', questionId: 'first', kind: 'confirm', text: 'Continue?' }, source).catch(async () => {
      const saved = existsSync(join(context.outputDir, 'project-run.json'));
      const errorCode = (error: { code?: string }) => error.code;
      const question = context.askUser({ requestId: 'second', questionId: 'second', kind: 'confirm', text: 'Continue now?' }, source).catch(errorCode);
      const input = session.input('more work', { requestId: 'late-input' }).catch(errorCode);
      afterCancellation.resolve([saved, await question, await input]);
    });
    throw Object.assign(new Error(`Business failed with ${credential}`), { code: 'PROJECT_GIT_FAILED' });
  } }, { outputRoot, clientCapabilities: { questions: true }, configuration: { sandbox: { apiKey: credential } } });
  session.onEvent(event => {
    if (event.type === 'question') observedQuestions.push(event.question.status);
    if (event.type === 'result') finalEvent = event.result;
  });

  await session.start({ cwd, prompt: 'work' }, { requestId: 'start' });
  const completed = (await session.completion)!;
  const persisted = JSON.parse(await readFile(completed.reportPath!, 'utf8'));

  assert.deepEqual(await afterCancellation.promise, [false, 'RUN_STOPPING', 'RUN_STOPPING']);
  assert.equal(completed.outcome, 'failed');
  assert.equal(completed.failure?.code, 'PROJECT_GIT_FAILED');
  assert.ok(completed.failure.message.includes('Business failed'));
  assert.ok(!completed.failure.message.includes(credential));
  assert.deepEqual(persisted.failure, completed.failure);
  assert.deepEqual((await session.getState()).result?.failure, completed.failure);
  assert.deepEqual(observedQuestions, ['pending', 'cancelled']);
  assert.deepEqual(persisted.questions, completed.questions);
  assert.deepEqual(persisted.operations, completed.operations);
  assert.deepEqual(persisted.operations.map((operation: { requestId: string }) => operation.requestId), ['start']);
  assert.deepEqual(completed.questions?.map(({ status, reason }) => [status, reason]), [['cancelled', 'run-finished']]);
  assert.deepEqual((await session.getState()).questions, completed.questions);
  assert.deepEqual(finalEvent, completed);
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

test('pending choice, text and confirm questions keep their budgets across a large live and final view', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'murm-question-budget-'));
  const outputRoot = await mkdtemp(join(tmpdir(), 'murm-question-budget-output-'));
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(outputRoot, { recursive: true, force: true });
  });
  const offered = Promise.withResolvers<void>();
  const displayReady = Promise.withResolvers<void>();
  const choiceId = '选'.repeat(6_000);
  const maxText = '答'.repeat(5_460) + 'ab';
  const listed = Array.from({ length: 25 }, (_, index) => ({ id: 'agent-' + index, status: 'idle' }));
  const runtime = { list: async () => listed, onEvent: () => () => {} } as unknown as import('@luna-shi/murm').Runtime;
  const session = createHarnessSession({ apiVersion: 1, id: 'budget', questions: true, async run(context) {
    context.registerAgentControls({
      runtime, capabilities: { configure: { supported: true, fields: ['setting-' + 's'.repeat(4_650)] } },
    });
    context.markRunning();
    const source = { id: 'work', signal: context.signal };
    const choice = context.askUser({ requestId: 'choice', kind: 'choice', questionId: 'choice', text: 'Choose',
      options: [{ id: choiceId, label: 'First' }, { id: 'other', label: 'Other' }] }, source);
    const confirm = context.askUser({ requestId: 'confirm', kind: 'confirm', questionId: 'confirm', text: 'Confirm?' }, source);
    const text = context.askUser({ requestId: 'text', kind: 'text', questionId: 'text', text: 'Explain?' }, source);
    for (const answer of [choice, confirm, text]) void answer.catch(() => {});
    await assert.rejects(context.askUser({ requestId: 'too-large', kind: 'text', text: '界'.repeat(6_000), timeoutMs: 100 }, source), { code: 'QUESTION_LIMIT' });
    await displayReady.promise;
    context.updateStatus({ business: '界'.repeat(9_700) });
    for (let index = 0; index < 3; index++) {
      context.emit({ type: 'session', agentId: listed[index].id, event: { type: 'textDelta', messageId: 'output-' + index, delta: 'o'.repeat(14_000) } });
    }
    offered.resolve();
    const answers = await Promise.all([choice, confirm, text]);
    return { outcome: 'completed', reason: 'done', artifacts: [], cleanup: { status: 'complete' },
      result: { answers, business: '界'.repeat(50_000) } };
  } }, { outputRoot, clientCapabilities: { questions: true }, limits: { questionBytes: 55_000 } });
  await session.start({ cwd, prompt: 'work' }, { requestId: 'start' });
  const live = Promise.withResolvers<void>();
  const off = session.onEvent(event => { if (event.type === 'state' && event.state.phase === 'running') live.resolve(); });
  if ((await session.getState()).phase === 'running') live.resolve();
  await live.promise;
  off();
  await session.describe();
  displayReady.resolve();
  await Promise.race([offered.promise, session.completion!.then(result => { throw new Error(result.reason); })]);
  const state = await session.getState();
  assert.deepEqual(state.questions.map(question => question.questionId), ['choice', 'confirm', 'text']);
  assert.equal(state.questions[0].options?.[0].id, choiceId);
  assert.equal(state.questions[2].maxAnswerBytes, 16 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) >= 198 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 256 * 1024);
  const initial = Promise.withResolvers<unknown>();
  const remove = session.onEvent(event => { if (event.type === 'snapshot') initial.resolve(event.state.questions); }, { initialSnapshot: true });
  assert.deepEqual(await initial.promise, state.questions);
  remove();
  await session.respond('choice', choiceId, { requestId: 'answer-choice' });
  await session.respond('confirm', false, { requestId: 'answer-confirm' });
  await assert.rejects(session.respond('text', maxText + 'x', { requestId: 'over-limit' }), { code: 'INVALID_ANSWER' });
  await session.respond('text', maxText, { requestId: 'answer-text' });
  const result = await session.completion;
  assert.deepEqual(result?.result.answers, [choiceId, false, maxText]);
  assert.ok(Buffer.byteLength(JSON.stringify(await session.getState())) <= 256 * 1024);
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

test('a slow SDK observer is invalidated without stalling other observers, stop, or completion', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'murm-observation-project-'));
  const outputRoot = await mkdtemp(join(tmpdir(), 'murm-observation-output-'));
  const ready = Promise.withResolvers<ProjectHarnessContext>();
  const barrier = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<Error>();
  t.after(async () => {
    barrier.resolve();
    await rm(cwd, { recursive: true, force: true });
    await rm(outputRoot, { recursive: true, force: true });
  });
  const session = createHarnessSession({ apiVersion: 1, id: 'observation', async run(context) {
    context.markRunning();
    ready.resolve(context);
    await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
    return { outcome: 'cancelled', reason: 'stopped', artifacts: [], cleanup: { status: 'complete' } };
  } }, { outputRoot });
  await session.start({ cwd, prompt: 'work' }, { requestId: 'start' });
  const context = await ready.promise;
  let invoked = 0;
  const detach = session.onEvent(async () => { invoked++; await barrier.promise; }, {
    initialSnapshot: true, ...{ onError: failed.resolve },
  });
  let next = 0;
  const observedResult = Promise.withResolvers<void>();
  const fast = session.onEvent(event => {
    if (event.type === 'event' && typeof event.event === 'number' && event.event === next) next++;
    if (event.type === 'result') observedResult.resolve();
  });
  try {
    for (let index = 0; index < 10_000; index++) context.emit(index);
    assert.equal(invoked, 1);
    assert.equal(next, 10_000);
    assert.equal((await failed.promise as Error & { code: string }).code, 'OBSERVATION_OVERFLOW');
    detach();
    barrier.resolve();
    assert.equal((await session.stop({ requestId: 'stop' })).status, 'accepted');
    assert.equal((await session.completion)?.cleanup.status, 'complete');
    await observedResult.promise;
    assert.equal(invoked, 1);
  } finally {
    detach(); fast();
    await session.stop({ requestId: 'stop' });
    await session.completion;
  }
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
    accepted.result.inputId = 'caller-injection';
    original.resolve({ status: 'unknown' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await session.input('feedback', { requestId: 'feedback' })).result.inputId, 'original-input');
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

test('a trusted source cancelled during target refresh is never published as pending', { timeout: 3_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'murm-question-target-'));
  const outputRoot = await mkdtemp(join(tmpdir(), 'murm-question-target-report-'));
  t.after(() => Promise.all([cwd, outputRoot].map(path => rm(path, { recursive: true, force: true }))));
  const ready = Promise.withResolvers<ProjectHarnessContext>();
  const finish = Promise.withResolvers<void>();
  const lookupStarted = Promise.withResolvers<void>();
  const targetLookup = Promise.withResolvers<readonly string[]>();
  const source = new AbortController();
  let waitForLookup = false;
  let authorized = true;
  const allowedModes = ['followUp'];
  let dispatched = 0;
  const agent = { id: 'agent', status: 'idle' };
  const runtime = { list: async () => [agent], onEvent: () => () => {} } as unknown as import('@luna-shi/murm').Runtime;
  const session = createHarnessSession({ id: 'source-cancellation', apiVersion: 1, questions: true, async run(context) {
    context.registerAgentControls({
      runtime,
      targets() {
        if (!waitForLookup) return ['agent'];
        lookupStarted.resolve();
        return targetLookup.promise;
      },
      capabilities: { send: { supported: true, text: true, modes: allowedModes } },
      handlers: { send() { dispatched++; return { status: 'accepted' }; } },
    });
    context.markRunning();
    ready.resolve(context);
    await finish.promise;
    return { outcome: 'completed', reason: 'done', artifacts: [], cleanup: { status: 'complete' } };
  } }, { outputRoot, clientCapabilities: { questions: true } });
  const questions: string[] = [];
  session.onEvent(event => { if (event.type === 'question') questions.push(event.question.status); });
  try {
    await session.start({ cwd, prompt: 'Check scope' }, { requestId: 'start' });
    const context = await ready.promise;
    await session.describe();

    const state = await session.getState();
    (state.capabilities.agents.agent.send!.modes as string[]).push('steer');
    assert.deepEqual((await session.getState()).capabilities.agents.agent.send!.modes, ['followUp']);
    await assert.rejects(session.agents.send('agent', 'outside Harness policy', { requestId: 'denied', mode: 'steer' }),
      { code: 'OPERATION_UNSUPPORTED' });
    assert.equal(dispatched, 0);

    waitForLookup = true;
    const result = assert.rejects(context.askUser({ requestId: 'cancel-during-lookup', questionId: 'q',
      agentId: 'agent', kind: 'confirm', text: 'Can this continue?' }, {
      id: 'caller', agentId: 'agent', signal: source.signal,
      assertAuthorized() { if (!authorized) throw new Error('revoked'); },
    }), { code: 'QUESTION_CANCELLED' });
    await lookupStarted.promise;
    source.abort();
    authorized = false;
    targetLookup.resolve(['agent']);
    await result;
    assert.deepEqual(questions, []);
    assert.deepEqual((await session.getState()).questions, []);
  } finally {
    targetLookup.resolve([]);
    finish.resolve();
    await session.completion;
  }
});

test('Session saves an unconfirmed close and never runs late reconciliation', { timeout: 3_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'murm-close-late-'));
  const outputRoot = await mkdtemp(join(tmpdir(), 'murm-close-late-report-'));
  t.after(() => Promise.all([cwd, outputRoot].map(path => rm(path, { recursive: true, force: true }))));
  const receipt = { cleanup: 'pending', agents: [],
    pending: [{ kind: 'agent', id: 'producer', action: 'collect-artifacts', sandboxId: 'original-sandbox' }] };
  const late = Promise.withResolvers<typeof receipt>();
  const trace: string[] = [];
  const session = createHarnessSession({ id: 'late-cleanup', apiVersion: 1, run: context => context.runWithRuntime({
    createRuntime() { return { id: 'original-runtime', close() { trace.push('close'); return late.promise; } }; },
    run() { trace.push('business'); return { accepted: true }; },
    closeTimeoutMs: 10,
    afterClose() { trace.push('release'); },
  }) }, { outputRoot });
  await session.start({ cwd, prompt: 'Preserve cleanup evidence' }, { requestId: 'start' });
  const completed = (await session.completion)!;
  assert.equal(completed.outcome, 'completed');
  assert.equal(completed.cleanup.status, 'pending');
  assert.equal(completed.result.cleanupFailure.code, 'CLOSE_WAIT_TIMEOUT');
  assert.equal(completed.result.runtimeId, 'original-runtime');
  const original = await readFile(completed.reportPath!, 'utf8');
  late.resolve(receipt);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(trace, ['business', 'close']);
  assert.equal(await readFile(completed.reportPath!, 'utf8'), original);
});

test('Session runs verification after an owned close and records a required export failure separately', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'murm-export-owner-'));
  const outputRoot = await mkdtemp(join(tmpdir(), 'murm-export-owner-report-'));
  t.after(() => Promise.all([cwd, outputRoot].map(path => rm(path, { recursive: true, force: true }))));
  const pending = [{ kind: 'agent', id: 'producer', action: 'collect-artifacts', sandboxId: 'original-sandbox' }];
  const receipt = { agents: [], cleanup: 'pending', pending };
  const trace: string[] = [];
  const session = createHarnessSession({ id: 'export-owner', apiVersion: 1, async run(context) {
    const result = await context.runWithRuntime({
      createRuntime() { return { id: 'export-owner-runtime', async close() { trace.push('close'); return receipt; } }; },
      run() { trace.push('business'); throw Object.assign(new Error('Handoff failed'), { code: 'HANDOFF_FAILED' }); },
      afterClose(closed) {
        trace.push('verify');
        assert.deepEqual(closed, receipt);
        if (closed.cleanup === 'complete') trace.push('release');
      },
    });
    return { ...result, acceptance: { status: 'unverified' } };
  } }, { outputRoot });
  await session.start({ cwd, prompt: 'Verify original ownership receipt' }, { requestId: 'start' });
  const completed = (await session.completion)!;
  assert.deepEqual(trace, ['business', 'close', 'verify']);
  assert.equal(completed.reason, 'HANDOFF_FAILED');
  assert.equal(completed.export?.status, 'pending');
  assert.deepEqual(completed.cleanup, { status: 'pending', receipt, pending });
  assert.deepEqual(completed.acceptance, { status: 'unverified' });
});
