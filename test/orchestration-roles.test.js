import assert from 'node:assert/strict';
import test from 'node:test';
import { IdentityTaskLoop, IDENTITY_LOOP_STATES } from '../src/runtime/identity-task-loop.js';
import { TaskController } from '../src/runtime/task-controller.js';
import { ServicesBridge } from '../src/agent/services-bridge.js';
import { TaskService } from '../src/task/task-service.js';
import { makeEnvelope } from '../src/protocol/envelope.js';

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

test('TaskController wakes every idle Core to discover work even with only one existing Task', async () => {
  const signals = [];
  const daemons = [1, 2, 3, 4].map((index) => ({ core_id: `core-${index}`, state: 'IDLE', healthy: true }));
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

  assert.equal(result.idle_loop_count, 4);
  assert.equal(result.signaled_loop_count, 4);
  assert.deepEqual(signals, ['core-1', 'core-2', 'core-3', 'core-4']);
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

test('TaskController permits empty-queue discovery on every Core without repeatedly waking an unchanged queue', async () => {
  let discoveries = 0;
  const loops = [1, 2, 3, 4].map((index) => new IdentityTaskLoop({
    coreId: `core-${index}`,
    listEligibleTasks: () => [],
    takeTask: async () => { discoveries += 1; return { no_work: true }; },
  }));
  const controller = new TaskController({
    listEligibleTasks: () => [],
    listIdentityLoops: () => loops,
    signalIdleIdentity: (loop) => { loop.notify('controller'); },
  });
  assert.equal((await controller.reconcile({ reason: 'initial' })).signaled_loop_count, 4);
  await Promise.all(loops.map((loop) => loop.runOnce()));
  assert.equal(discoveries, 4);
  assert.equal((await controller.reconcile({ reason: 'periodic_sweep' })).signaled_loop_count, 0);
  await Promise.all(loops.map((loop) => loop.runOnce()));
  assert.equal(discoveries, 4);
});

test('observing discovery in flight does not rearm a no-work Bot on the next controller sweep', async () => {
  const reading = deferred();
  const finishReading = deferred();
  let discoveries = 0;
  const loop = new IdentityTaskLoop({
    coreId: 'core-1',
    listEligibleTasks: () => [],
    takeTask: async () => {
      discoveries += 1;
      reading.resolve();
      await finishReading.promise;
      return { no_work: true };
    },
  });
  const controller = new TaskController({
    listEligibleTasks: () => [],
    listIdentityLoops: () => [loop],
    signalIdleIdentity: (target) => { target.notify('controller'); },
  });
  await controller.reconcile();
  const discovery = loop.runOnce();
  await reading.promise;
  await controller.reconcile();
  finishReading.resolve();
  await discovery;
  assert.equal((await controller.reconcile()).signaled_loop_count, 0);
  await loop.runOnce();
  assert.equal(discoveries, 1);
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
  await controller.reconcile({ reason: 'taken' });
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

test('TaskController never takes work and wakes after a dependency event', async () => {
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

test('IdentityTaskLoop presents a bounded shortlist, takes once, hands off to Runtime, and returns idle', async () => {
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
      return { task: { task_id: 'task-1', state: 'RUNNING' }, execution: { execution_id: 'execution-1', task_id: 'task-1', state: 'CREATED' } };
    },
    runExecution: async (take) => {
      calls.push({ type: 'run', take: take });
      return { execution: { ...take.execution, state: 'SUCCEEDED' } };
    },
  });

  const result = await daemon.runOnce({ reason: 'initial' });

  assert.equal(result.disposition, 'completed');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].candidates.map((task) => task.task_id), ['task-1']);
  assert.match(calls[0].prompt, /task_take|same Core identity/s);
  assert.equal(calls[1].take.execution.execution_id, 'execution-1');
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
      return { take_failed: true, error: { code: 'CONFLICT', message: 'another Bot won the take' } };
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
      return { task: { task_id: 'task-rearm' }, execution: { execution_id: 'execution-rearm', task_id: 'task-rearm', state: 'CREATED' } };
    },
    runExecution: async (take) => ({ execution: { ...take.execution, state: 'SUCCEEDED' } }),
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

test('IdentityTaskLoop bounds infrastructure take failures instead of treating them as take conflicts', async () => {
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

test('IdentityTaskLoop rejects a selected Task ID without creating an operator take', async () => {
  let operatorTakes = 0;
  const daemon = new IdentityTaskLoop({
    coreId: 'core-bare-selection',
    taskService: { takeTask() { operatorTakes += 1; throw new Error('supervisor must not take'); } },
    listEligibleTasks: () => [{ task_id: 'task-selected' }],
    takeTask: async () => ({ selected_task_id: 'task-selected' }),
  });
  assert.equal((await daemon.runOnce()).disposition, 'take_invalid');
  assert.equal(operatorTakes, 0);
  assert.equal(daemon.snapshot().take_count, 0);
});

test('IdentityTaskLoop discovers an empty queue without manufacturing a take', async () => {
  let selections = 0;
  const daemon = new IdentityTaskLoop({
    coreId: 'core-empty',
    listEligibleTasks: () => [],
    takeTask: async () => { selections += 1; return { no_work: true }; },
  });

  const result = await daemon.runOnce({ reason: 'empty' });

  assert.equal(result.disposition, 'idle');
  assert.equal(selections, 1);
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
    takeTask: async ({ candidates }) => candidates.length ? { task: { task_id: 'task-loop' }, execution: { execution_id: 'execution-loop', task_id: 'task-loop', state: 'CREATED' } } : { no_work: true },
    runExecution: async () => ({ execution: { state: 'SUCCEEDED' } }),
    waitForSignal: () => wake.promise,
  });

  const running = daemon.run({ maxTurns: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  daemon.notify('task-created');
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
    takeTask: async ({ candidates }) => candidates.length ? { task: { task_id: 'task-custom-wake' }, execution: { execution_id: 'execution-custom-wake', task_id: 'task-custom-wake', state: 'CREATED' } } : { no_work: true },
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
    takeTask: async ({ candidates }) => candidates.length ? { task: { task_id: 'task-woken' }, execution: { execution_id: 'execution-woken', task_id: 'task-woken', state: 'CREATED' } } : { no_work: true },
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

test('IdentityTaskLoop stop aborts a taken Runtime handoff and fences the take', async () => {
  let fenced = 0;
  const events = [];
  const daemon = new IdentityTaskLoop({
    coreId: 'core-abort',
    listEligibleTasks: () => [{ task_id: 'task-abort' }],
    takeTask: async () => ({ task: { task_id: 'task-abort' }, execution: { execution_id: 'execution-abort', task_id: 'task-abort', state: 'CREATED' } }),
    runtime: {
      startTakenExecution: async (execution) => ({ execution }),
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

test('a Bot that loses a tool-level take race can rescan and execute other work', async () => {
  let selections = 0;
  const loop = new IdentityTaskLoop({
    coreId: 'core-conflict',
    listEligibleTasks: () => [{ task_id: 'remaining-work' }],
    takeTask: async () => ++selections === 1
      ? { take_failed: true, error: { code: 'CONFLICT', message: 'another Bot owns this Task' } }
      : { task: { task_id: 'remaining-work' }, execution: { execution_id: 'next-execution', task_id: 'remaining-work' } },
    runExecution: async (take) => ({ execution: { ...take.execution, state: 'SUCCEEDED' } }),
  });
  const result = await loop.runOnce();
  assert.equal(result.disposition, 'completed');
  assert.equal(result.take.execution.execution_id, 'next-execution');
  assert.equal(loop.snapshot().take_conflict_count, 1);
  assert.equal(loop.snapshot().take_failure_count, 0);
});


test('four Cores discover a zero-Task Mission and hold distinct proposed Tasks concurrently', async () => {
  const service = new TaskService();
  const mission = service.dispatch('mission.create', { mission_id: 'mission-discovery', goal: 'Build a CSV tool' }, makeEnvelope({ actorRef: 'operator:test' })).mission;
  const discoveryGate = deferred();
  const executionGate = deferred();
  const entered = [];
  const active = [];
  const responsibilities = ['filter rows', 'group statistics', 'JSON output', 'verify sample data'];
  const loops = responsibilities.map((responsibility, index) => new IdentityTaskLoop({
    coreId: `core-${index + 1}`,
    taskService: service,
    listEligibleTasks: () => service.listEligibleTasks({ missionId: mission.mission_id }),
    takeTask: async ({ candidates }) => {
      entered.push({ index, candidates });
      await discoveryGate.promise;
      const actorRef = `bot-discovery-${index}`;
      const task = service.dispatch('task.create', {
        mission_id: mission.mission_id, summary: `Implement ${responsibility} independently of other CSV features.`, goal: responsibility,
        expected_output: `Reusable ${responsibility} result`, acceptance_conditions: ['Documented independently testable result'],
      }, makeEnvelope({ actorRef })).task;
      return service.takeTask(task.task_id, { owner_ref: actorRef, core_id: `core-${index + 1}`, take_key: `take-${index}`, workspace_mode: 'clean' });
    },
    runExecution: async (take) => {
      active.push(take);
      await executionGate.promise;
      return { execution: take.execution };
    },
  }));
  const running = loops.map(loop => loop.runOnce());
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(entered.length, 4, 'every Core enters discovery even before the first Task exists');
    assert.ok(entered.every(item => item.candidates.length === 0));
    discoveryGate.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(active.length, 4, JSON.stringify(loops.map(loop => loop.snapshot().last_error)));
    assert.equal(new Set(active.map(take => take.task.task_id)).size, 4);
    assert.equal(active.flatMap(take => service.listExecutions(take.task.task_id, { includeTerminal: false })).length, 4);
  } finally {
    discoveryGate.resolve(); executionGate.resolve();
    await Promise.allSettled(running);
    service.close();
  }
  assert.ok((await Promise.all(running)).every(result => result.disposition === 'completed'));
});

test('a bounded discovery page does not reject a newly proposed Task already accepted by Task Service', async () => {
  const service = new TaskService();
  const mission = service.dispatch('mission.create', { mission_id: 'mission-other-work', goal: 'Independent CSV features' }, makeEnvelope({ actorRef: 'operator:test' })).mission;
  const create = (summary) => service.dispatch('task.create', { mission_id: mission.mission_id, summary, goal: summary, expected_output: 'Independent reusable result', acceptance_conditions: ['Verify the stated result'] }, makeEnvelope({ actorRef: 'bot:discover' })).task;
  create('Review the CSV output while other work identifies input edge cases');
  let chosen;
  const loop = new IdentityTaskLoop({
    coreId: 'core-discover', taskService: service,
    listEligibleTasks: () => service.listEligibleTasks({ missionId: mission.mission_id, limit: 1 }),
    takeTask: () => {
      chosen = create('Investigate malformed CSV inputs without duplicating output review');
      return service.takeTask(chosen.task_id, { owner_ref: 'bot:discover', core_id: 'core-discover', take_key: 'new-local-work', workspace_mode: 'clean' });
    },
    runExecution: async (take) => ({ execution: take.execution }),
  });
  try {
    const result = await loop.runOnce();
    assert.equal(result.disposition, 'completed');
    assert.equal(result.take.task.task_id, chosen.task_id);
    assert.equal(loop.snapshot().take_count, 1);
  } finally { service.close(); }
});

test('no-work discovery backoff permits a public-state signal to rearm it early', async () => {
  let discoveries = 0;
  const loop = new IdentityTaskLoop({
    coreId: 'core-no-work',
    listEligibleTasks: () => [],
    takeTask: async () => { discoveries += 1; return { no_work: true }; },
  });
  assert.equal((await loop.runOnce()).disposition, 'idle');
  assert.equal(loop.snapshot().take_failure_count, 0);
  await loop.runOnce({ reason: 'fallback-timer' });
  assert.equal(discoveries, 1, 'early polling must not bypass the discovery backoff');
  loop.notify('material_published');
  assert.equal((await loop.runOnce()).disposition, 'idle');
  assert.equal(discoveries, 2, 'new public information allows discovery even with no eligible Task');
});

test('each Core honors its first discovery offset without delaying replacement discovery', async () => {
  let at = 1000;
  const attempted = [];
  const loops = [1, 2, 3, 4].map(index => new IdentityTaskLoop({
    coreId: `core-${index}`,
    firstDiscoveryAt: at + (index - 1) * 60_000,
    now: () => at,
    listEligibleTasks: () => [],
    takeTask: () => { attempted.push(index); return { take_deferred: true }; },
  }));
  for (const [index, loop] of loops.entries()) {
    at = 1000 + index * 60_000;
    await loop.runOnce();
    if (loops[index + 1]) {
      const delayed = loops[index + 1];
      delayed.notify('material_published');
      assert.equal((await delayed.runOnce()).reason, 'initial_stagger');
    }
    assert.deepEqual(attempted, [1, 2, 3, 4].slice(0, index + 1));
  }
  await loops[3].runOnce();
  assert.deepEqual(attempted, [1, 2, 3, 4, 4]);
});

test('stopping an identity loop cancels its delayed first discovery', async () => {
  const loop = new IdentityTaskLoop({ coreId: 'core-delayed', firstDiscoveryAt: Date.now() + 60_000,
    listEligibleTasks: () => assert.fail('discovery must wait'), takeTask: () => assert.fail('no Bot may start'),
  });
  const running = loop.run();
  await new Promise(resolve => setImmediate(resolve));
  loop.stop();
  assert.equal((await running).disposition, 'stopped');
});

test('a public change during discovery is not lost when the Bot reports no work', async () => {
  let discoveries = 0;
  const loop = new IdentityTaskLoop({
    coreId: 'core-discovery-signal', listEligibleTasks: () => [],
    takeTask: async () => {
      discoveries += 1;
      if (discoveries === 1) loop.notify('material_published');
      return { no_work: true };
    },
  });
  await loop.runOnce();
  await loop.runOnce();
  assert.equal(discoveries, 2);
});


test('a real Bridge tool rejection preserves the take conflict for Core rescan', async () => {
  const service = new TaskService();
  const mission = service.dispatch('mission.create', { mission_id: 'mission-bridge-race', goal: 'Compare independent routes' }, makeEnvelope({ actorRef: 'operator:test' })).mission;
  const task = service.dispatch('task.create', { mission_id: mission.mission_id, summary: 'Verify one existing route without duplicating another responsibility', expected_output: 'Verified route', acceptance_conditions: ['Evidence is published'] }, makeEnvelope({ actorRef: 'bot:first' })).task;
  service.takeTask(task.task_id, { owner_ref: 'bot:winner', core_id: 'core-winner', take_key: 'winner', workspace_mode: 'clean' });
  const bridge = new ServicesBridge({ taskService: service, contextService: {}, runtime: {}, actorRef: 'bot:loser', coreId: 'core-loser' });
  const loop = new IdentityTaskLoop({
    coreId: 'core-loser', taskService: service, maxTakeRescans: 0,
    listEligibleTasks: () => [task],
    takeTask: async () => {
      bridge.beginTakeAttempt();
      await assert.rejects(bridge.call({ operation: 'task_take', operation_id: 'loser-tool-call', payload: { task_id: task.task_id, take_key: 'loser' } }), { code: 'CONFLICT' });
      return { take_failed: true, error: bridge.lastTakeOutcome };
    },
  });
  try {
    assert.equal((await loop.runOnce()).disposition, 'take_conflict');
    assert.equal(loop.snapshot().take_failure_count, 0);
    assert.equal(bridge.lastTakeOutcome.operation_id, 'loser-tool-call');
    assert.equal(service.listExecutions(task.task_id, { includeTerminal: false }).length, 1);
  } finally { service.close(); }
});

test('private checkpoints do not wake no-work discovery but public Materials do', async () => {
  let discoveries = 0;
  const loop = new IdentityTaskLoop({
    coreId: 'core-public-changes', listEligibleTasks: () => [],
    takeTask: async () => { discoveries += 1; return { no_work: true }; },
  });
  await loop.runOnce();
  for (const operation of ['save_checkpoint', 'save_workspace_revision', 'execution_progress', 'task_feedback']) {
    loop.notifyPublicChange({ operation, changed: true });
    await loop.runOnce();
  }
  assert.equal(discoveries, 1);
  loop.notifyPublicChange({ kind: 'material_published', operation: 'publish_material', changed: true });
  await loop.runOnce();
  assert.equal(discoveries, 2);
});

test('a failed Runtime binding remains a failed take and releases the provisional Task ownership', async () => {
  const service = new TaskService();
  const mission = service.dispatch('mission.create', { mission_id: 'mission-bind-failure', goal: 'Investigate a route' }, makeEnvelope({ actorRef: 'operator:test' })).mission;
  const task = service.dispatch('task.create', { mission_id: mission.mission_id, summary: 'Investigate an independent route with a reproducible written result', expected_output: 'Route note', acceptance_conditions: ['Evidence is published'] }, makeEnvelope({ actorRef: 'bot:test' })).task;
  const bridge = new ServicesBridge({
    taskService: service, contextService: {}, runtime: {}, actorRef: 'bot:test', coreId: 'core-bind',
    onTake: async () => { const error = new Error('provider preparation failed'); error.code = 'SERVICE_UNAVAILABLE'; throw error; },
  });
  try {
    await assert.rejects(bridge.call({ operation: 'task_take', payload: { task_id: task.task_id, take_key: 'bind-failure' } }), { code: 'SERVICE_UNAVAILABLE' });
    assert.equal(bridge.lastTakeOutcome.ok, false);
    assert.equal(bridge.lastTakeOutcome.code, 'SERVICE_UNAVAILABLE');
    assert.equal(bridge.executionId, null);
    assert.equal(service.listExecutions(task.task_id, { includeTerminal: false }).length, 0);
  } finally { service.close(); }
});
