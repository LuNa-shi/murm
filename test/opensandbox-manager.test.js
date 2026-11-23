import { openSandboxBotKey, openSandboxMissionKey, openSandboxRuntimeKey } from '../src/runtime/opensandbox-metadata.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BOT_RESOURCES, BOT_PROTOCOL_VERSION } from '../src/agent/bot-contract.js';
import { ensureAgentSession } from '../src/benchmark/putnam-runner.js';
import { createOpenSandboxManager, ERROR_CODES } from '../src/index.js';

function response(body, { status = 200, contentType = 'application/json' } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  return { ok: status >= 200 && status < 300, status, headers: { get: (name) => name === 'content-type' ? contentType : null }, text: async () => text };
}

test('OpenSandbox creates an independent sandbox and executes through its Execd endpoint', async () => {
  const calls = [];
  const manager = createOpenSandboxManager({
    lifecycleBaseUrl: 'http://sandbox.test/v1', image: 'swarmenv/agent:2026-11-11', apiKey: 'test-key', execdToken: 'execd-key',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/sandboxes')) return response({ id: 'sbx-1', status: { state: 'Running' } }, { status: 202 });
      if (url.includes('/endpoints/44772')) return response({ url: 'http://execd.test/sbx-1' });
      if (url === 'http://execd.test/sbx-1/command') return response('event: stdout\ndata: {"text":"hello\\n"}\n\nevent: execution_complete\ndata: {"exit_code":0}\n\n', { contentType: 'text/event-stream' });
      if (url.includes('/sandboxes/sbx-1')) return response({}, { status: options.method === 'DELETE' ? 204 : 404 });
      throw new Error(`unexpected URL: ${url}`);
    },
  });
  const started = await manager.ensureExecution({ executionId: 'execution-1', botId: 'execution-1', workspaceRef: '/host/private', bindingVersion: 3 });
  assert.equal(started.sandbox_id, 'sbx-1');
  assert.equal(started.workspace, '/workspace/project');
  assert.equal(started.host_workspace_ref, null);
  assert.equal(calls[0].options.headers['OPEN-SANDBOX-API-KEY'], 'test-key');
  const createBody = JSON.parse(calls[0].options.body);
  assert.equal(createBody.image.uri, 'swarmenv/agent:2026-11-11');
  assert.equal(createBody.metadata.bot_key, openSandboxBotKey('execution-1'));
  assert.equal(createBody.metadata.binding_version, '3');
  assert.equal(createBody.workspace, undefined);

  const result = await manager.exec({ executionId: 'execution-1', command: 'printf hello' });
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, 'hello\n');
  assert.equal(result.stderr, '');
  const execdCall = calls.find((call) => call.url === 'http://execd.test/sbx-1/command');
  assert.equal(execdCall.options.headers['X-EXECD-ACCESS-TOKEN'], 'execd-key');
  assert.equal(execdCall.options.headers['OPEN-SANDBOX-API-KEY'], undefined);
  await manager.stopExecution('execution-1');
  assert.deepEqual(calls.slice(-2).map(call => call.options.method), ['DELETE', 'GET']);
});

test('OpenSandbox accepts Execd JSON-lines output and falls back from legacy argv validation', async () => {
  const calls = [];
  const manager = createOpenSandboxManager({
    lifecycleBaseUrl: 'http://sandbox.test/v1', image: 'image:test',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/sandboxes')) return response({ id: 'sbx-json-lines' }, { status: 202 });
      if (url.includes('/endpoints/44772')) return response({ url: 'http://execd.test/sbx-json-lines' });
      if (url === 'http://execd.test/sbx-json-lines/command' && JSON.parse(options.body).argv) {
        return response({ code: 'INVALID_REQUEST_BODY', message: "RunCommandRequest.Command failed on required" }, { status: 400 });
      }
      if (url === 'http://execd.test/sbx-json-lines/command') return response('{"type":"stdout","text":"legacy-ok"}\n\n{"type":"execution_complete","exit_code":0}\n\n', { contentType: 'text/event-stream' });
      if (url.includes('/sandboxes/sbx-json-lines')) return response({}, { status: options.method === 'DELETE' ? 204 : 404 });
      throw new Error(`unexpected URL: ${url}`);
    },
  });
  await manager.ensureExecution({ executionId: 'e-json-lines', botId: 'e-json-lines' });
  const result = await manager.exec({ executionId: 'e-json-lines', command: ['printf', 'legacy-ok'] });
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, 'legacy-ok');
  const commandBodies = calls.filter((call) => call.url.endsWith('/command')).map((call) => JSON.parse(call.options.body));
  assert.deepEqual(commandBodies.map((body) => Object.keys(body).includes('argv')), [true, false]);
  assert.equal(commandBodies[1].command, "'printf' 'legacy-ok'");
  await manager.stopExecution('e-json-lines');
});

