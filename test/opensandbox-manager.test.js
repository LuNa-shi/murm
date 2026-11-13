import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
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
      if (url.includes('/sandboxes/sbx-1')) return response({});
      throw new Error(`unexpected URL: ${url}`);
    },
  });
  const started = await manager.ensureExecution({ executionId: 'execution-1', workspaceRef: '/host/private', bindingVersion: 3 });
  assert.equal(started.sandbox_id, 'sbx-1');
  assert.equal(started.workspace, '/workspace');
  assert.equal(started.host_workspace_ref, null);
  assert.equal(calls[0].options.headers['OPEN-SANDBOX-API-KEY'], 'test-key');
  const createBody = JSON.parse(calls[0].options.body);
  assert.equal(createBody.image.uri, 'swarmenv/agent:2026-11-11');
  assert.equal(createBody.metadata.execution_id, 'execution-1');
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
  assert.equal(calls.at(-1).options.method, 'DELETE');
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
      if (url.includes('/sandboxes/sbx-json-lines')) return response({});
      throw new Error(`unexpected URL: ${url}`);
    },
  });
  await manager.ensureExecution({ executionId: 'e-json-lines' });
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
  await manager.ensureExecution({ executionId: 'e1' });
  await assert.rejects(() => manager.exec({ executionId: 'e1', command: 'pwd', cwd: '/etc' }), (error) => error.code === ERROR_CODES.INVALID_CONTRACT);
  await assert.rejects(() => manager.exec({ executionId: 'e1', command: 'pwd', cwd: '/workspace-escape' }), (error) => error.code === ERROR_CODES.INVALID_CONTRACT);
  await assert.rejects(() => manager.exec({ executionId: 'e1', command: 'env', env: { API_TOKEN: 'secret' } }), (error) => error.code === ERROR_CODES.NOT_ALLOWED);
  assert.throws(() => createOpenSandboxManager({ lifecycleBaseUrl: 'http://sandbox.test/v1', image: 'image:test', volumes: [{ name: 'host', mountPath: '/workspace', host: { path: '/tmp' } }] }), (error) => error.code === ERROR_CODES.NOT_ALLOWED);
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
  await assert.rejects(() => manager.ensureExecution({ executionId: 'e-failed' }), (error) => error.code === ERROR_CODES.SERVICE_UNAVAILABLE);
  assert.deepEqual(calls.map((call) => call.method), ['POST', 'GET', 'DELETE']);
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
      if (url === 'http://execd.test/sbx-worker/command') return response({ command_id: 'worker-job', running: true });
      if (url.includes('/endpoints/44100')) return response({ url: 'http://worker.test/sbx-worker' });
      if (url === 'http://worker.test/sbx-worker/health') return response({ ok: true });
      if (url === 'http://worker.test/sbx-worker/start') return response({ ok: true });
      if (url.includes('/sandboxes/sbx-worker')) return response({});
      throw new Error(`unexpected URL: ${url}`);
    },
  });
  await manager.ensureExecution({ executionId: 'e-worker' });
  const started = await manager.startAgent({ executionId: 'e-worker', command: 'nurouter', args: ['pi', '--mode', 'rpc'] });
  assert.equal(started.worker_port, 44100);
  const workerCommand = calls.find((call) => call.url === 'http://execd.test/sbx-worker/command');
  const workerPayload = JSON.parse(workerCommand.options.body);
  assert.match(workerPayload.argv.join(' '), /nohup/);
  assert.doesNotMatch(workerPayload.argv.join(' '), /--token/);
  assert.match(JSON.parse(workerCommand.options.body).envs.SWARMENV_WORKER_TOKEN, /^[0-9a-f-]{36}$/);
  const launch = calls.find((call) => call.url === 'http://worker.test/sbx-worker/start');
  assert.equal(launch.options.headers.authorization.startsWith('Bearer '), true);
  assert.deepEqual(JSON.parse(launch.options.body).args, ['pi', '--mode', 'rpc']);
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
      if (url === 'http://worker.test/sbx-secret/start') return response({ ok: true });
      if (url.includes('/sandboxes/sbx-secret')) return response({});
      throw new Error(`unexpected URL: ${url}`);
    },
  });
  await manager.ensureExecution({ executionId: 'e-secret' });
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
  await manager.ensureExecution({ executionId: 'e-versions' });
  const commands = [];
  manager.exec = async ({ command }) => {
    commands.push(command);
    const versions = { pi: 'pi 1.3.0', nurouter: 'nurouter 0.2.16', node: 'v22.19.0' };
    return { exit_code: 0, stdout: versions[command[0]], stderr: '' };
  };
  assert.deepEqual(await manager.agentVersions({ executionId: 'e-versions' }), { piVersion: '1.3.0', nurouterVersion: '0.2.16', nodeVersion: '22.19.0' });
  assert.deepEqual(commands, [['pi', '--version'], ['nurouter', '--version'], ['node', '--version']]);
});

