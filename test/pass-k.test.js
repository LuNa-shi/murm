import assert from 'node:assert/strict';
import test from 'node:test';
import { runPassK } from '../src/benchmark/pass-k.js';

test('Pass@K uses K independent one-Core attempts and waits for its full window after early success', async () => {
  let now = 10_000;
  const calls = [];
  const result = await runPassK({ id: 'problem' }, {}, { k: 4, timeboxMs: 3_600_000 }, {
    now: () => now, wait: async ms => { now += ms; },
    runAttempt: async (_problem, _config, options) => {
      calls.push(options);
      return { run: { solved: options.attemptIndex === 2, accepted_at: options.attemptIndex === 2 ? new Date(11_000).toISOString() : null }, audit: { invalid: false } };
    },
  });
  assert.equal(calls.length, 4);
  assert.equal(new Set(calls.map(x => x.runId)).size, 4);
  assert.deepEqual(calls.map(x => x.attemptIndex), [1, 2, 3, 4]);
  assert.ok(calls.every(x => x.cores === 1 && x.agentMode === 'solver' && x.initialBotStaggerMs === 0 && x.startedAt === 10_000));
  assert.equal(result.summary.passed, true);
  assert.equal(result.summary.first_success_ms, 1000);
  assert.equal(result.summary.window_elapsed_ms, 3_600_000);
  assert.equal(result.summary.k, 4);
});

test('K=1 is the same execution path and late acceptance does not count', async () => {
  let now = 0;
  let calls = 0;
  const result = await runPassK({ id: 'problem' }, {}, { k: 1, timeboxMs: 100 }, {
    now: () => now, wait: async ms => { now += ms; },
    runAttempt: async (_p, _c, options) => {
      calls++;
      assert.equal(options.cores, 1);
      now = 101;
      return { run: { solved: true, accepted_at: new Date(101).toISOString() }, audit: { invalid: false } };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.summary.passed, false);
  assert.equal(result.summary.attempts[0].accepted_after_deadline, true);
  assert.equal(result.summary.settlement_elapsed_ms, 1);
});

test('operator stop interrupts the group observation without creating extra attempts', async () => {
  let now = 0;
  const controller = new AbortController();
  const result = await runPassK({ id: 'problem' }, {}, { k: 1, timeboxMs: 3_600_000, signal: controller.signal }, {
    now: () => now, wait: async ms => { now += ms; controller.abort(); },
    runAttempt: async () => ({ run: { solved: false }, audit: { invalid: false } }),
  });
  assert.equal(result.summary.stopped_by_operator, true);
  assert.equal(result.summary.valid, false);
  assert.equal(result.summary.window_elapsed_ms, 1000);
});