test('OpenSandbox rejects host paths, secret environment variables, and unbound executions', async () => {
  const manager = createOpenSandboxManager({
    lifecycleBaseUrl: 'http://sandbox.test/v1', image: 'image:test',
    fetchImpl: async (url) => url.includes('/endpoints/') ? response({ url: 'http://execd.test/sbx-1' }) : response({ id: 'sbx-1' }),
  });
  await assert.rejects(() => manager.exec({ executionId: 'missing', command: 'pwd' }), (error) => error.code === ERROR_CODES.NOT_ALLOWED);
  await manager.ensureExecution({ executionId: 'e1', botId: 'e1' });
  await assert.rejects(() => manager.exec({ executionId: 'e1', command: 'pwd', cwd: '/etc' }), (error) => error.code === ERROR_CODES.INVALID_CONTRACT);
  await assert.rejects(() => manager.exec({ executionId: 'e1', command: 'pwd', cwd: '/workspace-escape' }), (error) => error.code === ERROR_CODES.INVALID_CONTRACT);
  await assert.rejects(() => manager.exec({ executionId: 'e1', command: 'env', env: { API_TOKEN: 'secret' } }), (error) => error.code === ERROR_CODES.NOT_ALLOWED);
  assert.throws(() => createOpenSandboxManager({ lifecycleBaseUrl: 'http://sandbox.test/v1', image: 'image:test', volumes: [{ name: 'host', mountPath: '/workspace', host: { path: '/tmp' } }] }), (error) => error.code === ERROR_CODES.NOT_ALLOWED);
});

test('OpenSandbox rejects custom entrypoints outside the fixed worker contract', () => {
  assert.throws(() => createOpenSandboxManager({
    lifecycleBaseUrl: 'http://sandbox.test/v1',
    image: 'image:test',
    entrypoint: ['sh', '-lc', 'tail -f /dev/null'],
  }), (error) => error.code === ERROR_CODES.INVALID_CONTRACT && /fixed Agent worker entrypoint/.test(error.message));
});

test('OpenSandbox compensates a created sandbox when Execd endpoint resolution fails', async () => {
  const calls = [];
  const manager = createOpenSandboxManager({
    lifecycleBaseUrl: 'http://sandbox.test/v1', image: 'image:test',
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      if (options.method === 'POST') return response({ id: 'orphan-candidate' }, { status: 202 });
      if (url.includes('/endpoints/')) return response({ message: 'not ready' }, { status: 503 });
      return response({}, { status: 404 });
    },
  });
  await assert.rejects(() => manager.ensureExecution({ executionId: 'e-failed', botId: 'e-failed' }), (error) => error.code === ERROR_CODES.SERVICE_UNAVAILABLE);
  assert.deepEqual(calls.map((call) => call.method), ['POST', 'GET', 'DELETE']);
  assert.equal(manager.snapshot().executions.length, 0);
});

test('failed preparation retains the provider resource when compensation deletion also fails', async () => {
  let cleanupFails = true;
  let creates = 0;
  const manager = createOpenSandboxManager({
    lifecycleBaseUrl: 'http://sandbox.test/v1', image: 'image:test',
    fetchImpl: async (_url, options) => {
      if (options.method === 'POST') { creates += 1; return response({ id: 'partial-start' }, { status: 202 }); }
      if (options.method === 'DELETE') return response({}, { status: cleanupFails ? 503 : 404 });
      return response({}, { status: 503 });
    },
  });
  await assert.rejects(manager.ensureExecution({ executionId: 'pending-start', botId: 'pending-start' }));
  assert.equal(manager.snapshot().executions[0].sandbox_id, 'partial-start');
  await assert.rejects(manager.ensureExecution({ executionId: 'pending-start', botId: 'pending-start' }), /pending/);
  assert.equal(creates, 1);
  cleanupFails = false;
  await manager.stopExecution('pending-start');
  assert.equal(manager.snapshot().executions.length, 0);
});

test('OpenSandbox starts an authenticated Agent worker through Execd', async () => {
  const calls = [];
  const manager = createOpenSandboxManager({
    lifecycleBaseUrl: 'http://sandbox.test/v1', image: 'image:test',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/sandboxes')) return response({ id: 'sbx-worker' }, { status: 202 });
      if (url.includes('/endpoints/44772')) return response({ url: 'http://execd.test/sbx-worker' });
      if (url.includes('/endpoints/44100')) return response({ url: 'http://worker.test/sbx-worker' });
      if (url === 'http://worker.test/sbx-worker/health') return response({ ok: true });
      if (url === 'http://worker.test/sbx-worker/start') return response({ result: { contract: { version: BOT_PROTOCOL_VERSION, resources: BOT_RESOURCES } } });
      if (url.includes('/sandboxes/sbx-worker')) return response({}, { status: options.method === 'DELETE' ? 204 : 404 });
      throw new Error(`unexpected URL: ${url}`);
    },
  });
  await manager.ensureExecution({ executionId: 'e-worker', botId: 'e-worker' });
  const started = await manager.startAgent({ executionId: 'e-worker', command: 'pi', args: ['--mode', 'rpc'] });
  assert.equal(started.worker_port, 44100);
  const sandboxCreate = calls.find((call) => call.url === 'http://sandbox.test/v1/sandboxes');
  const sandboxPayload = JSON.parse(sandboxCreate.options.body);
  assert.deepEqual(sandboxPayload.entrypoint, ['node', '/opt/swarmenv/agent-worker.mjs', '--port', '44100']);
  assert.match(sandboxPayload.env.SWARMENV_WORKER_TOKEN, /^[0-9a-f-]{36}$/);
  const launch = calls.find((call) => call.url === 'http://worker.test/sbx-worker/start');
  assert.equal(launch.options.headers.authorization.startsWith('Bearer '), true);
  assert.deepEqual(JSON.parse(launch.options.body).args, ['--mode', 'rpc']);
  await manager.stopExecution('e-worker');
});

