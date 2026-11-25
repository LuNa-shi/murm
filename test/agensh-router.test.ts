import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLifecycleProvider } from './fixtures/core-lifecycle-provider.js';

async function fixture(t, onPrompt = () => {}, routerOptions = {}) {
  let environment; t.after(() => environment?.close({ timeoutMs: 200 }));
  let submitted = 0; let deliver; let ready = false; let contextReads = 0;
  const provider = await createLifecycleProvider(t, { onCollect: () => ({ error: { code: 'SERVICE_UNAVAILABLE', message: 'fixture pending export' } }),
    async onRpc(message) {
      if (message.type !== 'prompt') return undefined;
      assert.equal(ready, true); assert.ok(message.message.includes('SHARED_CONTEXT'));
      const ordinal = ++submitted; const outcome = await onPrompt({ message, ordinal });
      if (outcome?.response) return outcome;
      return { response: { id: message.id, success: true, command: 'prompt', data: { disposition: 'started' } }, records: [
        { worker_sequence: (ordinal - 1) * 3 + 1, type: 'agent_start' },
        { worker_sequence: (ordinal - 1) * 3 + 2, type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: outcome ?? `completed-${ordinal}` }], stopReason: 'stop' } },
        { worker_sequence: (ordinal - 1) * 3 + 3, type: 'agent_settled' },
      ] };
    } }); provider.allowDeletion();
  const outputDir = await mkdtemp(join(tmpdir(), 'agensh-router-')); t.after(() => rm(outputDir, { recursive: true, force: true }));
  const { createPeerMeshRouterHarness } = await import('../src/harnesses/peermesh/routed.js');
  const { createPiOpenSandboxBackend } = await import('../src/core/backends/pi-opensandbox.js');
  environment = await createPeerMeshRouterHarness({ runId: 'router', image: 'fixture', outputDir, exportLimit: 1024 ** 2,
    backend: createPiOpenSandboxBackend({ sandbox: { lifecycleBaseUrl: provider.url }, bridge: { host: '127.0.0.1', publicUrl: 'http://172.17.0.1:{port}' }, modelGateway: { host: '127.0.0.1', advertiseHost: '172.17.0.1' },
      models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } }, isolation: { network: 'local-docker', disk: { bytes: 16 * 1024 ** 2, inodes: 2048 } } }),
    prepare: async () => ({ runId: 'router', repository: { owner: 'owner', name: 'repo' }, repositoryUrl: 'http://172.17.0.1:3000/owner/repo.git', channelId: 'channel', boardId: 'board', issueNumber: 1,
      endpoints: { gitea: 'http://172.17.0.1:3000', message: 'http://127.0.0.1:1', board: 'http://127.0.0.1:1' },
      peer: { gitea: { binding: 'git', accountId: '101', username: 'peer', token: 'secret-git' }, message: { binding: 'mm', accountId: 'mm-peer', token: 'secret-mm' }, board: { binding: 'board', workerId: 'worker-router' } } }),
    router: { workTimeoutMs: 5000, turnTimeoutMs: 1000, readContext: async () => { contextReads++; return 'SHARED_CONTEXT'; },
      subscribe: async ({ ingest, mapping }) => { assert.equal(mapping.workerId, 'worker-router'); deliver = ingest; ready = true; return { ready: true, stop: async () => {} }; }, ...routerOptions },
  });
  return { environment, ingest: event => deliver(event), submitted: () => submitted, contexts: () => contextReads, provider };
}

