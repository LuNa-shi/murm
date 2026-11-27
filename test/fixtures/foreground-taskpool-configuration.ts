import { registerHooks } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTaskPoolStores } from './taskpool-task-stores.js';
import { controls, transport } from './taskpool-controller-backend.js';

// Only provider execution is controlled. Core, authenticated Bridge, Agent CLI,
// TaskPool preparation, directed input and domain/physical close run normally.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) {
    return { url: new URL('./taskpool-controller-backend.js', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
transport.reset(); controls.credentials.clear(); controls.stopError = null; controls.destroyError = null;
transport.next = function accept(id) { transport.confirm(id, 'started'); transport.next = accept; };
const outputDir = process.env.FOREGROUND_TEST_OUTPUT;
const stores = await createTaskPoolStores(outputDir, { persistent: true });
export default { mode: 'taskpool', timeoutMs: 15_000, options: {
  taskService: stores.tasks, contextService: stores.context, missionWorkspace: stores.workspace,
  workspaceManager: stores.manager, missionId: stores.missionId, workspaceId: stores.workspaceId,
  outputDir, sandbox: {}, model: 'default', image: 'fixture', capacity: 1,
  deadlineAt: Date.now() + 15_000, closeTimeoutMs: 1000,
  controller: { automaticContinuation: false, async beforeInitialDispatch({ agentIds }) {
    const agentId = agentIds[0];
    const credentials = controls.credentials.get(agentId);
    const env = { ...process.env, ...credentials.environment, ...credentials.secretEnvironment };
    const bridge = new URL(env.MURM_BRIDGE_URL); bridge.hostname = '127.0.0.1'; env.MURM_BRIDGE_URL = bridge.origin;
    const { stdout } = await promisify(execFile)(process.execPath, [new URL('../../scripts/swarm.js', import.meta.url).pathname,
      'task', 'take', stores.task.task_id, '--request-id', 'fixture-take'], { env, timeout: 5000 });
    const taken = JSON.parse(stdout);
    await writeFile(join(outputDir, 'fixture-binding.json'), JSON.stringify({ taskId: stores.task.task_id, agentId, executionId: taken.execution.execution_id }));
  } },
} };