test('OpenSandbox keeps explicit Agent secrets in the authenticated worker start request', async () => {
  const calls = [];
  const manager = createOpenSandboxManager({
    lifecycleBaseUrl: 'http://sandbox.test/v1', image: 'image:test',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/sandboxes')) return response({ id: 'sbx-secret' }, { status: 202 });
      if (url.includes('/endpoints/44772')) return response({ url: 'http://execd.test/sbx-secret' });
      if (url === 'http://execd.test/sbx-secret/command') return response({ command_id: 'worker-job', running: true });
      if (url.includes('/endpoints/44100')) return response({ url: 'http://worker.test/sbx-secret' });
      if (url === 'http://worker.test/sbx-secret/health') return response({ ok: true });
      if (url === 'http://worker.test/sbx-secret/start') return response({ result: { contract: { version: BOT_PROTOCOL_VERSION, resources: BOT_RESOURCES } } });
      if (url.includes('/sandboxes/sbx-secret')) return response({}, { status: options.method === 'DELETE' ? 204 : 404 });
      throw new Error(`unexpected URL: ${url}`);
    },
  });
  await manager.ensureExecution({ executionId: 'e-secret', botId: 'e-secret' });
  await manager.startAgent({ executionId: 'e-secret', command: 'pi', secretEnvironment: { SWARMENV_TASK_SERVICE_TOKEN: 'secret-value' } });
  const startCall = calls.find((call) => call.url === 'http://worker.test/sbx-secret/start');
  assert.equal(JSON.parse(startCall.options.body).secret_env.SWARMENV_TASK_SERVICE_TOKEN, 'secret-value');
  assert.equal(JSON.stringify(manager.snapshot()).includes('secret-value'), false);
});

test('OpenSandbox resolves Agent versions by executing inside the guest', async () => {
  const manager = createOpenSandboxManager({
    lifecycleBaseUrl: 'http://sandbox.test/v1', image: 'image:test',
    fetchImpl: async (url) => url.endsWith('/sandboxes')
      ? response({ id: 'sbx-versions' }, { status: 202 })
      : url.includes('/endpoints/44772')
        ? response({ url: 'http://execd.test/sbx-versions' })
        : response({}),
  });
  await manager.ensureExecution({ executionId: 'e-versions', botId: 'e-versions' });
  const commands = [];
  manager.exec = async ({ command }) => {
    commands.push(command);
    const versions = { pi: 'pi 1.3.0', node: 'v22.19.0' };
    return { exit_code: 0, stdout: versions[command[0]], stderr: '' };
  };
  assert.deepEqual(await manager.agentVersions({ executionId: 'e-versions' }), { piVersion: '1.3.0', nodeVersion: '22.19.0' });
  assert.deepEqual(commands, [['pi', '--version'], ['node', '--version']]);
});



test('OpenSandbox normalizes the Docker provider bare Execd endpoint shape', async () => {
  const manager = createOpenSandboxManager({
    lifecycleBaseUrl: 'http://sandbox.test/v1', image: 'image:test', endpointHost: '127.0.0.1',
    fetchImpl: async (url, options) => {
      if (url.endsWith('/sandboxes')) return response({ id: 'sbx-bare-endpoint' }, { status: 202 });
      if (url.includes('/endpoints/44772')) return response({ endpoint: '172.30.0.4:40554/proxy/44772' });
      if (url === 'http://127.0.0.1:40554/proxy/44772/command') return response({ exit_code: 0, stdout: 'ok' });
      if (url.includes('/sandboxes/sbx-bare-endpoint')) return response({}, { status: options.method === 'DELETE' ? 204 : 404 });
      throw new Error(`unexpected URL: ${url}`);
    },
  });
  const started = await manager.ensureExecution({ executionId: 'e-bare-endpoint', botId: 'e-bare-endpoint' });
  assert.equal(started.execd_url, undefined);
  const result = await manager.exec({ executionId: 'e-bare-endpoint', command: 'printf ok' });
  assert.equal(result.stdout, 'ok');
  await manager.stopExecution('e-bare-endpoint');
});

