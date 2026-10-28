import assert from 'node:assert/strict';
import test from 'node:test';
import { CoreDaemon, CORE_DAEMON_STATES } from '../src/runtime/core-daemon.js';
import { TaskController } from '../src/runtime/task-controller.js';

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

test('TaskController reconciles claimability and signals each idle daemon once per view', async () => {
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
    listDaemons: () => [daemon],
    signalIdleDaemon: (target, payload) => signals.push({ target, payload }),
    onEvent: (event) => events.push(event),
  });

  const first = await controller.reconcile({ reason: 'dependency-complete' });
  const second = await controller.reconcile({ reason: 'duplicate-event' });

  assert.equal(first.claimable_count, 1);
  assert.equal(first.blocked_count, 1);
  assert.equal(second.signaled_daemon_count, 0);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].target, daemon);
  assert.equal(signals[0].payload.reason, 'dependency-complete');
  assert.equal(events.filter((event) => event.kind === 'controller_reconcile').length, 2);
  assert.equal(events.some((event) => event.kind === 'controller_task_claimable'), true);
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
    listDaemons: () => [daemon],
    signalIdleDaemon: (_target, payload) => signals.push(payload.reason),
  });

  await controller.reconcile({ reason: 'initial' });
  await controller.reconcile({ reason: 'duplicate' });
  idleGeneration = 1;
  await controller.reconcile({ reason: 'selection_invalid' });
  await controller.reconcile({ reason: 'duplicate-after-retry' });

  assert.deepEqual(signals, ['initial', 'selection_invalid']);
});

test('TaskController does not wake an idle daemon during selection retry cooldown', async () => {
  const signals = [];
  const daemon = {
    core_id: 'core-1',
    snapshot: () => ({
      core_id: 'core-1', state: 'IDLE', healthy: true, idle_generation: 1,
      selection_exhausted: true, selection_retry_at: 2_000,
    }),
  };
  const controller = new TaskController({
    now: () => 1_000,
    taskService: {
      listTasks: ({ states, availableOnly }) => states.includes('OPEN') && availableOnly
        ? [{ task_id: 'task-1', state: 'OPEN' }]
        : [],
    },
    listDaemons: () => [daemon],
    signalIdleDaemon: () => signals.push('signal'),
  });

  const result = await controller.reconcile({ reason: 'selection_exhausted' });

  assert.equal(result.idle_daemon_count, 0);
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
    listDaemons: () => [daemon],
    signalIdleDaemon: (_target, payload) => signals.push(payload.reason),
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
    listDaemons: () => [daemon],
    signalIdleDaemon: (_target, payload) => signals.push(payload.reason),
  });

  const result = await controller.reconcile({ reason: 'discovery-in-flight' });

  assert.equal(result.idle_daemon_count, 0);
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
    listDaemons: () => [daemon],
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
  let claimable = [];
  const controller = new TaskController({
    taskService: {
      listTasks: ({ availableOnly }) => availableOnly ? claimable : [],
    },
    listDaemons: () => [],
    signalIdleDaemon: () => calls.push('signal'),
  });

  const pending = controller.notify({ type: 'dependency_changed', task_id: 'task-1' });
  claimable = [{ task_id: 'task-1' }];
  const result = await pending;
  assert.equal(result.reason, 'dependency_changed');
  assert.equal(calls.length, 0);
  assert.equal(controller.snapshot().claim_count, 0);
});

