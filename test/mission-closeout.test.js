import assert from 'node:assert/strict';
import test from 'node:test';
import { beginMissionCloseout, stopBenchmarkRuntime } from '../src/benchmark/putnam-runner.js';

function fixture() {
  const executions = ['first', 'second'].map(id => ({ execution_id: id, task_id: id, owner_ref: id,
    state: 'RUNNING', state_version: 1, spec_version: 1, fencing_version: 1 }));
  let stops = 0;
  let wakes = 0;
  const state = { missionId: 'mission', runDeadlineAt: Date.now() + 60_000, missionCloseoutMs: 20_000,
    controller: { stop: async () => { stops++; } }, identityLoops: [], cores: [], cleanupErrors: [],
    requestIdentityWake: () => { wakes++; }, taskService: {
      getBot: () => ({ core_id: 'core' }), getTask: () => ({ mission_id: 'mission' }), listActiveExecutions: () => executions,
      recordHandoffReminder: (payload, envelope) => { executions.find(row => row.execution_id === envelope.execution_id).handoff_reminder_sent_at = payload.reminded_at; },
    } };
  const submission = { submission_id: 'accepted', actor_ref: 'first', finished_at: new Date().toISOString() };
  return { state, submission, executions, stops: () => stops, wakes: () => wakes };
}

test('acceptance callback retry completes partial reminders without extending closeout or repeating stop', async () => {
  const f = fixture();
  const remind = f.state.taskService.recordHandoffReminder;
  let fail = true;
  const calls = [];
  f.state.taskService.recordHandoffReminder = (payload, envelope) => {
    calls.push(envelope.execution_id);
    if (fail && envelope.execution_id === 'second') throw new Error('temporary notification write failure');
    remind(payload, envelope);
  };
  assert.throws(() => beginMissionCloseout(f.state, f.submission), /temporary/);
  const deadline = f.state.missionCloseoutDeadline;
  assert.equal(f.wakes(), 0);
  fail = false;
  beginMissionCloseout(f.state, f.submission);
  await Promise.all(f.state.backgroundStopPromises);
  assert.deepEqual(calls, ['first', 'second', 'second']);
  assert.equal(f.state.missionCloseoutDeadline, deadline);
  assert.equal(f.stops(), 1);
  assert.equal(f.wakes(), 1);
});

test('closeout retains original controller failure for cleanup without unhandled rejection', async () => {
  const f = fixture();
  let stops = 0;
  f.state.controller.stop = async () => { if (++stops === 1) throw Object.assign(new Error('stop failed'), { code: 'PASS_STOP_FAILED' }); };
  beginMissionCloseout(f.state, f.submission);
  // A rejected callback Promise is observed before the later cleanup join.
  await new Promise(resolve => setImmediate(resolve));
  await stopBenchmarkRuntime(f.state, { cleanupGraceMs: 100 });
  assert.ok(f.state.cleanupErrors.some(row => row.code === 'PASS_STOP_FAILED'));
});

test('closeout only grants reminders to activated work and waits for its original stop', async () => {
  const f = fixture();
  f.executions[1].state = 'CREATED';
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let stops = 0;
  f.state.controller.stop = () => ++stops === 1 ? held : Promise.resolve();
  beginMissionCloseout(f.state, f.submission);
  assert.ok(f.executions[0].handoff_reminder_sent_at);
  assert.equal(f.executions[1].handoff_reminder_sent_at, undefined);
  await stopBenchmarkRuntime(f.state, { cleanupGraceMs: 20 });
  assert.ok(f.state.cleanupErrors.some(row => row.code === 'BACKGROUND_STOP_TIMEOUT'));
  let settled = false;
  f.state.cleanupPromise.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await f.state.cleanupPromise;
});