test('OpenSandbox readiness falls back to Execd v1.1 ping when ready is absent', async () => {
  const calls = [];
  const manager = createOpenSandboxManager({
    lifecycleBaseUrl: 'http://sandbox.test/v1', image: 'image:test', waitForExecdReady: true,
    fetchImpl: async (url, options) => {
      calls.push(url);
      if (url.endsWith('/sandboxes')) return response({ id: 'sbx-ping-ready' }, { status: 202 });
      if (url.includes('/endpoints/44772')) return response({ endpoint: '127.0.0.1:40555/proxy/44772' });
      if (url === 'http://127.0.0.1:40555/proxy/44772/ready') return response({}, { status: 404 });
      if (url === 'http://127.0.0.1:40555/proxy/44772/ping') return response({});
      if (url.includes('/sandboxes/sbx-ping-ready')) return response({}, { status: options.method === 'DELETE' ? 204 : 404 });
      throw new Error(`unexpected URL: ${url}`);
    },
  });
  await manager.ensureExecution({ executionId: 'e-ping-ready', botId: 'e-ping-ready' });
  assert.equal(calls.some((url) => url.endsWith('/ready')), true);
  assert.equal(calls.some((url) => url.endsWith('/ping')), true);
  await manager.stopExecution('e-ping-ready');
});

test('OpenSandbox foreground session mode uses an interruptible Execd session', async () => {
  const calls = [];
  const manager = createOpenSandboxManager({
    lifecycleBaseUrl: 'http://sandbox.test/v1', image: 'image:test', foregroundSession: true,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/sandboxes')) return response({ id: 'sbx-session' }, { status: 202 });
      if (url.includes('/endpoints/44772')) return response({ url: 'http://execd.test/sbx-session' });
      if (url === 'http://execd.test/sbx-session/session') return response({ session_id: 'session-1' });
      if (url.endsWith('/session/session-1/run')) return response('event: stdout\ndata: {"text":"ok"}\n\nevent: execution_complete\ndata: {"exit_code":0}\n\n', { contentType: 'text/event-stream' });
      if (url.includes('/session/session-1')) return response({});
      if (url.includes('/sandboxes/sbx-session')) return response({}, { status: options.method === 'DELETE' ? 204 : 404 });
      throw new Error(`unexpected URL: ${url}`);
    },
  });
  await manager.ensureExecution({ executionId: 'e-session', botId: 'e-session' });
  const result = await manager.exec({ executionId: 'e-session', command: 'echo ok', env: { CONTEXT_URL: 'http://context' }, internalEnvironment: { CONTEXT_TOKEN: 'secret-token' } });
  assert.equal(result.stdout, 'ok');
  const runCall = calls.find((call) => call.url.endsWith('/session/session-1/run'));
  assert.deepEqual(JSON.parse(runCall.options.body).envs, { CONTEXT_URL: 'http://context', CONTEXT_TOKEN: 'secret-token' });
  assert.equal(calls.some((call) => call.url.endsWith('/session/session-1/run')), true);
  await manager.stopExecution('e-session');
});

test('Bot Sandbox is recorded before endpoint preparation and reused for its sole Execution', async () => {
  const calls = [];
  let recorded = false;
  const manager = createOpenSandboxManager({ lifecycleBaseUrl: 'http://provider.test', image: 'bot:test', waitForExecdReady: false,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (options.method === 'POST' && url.endsWith('/sandboxes')) return response({ id: 'sandbox:one' });
      if (url.includes('/endpoints/')) { assert.equal(recorded, true); return response({ url: 'http://execd.test' }); }
      if (url.includes('/sandboxes/sandbox%3Aone')) return response({}, { status: options.method === 'DELETE' ? 204 : 404 });
      return response({});
    },
  });
  const unbound = await manager.ensureExecution({ executionId: 'bot:one', botId: 'bot:one', onCreated: (snapshot) => {
    assert.equal(snapshot.execution_id, null);
    assert.equal(snapshot.bot_id, 'bot:one');
    assert.equal(snapshot.sandbox_id, 'sandbox:one');
    recorded = true;
  } });
  assert.equal(unbound.execution_id, null);
  const metadata = JSON.parse(calls[0].options.body).metadata;
  assert.equal(metadata.bot_key, openSandboxBotKey('bot:one'));
  assert.equal(metadata.bot_id, undefined);
  assert.equal(metadata.execution_id, undefined);
  const bound = manager.bindBotExecution({ botId: 'bot:one', executionId: 'execution:one', bindingVersion: 0 });
  assert.equal(bound.sandbox_id, unbound.sandbox_id);
  assert.equal(bound.execution_id, 'execution:one');
  assert.equal(manager.snapshot().executions.length, 1);
  assert.throws(() => manager.bindBotExecution({ botId: 'bot:one', executionId: 'execution:two' }), /already bound/);
  await manager.stopExecution('execution:one');
  assert.equal(manager.snapshot().executions.length, 0);
  assert.equal(await manager.stopExecution('bot:one'), false);
  assert.equal(calls.filter(({ options }) => options.method === 'POST').length, 1);
});


