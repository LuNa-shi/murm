import assert from 'node:assert/strict';
import test from 'node:test';
import { GENERIC_AGENT_PROMPT } from '../src/agent/agent-prompt.js';
import { Scheduler } from '../src/runtime/scheduler.js';

function schedulerFixture({ readyTasks = [], cores = [{ id: 'core-1', free: true }], startUnboundSession, ...options } = {}) {
  let currentReady = readyTasks;
  let currentCores = cores;
  const scheduler = new Scheduler({
    listReadyTasks: () => currentReady,
    listCores: () => currentCores,
    isCoreAvailable: (core) => core.free === true,
    startUnboundSession,
    ...options,
  });
  return {
    scheduler,
    setReady(tasks) { currentReady = tasks; },
    setCores(nextCores) { currentCores = nextCores; },
  };
}

test('an empty READY queue does not start a Pi session', async () => {
  let starts = 0;
  const { scheduler } = schedulerFixture({
    startUnboundSession: async () => {
      starts += 1;
    },
  });

  await scheduler.reconcile({ reason: 'initial' });
  await scheduler.notify('duplicate-ready-event');

  assert.equal(starts, 0);
  assert.equal(scheduler.snapshot().dispatch_count, 0);
});

test('one READY Task and one free Core dispatch exactly one unbound generic session', async () => {
  const calls = [];
  const { scheduler } = schedulerFixture({
    readyTasks: [{ task_id: 'task-1' }],
    startUnboundSession: async (request) => {
      calls.push(request);
      return { started: true };
    },
  });

  await scheduler.reconcile({ reason: 'ready-created' });
  await scheduler.notify('duplicate-ready-event');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].core.id, 'core-1');
  assert.equal(calls[0].prompt, GENERIC_AGENT_PROMPT);
  assert.equal(Object.hasOwn(calls[0], 'task'), false, 'Scheduler must not pre-bind a Task');
  assert.equal(calls[0].ready_count, 1);
  assert.equal(scheduler.snapshot().dispatch_count, 1);
});

test('duplicate readiness notifications do not race a pending startup', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let starts = 0;
  const { scheduler } = schedulerFixture({
    readyTasks: [{ task_id: 'task-1' }],
    startUnboundSession: async () => {
      starts += 1;
      await gate;
      return { started: true };
    },
  });

  const first = scheduler.notify('ready-created');
  const second = scheduler.notify('ready-created-duplicate');
  release();
  await Promise.all([first, second]);

  assert.equal(starts, 1);
  assert.equal(scheduler.snapshot().dispatch_count, 1);
});

test('provider startup failures stop after the configured bounded attempts', async () => {
  let now = 0;
  let starts = 0;
  const { scheduler } = schedulerFixture({
    readyTasks: [{ task_id: 'task-1' }],
    now: () => now,
    maxStartupAttempts: 2,
    retryBackoffMs: 0,
    dispatchBackoffMs: 0,
    startUnboundSession: async () => {
      starts += 1;
      throw Object.assign(new Error('provider unavailable'), { code: 'PROVIDER_UNAVAILABLE' });
    },
  });

  await scheduler.reconcile({ reason: 'ready-created' });
  now += 1;
  await scheduler.reconcile({ reason: 'bounded-retry' });
  now += 1;
  await scheduler.reconcile({ reason: 'duplicate-ready-event' });

  assert.equal(starts, 2);
  assert.equal(scheduler.snapshot().startup_failure_count, 2);
  assert.equal(scheduler.snapshot().bounded_startup_exhausted_count, 1);
});