test('OpenSandbox pulls bounded guest files back before the sandbox is removed', async () => {
  const root = await mkdtemp('/tmp/swarmenv-provider-pull-');
  try {
    const manager = createOpenSandboxManager({
      lifecycleBaseUrl: 'http://sandbox.test/v1', image: 'image:test',
      fetchImpl: async (url, options) => {
        if (url.endsWith('/sandboxes')) return response({ id: 'sbx-pull' }, { status: 202 });
        if (url.includes('/endpoints/44772')) return response({ url: 'http://execd.test/sbx-pull' });
        if (url === 'http://execd.test/sbx-pull/command') {
          const body = JSON.parse(options.body);
          return body.argv?.[2]?.startsWith('find ') ? response('event: execution_complete\ndata: {"exit_code":0}\n\n', { contentType: 'text/event-stream' })
            : response('event: stdout\ndata: {"text":"aGVsbG8="}\n\nevent: execution_complete\ndata: {"exit_code":0}\n\n', { contentType: 'text/event-stream' });
        }
        if (url.includes('/sandboxes/sbx-pull')) return response({});
        throw new Error(`unexpected URL: ${url}`);
      },
    });
    await manager.ensureExecution({ executionId: 'e-pull' });
    // The fake Execd listing is supplied by the command response above; make
    // the command-specific branch explicit by replacing the response shape.
    const originalExec = manager.exec.bind(manager);
    manager.exec = async (input) => input.command?.[2]?.startsWith('find ')
      ? { exit_code: 0, stdout: '/workspace/notes.txt\n', stderr: '' }
      : originalExec(input);
    await manager.syncWorkspaceBack({ executionId: 'e-pull', workspaceRef: root });
    assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'hello');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('OpenSandbox workspace pull is idempotent after provider cleanup removed the record', async () => {
  const root = await mkdtemp('/tmp/swarmenv-provider-pull-race-');
  try {
    const manager = createOpenSandboxManager({ lifecycleBaseUrl: 'http://sandbox.test/v1', image: 'image:test' });
    const result = await manager.syncWorkspaceBack({ executionId: 'already-stopped', workspaceRef: root });
    assert.equal(result.skipped, true);
    assert.equal(result.file_count, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('OpenSandbox reconciles provider sandboxes by durable Execution metadata', async () => {
  const manager = createOpenSandboxManager({
    lifecycleBaseUrl: 'http://sandbox.test/v1', image: 'image:test',
    fetchImpl: async (url) => {
      if (url.includes('/sandboxes?pageSize=100')) return response({ items: [{ id: 'sbx-existing', metadata: { execution_id: 'e-existing', binding_version: '4' } }] });
      if (url.includes('/endpoints/44772')) return response({ url: 'http://execd.test/existing' });
      throw new Error(`unexpected URL: ${url}`);
    },
  });
  const result = await manager.reconcileExecutions({ executionIds: ['e-existing'] });
  assert.equal(result.adopted[0].execution_id, 'e-existing');
  assert.equal(result.adopted[0].sandbox_id, 'sbx-existing');
  assert.equal(result.adopted[0].binding_version, 4);
});

test('OpenSandbox normalizes the Docker provider bare Execd endpoint shape', async () => {
  const manager = createOpenSandboxManager({
    lifecycleBaseUrl: 'http://sandbox.test/v1', image: 'image:test', endpointHost: '127.0.0.1',
    fetchImpl: async (url, options) => {
      if (url.endsWith('/sandboxes')) return response({ id: 'sbx-bare-endpoint' }, { status: 202 });
      if (url.includes('/endpoints/44772')) return response({ endpoint: '172.30.0.4:40554/proxy/44772' });
      if (url === 'http://127.0.0.1:40554/proxy/44772/command') return response({ exit_code: 0, stdout: 'ok' });
      if (url.includes('/sandboxes/sbx-bare-endpoint')) return response({});
      throw new Error(`unexpected URL: ${url}`);
    },
  });
  const started = await manager.ensureExecution({ executionId: 'e-bare-endpoint' });
  assert.equal(started.execd_url, undefined);
  const result = await manager.exec({ executionId: 'e-bare-endpoint', command: 'printf ok' });
  assert.equal(result.stdout, 'ok');
  await manager.stopExecution('e-bare-endpoint');
});

test('OpenSandbox readiness falls back to Execd v1.1 ping when ready is absent', async () => {
  const calls = [];
  const manager = createOpenSandboxManager({
    lifecycleBaseUrl: 'http://sandbox.test/v1', image: 'image:test', waitForExecdReady: true,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith('/sandboxes')) return response({ id: 'sbx-ping-ready' }, { status: 202 });
      if (url.includes('/endpoints/44772')) return response({ endpoint: '127.0.0.1:40555/proxy/44772' });
      if (url === 'http://127.0.0.1:40555/proxy/44772/ready') return response({}, { status: 404 });
      if (url === 'http://127.0.0.1:40555/proxy/44772/ping') return response({});
      if (url.includes('/sandboxes/sbx-ping-ready')) return response({});
      throw new Error(`unexpected URL: ${url}`);
    },
  });
  await manager.ensureExecution({ executionId: 'e-ping-ready' });
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
      if (url.includes('/sandboxes/sbx-session')) return response({});
      throw new Error(`unexpected URL: ${url}`);
    },
  });
  await manager.ensureExecution({ executionId: 'e-session' });
  const result = await manager.exec({ executionId: 'e-session', command: 'echo ok', env: { CONTEXT_URL: 'http://context' }, internalEnvironment: { CONTEXT_TOKEN: 'secret-token' } });
  assert.equal(result.stdout, 'ok');
  const runCall = calls.find((call) => call.url.endsWith('/session/session-1/run'));
  assert.deepEqual(JSON.parse(runCall.options.body).envs, { CONTEXT_URL: 'http://context', CONTEXT_TOKEN: 'secret-token' });
  assert.equal(calls.some((call) => call.url.endsWith('/session/session-1/run')), true);
  await manager.stopExecution('e-session');
});
