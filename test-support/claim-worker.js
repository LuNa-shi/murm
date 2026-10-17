import { parentPort, workerData } from 'node:worker_threads';
import { ServicesSDK, TaskService } from '../src/index.js';

const service = new TaskService(workerData.databasePath);
const sdk = new ServicesSDK(service, {
  actorRef: workerData.actorRef,
  taskId: workerData.taskId,
  specVersion: workerData.specVersion,
  stateVersion: workerData.stateVersion,
});
try {
  const result = sdk.claim({
    claim_key: workerData.claimKey,
    owner_ref: workerData.actorRef,
    initial_prompt: 'concurrent claim',
    initial_context_ref: `context://${workerData.claimKey}`,
    input_snapshot_hash: workerData.claimKey,
    input_material_refs: [],
  }, { operationId: workerData.operationId });
  parentPort.postMessage({ ok: true, executionId: result.execution.execution_id });
} catch (error) {
  parentPort.postMessage({ ok: false, code: error.code, message: error.message });
} finally {
  service.close();
}
