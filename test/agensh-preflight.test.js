import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../src/core/index.js';
import { createPiOpenSandboxBackend } from '../src/core/backends/pi-opensandbox.js';
import { createPeerProfile } from '../src/environments/agensh/index.js';
import { createAgenshServices } from '../src/environments/agensh/services.js';
import { createBoardLauncher } from '../src/environments/agensh/board-process.js';

test('exact Agensh Profile and Services assemble actual Runtime/Bridge/gateway with no sandbox or model call', async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'agensh-preflight-')); t.after(() => rm(outputDir, { recursive: true, force: true }));
  const facilities = { runId: 'preflight', repositoryUrl: 'http://192.0.2.1:3000/owner/repo.git', repository: { owner: 'owner', name: 'repo' }, issueNumber: 1,
    channelId: 'channel', boardId: 'board', endpoints: { gitea: 'http://192.0.2.1:3000', message: 'http://127.0.0.1:1', board: 'http://127.0.0.1:1' },
    peer: { gitea: { binding: 'git', accountId: 'git-account', username: 'peer', token: 'git-private' }, message: { binding: 'message', accountId: 'mm-account', token: 'mm-private' }, board: { binding: 'board', workerId: 'worker' } } };
  const { services } = createAgenshServices(facilities);
  const profile = createPeerProfile({ image: 'fixture-no-allocation', facilities });
  const runtime = await createRuntime({ outputDir, maxBots: 1, services, profiles: { peer: profile }, backend: createPiOpenSandboxBackend({
    sandbox: { lifecycleBaseUrl: 'http://127.0.0.1:1/v1' }, bridge: { host: '127.0.0.1', publicUrl: 'http://192.0.2.1:{port}' }, modelGateway: { host: '127.0.0.1', advertiseHost: '192.0.2.1' },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } }, isolation: { network: 'local-docker', disk: { bytes: 128 * 1024 ** 2, inodes: 8192 } },
  }) });
  const closed = await runtime.close(); assert.equal(closed.cleanup, 'complete'); assert.deepEqual(closed.bots, []);
  const configuration = JSON.parse(await readFile(join(outputDir, runtime.id, 'runtime.json'), 'utf8')).config;
  assert.equal(configuration.models.default.model, 'k3'); assert.equal(configuration.profiles.peer.services['agensh-context'].length, 4);
  assert.deepEqual(configuration.services.map(service => service.id).sort(), ['agensh-context', 'bot', 'gitea', 'message']);
  assert.equal(configuration.profiles.peer.services.bot, undefined);
  assert.equal(typeof createBoardLauncher({ sourceDirectory: '/unused-pinned-native-board', mysqlDsn: 'mysql://agensh:private@127.0.0.1/board', origin: 'http://127.0.0.1:8660' }), 'function');
  assert.throws(() => createBoardLauncher({ sourceDirectory: '/unused', mysqlDsn: 'private', origin: 'http://user:private@127.0.0.1:8660' }));
});
