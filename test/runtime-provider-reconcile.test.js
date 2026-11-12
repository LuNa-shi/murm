import assert from 'node:assert/strict';
import test from 'node:test';
import { Runtime } from '../src/runtime/runtime.js';

test('Runtime reconciles provider sandboxes from durable active Executions', async () => {
  const calls = [];
  const events = [];
  const taskService = {
    listActiveExecutions: () => [{ execution_id: 'execution-a' }, { execution_id: 'execution-b' }],
    subscribeExecutionState: () => () => {},
    subscribeNotifications: () => () => {},
  };
  const runtime = new Runtime({
    taskService,
    workspaceManager: {},
    agentAdapter: {},
    sandboxManager: {
      reconcileExecutions: async (input) => {
        calls.push(input);
        return { provider: 'opensandbox', adopted: [{ execution_id: 'execution-a', sandbox_id: 'sandbox-a' }] };
      },
    },
    logger: { append: (event) => events.push(event) },
  });
  try {
    const result = await runtime.reconcileProviderExecutions();
    assert.deepEqual(calls, [{ executionIds: ['execution-a', 'execution-b'] }]);
    assert.deepEqual(result.adopted, [{ execution_id: 'execution-a', sandbox_id: 'sandbox-a' }]);
    assert.deepEqual(events, [{
      event: 'runtime.provider_reconciled',
      provider: 'opensandbox',
      requested_execution_count: 2,
      adopted_execution_count: 1,
    }]);
  } finally {
    await runtime.shutdown();
  }
});