for (const receipt of [null, { version: BOT_PROTOCOL_VERSION, resources: [] }, { version: BOT_PROTOCOL_VERSION, resources: BOT_RESOURCES.map(item => ({ ...item, sha256: '0'.repeat(64) })) }]) {
  test(`Agent startup refuses missing or mismatched worker contract attestation: ${receipt === null ? 'missing' : receipt.resources.length}`, async () => {
    const manager = createOpenSandboxManager({ lifecycleBaseUrl: 'http://provider.test', image: 'fixture', waitForExecdReady: false,
      fetchImpl: async (url, options) => {
        if (options.method === 'DELETE') return response({}, { status: 204 });
        if (url.endsWith('/sandboxes/sandbox-attestation')) return response({}, { status: 404 });
        if (url.endsWith('/sandboxes')) return response({ id: 'sandbox-attestation' }, { status: 202 });
        if (url.includes('/endpoints/')) return response({ url: 'http://worker.test' });
        if (url.endsWith('/health')) return response({ ok: true });
        if (url.endsWith('/start')) return response({ result: { pid: 123, contract: receipt } });
        throw new Error(`unexpected: ${url}`);
      },
    });
    await manager.ensureExecution({ executionId: 'B-attestation', botId: 'B-attestation' });
    await assert.rejects(manager.startAgent({ executionId: 'B-attestation', command: 'pi' }), { code: ERROR_CODES.BOT_STARTUP_CONTRACT });
    assert.equal(manager.snapshot().executions[0].agent, undefined);
    await manager.stopExecution('B-attestation');
    assert.equal(manager.snapshot().executions.length, 0);
  });
}

test('restart quarantines only durable Mission resources across provider pages without resolving endpoints', async () => {
  const calls = [];
  let cleanupComplete = false;
  const manager = createOpenSandboxManager({
    lifecycleBaseUrl: 'http://provider.test/v1', image: 'image:test',
    fetchImpl: async (url, { method }) => {
      const path = new URL(url).pathname;
      const page = Number(new URL(url).searchParams.get('page') ?? 1);
      calls.push([method, path, page]);
      if (path.endsWith('/sandboxes')) return response({
        items: page === 1 ? [
          { id: 'foreign', metadata: { mission_key: openSandboxMissionKey('other'), bot_key: openSandboxBotKey('B-foreign') } },
          { id: 'legacy', metadata: { execution_id: 'E-legacy' } },
          { id: 'conflict', metadata: { mission_key: openSandboxMissionKey('other'), bot_key: openSandboxBotKey('B-conflict') } },
        ] : cleanupComplete ? [] : [
          { id: 'registered', metadata: { mission_key: openSandboxMissionKey('M'), bot_key: openSandboxBotKey('B-unbound'), resource_key: openSandboxBotKey('bot:unbound') } },
        ],
        pagination: { page, hasNextPage: page === 1 },
      });
      const id = path.split('/').at(-1);
      assert.ok(['registered', 'legacy', 'known-not-listed'].includes(id), `unexpected lifecycle target: ${id}`);
      if (method === 'DELETE') return response({}, { status: id === 'registered' ? 502 : 204 });
      return response({}, { status: id !== 'registered' || cleanupComplete ? 404 : 200 });
    },
  });
  const bots = [
    { mission_id: 'M', bot_id: 'B-unbound', resource_key: 'bot:unbound', state: 'UNBOUND' },
    { mission_id: 'M', bot_id: 'B-known', resource_key: 'bot:known', state: 'CLOSING', sandbox_id: 'known-not-listed' },
    { mission_id: 'M', bot_id: 'B-conflict', resource_key: 'bot:conflict' },
    { mission_id: 'M', bot_id: 'B-missing', resource_key: 'bot:missing', state: 'STARTING' },
    { mission_id: 'other', bot_id: 'B-foreign', resource_key: 'bot:foreign' },
  ];
  const first = await manager.reconcileExecutions({ missionId: 'M', bots });
  assert.deepEqual(calls.slice(0, 2), [['GET', '/v1/sandboxes', 1], ['GET', '/v1/sandboxes', 2]]);
  assert.deepEqual(first.confirmed_bot_ids, ['B-known']);
  assert.deepEqual(first.quarantined.map(({ sandbox_id }) => sandbox_id), ['known-not-listed']);
  assert.deepEqual(first.pending.map(({ bot_id, reason }) => [bot_id, reason]), [
    ['B-unbound', 'deletion_unconfirmed'], ['B-conflict', 'provider_identity_mismatch'], ['B-missing', 'creation_unconfirmed'],
  ]);
  assert.equal(first.pending[0].sandbox_id, 'registered');
  cleanupComplete = true;
  const retry = await manager.reconcileExecutions({ missionId: 'M', bots: [bots[0]] });
  assert.deepEqual(retry.pending, []);
  assert.deepEqual(retry.confirmed_bot_ids, ['B-unbound']);
});

