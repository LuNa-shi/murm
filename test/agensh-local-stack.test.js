import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalAgenshStack, facilityImages, boardSchema } from './fixtures/agensh-local-stack.js';

for (const scenario of ['ready', 'missing-schema', 'board-exited']) test(`production local stack final TCP/schema readiness and permanent board exit: ${scenario}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agensh-stack-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let boardReads = 0;
  const server = createServer(async (request, response) => {
    if (request.url.startsWith('/board/')) boardReads++;
    request.resume();
    response.setHeader('content-type', 'application/json');
    if (request.url.endsWith('/login')) { response.setHeader('Token', 'private-mm-token'); response.end('{}'); }
    else response.end(JSON.stringify(request.url.endsWith('/teams') ? { id: 'team' } : {}));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const calls = [], owned = new Set(); let rootAttempts = 0, appAttempts = 0, schemaCalls = 0, socketCalls = 0, boardSchemaInstalled = false, boardSchemaChecked = false;
  const stack = await createLocalAgenshStack({ directory: join(directory, 'facilities'), executeCommand: async (_name, args, options) => {
    calls.push(args); assert.ok(options.timeout > 0 && options.timeout <= 15_000);
    if (args[0] === 'run') {
      assert.equal(args.includes('--pull=never'), true); assert.equal(args.includes('--pids-limit'), true);
      assert.equal(args.includes('512'), true);
      const name = args[args.indexOf('--name') + 1]; owned.add(name);
      const kind = name.split('-').at(-1);
      if (kind === 'board') assert.equal(boardSchemaChecked, true, 'board cannot start before verified schema');
      assert.ok(args.includes(facilityImages[kind]));
      const expected = { mysql: ['1', '1g'], gitea: ['1', '512m'], mattermost: ['1', '2g'], board: ['0.25', '256m'] }[kind];
      assert.equal(args[args.indexOf('--cpus') + 1], expected[0]); assert.equal(args[args.indexOf('--memory') + 1], expected[1]);
      return { stdout: name };
    }
    if (args[0] === 'inspect' && args.includes('{{json .State}}')) return { stdout: JSON.stringify(scenario === 'board-exited' ? { Status: 'exited', Running: false, ExitCode: 3 } : { Status: 'running', Running: true, ExitCode: 0 }) };
    if (args[0] === 'inspect') return { stdout: args.includes('{{json .Id}}') ? JSON.stringify('a'.repeat(64)) : JSON.stringify(Object.fromEntries([3000, 8065, 8660].map(port => [`${port}/tcp`, [{ HostPort: String(server.address().port) }]]))) };
    if (args[0] === 'exec' && args.includes('mysql')) {
      const statement = args.at(-1);
      // The temporary socket is already answering, while final TCP refuses.
      if (!args.includes('--protocol=TCP')) { socketCalls++; return { stdout: '1\n' }; }
      assert.ok(args.includes('--host=127.0.0.1') && args.includes('--port=3306') && args.includes('--connect-timeout=2'));
      assert.ok(args.includes('--batch') && args.includes('--skip-column-names'));
      if (statement.startsWith('SELECT IF(@@skip_networking')) {
        rootAttempts++;
        assert.ok(args.includes('--user=root'));
        assert.ok(statement.includes("mysql.user WHERE User='agensh' AND Host='%'"));
        assert.ok(statement.includes("SCHEMA_NAME='board'"));
        if (rootAttempts === 1) throw Object.assign(new Error('PRIVATE_DIAGNOSTIC'), { code: 1, stderr: 'PRIVATE_DIAGNOSTIC' });
        if (rootAttempts === 2) return { stdout: '0\n' }; // Authenticated, but initialized app/schema check still false.
        return { stdout: '1\n' };
      }
      if (statement.startsWith('SELECT IF(SUBSTRING_INDEX')) {
        appAttempts++; assert.ok(rootAttempts >= 3 && args.includes('--user=agensh') && args.includes('--database=board'));
        return { stdout: '1\n' };
      }
      if (statement.includes('CREATE TABLE IF NOT EXISTS board_gists')) {
        assert.ok(args.includes('--user=agensh') && args.includes('--database=board'));
        boardSchemaInstalled = true; return { stdout: '' };
      }
      if (statement.includes('FROM board_gists LIMIT 0')) {
        assert.equal(boardSchemaInstalled, true, 'readiness requires canonical schema installation');
        assert.ok(args.includes('--user=agensh') && args.includes('--database=board'));
        if (scenario === 'missing-schema') throw Object.assign(new Error('PRIVATE_DIAGNOSTIC'), { code: 1 });
        boardSchemaChecked = true; return { stdout: '1\n' };
      }
      schemaCalls++; assert.equal(appAttempts, 1); assert.ok(args.includes('--user=root'));
      assert.ok(statement.startsWith('CREATE DATABASE IF NOT EXISTS mattermost '));
      assert.ok(statement.includes("GRANT ALL PRIVILEGES ON mattermost.* TO 'agensh'@'%'; FLUSH PRIVILEGES;"));
      return { stdout: '' };
    }
    if (args[0] === 'exec') {
      assert.ok(args.includes('--user') && args.includes('git'));
      assert.ok(args.includes('GITEA_WORK_DIR=/data/gitea') && args.includes('GITEA_CUSTOM=/data/gitea'));
      assert.ok(args.includes('/data/gitea/conf/app.ini'));
      return { stdout: args.includes('generate-access-token') ? 'private-git-token' : '' };
    }
    if (args[0] === 'ps') {
      const selector = args.find(value => value.startsWith('name='));
      return { stdout: selector ? [...owned].find(name => selector.includes(name)) ?? '' : '' };
    }
    if (args[0] === 'rm') { owned.delete(args.at(-1)); return { stdout: '' }; }
    if (args[0] === 'network' && args[1] === 'ls') return { stdout: 'owned-network' };
    return { stdout: '' };
  } });
  t.after(() => stack.close());
  if (scenario === 'missing-schema') {
    await assert.rejects(stack.start(), { code: 'LOCAL_FACILITY_DOCKER_FAILED' });
    assert.equal(calls.filter(args => args[0] === 'run').length, 1);
    assert.ok(stack.receipt().commands.some(row => row.stage === 'mysql.board-schema-ready' && row.state === 'failed'));
    assert.equal(JSON.stringify(stack.receipt()).includes('PRIVATE_DIAGNOSTIC'), false);
    assert.equal((await stack.close()).cleanup, 'complete'); return;
  }
  const config = await stack.start();
  if (scenario === 'board-exited') {
    const before = Date.now();
    await assert.rejects(config.startBoard({ boardId: 'board-fixed', workerId: 'worker-fixed', own() {} }), { code: 'LOCAL_BOARD_EXITED' });
    assert.ok(Date.now() - before < 1000, 'permanent exit fails without readiness polling');
    assert.deepEqual(stack.receipt().readiness.board, { state: 'exited', exitClass: 'nonzero' });
    assert.equal(boardReads, 0, 'known exited board never enters HTTP readiness polling');
    assert.equal((await stack.close()).cleanup, 'complete'); return;
  }
  await config.startBoard({ boardId: 'board-fixed', workerId: 'worker-fixed', own() {} });
  assert.equal(boardSchemaInstalled, true); assert.equal(boardSchemaChecked, true);
  assert.equal(rootAttempts, 3); assert.equal(appAttempts, 1); assert.equal(schemaCalls, 1); assert.equal(socketCalls, 0);
  assert.equal((await stack.close()).cleanup, 'complete');
  assert.deepEqual(stack.receipt().readiness.mysql, { protocol: 'TCP', rootAuthenticated: true, applicationAuthenticated: true, applicationSchema: 'board', skipNetworking: false });
  assert.deepEqual(stack.receipt().readiness.boardSchema, { ...boardSchema, table: 'board_gists', applicationAuthenticated: true, columnsVerified: true });
  assert.deepEqual(stack.receipt().readiness.board, { state: 'ready' });
  assert.equal(boardReads, 1);
  const commands = stack.receipt().commands;
  assert.ok(commands.some(row => row.stage === 'mysql.root-ready' && row.state === 'failed' && row.errorClass === 'nonzero_exit'));
  assert.ok(commands.some(row => row.stage === 'mysql.schema-initialize' && row.state === 'succeeded'));
  assert.equal(JSON.stringify(stack.receipt()).includes('PRIVATE_DIAGNOSTIC'), false);
  assert.equal(JSON.stringify(stack.receipt()).includes('private-git-token'), false);
  assert.ok(commands.every(row => Object.keys(row).every(key => ['stage', 'state', 'errorClass'].includes(key))));
  assert.equal(calls.filter(args => args[0] === 'run').length, 4);
});

for (const [error, errorClass] of [
  [{ code: 1 }, 'nonzero_exit'], [{ killed: true }, 'timeout'], [{ code: 'ENOENT' }, 'unavailable'],
  [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'output_limit'], [{}, 'unknown'],
]) test(`Docker diagnostics project only categorical stage and ${errorClass} error class`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agensh-stage-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const stack = await createLocalAgenshStack({ directory, executeCommand: async (_name, args) => {
    if (args[0] === 'image') throw Object.assign(new Error('PRIVATE_DIAGNOSTIC'), error, { stdout: 'PRIVATE_DIAGNOSTIC', stderr: 'PRIVATE_DIAGNOSTIC' });
    return { stdout: '' };
  } });
  await assert.rejects(stack.start(), { code: 'LOCAL_FACILITY_DOCKER_FAILED' });
  assert.deepEqual(stack.receipt().commands, [{ stage: 'image.cached', state: 'failed', errorClass }]);
  assert.equal(JSON.stringify(stack.receipt()).includes('PRIVATE_DIAGNOSTIC'), false);
  await stack.close();
});

test('lead-helper Gitea-only stack caches and allocates no unrelated facilities', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lead-helper-git-stack-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createServer((request, response) => { request.resume(); response.end('{}'); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const calls = []; let owned;
  const stack = await createLocalAgenshStack({ directory, giteaOnly: true, executeCommand: async (_name, args) => {
    calls.push(args);
    if (args[0] === 'run') { owned = args[args.indexOf('--name') + 1]; return { stdout: owned }; }
    if (args[0] === 'inspect') return { stdout: args.includes('{{json .Id}}') ? JSON.stringify('a'.repeat(64)) : JSON.stringify({ '3000/tcp': [{ HostPort: String(server.address().port) }] }) };
    if (args[0] === 'exec') return { stdout: args.includes('generate-access-token') ? 'private-fixture-token' : '' };
    if (args[0] === 'ps') return { stdout: owned ?? '' };
    if (args[0] === 'rm') owned = undefined;
    if (args[0] === 'network' && args[1] === 'ls') return { stdout: 'network' };
    return { stdout: '' };
  } });
  t.after(() => stack.close());
  const config = await stack.start(); assert.equal(config.gitea.owner, 'run-owner'); assert.equal(config.mattermost, undefined); assert.equal(config.startBoard, undefined);
  assert.deepEqual(calls.filter(args => args[0] === 'image').map(args => args.at(-1)), [facilityImages.gitea]);
  assert.equal(calls.filter(args => args[0] === 'run').length, 1); assert.ok(calls.find(args => args[0] === 'run').includes(facilityImages.gitea));
  assert.equal((await stack.close()).cleanup, 'complete');
});
