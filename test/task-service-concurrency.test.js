import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { ServicesSDK, TaskService } from '../src/index.js';

function runWorker(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../test-support/claim-worker.js', import.meta.url), { workerData });
    worker.once('message', resolve);
    worker.once('error', reject);
  });
}

test('two worker threads racing to claim one Task produce one active Execution', async () => {
  const directory = await mkdtemp('/tmp/swarmenv-claim-');
  const databasePath = join(directory, 'swarmenv.sqlite');
  const service = new TaskService(databasePath);
  const sdk = new ServicesSDK(service, { actorRef: 'owner:root' });
  const task = sdk.proposeTask({
    task_type: 'proof', goal: 'race', expected_output: 'artifact', acceptance_conditions: { fixture: true }, owner_ref: 'owner:root',
  }, { operationId: 'race-proposal' }).task;
  service.close();

  const results = await Promise.all([
    runWorker({ databasePath, taskId: task.task_id, specVersion: 1, stateVersion: 0, actorRef: 'runtime:one', claimKey: 'race-claim-one', operationId: 'race-op-one' }),
    runWorker({ databasePath, taskId: task.task_id, specVersion: 1, stateVersion: 0, actorRef: 'runtime:two', claimKey: 'race-claim-two', operationId: 'race-op-two' }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok).length, 1);

  const audit = new TaskService(databasePath);
  assert.equal(audit.db.prepare("SELECT COUNT(*) AS count FROM executions WHERE task_id = ? AND state IN ('CREATED','RUNNING','WAITING')").get(task.task_id).count, 1);
  audit.close();
  await rm(directory, { recursive: true, force: true });
});