test('unknown create blocks new starts and local cleanup until the real resource disappears', async () => {
  const calls = [];
  let listed = false;
  let deleted = false;
  let releasePost;
  const manager = createOpenSandboxManager({
    lifecycleBaseUrl: 'http://provider.test', image: 'image:test',
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      calls.push([options.method, path]);
      if (path === '/sandboxes' && options.method === 'POST') {
        assert.deepEqual(JSON.parse(options.body).metadata, { mission_key: openSandboxMissionKey('M'), bot_key: openSandboxBotKey('B'), resource_key: openSandboxBotKey('bot:B') });
        return new Promise((resolve) => { releasePost = () => resolve(response({}, { status: 502 })); });
      }
      if (path === '/sandboxes') return response({ items: listed ? [
        { id: 'late', metadata: { mission_key: openSandboxMissionKey('M'), bot_key: openSandboxBotKey('B'), resource_key: openSandboxBotKey('bot:B') } },
      ] : [] });
      assert.equal(path, '/sandboxes/late');
      if (options.method === 'DELETE') return response({}, { status: 202 });
      return response({}, { status: deleted ? 404 : 200 });
    },
  });
  const input = { executionId: 'bot:B', botId: 'B', metadata: { mission_id: 'M' } };
  const start = manager.ensureExecution(input);
  await assert.rejects(manager.stopExecution('bot:B'), { code: ERROR_CODES.SERVICE_UNAVAILABLE });
  await assert.rejects(manager.ensureExecution(input), { code: ERROR_CODES.SERVICE_UNAVAILABLE });
  const live = await manager.reconcileExecutions({ missionId: 'M', bots: [{ bot_id: 'B', mission_id: 'M', resource_key: 'bot:B' }] });
  assert.deepEqual(live.owned_bot_ids, ['B']);
  releasePost();
  await assert.rejects(start, { code: ERROR_CODES.SERVICE_UNAVAILABLE });
  await assert.rejects(manager.stopExecution('bot:B'), { code: ERROR_CODES.SERVICE_UNAVAILABLE });
  listed = true;
  await assert.rejects(manager.stopExecution('bot:B'), { code: ERROR_CODES.SERVICE_UNAVAILABLE });
  listed = false;
  deleted = true;
  assert.equal(await manager.stopExecution('bot:B'), true);
  assert.equal(await manager.stopExecution('bot:B'), false);
  assert.equal(calls.filter(([method]) => method === 'POST').length, 1);
});

test('restart records a newly found provider ID before deletion and never deletes conflicting matches', async () => {
  const deleted = [];
  const rows = [
    { id: 's-found', metadata: { mission_key: openSandboxMissionKey('M'), bot_key: openSandboxBotKey('B-found'), resource_key: openSandboxBotKey('bot:found') } },
    { id: 's-duplicate-1', metadata: { mission_key: openSandboxMissionKey('M'), bot_key: openSandboxBotKey('B-duplicate'), resource_key: openSandboxBotKey('bot:duplicate') } },
    { id: 's-duplicate-2', metadata: { mission_key: openSandboxMissionKey('M'), bot_key: openSandboxBotKey('B-duplicate'), resource_key: openSandboxBotKey('bot:duplicate') } },
  ];
  const bots = [
    { mission_id: 'M', bot_id: 'B-found', resource_key: 'bot:found' },
    { mission_id: 'M', bot_id: 'B-duplicate', resource_key: 'bot:duplicate' },
  ];
  let persisted = null;
  const manager = createOpenSandboxManager({
    lifecycleBaseUrl: 'http://provider.test', image: 'image:test',
    fetchImpl: async (url, { method }) => {
      const path = new URL(url).pathname;
      if (path === '/sandboxes') return response({ items: rows });
      assert.equal(path, '/sandboxes/s-found');
      if (method === 'DELETE') {
        assert.equal(persisted, 's-found');
        deleted.push(path);
        return response({}, { status: 204 });
      }
      return response({}, { status: 404 });
    },
  });
  const error = await manager.reconcileExecutions({ missionId: 'M', bots, onSandboxDiscovered: () => { throw new Error('SQLite unavailable'); } });
  assert.deepEqual(error.pending.map(({ reason }) => reason), [
    'resource_record_unconfirmed', 'provider_identity_mismatch', 'provider_identity_mismatch',
  ]);
  assert.deepEqual(deleted, []);
  const result = await manager.reconcileExecutions({ missionId: 'M', bots, onSandboxDiscovered: (bot, id) => {
    assert.equal(bot.bot_id, 'B-found');
    persisted = id;
  } });
  assert.deepEqual(result.confirmed_bot_ids, ['B-found']);
  assert.deepEqual(deleted, ['/sandboxes/s-found']);
});

test('restart does not delete an otherwise eligible first page if listing cannot finish', async () => {
  const methods = [];
  const manager = createOpenSandboxManager({
    lifecycleBaseUrl: 'http://provider.test', image: 'image:test',
    fetchImpl: async (url, { method }) => {
      methods.push(method);
      if (new URL(url).searchParams.get('page') === '2') return response({}, { status: 502 });
      return response({ items: [{ id: 's', metadata: { execution_id: 'E' } }], pagination: { page: 1, hasNextPage: true } });
    },
  });
  await assert.rejects(manager.reconcileExecutions({ missionId: 'M', bots: [{ mission_id: 'M', bot_id: 'B', resource_key: 'bot:B' }] }), { code: ERROR_CODES.SERVICE_UNAVAILABLE });
  assert.deepEqual(methods, ['GET', 'GET']);
});

