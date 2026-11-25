import { registerHooks } from 'node:module';
import { transport } from './core-bot-service-backend.js';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return { url: new URL('./agensh-team-backend.js', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
transport.reset(); transport.collectable = true;
if (process.env.FOREGROUND_TEST_CLEANUP_FAILURE === 'stop-execution') {
  transport.onStop = async () => { throw Object.assign(new Error('PRIVATE_STOP_FAILURE'), { code: 'FIXTURE_STOP_FAILED' }); };
}
if (process.env.FOREGROUND_TEST_CLEANUP_FAILURE === 'collect-artifacts') {
  transport.onCollect = async () => { throw Object.assign(new Error('PRIVATE_EXPORT_FAILURE'), { code: 'FIXTURE_EXPORT_FAILED' }); };
}
transport.next = function settle(id) {
  if (process.env.FOREGROUND_TEST_HOLD === '1') return;
  const submission = transport.submissions.get(id);
  transport.spawns.get(submission.botId).onEvent({ type: 'settled', outcome: 'completed', output: 'PRIVATE_MODEL_OUTPUT' });
  transport.next = settle;
};
const peers = ['a', 'b'].map(key => ({ key, branch: `branch-${key}`,
  gitea: { username: key, binding: `git-${key}`, accountId: key, token: `private-git-${key}` },
  message: { binding: `mm-${key}`, accountId: key, token: `private-mm-${key}` }, board: { binding: `board-${key}`, workerId: `worker-${key}` } }));
export default { mode: 'peermesh', timeoutMs: 5000, options: {
  runId: 'foreground', image: 'fixture', outputDir: process.env.FOREGROUND_TEST_OUTPUT, backend: {}, closeTimeoutMs: 1000,
  prepare: async () => ({ runId: 'foreground', repository: { owner: 'owner', name: 'repo' }, repositoryUrl: 'http://172.17.0.1:3000/owner/repo.git', channelId: 'channel', boardId: 'board', issueNumber: 1,
    endpoints: { gitea: 'http://172.17.0.1:3000', message: 'http://127.0.0.1:3001', board: 'http://127.0.0.1:3002' }, peers }),
  router: { workTimeoutMs: 5000, turnTimeoutMs: 1000, readContext: async () => 'PRIVATE_CONTEXT', subscribe: async () => ({ ready: true, stop: async () => {} }) },
} };
