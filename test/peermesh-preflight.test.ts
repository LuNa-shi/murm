import { runtimeSettings } from './fixtures/core-runtime-settings.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/core/index.js';
import { createPeerProfile } from '../src/harnesses/peermesh/index.js';
import { createPeerMeshServices } from '../src/harnesses/peermesh/services.js';
import { createBoardLauncher } from '../src/harnesses/peermesh/board-process.js';
import { execute } from './fixtures/notes-installed-package.js';

test('foreground PeerMesh example validates host configuration without starting facilities', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agensh-foreground-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = new URL('../examples/peermesh/config.js', import.meta.url);
  const cli = new URL('../scripts/run-harness.js', import.meta.url);
  const backendModule = new URL('../src/core/opensandbox-backend.js', import.meta.url);
  const env = { PATH: process.env.PATH };
  const options = { cwd: directory, env, timeout: 5_000 };
  const command = [fileURLToPath(cli), '--config', fileURLToPath(config)];
  await assert.rejects(execute(process.execPath, command, options), error => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.deepEqual(JSON.parse(error.stderr), { code: 'PEERMESH_CONFIG_RUN_ID_REQUIRED' });
    return true;
  });

  const projectFile = join(directory, 'project.json');
  await writeFile(projectFile, JSON.stringify({ title: 'Example project', body: 'Implement the target together', durationMs: 3_600_000 }));
  const values = {
    PROJECT_FILE: projectFile, PEERS: '4',
    RUN_ID: 'local-example', IMAGE: 'sha256:immutable-fixture', MODEL_URL: 'http://127.0.0.1:1/v1/responses',
    MODEL_TOKEN: 'private-model-marker', GITEA_ORIGIN: 'http://192.0.2.1:3000', GITEA_OWNER: 'fixture-owner',
    GITEA_TOKEN: 'private-gitea-marker', MATTERMOST_ORIGIN: 'http://127.0.0.1:1', MATTERMOST_TEAM_ID: 'fixture-team',
    MATTERMOST_TOKEN: 'private-mattermost-marker', BOARD_SOURCE: 'unused-board', BOARD_MYSQL_DSN: 'private-DSN-marker',
  };
  for (const [name, value] of Object.entries(values)) env[`MURM_PEERMESH_${name}`] = value;
  const observed = await execute(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import configuration from ${JSON.stringify(config.href)};
    import { claimOpenSandboxBackend } from ${JSON.stringify(backendModule.href)};
    const { mode, options, timeoutMs } = configuration;
    assert.equal(mode, 'peermesh');
    assert.equal(options.runId, 'local-example');
    assert.equal(options.gitea.owner, 'fixture-owner');
    assert.equal(options.mattermost.teamId, 'fixture-team');
    assert.equal(options.outputDir, './peermesh-runs');
    assert.equal(timeoutMs, 3_720_000);
    assert.equal(options.project.durationMs, 3_600_000);
    assert.deepEqual(options.peerKeys, ['a', 'b', 'c', 'd']);
    assert.equal(typeof options.startBoard, 'function');
    const backend = claimOpenSandboxBackend(options.backend);
    assert.equal(backend.sandbox.timeoutSeconds, 3_750);
  `], options);
  assert.equal(observed.stdout, '');
  assert.deepEqual(await readdir(directory), ['project.json']);
});

test('exact PeerMesh Profile and Services assemble actual Runtime/Bridge/gateway with no sandbox or model call', async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'agensh-preflight-')); t.after(() => rm(outputDir, { recursive: true, force: true }));
  const facilities = { runId: 'preflight', repositoryUrl: 'http://192.0.2.1:3000/owner/repo.git', repository: { owner: 'owner', name: 'repo' }, issueNumber: 1,
    channelId: 'channel', boardId: 'board', endpoints: { gitea: 'http://192.0.2.1:3000', message: 'http://127.0.0.1:1', board: 'http://127.0.0.1:1' },
    peer: { gitea: { binding: 'git', accountId: 'git-account', username: 'peer', token: 'git-private' }, message: { binding: 'message', accountId: 'mm-account', token: 'mm-private' }, board: { binding: 'board', workerId: 'worker' } } };
  const { services } = createPeerMeshServices(facilities);
  const profile = createPeerProfile({ image: 'fixture-no-allocation', facilities });
  const runtime = await createRuntime({ outputDir, maxAgents: 1, services, profiles: { peer: profile }, ...runtimeSettings({
    sandbox: { lifecycleBaseUrl: 'http://127.0.0.1:1/v1' }, bridge: { host: '127.0.0.1', publicUrl: 'http://192.0.2.1:{port}' }, modelGateway: { host: '127.0.0.1', advertiseHost: '192.0.2.1' },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } }, isolation: { network: 'local-docker', disk: { bytes: 128 * 1024 ** 2, inodes: 8192 } },
  }) });
  const closed = await runtime.close(); assert.equal(closed.cleanup, 'complete'); assert.deepEqual(closed.agents, []);
  const configuration = JSON.parse(await readFile(join(outputDir, runtime.id, 'runtime.json'), 'utf8')).config;
  assert.equal(configuration.models.default.model, 'k3'); assert.equal(configuration.profiles.peer.services['peermesh-context'].length, 4);
  assert.deepEqual(configuration.services.map(service => service.id).sort(), ['agent', 'gitea', 'message', 'peermesh-context']);
  assert.equal(configuration.profiles.peer.services.agent, undefined);
  assert.equal(typeof createBoardLauncher({ sourceDirectory: '/unused-pinned-native-board', mysqlDsn: 'mysql://agensh:private@127.0.0.1/board', origin: 'http://127.0.0.1:8660' }), 'function');
  assert.throws(() => createBoardLauncher({ sourceDirectory: '/unused', mysqlDsn: 'private', origin: 'http://user:private@127.0.0.1:8660' }));
});
