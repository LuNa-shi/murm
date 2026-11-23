import assert from 'node:assert/strict';
import test from 'node:test';
import { runInput } from '../src/environments/shared/run-input.js';

const botId = 'peer';
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
  function publish(options = {}) { listener?.({ botId, seq: 11, type: 'settled', outcome: 'completed', ...options }); }
  return { runtime, publish, calls, listening: () => Boolean(listener) };
}

test('exclusive waits accept a new settlement before or after receipt, ignore old and foreign events, and permit another request', async () => {
  let round = 0;
  const { runtime, calls, listening } = fixture(async publish => {
    publish({ botId: 'foreign', outcome: 'failed' });
    publish({ seq: 10, outcome: 'failed' });
    if (++round === 1) publish({ output: 'one' });
    else setImmediate(() => publish({ seq: 12, output: 'two' }));
    return started;
  });
  assert.equal((await runInput(runtime, botId, 'fixed', options)).settled.output, 'one');
  await assert.rejects(runInput(runtime, botId, 'fixed', options), { code: 'wait_request_id_reused' });
  assert.equal((await runInput(runtime, botId, 'again', { ...options, requestId: 'two' })).settled.output, 'two');
  assert.deepEqual(calls.map(({ requestId, mode }) => [requestId, mode]), [['one', 'followUp'], ['two', 'followUp']]);
  assert.equal(listening(), false);
});

test('wait rejects concurrent, non-idle and handled inputs without declaring business completion', async () => {
  const idle = fixture(async publish => { publish(); return { ...started, disposition: 'handled' }; });
  const active = runInput(idle.runtime, botId, 'one', options);
  await assert.rejects(runInput(idle.runtime, botId, 'two', { ...options, requestId: 'two' }), { code: 'concurrent_wait_for_bot' });
  await assert.rejects(active, { code: 'input_handled_without_model_run', inputId: started.inputId });
  assert.equal(idle.calls.length, 1);
  const busy = fixture(() => assert.fail('A busy Bot must not receive input'), 'running');
  await assert.rejects(runInput(busy.runtime, botId, 'one', options), { code: 'wait_requires_idle_bot' });
});

test('failed settlement keeps the same identity and output even if observed before acceptance', async () => {
  const { runtime } = fixture(async publish => { publish({ outcome: 'failed', error: { code: 'MODEL_FAILED' } }); return started; });
  await assert.rejects(runInput(runtime, botId, 'fixed', options), error => {
    assert.equal(error.code, 'input_failed');
    assert.equal(error.requestId, options.requestId);
    assert.equal(error.inputId, started.inputId);
    assert.equal(error.event.error.code, 'MODEL_FAILED');
    return true;
  });
});

test('unknown and queued inputs keep their receipts and fence later work to the same Bot', async () => {
  for (const [receipt, code] of [[{ inputId: started.inputId, status: 'unknown' }, 'input_unknown'],
    [{ ...started, disposition: 'queued' }, 'exclusive_input_was_queued']]) {
    const { runtime, calls, listening } = fixture(async publish => { publish(); return receipt; });
    await assert.rejects(runInput(runtime, botId, 'fixed', options), error => {
      assert.equal(error.code, code);
      assert.equal(error.receipt, receipt);
      return true;
    });
    await assert.rejects(runInput(runtime, botId, 'again', { ...options, requestId: 'new' }), { code: 'previous_submission_unresolved' });
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
    await assert.rejects(runInput(runtime, botId, 'fixed', { ...options, timeoutMs, signal: controller.signal }), { code: cause, inputId: started.inputId });
    await assert.rejects(runInput(runtime, botId, 'again', { ...options, requestId: 'new' }), { code: 'previous_submission_unresolved' });
    assert.equal(calls.length, 1);
    assert.equal(listening(), false);
  }
});
