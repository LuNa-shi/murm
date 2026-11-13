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

test('successful dispatch is not relaunched on later polls for the same READY set', async () => {
  let now = 0;
  let starts = 0;
  const { scheduler } = schedulerFixture({
    now: () => now,
    readyTasks: [{ task_id: 'task-1' }],
    startUnboundSession: async () => {
      starts += 1;
      return { started: true };
    },
  });

  await scheduler.reconcile({ reason: 'ready-created' });
  now = 5_000;
  await scheduler.reconcile({ reason: 'bounded-poll' });
  now = 10_000;
  await scheduler.reconcile({ reason: 'duplicate-ready-event' });

  assert.equal(starts, 1);
  assert.equal(scheduler.snapshot().dispatch_count, 1);
  assert.equal(scheduler.snapshot().duplicate_suppression_count, 2);
});

test('a bound Task release opens a new dispatch opportunity for the same READY set', async () => {
  let core = { id: 'core-1', free: true };
  let starts = 0;
  const { scheduler, setCores } = schedulerFixture({
    readyTasks: [{ task_id: 'task-1' }],
    cores: [core],
    startUnboundSession: async () => {
      starts += 1;
      return { started: true };
    },
  });

  await scheduler.reconcile({ reason: 'ready-created' });
  core = { id: 'core-1', free: false, taskId: 'task-1', executionId: 'execution-1' };
  setCores([core]);
  await scheduler.reconcile({ reason: 'take-succeeded' });
  core = { id: 'core-1', free: true };
  setCores([core]);
  await scheduler.reconcile({ reason: 'execution-released' });

  assert.equal(starts, 2);
  assert.equal(scheduler.snapshot().dispatch_count, 2);
});

test('a closed unbound session reopens a bounded dispatch opportunity', async () => {
  const core = { id: 'core-1', free: true, session: { closed: false } };
  let starts = 0;
  const { scheduler, setCores } = schedulerFixture({
    readyTasks: [{ task_id: 'task-1' }],
    cores: [core],
    maxStartupAttempts: 2,
    startUnboundSession: async () => {
      starts += 1;
      return { started: true };
    },
  });

  await scheduler.reconcile({ reason: 'ready-created' });
  core.session = { closed: true };
  setCores([core]);
  await scheduler.reconcile({ reason: 'worker-exited' });
  core.session = { closed: true };
  await scheduler.reconcile({ reason: 'replacement-exited' });
  core.session = { closed: true };
  await scheduler.reconcile({ reason: 'bounded-retry' });

  assert.equal(starts, 2);
  assert.equal(scheduler.snapshot().dispatch_count, 2);
  assert.equal(scheduler.snapshot().duplicate_suppression_count, 0);
  assert.equal(scheduler.snapshot().bounded_startup_exhausted_count, 0);
});

test('closed unbound workers do not monopolize the next READY dispatch', async () => {
  const cores = [1, 2, 3, 4].map((id) => ({ id: `core-${id}`, free: true, session: { closed: false } }));
  const calls = [];
  const { scheduler } = schedulerFixture({
    readyTasks: [{ task_id: 'task-1' }],
    cores,
    startUnboundSession: async ({ core }) => {
      calls.push(core.id);
      core.session = { closed: true };
      return { started: true };
    },
  });

  for (let attempt = 0; attempt < cores.length; attempt += 1) {
    await scheduler.reconcile({ reason: `worker-exited-${attempt}` });
  }

  assert.deepEqual(calls, ['core-1', 'core-2', 'core-3', 'core-4']);
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

test('dispatch latency is measured through startup completion', async () => {
  let now = 0;
  const { scheduler } = schedulerFixture({
    now: () => now,
    readyTasks: [{ task_id: 'task-1' }],
    startUnboundSession: async () => {
      now = 25;
      return { started: true };
    },
  });

  await scheduler.reconcile({ reason: 'ready-created' });

  assert.deepEqual(scheduler.snapshot().dispatch_latencies_ms, [25]);
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
