import { runtimeSettings } from './fixtures/core-runtime-settings.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLifecycleProvider } from './fixtures/core-lifecycle-provider.js';

test('Environment admits one real Core peer with bindings, native Git secret and required collection before work', async t => {
  let start; const provider = await createLifecycleProvider(t, { onStart: body => { start = body; }, onCollect: () => ({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Fixture export pending' } }) });
  const { createPeerMeshHarness } = await import('../examples/peermesh/harness/index.js');
  provider.allowDeletion();
  const outputDir = await mkdtemp(join(tmpdir(), 'agensh-harness-')); t.after(() => rm(outputDir, { recursive: true, force: true }));
  let facilityClosed = false;
  const harness = await createPeerMeshHarness({ runId: 'fixture', image: 'murm-agent:test', outputDir, model: 'default', exportLimit: 1024 * 1024,
    ...runtimeSettings({ sandbox: { lifecycleBaseUrl: provider.url, apiKey: provider.apiKey, egressMode: 'dns+nft' }, bridge: { host: '127.0.0.1', publicUrl: 'http://172.17.0.1:{port}' },
      modelGateway: { host: '127.0.0.1', advertiseHost: '172.17.0.1' }, models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } },
      isolation: { network: 'api' } }),
    prepare: async ({ resources }) => { resources.own({ kind: 'board-process', id: 'board-fixture', close: () => { facilityClosed = true; } }); return {
      runId: 'fixture', repository: { owner: 'owner', name: 'repo' }, repositoryUrl: 'http://172.17.0.1:3000/owner/repo.git', channelId: 'channel', boardId: 'board', issueNumber: 1,
      endpoints: { gitea: 'http://172.17.0.1:3000', message: 'http://127.0.0.1:1', board: 'http://127.0.0.1:1' },
      peer: { gitea: { binding: 'git', accountId: '101', username: 'peer', token: 'private-git-marker' }, message: { binding: 'message', accountId: 'mm-peer', token: 'private-mm-marker' }, board: { binding: 'board', workerId: 'worker-fixture' } } }; },
  });
  assert.equal(harness.peer.status, 'idle'); assert.equal(provider.allocations(), 1);
  const summary = harness.snapshot();
  assert.equal(summary.identities.agentId, harness.peer.id);
  assert.notEqual(summary.identities.agentId, summary.identities.board.workerId);
  assert.equal(JSON.stringify(summary).includes('private-'), false);
  assert.deepEqual(harness.redact({ token: 'private-git-marker', message: 'private-mm-marker' }), { token: '[redacted]', message: '[redacted]' });
  assert.ok(JSON.stringify(start).includes('private-git-marker'));
  const receipt = await harness.close({ timeoutMs: 200 });
  assert.equal(receipt.cleanup, 'pending'); assert.equal(receipt.agents[0].execution, 'stopped');
  assert.equal(facilityClosed, false, 'required export pending preserves owned dependencies');
  await assert.rejects(harness.runInput('later', { requestId: 'later', timeoutMs: 50 }), { code: 'HARNESS_CLOSING' });
});

test('partial facility startup closes only registered owned resources and retains a sanitized pending ledger', async () => {
  const { createPeerMeshHarness } = await import('../examples/peermesh/harness/index.js');
  const attempts = [];
  await assert.rejects(createPeerMeshHarness({ runId: 'partial', image: 'unused', exportLimit: 1024, prepare: async ({ resources }) => {
    resources.own({ kind: 'channel', id: 'shared', retained: true });
    resources.own({ kind: 'account', id: 'owned', close: () => { attempts.push('owned'); throw new Error('private credential'); } });
    throw new Error('private credential');
  } }), error => {
    assert.equal(error.cleanup, 'pending'); assert.equal(JSON.stringify(error).includes('private credential'), false);
    assert.ok(JSON.stringify(error.details).includes('owned')); return true;
  });
  assert.deepEqual(attempts, ['owned']);
});
