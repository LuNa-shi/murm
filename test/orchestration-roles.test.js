import assert from 'node:assert/strict';
import test from 'node:test';
import { IdentityTaskLoop, IDENTITY_LOOP_STATES } from '../src/runtime/identity-task-loop.js';
import { TaskController } from '../src/runtime/task-controller.js';

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

test('TaskController reconciles takeability and signals each idle daemon once per view', async () => {
  const signals = [];
  const events = [];
  const daemon = { core_id: 'core-1', state: 'IDLE', healthy: true };
  const taskService = {
    listTasks: ({ states, availableOnly }) => states.includes('OPEN') && availableOnly
      ? [{ task_id: 'task-1', state: 'OPEN' }]
      : [{ task_id: 'blocked-1', state: 'BLOCKED', block_reason: 'dependency:dep-1' }],
  };
  const controller = new TaskController({
    taskService,
    listIdentityLoops: () => [daemon],
    signalIdleIdentity: (target, payload) => signals.push({ target, payload }),
    onEvent: (event) => events.push(event),
  });

  const first = await controller.reconcile({ reason: 'dependency-complete' });
  const second = await controller.reconcile({ reason: 'duplicate-event' });

  assert.equal(first.eligible_count, 1);
  assert.equal(first.blocked_count, 1);
  assert.equal(second.signaled_loop_count, 0);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].target, daemon);
  assert.equal(signals[0].payload.reason, 'dependency-complete');
  assert.equal(events.filter((event) => event.kind === 'controller_reconcile').length, 2);
  assert.equal(events.some((event) => event.kind === 'controller_task_eligible'), true);
});

test('TaskController reserves one idle daemon per eligible Task', async () => {
  const signals = [];
  const daemons = [1, 2, 3].map((index) => ({ core_id: `core-${index}`, state: 'IDLE', healthy: true }));
  const controller = new TaskController({
    taskService: {
      listTasks: ({ states, availableOnly }) => states.includes('OPEN') && availableOnly
        ? [{ task_id: 'task-only', state: 'OPEN' }]
        : [],
    },
    listIdentityLoops: () => daemons,
    signalIdleIdentity: (daemon) => {
      signals.push(daemon.core_id);
      daemon.state = 'DISCOVERING';
    },
  });

  const result = await controller.reconcile({ reason: 'single-task' });

  assert.equal(result.idle_loop_count, 3);
  assert.equal(result.signaled_loop_count, 1);
  assert.deepEqual(signals, ['core-1']);
});

test('TaskController re-arms an idle signal after an unseen completed attempt', async () => {
  const signals = [];
  let idleGeneration = 0;
  const daemon = {
    core_id: 'core-1',
    snapshot: () => ({
      core_id: 'core-1', state: 'IDLE', healthy: true, idle_generation: idleGeneration,
    }),
  };
  const controller = new TaskController({
    taskService: {
      listTasks: ({ states, availableOnly }) => states.includes('OPEN') && availableOnly
        ? [{ task_id: 'task-1', state: 'OPEN' }]
        : [],
    },
    listIdentityLoops: () => [daemon],
    signalIdleIdentity: (_target, payload) => signals.push(payload.reason),
  });

  await controller.reconcile({ reason: 'initial' });
  await controller.reconcile({ reason: 'duplicate' });
  idleGeneration = 1;
  await controller.reconcile({ reason: 'take_invalid' });
  await controller.reconcile({ reason: 'duplicate-after-retry' });

  assert.deepEqual(signals, ['initial', 'take_invalid']);
});

test('TaskController does not wake an identity loop during take retry cooldown', async () => {
  const signals = [];
  const daemon = {
    core_id: 'core-1',
    snapshot: () => ({
      core_id: 'core-1', state: 'IDLE', healthy: true, idle_generation: 1,
      take_exhausted: true, take_retry_at: 2_000,
    }),
  };
  const controller = new TaskController({
    now: () => 1_000,
    taskService: {
      listTasks: ({ states, availableOnly }) => states.includes('OPEN') && availableOnly
        ? [{ task_id: 'task-1', state: 'OPEN' }]
        : [],
    },
    listIdentityLoops: () => [daemon],
    signalIdleIdentity: () => signals.push('signal'),
  });

  const result = await controller.reconcile({ reason: 'take_exhausted' });

  assert.equal(result.idle_loop_count, 0);
  assert.deepEqual(signals, []);
});