test('one actual Core router serializes kickoff, external event and targeted user input, reuses completed ingest records', async t => {
  const f = await fixture(t); assert.equal(f.environment.runInput, undefined, 'routed host façade has no second input path');
  const first = f.environment.kickoff('fixed kickoff');
  const event = { source: 'gitea', eventId: 'comment-1', targetWorker: 'worker-router', kind: 'external', text: 'a real PR comment' };
  const external = f.ingest(event);
  const user = f.environment.ingest({ source: 'user', eventId: 'user-1', targetWorker: 'worker-router', kind: 'user', text: 'targeted input' });
  for (const row of [first, external, user]) { const actual = await f.environment.wait(row.batchId, { timeoutMs: 2000 }); assert.equal(actual.state, 'completed', JSON.stringify(actual)); }
  assert.equal(f.submitted(), 3); assert.equal(f.contexts(), 3);
  const duplicate = f.ingest(event); assert.equal(duplicate.batchId, external.batchId); assert.equal(duplicate.state, 'completed'); assert.equal(f.submitted(), 3);
  assert.throws(() => f.ingest({ ...event, text: 'changed original event' }), { code: 'BATCH_CONFLICT' });
  const unknown = f.ingest({ ...event, eventId: 'comment-2', targetWorker: 'other-worker' }); assert.equal(unknown.state, 'undelivered');
  const snapshot = f.environment.snapshot(); assert.equal(snapshot.router.mapping.botId, f.environment.peer.id);
  assert.deepEqual(snapshot.router.batches.filter(row => row.state === 'completed').map(row => row.source), ['kickoff', 'gitea', 'user']);
  assert.ok(snapshot.router.batches.filter(row => row.state === 'completed').every(row => row.inputId && row.settled.outcome === 'completed'));
  const close = await f.environment.close({ timeoutMs: 100 }); assert.equal(close.cleanup, 'pending', 'required export preserves facilities independently');
  assert.equal(f.environment.ingest({ ...event, eventId: 'after' }).state, 'undelivered');
});

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { const end = Date.now() + 2000; while (!check()) { assert.ok(Date.now() < end); await tick(); } }
const incoming = id => ({ source: 'mattermost', eventId: id, targetWorker: 'worker-router', kind: 'mention', text: 'targeted work' });

test('accepted admission alone does not dispatch next batch; cancellation after submission keeps identity and fences the channel', async t => {
  const f = await fixture(t, ({ message }) => ({ response: { id: message.id, command: 'prompt', success: true, data: { disposition: 'started' } }, records: [] }));
  const first = f.environment.kickoff('waiting'); const next = f.environment.ingest(incoming('next'));
  await until(() => f.submitted() === 1);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(f.submitted(), 1);
  const abort = new AbortController(); const waiting = f.environment.wait(first.batchId, { timeoutMs: 500, signal: abort.signal }); abort.abort();
  await assert.rejects(waiting, { code: 'ROUTER_WAIT_ABORTED' });
  await tick(); assert.equal(f.environment.snapshot().router.fenced, true);
  await until(() => f.environment.snapshot().router.batches[0].state === 'uncertain');
  const before = f.environment.snapshot().router;
  assert.equal(before.fenced, true); assert.equal(before.batches[1].state, 'cancelled'); assert.equal(f.submitted(), 1);
  assert.equal(f.environment.ingest(incoming('next')).batchId, next.batchId);
  assert.equal(before.batches[0].requestId, first.requestId); assert.ok(before.batches[0].inputId);
});

test('cancelling an unsent batch abandons its context read and releases the next Core input', async t => {
  const reading = Promise.withResolvers();
  const abandoned = Promise.withResolvers();
  let reads = 0;
  const f = await fixture(t, () => {}, { readContext({ signal }) {
    if (++reads === 1) { reading.resolve(signal); return abandoned.promise; }
    return 'SHARED_CONTEXT';
  } });
  const first = f.environment.kickoff('undispatched');
  const next = f.environment.ingest(incoming('kept'));
  const readSignal = await reading.promise;
  const abort = new AbortController();
  const waiting = f.environment.wait(first.batchId, { timeoutMs: 1000, signal: abort.signal });
  const observer = f.environment.wait(first.batchId, { timeoutMs: 1000 });
  void observer.catch(() => {});
  try {
    abort.abort();
    await assert.rejects(waiting, { code: 'ROUTER_WAIT_ABORTED' });
    assert.equal(readSignal.aborted, true);
    const cancelled = await observer;
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.code, 'ROUTER_WAIT_ABORTED');
    assert.equal(cancelled.requestId, first.requestId);
    assert.equal(cancelled.inputId, undefined);
    assert.equal((await f.environment.wait(next.batchId, { timeoutMs: 1500 })).state, 'completed');
  } finally { abandoned.reject(new Error('old reader finished late')); }
  const snapshot = f.environment.snapshot().router;
  assert.equal(snapshot.fenced, false);
  assert.equal(snapshot.batches[0].code, 'ROUTER_WAIT_ABORTED');
  assert.equal(f.submitted(), 1);
});

