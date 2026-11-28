import assert from 'node:assert/strict';
import test from 'node:test';
import { createTurnRunner } from '../examples/first-harness/turn.js';

function fixture(send) {
  const listeners = new Set();
  const emit = event => { for (const listener of listeners) listener(event); };
  return {
    emit, listeners,
    runtime: {
      state: 'open',
      get: async id => ({ id, profile: id, status: 'idle' }),
      onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      send: (id, text, options) => send(id, text, options, emit),
    },
  };
}

const accepted = { inputId: 'input', status: 'accepted', disposition: 'started' };
const settled = agentId => ({ agentId, type: 'settled', outcome: 'completed', output: agentId });

test('turn runner subscribes before send, isolates parallel Agents and refuses a second waiter', async () => {
  const { runtime, listeners } = fixture(async (id, _, _options, emit) => {
    emit(settled(id));
    return accepted;
  });
  const run = createTurnRunner(runtime);
  const first = run('first', 'go', { requestId: 'one' });
  const second = run('second', 'go', { requestId: 'two' });
  await assert.rejects(run('first', 'again', { requestId: 'three' }), { code: 'TURN_IN_FLIGHT' });
  assert.deepEqual((await Promise.all([first, second])).map(result => result.output), ['first', 'second']);
  assert.equal(listeners.size, 0);
});

test('turn runner bounds both admission and completion and disposes the subscription', async () => {
  for (const [effect, code] of [
    [() => new Promise(() => {}), 'TURN_TIMEOUT'],
    [async () => ({ status: 'unknown' }), 'INPUT_UNKNOWN'],
    [async () => ({ status: 'not-accepted' }), 'INPUT_NOT_ACCEPTED'],
    [async () => { throw Object.assign(new Error('test'), { code: 'INVALID_INPUT' }); }, 'INVALID_INPUT'],
    [async (id, _, _options, emit) => { emit({ type: 'error', agentId: id, fatal: true, error: { code: 'UPSTREAM_ERROR' } }); return accepted; }, 'UPSTREAM_ERROR'],
    [async (id, _, _options, emit) => { emit({ type: 'exit', agentId: id, expected: false }); return accepted; }, 'AGENT_EXITED'],
    [async (id, _, _options, emit) => { emit({ type: 'settled', agentId: id, outcome: 'failed' }); return accepted; }, 'TURN_FAILED'],
  ]) {
    const { runtime, listeners } = fixture(effect);
    await assert.rejects(createTurnRunner(runtime)('a', 'go', { requestId: 'one', timeoutMs: 25 }), { code });
    assert.equal(listeners.size, 0);
  }
});

test('aborting a turn removes its waiter even while send is unresolved', async () => {
  const controller = new AbortController();
  const { runtime, listeners } = fixture(() => {
    controller.abort();
    return new Promise(() => {});
  });
  await assert.rejects(createTurnRunner(runtime)('a', 'go', { requestId: 'one', signal: controller.signal }), { code: 'TURN_CANCELLED' });
  assert.equal(listeners.size, 0);
});