test('TaskController re-arms a daemon signal after a running handoff returns idle', async () => {
  const signals = [];
  const daemon = { core_id: 'core-1', state: 'IDLE', healthy: true };
  const taskService = {
    listTasks: ({ states, availableOnly }) => states.includes('OPEN') && availableOnly
      ? [{ task_id: 'task-1', state: 'OPEN' }]
      : [],
  };
  const controller = new TaskController({
    taskService,
    listIdentityLoops: () => [daemon],
    signalIdleIdentity: (_target, payload) => signals.push(payload.reason),
  });

  await controller.reconcile({ reason: 'initial' });
  await controller.reconcile({ reason: 'duplicate' });
  daemon.state = 'RUNNING';
  await controller.reconcile({ reason: 'claimed' });
  daemon.state = 'IDLE';
  await controller.reconcile({ reason: 'released' });

  assert.deepEqual(signals, ['initial', 'released']);
});

test('TaskController does not wake a daemon while it is discovering', async () => {
  const signals = [];
  const daemon = { core_id: 'core-discovering', state: 'DISCOVERING', healthy: true };
  const controller = new TaskController({
    taskService: {
      listTasks: ({ states, availableOnly }) => states.includes('OPEN') && availableOnly
        ? [{ task_id: 'task-1', state: 'OPEN' }]
        : [],
    },
    listIdentityLoops: () => [daemon],
    signalIdleIdentity: (_target, payload) => signals.push(payload.reason),
  });

  const result = await controller.reconcile({ reason: 'discovery-in-flight' });

  assert.equal(result.idle_loop_count, 0);
  assert.deepEqual(signals, []);
});

test('TaskController projects a stable blocked Task only once', async () => {
  const events = [];
  const daemon = { core_id: 'core-1', state: 'IDLE', healthy: true };
  const controller = new TaskController({
    taskService: {
      listTasks: ({ availableOnly }) => availableOnly
        ? []
        : [{ task_id: 'blocked-1', state: 'BLOCKED', block_reason: 'dependency:dep-1' }],
    },
    listIdentityLoops: () => [daemon],
    onEvent: (event) => events.push(event),
  });

  await controller.reconcile({ reason: 'first' });
  await controller.reconcile({ reason: 'periodic' });

  assert.equal(events.filter((event) => event.kind === 'controller_task_blocked').length, 1);
});


test('TaskController adapts TaskService.reconcileTask to its task-id contract', async () => {
  const repaired = [];
  const controller = new TaskController({
    taskService: {
      listTasks: ({ availableOnly }) => availableOnly ? [] : [{ task_id: 'blocked-1', state: 'BLOCKED' }],
      reconcileTask: (taskId, context) => {
        repaired.push({ taskId, context });
        return { reopened: true };
      },
    },
  });

  await controller.reconcile({ reason: 'dependency-complete' });

  assert.equal(repaired.length, 1);
  assert.equal(repaired[0].taskId, 'blocked-1');
});

test('TaskController never claims work and wakes after a dependency event', async () => {
  const calls = [];
  let eligible = [];
  const controller = new TaskController({
    taskService: {
      listTasks: ({ availableOnly }) => availableOnly ? eligible : [],
    },
    listIdentityLoops: () => [],
    signalIdleIdentity: () => calls.push('signal'),
  });

  const pending = controller.notify({ type: 'dependency_changed', task_id: 'task-1' });
  eligible = [{ task_id: 'task-1' }];
  const result = await pending;
  assert.equal(result.reason, 'dependency_changed');
  assert.equal(calls.length, 0);
  assert.equal(controller.snapshot().take_count, 0);
});

