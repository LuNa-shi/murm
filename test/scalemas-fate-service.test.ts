import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { invokeService, ServiceRegistry, snapshotServiceRegistry } from '@swarmenv/core/services';
import { createFateTaskService } from '../examples/scalemas-environment/fate-service.js';

test('a peer gets ten independent Lean trials, retries a stable one for free, and freezes only its final submitted proof', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fate-task-'));
  const services = new ServiceRegistry(), submitted = [];
  let calls = 0;
  const task = createFateTaskService({
    path: join(directory, 'submissions.sqlite'), services,
    authorize(caller) {
      if (caller.runtimeId !== 'run' || caller.botId !== 'a') throw Object.assign(new Error('forbidden'), { code: 'NOT_ALLOWED' });
    },
    countOperation() {},
    remainingMs: () => 20_000,
    signal: new AbortController().signal,
    problemAddress: 'fate:1',
    search: async () => [],
    check: async () => ({ status: 'rejected', code: `LEAN_${++calls}`, elapsedMs: 0 }),
    validateReferences(caller, _rationale, refs) {
      assert.equal(caller, 'a');
      assert.deepEqual(refs, ['fate:1']);
    },
    onFinish: id => submitted.push(id),
  });
  t.after(async () => { task.close(); await rm(directory, { recursive: true, force: true }); });
  const registration = snapshotServiceRegistry(services).get('fate');
  const call = (operation, input, id) => invokeService(registration, { operation, input, envelope: { operation_id: id },
    caller: { botId: 'a', runtimeId: 'run', profile: 'peer' } });
  const first = { proof: 'by trivial' };
  await Promise.all([call('check_lean', first, 'check-0'), call('check_lean', first, 'check-0')]);
  await assert.rejects(call('check_lean', { proof: 'by simp' }, 'check-0'), { code: 'CONFLICT' });
  for (let i = 1; i < 10; ++i) await call('check_lean', first, `check-${i}`);
  await assert.rejects(call('check_lean', first, 'check-10'), { code: 'CHECK_LIMIT' });
  assert.equal(calls, 10);
  assert.equal(task.snapshot().candidates.length, 0);
  const input = { proof: first.proof, rationale: 'fate:1 supplies the goal', refs: ['fate:1'], finish: false };
  const draft = await call('submit', input, 'draft');
  const finish = { ...input, proof: 'by simp', finish: true };
  const final = await call('submit', finish, 'final');
  assert.deepEqual(await call('submit', finish, 'final'), final);
  await assert.rejects(call('submit', input, 'late'), { code: 'NOT_ALLOWED' });
  assert.notEqual(final.sha256, draft.sha256);
  assert.deepEqual(submitted, ['a']);
  assert.deepEqual(task.snapshot().candidates.map(({ proof, sha256 }) => [proof, sha256]), [[finish.proof, final.sha256]]);
});