const startupCases = [
  { name: 'Execd endpoint 404', errorCode: ERROR_CODES.INVALID_CONTRACT, endpointStatus: 404, endpointPort: 44772 },
  { name: 'worker endpoint 404', errorCode: ERROR_CODES.INVALID_CONTRACT, endpointStatus: 404, endpointPort: 44100 },
  { name: 'untyped worker rejection', errorCode: ERROR_CODES.INVALID_CONTRACT, startStatus: 400, startBody: { ok: false } },
  { name: 'worker HTTP 502', errorCode: ERROR_CODES.SERVICE_UNAVAILABLE, startStatus: 502, startBody: { ok: false, code: ERROR_CODES.BOT_STARTUP_CONTRACT } },
  { name: 'worker contract rejection', errorCode: ERROR_CODES.BOT_STARTUP_CONTRACT, startStatus: 400, startBody: { ok: false, code: ERROR_CODES.BOT_STARTUP_CONTRACT } },
  { name: 'missing worker attestation', errorCode: ERROR_CODES.BOT_STARTUP_CONTRACT, startStatus: 200, startBody: { ok: true, result: { pid: 123 } } },
];

for (const scenario of startupCases) {
  test(`benchmark handles ${scenario.name} through the actual OpenSandbox manager`, async () => {
    const manager = createOpenSandboxManager({ lifecycleBaseUrl: 'http://provider.test', image: 'fixture', waitForExecdReady: false,
      fetchImpl: async (url, options) => {
        if (options.method === 'DELETE') return response({}, { status: 204 });
        if (url.endsWith('/sandboxes')) return response({ id: 'sandbox-startup' }, { status: 202 });
        if (url.endsWith('/sandboxes/sandbox-startup')) return response({}, { status: 404 });
        if (url.endsWith(`/endpoints/${scenario.endpointPort}`)) {
          return response({ ok: false, code: ERROR_CODES.BOT_STARTUP_CONTRACT }, { status: scenario.endpointStatus });
        }
        if (url.includes('/endpoints/')) return response({ url: 'http://worker.test' });
        if (url.endsWith('/health')) return response({ ok: true });
        if (url.endsWith('/start')) return response(scenario.startBody, { status: scenario.startStatus });
        throw new Error(`unexpected: ${url}`);
      },
    });
    let attempts = 0;
    const wakes = [];
    const stateRef = { mission: { mission_id: 'mission' }, requestIdentityWake: (reason) => wakes.push(reason) };
    const runtime = {
      taskService: { isMissionStopped: () => false },
      startBot: async () => {
        const id = `bot-${++attempts}`;
        try {
          await manager.ensureExecution({ executionId: id, botId: id });
          await manager.startAgent({ executionId: id, command: 'pi' });
        } finally {
          await manager.stopExecution(id);
        }
      },
    };
    const makeCore = index => ({
      index, errors: [], childEnv: {}, sessionNumber: 0, stateRef, runtime,
      startConfig: { options: { requireThirdPartySandbox: true, botMaxMs: 1000 } },
    });
    const first = makeCore(1);
    assert.equal(await ensureAgentSession(first), false);
    assert.equal(await ensureAgentSession(makeCore(2)), false);
    assert.equal(first.errors[0].code, scenario.errorCode);
    if (scenario.errorCode === ERROR_CODES.BOT_STARTUP_CONTRACT) {
      assert.equal(attempts, 1);
      assert.deepEqual(stateRef.startupFailure, { core_id: 'core-1', code: scenario.errorCode, class: 'bot_startup_contract' });
      assert.deepEqual(wakes, ['bot_startup_contract']);
    } else {
      assert.equal(attempts, 2);
      assert.equal(stateRef.startupFailure, undefined);
      assert.deepEqual(wakes, []);
    }
    assert.equal(manager.snapshot().executions.length, 0);
  });
}