test('IdentityTaskLoop presents a bounded shortlist, claims once, hands off to Runtime, and returns idle', async () => {
  const calls = [];
  const daemon = new IdentityTaskLoop({
    coreId: 'core-1',
    listEligibleTasks: () => [
      { task_id: 'task-1', priority: 10 },
      { task_id: 'task-2', priority: 1 },
    ],
    shortlistLimit: 1,
    takeTask: async ({ candidates, prompt }) => {
      calls.push({ type: 'take', candidates, prompt });
      return { task_id: 'task-1' };
    },
    takeSelectedTask: async (taskId, context) => {
      calls.push({ type: 'take', taskId, context });
      return { task: { task_id: taskId, state: 'RUNNING' }, execution: { execution_id: 'execution-1', task_id: taskId, state: 'CREATED' } };
    },
    runExecution: async (claim) => {
      calls.push({ type: 'run', take: claim });
      return { execution: { ...claim.execution, state: 'SUCCEEDED' } };
    },
  });

  const result = await daemon.runOnce({ reason: 'initial' });

  assert.equal(result.disposition, 'completed');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].candidates.map((task) => task.task_id), ['task-1']);
  assert.match(calls[0].prompt, /task_take|same Core identity/s);
  assert.equal(calls[1].taskId, 'task-1');
  assert.equal(calls[1].context.core_id, 'core-1');
  assert.equal(calls[1].context.take_key, 'core-1:task-1:0');
  assert.equal(calls[1].context.owner_ref, 'identity:core-1');
  assert.equal(calls[2].take.execution.execution_id, 'execution-1');
  assert.equal(daemon.snapshot().state, 'IDLE');
  assert.equal(daemon.snapshot().execution_id, null);
  assert.deepEqual(daemon.snapshot().state_history.map((item) => item.state), ['IDLE', 'DISCOVERING', 'TAKING', 'RUNNING', 'IDLE']);
});

test('IdentityTaskLoop boundedly rescans after a lost take race without retrying the same take forever', async () => {
  const selected = [];
  let discoveries = 0;
  const daemon = new IdentityTaskLoop({
    coreId: 'core-2',
    maxTakeRescans: 1,
    listEligibleTasks: () => {
      discoveries += 1;
      return [{ task_id: discoveries === 1 ? 'task-stale' : 'task-next' }];
    },
    takeTask: async ({ candidates }) => {
      selected.push(candidates[0].task_id);
      return candidates[0].task_id;
    },
    takeSelectedTask: async () => {
      const error = new Error('another daemon won the claim');
      error.code = 'CONFLICT';
      throw error;
    },
  });

  const result = await daemon.runOnce({ reason: 'contention' });

  assert.equal(result.disposition, 'take_conflict');
  assert.equal(result.rescans, 1);
  assert.deepEqual(selected, ['task-stale', 'task-next']);
  assert.equal(daemon.snapshot().take_count, 0);
  assert.equal(daemon.snapshot().take_conflict_count, 2);
  assert.equal(daemon.snapshot().state, 'IDLE');
});

test('IdentityTaskLoop re-arms a selection failure after its bounded cooldown', async () => {
  let now = 1_000;
  let selectionAttempts = 0;
  const events = [];
  const daemon = new IdentityTaskLoop({
    coreId: 'core-rearm',
    maxTakeAttempts: 1,
    takeRetryCooldownMs: 100,
    now: () => now,
    listEligibleTasks: () => [{ task_id: 'task-rearm' }],
    takeTask: async () => {
      selectionAttempts += 1;
      if (selectionAttempts === 1) throw new Error('transient take provider failure');
      return 'task-rearm';
    },
    takeSelectedTask: async () => ({ task: { task_id: 'task-rearm' }, execution: { execution_id: 'execution-rearm', task_id: 'task-rearm', state: 'CREATED' } }),
    runExecution: async (claim) => ({ execution: { ...claim.execution, state: 'SUCCEEDED' } }),
    onEvent: (event) => events.push(event),
  });

  assert.equal((await daemon.runOnce({ reason: 'initial' })).disposition, 'take_failed');
  assert.equal(daemon.snapshot().take_exhausted, true);
  assert.equal(daemon.snapshot().idle_generation, 1);
  daemon.notify('before-cooldown');
  assert.equal(daemon.snapshot().take_exhausted, true);
  assert.equal(events.at(-1).kind, 'identity_loop_wake_deferred');
  now += 100;
  daemon.notify('provider-recovered');
  assert.equal(daemon.snapshot().take_exhausted, false);
  assert.equal((await daemon.runOnce({ reason: 'rearmed' })).disposition, 'completed');
  assert.equal(selectionAttempts, 2);
});