test('cancelling queued work notifies another observer even while the active batch is held', async t => {
  const context = Promise.withResolvers();
  const f = await fixture(t, () => {}, { readContext: () => context.promise });
  const first = f.environment.kickoff('still running');
  const queued = f.environment.ingest(incoming('queued-cancel'));
  const abort = new AbortController();
  const waiting = f.environment.wait(queued.batchId, { timeoutMs: 1000, signal: abort.signal });
  const observer = f.environment.wait(queued.batchId, { timeoutMs: 300 });
  void observer.catch(() => {});
  try {
    abort.abort();
    await assert.rejects(waiting, { code: 'ROUTER_WAIT_ABORTED' });
    const cancelled = await observer;
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.code, 'ROUTER_WAIT_ABORTED');
    assert.equal(f.submitted(), 0);
  } finally { context.resolve('SHARED_CONTEXT'); }
  assert.equal((await f.environment.wait(first.batchId, { timeoutMs: 1500 })).state, 'completed');
  assert.equal(f.submitted(), 1);
});

test('host close cancels a context read before shutting down the event source', async t => {
  const reading = Promise.withResolvers();
  const sourceStopped = Promise.withResolvers();
  let readSignal;
  const f = await fixture(t, () => {}, {
    readContext({ signal }) {
      readSignal = signal;
      reading.resolve();
      return new Promise(() => {});
    },
    subscribe: async () => ({ ready: true, async stop() { sourceStopped.resolve(readSignal.aborted); } }),
  });
  const first = f.environment.kickoff('held context');
  await reading.promise;
  const closing = f.environment.close({ timeoutMs: 150 });
  assert.equal(await sourceStopped.promise, true);
  const cancelled = await f.environment.wait(first.batchId, { timeoutMs: 500 });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.code, 'ROUTER_STOPPING');
  await closing;
  assert.equal(f.environment.snapshot().router.fenced, false);
  assert.equal(f.submitted(), 0);
});

for (const disposition of ['unknown', 'queued', 'handled']) test(`${disposition} admission does not complete a batch or dispatch later work`, async t => {
  const f = await fixture(t, ({ message }) => ({ response: { id: message.id, command: 'prompt', success: true, ...(disposition === 'unknown' ? {} : { data: { disposition } }) }, records: [] }));
  const first = f.environment.kickoff('fixed'); f.environment.ingest(incoming('blocked'));
  const result = await f.environment.wait(first.batchId, { timeoutMs: 1500 });
  assert.notEqual(result.state, 'completed'); assert.equal(f.submitted(), 1); assert.equal(f.environment.snapshot().router.fenced, true);
  assert.ok(result.inputId); assert.equal(result.requestId, first.requestId);
});

test('fatal without settled ends the actual Core wait; close cancels queued work and retains submitted events', async t => {
  const f = await fixture(t, ({ message }) => ({ response: { id: message.id, command: 'prompt', success: true, data: { disposition: 'started' } }, records: [
    { worker_sequence: 1, type: 'worker_error', message: 'fixed fatal' },
  ] }));
  const first = f.environment.kickoff('fixed'); f.environment.ingest(incoming('blocked'));
  const result = await f.environment.wait(first.batchId, { timeoutMs: 1500 });
  assert.equal(result.code, 'bot_failed'); assert.equal(f.submitted(), 1);
  await f.environment.close({ timeoutMs: 100 });
  assert.ok(f.environment.snapshot().router.events.some(row => row.type === 'error'));
});

test('idle nudges use the same router for exactly the configured rounds then leave the queue idle', async t => {
  const f = await fixture(t, () => {}, { idleNudgeMs: 10, maxNudges: 2 });
  const first = f.environment.kickoff('kickoff'); await f.environment.wait(first.batchId, { timeoutMs: 1000 });
  await until(() => f.submitted() === 3);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(f.submitted(), 3); const state = f.environment.snapshot().router;
  assert.equal(state.nudges, 2); assert.deepEqual(state.batches.map(row => row.source), ['kickoff', 'nudge', 'nudge']);
  assert.ok(state.batches.every(row => row.state === 'completed'));
});

