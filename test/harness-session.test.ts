import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHarnessSession, type ProjectHarness } from '../src/harness/project-harness.js';

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
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(answer, 'yes');
    await session.stop({ requestId: 'stop' });
    assert.equal((await stalled).status, 'unknown');
    assert.equal((await session.completion)!.cleanup.status, 'complete');
    assert.equal((await session.getState()).questions[0].answer, 'yes');
  } finally { await rm(cwd, { recursive: true, force: true }); await rm(outputRoot, { recursive: true, force: true }); }
});