test('CoreDaemon presents a bounded shortlist, claims once, hands off to Runtime, and returns idle', async () => {
  const calls = [];
  const daemon = new CoreDaemon({
    coreId: 'core-1',
    listClaimableTasks: () => [
      { task_id: 'task-1', priority: 10 },
      { task_id: 'task-2', priority: 1 },
    ],
    shortlistLimit: 1,
    selectTask: async ({ candidates, prompt }) => {
      calls.push({ type: 'select', candidates, prompt });
      return { task_id: 'task-1' };
    },
    claimTask: async (taskId, context) => {
      calls.push({ type: 'claim', taskId, context });
      return { task: { task_id: taskId, state: 'RUNNING' }, execution: { execution_id: 'execution-1', task_id: taskId, state: 'CREATED' } };
    },
    runExecution: async (claim) => {
      calls.push({ type: 'run', claim });
      return { execution: { ...claim.execution, state: 'SUCCEEDED' } };
    },
  });

  const result = await daemon.runOnce({ reason: 'initial' });

  assert.equal(result.disposition, 'completed');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].candidates.map((task) => task.task_id), ['task-1']);
  assert.match(calls[0].prompt, /list_tasks.*select.*claim/s);
  assert.equal(calls[1].taskId, 'task-1');
  assert.equal(calls[1].context.core_id, 'core-1');
  assert.equal(calls[1].context.claim_key, 'core-1:task-1:0');
  assert.equal(calls[1].context.owner_ref, 'daemon:core-1');
  assert.equal(calls[2].claim.execution.execution_id, 'execution-1');
  assert.equal(daemon.snapshot().state, 'IDLE');
  assert.equal(daemon.snapshot().execution_id, null);
  assert.deepEqual(daemon.snapshot().state_history.map((item) => item.state), ['IDLE', 'DISCOVERING', 'SELECTING', 'RUNNING', 'IDLE']);
});

test('CoreDaemon boundedly rescans after a lost claim race without retrying the same claim forever', async () => {
  const selected = [];
  let discoveries = 0;
  const daemon = new CoreDaemon({
    coreId: 'core-2',
    maxClaimRescans: 1,
    listClaimableTasks: () => {
      discoveries += 1;
      return [{ task_id: discoveries === 1 ? 'task-stale' : 'task-next' }];
    },
    selectTask: async ({ candidates }) => {
      selected.push(candidates[0].task_id);
      return candidates[0].task_id;
    },
    claimTask: async () => {
      const error = new Error('another daemon won the claim');
      error.code = 'CONFLICT';
      throw error;
    },
  });

  const result = await daemon.runOnce({ reason: 'contention' });

  assert.equal(result.disposition, 'claim_conflict');
  assert.equal(result.rescans, 1);
  assert.deepEqual(selected, ['task-stale', 'task-next']);
  assert.equal(daemon.snapshot().claim_count, 0);
  assert.equal(daemon.snapshot().claim_conflict_count, 2);
  assert.equal(daemon.snapshot().state, 'IDLE');
});

test('CoreDaemon re-arms a selection failure after its bounded cooldown', async () => {
  let now = 1_000;
  let selectionAttempts = 0;
  const events = [];
  const daemon = new CoreDaemon({
    coreId: 'core-rearm',
    maxSelectionAttempts: 1,
    selectionRetryCooldownMs: 100,
    now: () => now,
    listClaimableTasks: () => [{ task_id: 'task-rearm' }],
    selectTask: async () => {
      selectionAttempts += 1;
      if (selectionAttempts === 1) throw new Error('transient selection provider failure');
      return 'task-rearm';
    },
    claimTask: async () => ({ task: { task_id: 'task-rearm' }, execution: { execution_id: 'execution-rearm', task_id: 'task-rearm', state: 'CREATED' } }),
    runExecution: async (claim) => ({ execution: { ...claim.execution, state: 'SUCCEEDED' } }),
    onEvent: (event) => events.push(event),
  });

  assert.equal((await daemon.runOnce({ reason: 'initial' })).disposition, 'selection_failed');
  assert.equal(daemon.snapshot().selection_exhausted, true);
  assert.equal(daemon.snapshot().idle_generation, 1);
  daemon.notify('before-cooldown');
  assert.equal(daemon.snapshot().selection_exhausted, true);
  assert.equal(events.at(-1).kind, 'daemon_wake_deferred');
  now += 100;
  daemon.notify('provider-recovered');
  assert.equal(daemon.snapshot().selection_exhausted, false);
  assert.equal((await daemon.runOnce({ reason: 'rearmed' })).disposition, 'completed');
  assert.equal(selectionAttempts, 2);
});