test('late settled after admission unlocks exactly the next queued batch', async t => {
  const f = await fixture(t, ({ message, ordinal }) => {
    if (ordinal !== 1) return undefined;
    setTimeout(() => {
      f.provider.publish({ type: 'agent_start' });
      f.provider.publish({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'late completion' }], stopReason: 'stop' } });
      f.provider.publish({ type: 'agent_settled' });
    }, 30);
    return { response: { id: message.id, command: 'prompt', success: true, data: { disposition: 'started' } }, records: [] };
  });
  const first = f.environment.kickoff('fixed'); const second = f.environment.ingest(incoming('after-late'));
  const completed = await f.environment.wait(first.batchId, { timeoutMs: 1000 }); assert.equal(completed.settled.output, 'late completion');
  assert.equal((await f.environment.wait(second.batchId, { timeoutMs: 1000 })).state, 'completed'); assert.equal(f.submitted(), 2);
});

test('host close bounds a stuck event-source stop and preserves source cleanup separately', async t => {
  const f = await fixture(t, () => {}, { subscribe: async () => ({ ready: true, stop: () => new Promise(() => {}) }) });
  const before = Date.now(); const receipt = await f.environment.close({ timeoutMs: 40 });
  assert.ok(Date.now() - before < 180); assert.equal(receipt.cleanup, 'pending'); assert.equal(receipt.sourceFailure.code, 'ROUTER_SOURCE_CLOSE_FAILED');
});

test('readiness timeout before kickoff closes admission without a first Pi input', { timeout: 1000 }, async t => {
  const before = Date.now();
  await assert.rejects(fixture(t, () => assert.fail('No input before readiness'), { readinessTimeoutMs: 15, subscribe: async () => new Promise(() => {}) }), { code: 'ROUTER_SUBSCRIPTION_TIMEOUT', cleanup: 'pending' });
  assert.ok(Date.now() - before < 400);
});

test('actual Core input timeout preserves admission and cancels later batches without resubmission', async t => {
  const f = await fixture(t, ({ message }) => ({ response: { id: message.id, command: 'prompt', success: true, data: { disposition: 'started' } }, records: [] }), { turnTimeoutMs: 20 });
  const first = f.environment.kickoff('fixed'); f.environment.ingest(incoming('after-timeout'));
  const result = await f.environment.wait(first.batchId, { timeoutMs: 1000 });
  assert.equal(result.state, 'uncertain'); assert.equal(result.code, 'input_timeout'); assert.ok(result.inputId);
  assert.equal(result.receipt.status, 'accepted'); assert.equal(result.requestId, first.requestId);
  assert.equal(f.submitted(), 1); assert.equal(f.environment.snapshot().router.batches[1].state, 'cancelled');
});

test('a busy project router steers DM and Board events once while keeping ordinary follow-up serial', async t => {
  const { createPeerMeshRouter } = await import('../src/harnesses/peermesh/router.js');
  const kickoff = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const calls = [];
  const runInput = (text, { onStarted }) => {
    const input = JSON.parse(text.slice(text.indexOf('\n') + 1));
    calls.push({ mode: 'followUp', input });
    if (input.kind === 'kickoff') {
      onStarted?.();
      entered.resolve();
      return kickoff.promise;
    }
    return Promise.resolve({ inputId: 'follow-up', receipt: { status: 'accepted', disposition: 'started' }, settled: { seq: 2 } });
  };
  const router = createPeerMeshRouter({ mapping: { botId: 'bot-a', workerId: 'worker-a' }, runInput, readContext: async () => 'shared',
    async steerInput(text) {
      const input = JSON.parse(text.slice(text.indexOf('\n') + 1));
      calls.push({ mode: 'steer', input });
      return { inputId: input.eventId, status: 'accepted', disposition: 'queued' };
    },
  });
  t.after(() => { kickoff.resolve({ inputId: 'initial', settled: { seq: 1 } }); return router.finishClose({}); });
  router.markReady();
  const first = router.kickoff('start work');
  await entered.promise;
  const make = (source, kind, eventId) => ({ source, kind, eventId, targetWorker: 'worker-a', text: `trusted ${eventId}` });
  const dmEvent = make('mattermost', 'dm', 'dm-b');
  const dm = router.ingest(dmEvent);
  const publicEvent = router.ingest(make('mattermost', 'peer-message', 'team-b'));
  const board = router.ingest(make('board', 'board-entry', 'G1'));
  assert.equal(router.ingest(dmEvent).batchId, dm.batchId);
  assert.equal((await router.wait(dm.batchId)).receipt.disposition, 'queued');
  assert.equal((await router.wait(board.batchId)).receipt.disposition, 'queued');
  assert.deepEqual(calls.map(call => [call.mode, call.input.kind]), [['followUp', 'kickoff'], ['steer', 'dm'], ['steer', 'board-entry']]);
  router.observe({ botId: 'bot-a', seq: 1, type: 'settled', outcome: 'completed' });
  kickoff.resolve({ inputId: 'initial', receipt: { status: 'accepted', disposition: 'started' }, settled: { seq: 1 } });
  assert.equal((await router.wait(first.batchId)).state, 'completed');
  assert.equal((await router.wait(publicEvent.batchId)).state, 'completed');
  assert.deepEqual(calls.map(call => call.input.eventId), ['kickoff', 'dm-b', 'G1', 'team-b']);
});

