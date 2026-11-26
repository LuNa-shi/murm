import assert from 'node:assert/strict';
import test from 'node:test';
import { runInput } from '../src/harnesses/shared/run-input.js';

const agentId = 'peer';
const started = { inputId: 'input-one', status: 'accepted', disposition: 'started' };
const options = { requestId: 'one', timeoutMs: 500 };

function fixture(send, status = 'idle') {
  let listener;
  const calls = [];
  const runtime = {
    id: 'fixture',
    async get() { return { status, cursor: 10 }; },
    onEvent(handler) {
      assert.equal(listener, undefined);
      listener = handler;
      return () => { listener = undefined; };
    },
    send(id, input, configuration) {
      assert.ok(listener);
      calls.push({ id, input, ...configuration });
      return send(publish);
    },
  };
  function publish(options = {}) { listener?.({ agentId, type: 'settled', outcome: 'completed', ...options }); }
  return { runtime, publish, calls, listening: () => Boolean(listener) };
}

test('exclusive waits accept a new settlement before or after receipt, ignore foreign events, and permit another request', async () => {
  let round = 0;
  const { runtime, calls, listening } = fixture(async publish => {
    publish({ agentId: 'foreign', outcome: 'failed' });
    if (++round === 1) publish({ output: 'one' });
    else setImmediate(() => publish({ output: 'two' }));
    return started;
  });
  const first = await runInput(runtime, agentId, 'fixed', options);
  assert.equal(first.settled.output, 'one'); assert.equal(first.receipt, started);
  await assert.rejects(runInput(runtime, agentId, 'fixed', options), { code: 'wait_request_id_reused' });
  assert.equal((await runInput(runtime, agentId, 'again', { ...options, requestId: 'two' })).settled.output, 'two');
  assert.deepEqual(calls.map(({ requestId, mode }) => [requestId, mode]), [['one', 'followUp'], ['two', 'followUp']]);
  assert.equal(listening(), false);
});

test('wait rejects concurrent, non-idle and handled inputs without declaring business completion', async () => {
  const idle = fixture(async publish => { publish(); return { ...started, disposition: 'handled' }; });
  const active = runInput(idle.runtime, agentId, 'one', options);
  await assert.rejects(runInput(idle.runtime, agentId, 'two', { ...options, requestId: 'two' }), { code: 'concurrent_wait_for_agent' });
  await assert.rejects(active, { code: 'input_handled_without_model_run', inputId: started.inputId });
  assert.equal(idle.calls.length, 1);
  const busy = fixture(() => assert.fail('A busy Agent must not receive input'), 'running');
  await assert.rejects(runInput(busy.runtime, agentId, 'one', options), { code: 'wait_requires_idle_agent' });
});

test('failed settlement keeps the same identity and output even if observed before acceptance', async () => {
  const { runtime } = fixture(async publish => { publish({ outcome: 'failed', error: { code: 'MODEL_FAILED' } }); return started; });
  await assert.rejects(runInput(runtime, agentId, 'fixed', options), error => {
    assert.equal(error.code, 'input_failed');
    assert.equal(error.requestId, options.requestId);
    assert.equal(error.inputId, started.inputId);
    assert.equal(error.event.error.code, 'MODEL_FAILED');
    return true;
  });
});

test('unknown and queued inputs keep their receipts and fence later work to the same Agent', async () => {
  for (const [receipt, code] of [[{ inputId: started.inputId, status: 'unknown' }, 'input_unknown'],
    [{ ...started, disposition: 'queued' }, 'exclusive_input_was_queued']]) {
    const { runtime, calls, listening } = fixture(async publish => { publish(); return receipt; });
    await assert.rejects(runInput(runtime, agentId, 'fixed', options), error => {
      assert.equal(error.code, code);
      assert.equal(error.receipt, receipt);
      return true;
    });
    await assert.rejects(runInput(runtime, agentId, 'again', { ...options, requestId: 'new' }), { code: 'previous_submission_unresolved' });
    assert.equal(calls.length, 1);
    assert.equal(listening(), false);
  }
});

test('abort or timeout after dispatch releases the host wait and prevents re-submission', async () => {
  for (const cause of ['wait_aborted', 'input_timeout']) {
    const controller = new AbortController();
    const { runtime, calls, listening } = fixture(async () => {
      if (cause === 'wait_aborted') setImmediate(() => controller.abort());
      return started;
    });
    const timeoutMs = cause === 'input_timeout' ? 20 : options.timeoutMs;
    await assert.rejects(runInput(runtime, agentId, 'fixed', { ...options, timeoutMs, signal: controller.signal }), { code: cause, inputId: started.inputId });
    await assert.rejects(runInput(runtime, agentId, 'again', { ...options, requestId: 'new' }), { code: 'previous_submission_unresolved' });
    assert.equal(calls.length, 1);
    assert.equal(listening(), false);
  }
});

test('a host guard can withdraw a turn after the idle snapshot and before Core registers an input', async () => {
  const { runtime, calls, listening } = fixture(async publish => { publish(); return started; });
  const get = runtime.get;
  let eligible = true;
  runtime.get = async () => {
    const snapshot = await get();
    eligible = false;
    return snapshot;
  };
  const withdrawn = new Error('The peer can no longer complete the task');
  await assert.rejects(runInput(runtime, agentId, 'continuation', {
    ...options,
    beforeSend() {
      if (!eligible) throw withdrawn;
    },
  }), error => error === withdrawn);
  assert.deepEqual(calls, []);
  assert.equal(listening(), false);
  assert.equal((await runInput(runtime, agentId, 'other work', { ...options, requestId: 'two' })).receipt, started);
});
