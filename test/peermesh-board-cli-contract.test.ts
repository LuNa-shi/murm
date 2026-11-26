import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createCoreBridge } from '../src/core/bridge.js';
import { snapshotServiceRegistry } from '../src/core/services.js';
import { createPeerMeshServices } from '../src/harnesses/peermesh/services.js';
import { liveCommon } from './fixtures/peermesh-team-kimi.js';

const execute = promisify(execFile);

test('Kimi Board instructions describe the real schema and unwrapped CLI results', async t => {
  const rendered = '[G1] FACT LIVE_T15_SEED=0123456789abcdef01234567\n[G2] CLAIM LIVE_T15_SHARED_COMPONENT';
  const entries = [{ label: 'G1', type: 'FACT', content: 'LIVE_T15_SEED=0123456789abcdef01234567' }];
  const requests = [];
  const facility = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    requests.push({ path: url.pathname, viewer: url.searchParams.get('viewer'), words: url.searchParams.get('words') });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(url.pathname.endsWith('/read') ? { rendered } : { total: 1, entries }));
  });
  facility.listen(0, '127.0.0.1');
  await once(facility, 'listening');
  t.after(() => new Promise(resolve => { facility.close(resolve); facility.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${facility.address().port}`;
  const service = createPeerMeshServices({ runId: 'board-cli', repository: { owner: 'owner', name: 'repo' }, channelId: 'channel', boardId: 'board',
    endpoints: { gitea: origin, message: origin, board: origin },
    peer: { gitea: { binding: 'git', accountId: 'git-peer', token: 'test-git-token' },
      message: { binding: 'message', accountId: 'message-peer', token: 'test-message-token' }, board: { binding: 'board', workerId: 'peer-a' } } });
  const agent = { profile: 'peer', status: 'idle', services: { 'peermesh-context': ['board_read', 'board_grep'] }, bindings: service.bindings };
  service.bindAgent({ runtimeId: 'runtime-board-cli', agentId: 'agent-a' });
  const bridge = await createCoreBridge({ runtimeId: 'runtime-board-cli',
    configuration: { host: '127.0.0.1', publicUrl: 'http://127.0.0.1:{port}' },
    getAgent: id => id === 'agent-a' ? agent : null, registrations: snapshotServiceRegistry(service.services) });
  t.after(() => bridge.close());
  const credentials = bridge.credentialsForAgent('agent-a');
  const env = { ...process.env, ...credentials.environment, ...credentials.secretEnvironment };
  const cli = (...args) => execute(process.execPath, ['dist/scripts/swarm.js', ...args], { env, timeout: 5000 });
  const manifest = JSON.parse((await cli('service', 'view', 'peermesh-context')).stdout);
  assert.deepEqual(manifest.capabilities.find(row => row.operation === 'board_read').output_schema.required, ['rendered']);
  assert.deepEqual(manifest.capabilities.find(row => row.operation === 'board_grep').output_schema.required, ['total', 'entries']);

  const directory = await mkdtemp(join(tmpdir(), 'murm-board-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'input.json');
  await writeFile(input, JSON.stringify({ board_id: 'board' }));
  const read = JSON.parse((await cli('peermesh-context', 'board_read', '--input', input, '--request-id', 'read-board')).stdout);
  assert.deepEqual(read, { rendered });
  assert.equal(Object.hasOwn(read, 'result'), false);
  assert.equal(Object.hasOwn(read, 'entries'), false);
  await writeFile(input, JSON.stringify({ board_id: 'board', words: 'LIVE_T15_SEED', limit: 10 }));
  const grep = JSON.parse((await cli('peermesh-context', 'board_grep', '--input', input, '--request-id', 'grep-board')).stdout);
  assert.deepEqual(grep, { total: 1, entries });
  assert.deepEqual(requests, [
    { path: '/board/board/read', viewer: 'peer-a', words: null },
    { path: '/board/board/grep', viewer: 'peer-a', words: 'LIVE_T15_SEED' },
  ]);
  assert.ok(liveCommon.includes('board_read returns an unwrapped JSON object with a top-level rendered string'));
  assert.ok(liveCommon.includes('board_grep returns an unwrapped JSON object with total and entries'));
  assert.ok(liveCommon.includes('Parse the FACT and CLAIM text from rendered for board_read, or inspect entries for board_grep'));
});
