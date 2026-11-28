/**
 * Run with a root-SDK configuration module exporting CreateRuntimeOptions.
 * node dist/examples/agent-session.js /absolute/config.mjs worker 'Your prompt'
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime, type CreateRuntimeOptions, type RuntimeEvent } from '@luna-shi/murm';

const [configurationPath, profile, prompt] = process.argv.slice(2);
if (!configurationPath || !profile || !prompt) throw new Error('Expected configuration module path, Profile name and prompt');
const configuration = (await import(pathToFileURL(resolve(configurationPath)).href)).default as CreateRuntimeOptions;
if (!configuration?.profiles?.[profile]) throw new Error('The configuration must export Runtime options containing the selected Profile');
const runtime = await createRuntime({
  ...configuration,
  hooks: { beforeCompact: {
    timeoutMs: 10000,
    handler(request) {
      if (request.signal.aborted) return 'cancel';
      return request.reason !== 'manual' && request.successfulAutoCompactions >= 3 ? 'stop' : 'allow';
    },
  } },
});
let unsubscribe = () => {};
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  const agent = await runtime.spawn({ profile, requestId: 'example-spawn', session: {
    compaction: { enabled: true }, retry: { enabled: true }, steeringMode: 'one-at-a-time',
  } });
  await runtime.session.configure(agent.id, { followUpMode: 'one-at-a-time' }, { requestId: 'example-configure' });
  await runtime.send(agent.id, {
    type: 'context', customType: 'harness-reference', content: 'Preserve verifiable results in your working directory.',
    display: false, details: { source: 'session-example' },
  }, { requestId: 'example-append', delivery: 'append' });
  await runtime.send(agent.id, {
    type: 'context', customType: 'next-task-reference', content: 'Explain the evidence supporting your final result.', display: false,
  }, { requestId: 'example-next-turn', delivery: 'nextTurn' });
  const settled = new Promise<RuntimeEvent>(resolveEvent => {
    unsubscribe = runtime.onEvent(event => {
      process.stdout.write(JSON.stringify(event) + '\n');
      if ('agentId' in event && event.agentId === agent.id && ['settled', 'exit'].includes(event.type)) resolveEvent(event);
    });
    timer = setTimeout(() => resolveEvent({ type: 'error', agentId: agent.id, fatal: false,
      error: { code: 'EXAMPLE_TIMEOUT', message: 'The bounded example work period expired', retryable: false } }), 120000);
  });
  const input = await runtime.send(agent.id, prompt, { requestId: 'example-task' });
  process.stdout.write(JSON.stringify({ input }) + '\n');
  if (input.status === 'accepted') await settled;
  if ((await runtime.get(agent.id)).status === 'running') await runtime.interrupt(agent.id, { requestId: 'example-timeout-interrupt' });
  if (['idle', 'running'].includes((await runtime.get(agent.id)).status)) {
    const state = await runtime.session.getState(agent.id);
    const stats = await runtime.session.getStats(agent.id);
    const messages = await runtime.session.getMessages(agent.id, { limit: 25, maxBytes: 32768 });
    process.stdout.write(JSON.stringify({ state, stats, messages }) + '\n');
  }
  const stop = await runtime.stop(agent.id);
  process.stdout.write(JSON.stringify({ stop }) + '\n');
} finally {
  clearTimeout(timer);
  unsubscribe();
  const cleanup = await runtime.close({ timeoutMs: 30000 });
  process.stdout.write(JSON.stringify({ cleanup }) + '\n');
  if (cleanup.cleanup !== 'complete') process.exitCode = 1;
}
