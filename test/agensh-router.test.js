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
  const { createAgenshRouterEnvironment } = await import('../src/environments/agensh/routed.js');
  const { createPiOpenSandboxBackend } = await import('../src/core/backends/pi-opensandbox.js');
  environment = await createAgenshRouterEnvironment({ runId: 'router', image: 'fixture', outputDir, exportLimit: 1024 ** 2,
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