test('IdentityTaskLoop bounds infrastructure take failures instead of treating them as claim conflicts', async () => {
  let now = 1_000;
  let attempts = 0;
  const daemon = new IdentityTaskLoop({
    coreId: 'core-provider-failure',
    maxTakeAttempts: 2,
    takeRetryCooldownMs: 100,
    now: () => now,
    listEligibleTasks: () => [{ task_id: 'task-provider-failure' }],
    takeTask: async () => {
      attempts += 1;
      return { take_failed: true, error: { code: 'SERVICE_UNAVAILABLE', message: 'provider unavailable' } };
    },
    takeSelectedTask: async () => { throw new Error('take should not be reached'); },
  });

  assert.equal((await daemon.runOnce({ reason: 'provider-failure' })).disposition, 'take_failed');
  assert.equal(daemon.snapshot().take_exhausted, false);
  assert.equal((await daemon.runOnce({ reason: 'provider-failure-retry' })).disposition, 'take_failed');
  assert.equal(daemon.snapshot().take_exhausted, true);
  assert.equal(daemon.snapshot().take_conflict_count, 0);
  assert.equal(attempts, 2);
  now += 100;
  daemon.notify('provider-recovered');
  assert.equal(daemon.snapshot().take_exhausted, false);
});

test('IdentityTaskLoop uses a fresh take key when the same Task is reclaimed later', async () => {
  const takeKeys = [];
  let executionNumber = 0;
  const daemon = new IdentityTaskLoop({
    coreId: 'core-reclaim',
    listEligibleTasks: () => [{ task_id: 'task-reclaim' }],
    takeTask: async ({ candidates }) => candidates[0].task_id,
    takeSelectedTask: async (taskId, context) => {
      takeKeys.push(context.take_key);
      executionNumber += 1;
      return { task: { task_id: taskId }, execution: { execution_id: `execution-${executionNumber}`, task_id: taskId, state: 'CREATED' } };
    },
    runExecution: async (claim) => ({ execution: { ...claim.execution, state: 'SUCCEEDED' } }),
  });

  await daemon.runOnce({ reason: 'first-attempt' });
  await daemon.runOnce({ reason: 'later-retry' });

  assert.deepEqual(takeKeys, ['core-reclaim:task-reclaim:0', 'core-reclaim:task-reclaim:1']);
});

test('IdentityTaskLoop does not select or claim when discovery is empty', async () => {
  let selections = 0;
  let claims = 0;
  const daemon = new IdentityTaskLoop({
    coreId: 'core-empty',
    listEligibleTasks: () => [],
    takeTask: async () => { selections += 1; return 'unused'; },
    takeSelectedTask: async () => { claims += 1; },
  });

  const result = await daemon.runOnce({ reason: 'empty' });

  assert.equal(result.disposition, 'idle');
  assert.equal(selections, 0);
  assert.equal(claims, 0);
  assert.equal(daemon.snapshot().state, IDENTITY_LOOP_STATES.IDLE);
});

