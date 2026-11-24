import { registerHooks } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFlatTaskStores } from './flat-task-stores.js';
import { controls, transport } from './flat-controller-backend.js';

// Only provider execution is controlled. Core, authenticated Bridge, Bot CLI,
// Flat preparation, directed input and domain/physical close run normally.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) {
    return { url: new URL('./flat-controller-backend.js', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
transport.reset(); controls.credentials.clear(); controls.stopError = null; controls.destroyError = null;
transport.next = function accept(id) { transport.confirm(id, 'started'); transport.next = accept; };
const outputDir = process.env.FOREGROUND_TEST_OUTPUT;
const stores = await createFlatTaskStores(outputDir, { persistent: true });
export default { mode: 'flat', timeoutMs: 15_000, options: {
  taskService: stores.tasks, contextService: stores.context, missionWorkspace: stores.workspace,
  workspaceManager: stores.manager, missionId: stores.missionId, workspaceId: stores.workspaceId,
  outputDir, backend: {}, model: 'default', image: 'fixture', capacity: 1,
  deadlineAt: Date.now() + 15_000, closeTimeoutMs: 1000,
  snapshotProject: async () => {
    await writeFile(join(outputDir, 'unexpected-snapshot'), 'called');
    throw new Error('This controlled feedback fixture must never capture a live Workspace');
  },
  controller: { automaticContinuation: false, async beforeInitialDispatch({ botIds }) {
    const botId = botIds[0];
    const credentials = controls.credentials.get(botId);
    const env = { ...process.env, ...credentials.environment, ...credentials.secretEnvironment };
    const bridge = new URL(env.SWARMENV_BRIDGE_URL); bridge.hostname = '127.0.0.1'; env.SWARMENV_BRIDGE_URL = bridge.origin;
    const { stdout } = await promisify(execFile)(process.execPath, [new URL('../../scripts/swarm.mjs', import.meta.url).pathname,
      'task', 'take', stores.task.task_id, '--request-id', 'fixture-take'], { env, timeout: 5000 });
    const taken = JSON.parse(stdout);
    await writeFile(join(outputDir, 'fixture-binding.json'), JSON.stringify({ taskId: stores.task.task_id, botId, executionId: taken.execution.execution_id }));
  } },
} };