test('worker quota and exact catalog attestations are required when configured', async () => {
  const quota = { bytes: 16 * 1024 ** 2, inodes: 1024 };
  const modelCatalogResource = { path: '/opt/swarmenv/pi-agent/models.json', sha256: 'c'.repeat(64) };
  for (const variant of ['quota missing', 'catalog mismatch', 'accepted']) {
    const manager = createOpenSandboxManager({ lifecycleBaseUrl: 'http://provider.test', image: 'fixture', waitForExecdReady: false,
      fetchImpl: async (url, options) => {
        if (options.method === 'DELETE') return response({}, { status: 204 });
        if (url.endsWith('/sandboxes/sandbox-quota')) return response({}, { status: 404 });
        if (url.endsWith('/sandboxes')) {
          assert.ok(JSON.parse(options.body).entrypoint.includes('--require-project-quota'));
          return response({ id: 'sandbox-quota' }, { status: 202 });
        }
        if (url.includes('/endpoints/')) return response({ url: 'http://worker.test' });
        if (url.endsWith('/health')) return response({ ok: true });
        if (url.endsWith('/start')) {
          assert.deepEqual(JSON.parse(options.body).project_quota, quota);
          assert.deepEqual(JSON.parse(options.body).model_catalog_resource, modelCatalogResource);
          return response({ result: { contract: { version: BOT_PROTOCOL_VERSION, resources: BOT_RESOURCES },
            ...(variant === 'quota missing' ? {} : { project_quota: quota }),
            model_catalog_resource: variant === 'catalog mismatch' ? { ...modelCatalogResource, sha256: '0'.repeat(64) } : modelCatalogResource } });
        }
        throw new Error(`unexpected: ${url}`);
      },
    });
    await manager.ensureExecution({ executionId: 'B-quota', botId: 'B-quota', projectQuotaRequired: true });
    await assert.rejects(manager.startAgent({ executionId: 'B-quota', command: 'pi' }), { code: ERROR_CODES.BOT_STARTUP_CONTRACT });
    const started = manager.startAgent({ executionId: 'B-quota', command: 'pi', projectQuota: quota, modelCatalogResource });
    if (variant === 'accepted') await started;
    else await assert.rejects(started, { code: ERROR_CODES.BOT_STARTUP_CONTRACT });
    await manager.stopExecution('B-quota');
  }
});

test('OpenSandbox refuses resource creation without a Bot before provider dispatch', async () => {
  const manager = createOpenSandboxManager({ lifecycleBaseUrl: 'http://provider.test', image: 'image:test',
    fetchImpl: async () => assert.fail('Unregistered creation must not reach the provider') });
  await assert.rejects(manager.ensureExecution({ executionId: 'unregistered' }), /bot_id is required/);
});


test('Runtime-owned sandbox creation needs no Mission and leaves failure cleanup to its owner', async () => {
  const calls = [];
  const manager = createOpenSandboxManager({
    lifecycleBaseUrl: 'http://provider.test', image: 'image:test',
    fetchImpl: async (url, options) => {
      calls.push(options.method);
      const path = new URL(url).pathname;
      if (path === '/sandboxes') {
        const metadata = JSON.parse(options.body).metadata;
        assert.deepEqual(metadata, { runtime_key: openSandboxRuntimeKey('runtime-1'),
          bot_key: openSandboxBotKey('bot-1'), resource_key: openSandboxBotKey('bot-1') });
        return response({ id: 'owned' });
      }
      if (path.includes('/endpoints/')) return response({}, { status: 404 });
      return response({}, { status: options.method === 'DELETE' ? 204 : 404 });
    },
  });
  await assert.rejects(manager.ensureExecution({ executionId: 'bot-1', botId: 'bot-1',
    metadata: { runtime_id: 'runtime-1' }, cleanupOnFailure: false }));
  assert.equal(calls.includes('DELETE'), false);
  assert.equal(manager.ownsBotResource('bot-1'), true);
  assert.equal(await manager.stopExecution('bot-1'), true);
  assert.equal(manager.ownsBotResource('bot-1'), false);
});

test('unknown Runtime-owned sandbox create is reconciled without a Mission identity', async () => {
  let metadata;
  let deleted = false;
  const manager = createOpenSandboxManager({
    lifecycleBaseUrl: 'http://provider.test', image: 'image:test',
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      if (path === '/sandboxes' && options.method === 'POST') {
        metadata = JSON.parse(options.body).metadata;
        return response({}, { status: 502 });
      }
      if (path === '/sandboxes') return response({ items: [{ id: 'late-runtime', metadata }] });
      assert.equal(path, '/sandboxes/late-runtime');
      if (options.method === 'DELETE') { deleted = true; return response({}, { status: 204 }); }
      return response({}, { status: deleted ? 404 : 200 });
    },
  });
  await assert.rejects(manager.ensureExecution({ executionId: 'bot-1', botId: 'bot-1', metadata: { runtime_id: 'runtime-1' } }));
  assert.equal(await manager.stopExecution('bot-1'), true);
  assert.equal(deleted, true);
});

test('Core startup accepts explicitly classified nonsecret application environment names', async () => {
  let launch;
  const manager = createOpenSandboxManager({ lifecycleBaseUrl: 'http://sandbox.test/v1', image: 'image:test',
    fetchImpl: async (url, options) => {
      if (url.endsWith('/sandboxes')) return response({ id: 'core-env' });
      if (url.includes('/endpoints/')) return response({ url: 'http://worker.test' });
      if (url.endsWith('/health')) return response({ ok: true });
      if (url.endsWith('/start')) {
        launch = JSON.parse(options.body);
        return response({ result: { contract: { version: 'swarmenv-core-v1', resources: [] } } });
      }
      throw new Error('Unexpected provider route');
    } });
  await manager.ensureExecution({ executionId: 'core-env', botId: 'core-env' });
  await manager.startAgent({ executionId: 'core-env', agentMode: 'core', command: 'pi', resources: [],
    env: { TOKENIZER: 'nonsecret-test-value' } });
  assert.equal(launch.env.TOKENIZER, 'nonsecret-test-value');
});