test('settlement racing with a started steer waits for that execution before the next work batch', async t => {
  const { createPeerMeshRouter } = await import('../src/harnesses/peermesh/router.js');
  const kickoff = Promise.withResolvers(), entered = Promise.withResolvers(), steerEntered = Promise.withResolvers();
  const steer = Promise.withResolvers();
  const calls = [];
  const router = createPeerMeshRouter({ mapping: { botId: 'bot-a', workerId: 'worker-a' }, readContext: async () => '',
    runInput(_text, { onStarted }) {
      calls.push('ordinary');
      onStarted();
      if (calls.length === 1) {
        entered.resolve();
        return kickoff.promise;
      }
      return Promise.resolve({ inputId: 'next', settled: { seq: 3 } });
    },
    steerInput() { steerEntered.resolve(); return steer.promise; },
  });
  t.after(() => { kickoff.resolve({ inputId: 'initial', settled: { seq: 1 } }); steer.resolve({ status: 'unknown', inputId: 'notice' }); return router.finishClose({}); });
  router.markReady();
  router.kickoff('go');
  await entered.promise;
  const event = { source: 'mattermost', kind: 'dm', eventId: 'dm', targetWorker: 'worker-a', text: 'test' };
  const dm = router.ingest(event);
  const next = router.ingest({ ...event, source: 'user', kind: 'user', eventId: 'followup' });
  await steerEntered.promise;
  router.observe({ botId: 'bot-a', type: 'settled', outcome: 'completed', seq: 1 });
  kickoff.resolve({ inputId: 'initial', settled: { seq: 1 } });
  steer.resolve({ inputId: 'notice', status: 'accepted', disposition: 'started' });
  assert.equal((await router.wait(dm.batchId)).receipt.disposition, 'started');
  assert.equal(calls.length, 1);
  router.observe({ botId: 'bot-a', type: 'settled', outcome: 'completed', seq: 2 });
  assert.equal((await router.wait(next.batchId)).state, 'completed');
  assert.equal(calls.length, 2);
});

test('a steer with unknown receipt reuses its request identity and never becomes a second prompt', async t => {
  const { createPeerMeshRouter } = await import('../src/harnesses/peermesh/router.js');
  const kickoff = Promise.withResolvers(), entered = Promise.withResolvers();
  const attempts = [];
  let runs = 0;
  const router = createPeerMeshRouter({ mapping: { botId: 'bot-a', workerId: 'worker-a' }, readContext: async () => '',
    runInput(_text, { onStarted }) { runs++; onStarted(); entered.resolve(); return kickoff.promise; },
    async steerInput(text, requestId) { attempts.push({ text, requestId }); return { inputId: 'unknown-input', status: 'unknown' }; },
  });
  t.after(() => { kickoff.resolve({ inputId: 'initial', settled: { seq: 1 } }); return router.finishClose({}); });
  router.markReady();
  const first = router.kickoff('go');
  await entered.promise;
  const event = { source: 'mattermost', kind: 'dm', eventId: 'dm', targetWorker: 'worker-a', text: 'test' };
  const dm = router.ingest(event);
  assert.equal((await router.wait(dm.batchId)).state, 'uncertain');
  assert.equal(router.snapshot().fenced, true);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(router.ingest(event).inputId, 'unknown-input');
  kickoff.resolve({ inputId: 'initial', settled: { seq: 1 } });
  await router.wait(first.batchId);
  assert.equal(runs, 1);
});