test('CoreDaemon uses a fresh claim key when the same Task is reclaimed later', async () => {
  const claimKeys = [];
  let executionNumber = 0;
  const daemon = new CoreDaemon({
    coreId: 'core-reclaim',
    listClaimableTasks: () => [{ task_id: 'task-reclaim' }],
    selectTask: async ({ candidates }) => candidates[0].task_id,
    claimTask: async (taskId, context) => {
      claimKeys.push(context.claim_key);
      executionNumber += 1;
      return { task: { task_id: taskId }, execution: { execution_id: `execution-${executionNumber}`, task_id: taskId, state: 'CREATED' } };
    },
    runExecution: async (claim) => ({ execution: { ...claim.execution, state: 'SUCCEEDED' } }),
  });

  await daemon.runOnce({ reason: 'first-attempt' });
  await daemon.runOnce({ reason: 'later-retry' });

  assert.deepEqual(claimKeys, ['core-reclaim:task-reclaim:0', 'core-reclaim:task-reclaim:1']);
});

test('CoreDaemon does not select or claim when discovery is empty', async () => {
  let selections = 0;
  let claims = 0;
  const daemon = new CoreDaemon({
    coreId: 'core-empty',
    listClaimableTasks: () => [],
    selectTask: async () => { selections += 1; return 'unused'; },
    claimTask: async () => { claims += 1; },
  });

  const result = await daemon.runOnce({ reason: 'empty' });

  assert.equal(result.disposition, 'idle');
  assert.equal(selections, 0);
  assert.equal(claims, 0);
  assert.equal(daemon.snapshot().state, CORE_DAEMON_STATES.IDLE);
});

test('CoreDaemon run loop waits for wake signals and stops cleanly', async () => {
  const wake = deferred();
  let discoveries = 0;
  const daemon = new CoreDaemon({
    coreId: 'core-loop',
    listClaimableTasks: () => {
      discoveries += 1;
      return discoveries === 1 ? [] : [{ task_id: 'task-loop' }];
    },
    selectTask: async () => 'task-loop',
    claimTask: async () => ({ execution: { execution_id: 'execution-loop', task_id: 'task-loop', state: 'CREATED' } }),
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

test('CoreDaemon notify wakes a custom waitForSignal path', async () => {
  let discoveries = 0;
  const daemon = new CoreDaemon({
    coreId: 'core-custom-wake',
    listClaimableTasks: () => {
      discoveries += 1;
      return discoveries === 1 ? [] : [{ task_id: 'task-custom-wake' }];
    },
    selectTask: async () => 'task-custom-wake',
    claimTask: async () => ({ execution: { execution_id: 'execution-custom-wake', task_id: 'task-custom-wake', state: 'CREATED' } }),
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

test('CoreDaemon default idle wait is interruptible by notify', async () => {
  const calls = [];
  let discoveries = 0;
  const daemon = new CoreDaemon({
    coreId: 'core-default-wake',
    idleBackoffMs: 10_000,
    listClaimableTasks: () => {
      discoveries += 1;
      return discoveries === 1 ? [] : [{ task_id: 'task-woken' }];
    },
    selectTask: async () => 'task-woken',
    claimTask: async () => ({ execution: { execution_id: 'execution-woken', task_id: 'task-woken', state: 'CREATED' } }),
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
  assert.equal(daemon.snapshot().state, CORE_DAEMON_STATES.IDLE);
  daemon.stop();
});

test('CoreDaemon stop aborts a claimed Runtime handoff and fences the claim', async () => {
  let fenced = 0;
  const events = [];
  const daemon = new CoreDaemon({
    coreId: 'core-abort',
    listClaimableTasks: () => [{ task_id: 'task-abort' }],
    selectTask: async () => 'task-abort',
    claimTask: async () => ({ task: { task_id: 'task-abort' }, execution: { execution_id: 'execution-abort', task_id: 'task-abort', state: 'CREATED' } }),
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
  assert.equal(fenced, 1);
  assert.equal(events.filter((event) => event.kind === 'daemon_execution_released').length, 1);
  assert.equal(events.find((event) => event.kind === 'daemon_execution_released').execution_state, 'FENCED');
  assert.equal(daemon.snapshot().state, 'STOPPING');
});