test('IdentityTaskLoop run loop waits for wake signals and stops cleanly', async () => {
  const wake = deferred();
  let discoveries = 0;
  const daemon = new IdentityTaskLoop({
    coreId: 'core-loop',
    listEligibleTasks: () => {
      discoveries += 1;
      return discoveries === 1 ? [] : [{ task_id: 'task-loop' }];
    },
    takeTask: async () => 'task-loop',
    takeSelectedTask: async () => ({ execution: { execution_id: 'execution-loop', task_id: 'task-loop', state: 'CREATED' } }),
    runExecution: async () => ({ execution: { state: 'SUCCEEDED' } }),
    waitForSignal: () => wake.promise,
  });

  const running = daemon.run({ maxTurns: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  wake.resolve('task-created');
  const result = await running;

  assert.equal(result.turns, 2);
  assert.equal(daemon.snapshot().state, 'IDLE');
  daemon.stop();
  assert.equal(daemon.snapshot().state, 'STOPPING');
});

test('IdentityTaskLoop notify wakes a custom waitForSignal path', async () => {
  let discoveries = 0;
  const daemon = new IdentityTaskLoop({
    coreId: 'core-custom-wake',
    listEligibleTasks: () => {
      discoveries += 1;
      return discoveries === 1 ? [] : [{ task_id: 'task-custom-wake' }];
    },
    takeTask: async () => 'task-custom-wake',
    takeSelectedTask: async () => ({ execution: { execution_id: 'execution-custom-wake', task_id: 'task-custom-wake', state: 'CREATED' } }),
    runExecution: async () => ({ execution: { state: 'SUCCEEDED' } }),
    waitForSignal: () => new Promise(() => {}),
  });

  const running = daemon.run({ maxTurns: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  daemon.notify('task-created');
  const result = await running;

  assert.equal(result.turns, 2);
  assert.equal(discoveries, 2);
  daemon.stop();
});

test('IdentityTaskLoop default idle wait is interruptible by notify', async () => {
  const calls = [];
  let discoveries = 0;
  const daemon = new IdentityTaskLoop({
    coreId: 'core-default-wake',
    idleBackoffMs: 10_000,
    listEligibleTasks: () => {
      discoveries += 1;
      return discoveries === 1 ? [] : [{ task_id: 'task-woken' }];
    },
    takeTask: async () => 'task-woken',
    takeSelectedTask: async () => ({ execution: { execution_id: 'execution-woken', task_id: 'task-woken', state: 'CREATED' } }),
    runExecution: async () => {
      calls.push('run');
      return { execution: { state: 'SUCCEEDED' } };
    },
  });

  const running = daemon.run({ maxTurns: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  daemon.notify('task-created');
  const result = await running;

  assert.equal(result.turns, 2);
  assert.equal(calls.length, 1);
  assert.equal(daemon.snapshot().state, IDENTITY_LOOP_STATES.IDLE);
  daemon.stop();
});

test('IdentityTaskLoop stop aborts a claimed Runtime handoff and fences the claim', async () => {
  let fenced = 0;
  const events = [];
  const daemon = new IdentityTaskLoop({
    coreId: 'core-abort',
    listEligibleTasks: () => [{ task_id: 'task-abort' }],
    takeTask: async () => 'task-abort',
    takeSelectedTask: async () => ({ task: { task_id: 'task-abort' }, execution: { execution_id: 'execution-abort', task_id: 'task-abort', state: 'CREATED' } }),
    runtime: {
      startClaimedExecution: async (execution) => ({ execution }),
      waitForExecutionRelease: async (_executionId, { signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ released: false, aborted: true }), { once: true })),
      fenceExecution: async () => { fenced += 1; return { execution: { state: 'FENCED' } }; },
    },
    onEvent: (event) => events.push(event),
  });
  const running = daemon.runOnce({ reason: 'abort-test' });
  await new Promise((resolve) => setImmediate(resolve));
  daemon.stop();
  const result = await running;
  assert.equal(result.disposition, 'runtime_failed');
  assert.ok(fenced >= 1);
  assert.equal(events.filter((event) => event.kind === 'identity_loop_execution_released').length, 1);
  assert.equal(events.find((event) => event.kind === 'identity_loop_execution_released').execution_state, 'FENCED');
  assert.equal(daemon.snapshot().state, 'STOPPING');
});
