import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { runSwarmCli } from '../src/cli/swarm-cli.js';

for (const contractVersion of [undefined, '2']) for (const timeoutMs of [undefined, 2_430_000]) test(`swarm take preserves its request ID after transport loss (Bridge: ${contractVersion ?? 'legacy'}, timeout: ${timeoutMs ?? 'default'})`, async t => {
  let invocation; let calls = 0; let metadataCalls = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    if (input.operation === 'get_service_metadata') {
      metadataCalls++;
      response.end(JSON.stringify({ ok: true, result: { capabilities: [{ operation: 'task_take', timeout_ms: 30_000 }] } }));
      return;
    }
    invocation = input; calls++;
    request.socket.destroy();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const restore = ['MURM_BRIDGE_URL', 'MURM_BRIDGE_TOKEN', 'MURM_BRIDGE_CONTRACT_VERSION'].map(key => [key, process.env[key]]);
  t.after(() => {
    for (const [key, value] of restore) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.MURM_BRIDGE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.MURM_BRIDGE_TOKEN = 'local-test-credential';
  if (contractVersion) process.env.MURM_BRIDGE_CONTRACT_VERSION = contractVersion;
  else delete process.env.MURM_BRIDGE_CONTRACT_VERSION;
  const args = ['task', 'take', 'task-1', ...(timeoutMs ? ['--timeout-ms', String(timeoutMs)] : [])];
  await assert.rejects(runSwarmCli(args), error => {
    assert.equal(invocation.operation, 'task_take');
    assert.equal(invocation.service_id, contractVersion ? 'task' : undefined);
    assert.equal(calls, 1);
    assert.equal(metadataCalls, contractVersion ? 1 : 0);
    assert.match(invocation.operation_id, /^cli:take:/);
    assert.equal(error.details.request_id, invocation.operation_id);
    assert.equal(error.details.request_outcome, 'unknown');
    assert.equal(error.details.operation, 'task_take');
    assert.ok(error.details.notice.includes(invocation.operation_id));
    return true;
  });
});

test('swarm CLI exposes offline help at every level', async () => {
  let output = '';
  const stdout = { write: (value) => { output += value; } };
  assert.equal(await runSwarmCli(['--help'], { stdout }), 0);
  assert.match(output, /MURM_<SERVICE>_SERVICE_URL/);
  assert.match(output, /task create\|list\|view/);
  output = '';
  await runSwarmCli(['task', '--help'], { stdout });
  assert.match(output, /create\|list\|view/);
  output = '';
  await runSwarmCli(['task', 'create', '--help'], { stdout });
  assert.match(output, /high, medium, or low/);
  assert.match(output, /--acceptance-conditions '\["[^"]+"\]'/);
  assert.match(output, /task\.task_id/);
  output = '';
  await runSwarmCli(['task', 'view', '--help'], { stdout });
  assert.match(output, /Required: <task-id>/);
  assert.match(output, /--timeout-ms/);
  output = '';
  assert.doesNotMatch(output, /task propose/);
  output = '';
  await runSwarmCli(['material', 'consume', '--help'], { stdout });
  assert.match(output, /--material-ids '\["M1"\]' --action integration --impact/);
  assert.match(output, /route, task, workspace, integration/);
  output = '';
  await runSwarmCli(['mission', 'submission', 'view', '--help'], { stdout });
  assert.match(output, /view \[id\].*\nWithout an ID, read current Mission state/);
  await assert.rejects(runSwarmCli(['context', 'publish'], { stdout }), /unknown command group/);
  await assert.rejects(runSwarmCli(['context', '--help'], { stdout }), /unknown command group/);
});

test('swarm task command discovers a manifest and sends a typed JSON request', async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push({ url: request.url, method: request.method, body: request.method === 'POST' ? JSON.parse(await new Promise((resolve) => { let value = ''; request.on('data', (chunk) => { value += chunk; }); request.on('end', () => resolve(value)); })) : null });
    if (request.url === '/v1/manifest') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, result: { service_id: 'task', endpoint: { url: `http://127.0.0.1:${server.address().port}` },
        capabilities: ['task_view'].map(operation => ({ name: operation, operation, method: 'POST', path: `/v1/${operation}` })) } }));
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, result: { task_id: 'task-1', state: 'OPEN' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const previous = process.env.MURM_TASK_SERVICE_URL;
  process.env.MURM_TASK_SERVICE_URL = endpoint;
  try {
    let output = '';
    await runSwarmCli(['task', 'view', '--task-id', 'task-1', '--json'], { stdout: { write: (value) => { output += value; } } });
    assert.match(output, /task-1/);
    const invocation = requests.find((request) => request.url === '/v1/task_view');
    assert.equal(invocation.body.input.task_id, 'task-1');
    assert.equal(invocation.body.envelope.actor_ref.startsWith('cli:'), true);
    await assert.rejects(runSwarmCli(['task', 'propose', '--base-revision', '0.2']), /unknown task command/);
    assert.ok(!requests.some(request => request.url === '/v1/task_create'));
  } finally {
    if (previous === undefined) delete process.env.MURM_TASK_SERVICE_URL;
    else process.env.MURM_TASK_SERVICE_URL = previous;
    server.close();
  }
});

test('swarm CLI gives a checker business FAIL its distinct exit code', async () => {
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/manifest') {
      response.end(JSON.stringify({ ok: true, result: { service_id: 'judge', endpoint: { url: `http://127.0.0.1:${server.address().port}` }, capabilities: [{ name: 'get_check_result', operation: 'get_check_result', method: 'POST', path: '/v1/get_check_result' }] } }));
      return;
    }
    response.end(JSON.stringify({ ok: true, result: { result_class: 'source_failure', verdict: 'FAIL' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const previous = process.env.MURM_JUDGE_SERVICE_URL;
  process.env.MURM_JUDGE_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
  const output = [];
  try {
    const result = await runSwarmCli(['judge', 'result', '--check-result-id', 'check-1'], {
      stdout: { write: (value) => output.push(value) },
    });
    assert.equal(result, 3);
    assert.match(output.join(''), /source_failure/);
  } finally {
    if (previous === undefined) delete process.env.MURM_JUDGE_SERVICE_URL;
    else process.env.MURM_JUDGE_SERVICE_URL = previous;
    server.close();
  }
});

test('swarm CLI retains resource-limit diagnosis, location and nonretryable guidance', async () => {
  const feedback = { verdict: 'ERROR', result_class: 'infrastructure_failure', mathematical_outcome: 'unassessed',
    diagnostic_code: 'lean_resource_limit', retryable: false,
    diagnostic_location: { file: 'src/Toy.lean', line: 3, column: 1 }, diagnostic_excerpt: 'maximum number of heartbeats reached' };
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, result: request.url === '/v1/manifest'
      ? { service_id: 'judge', endpoint: { url: `http://127.0.0.1:${server.address().port}` },
        capabilities: [{ name: 'get_check_result', operation: 'get_check_result', method: 'POST', path: '/v1/get_check_result' }] }
      : feedback }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const previous = process.env.MURM_JUDGE_SERVICE_URL;
  process.env.MURM_JUDGE_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
  const output = [];
  try {
    const exitCode = await runSwarmCli(['judge', 'result', '--check-result-id', 'check-resource'], {
      stdout: { write: value => output.push(value) },
    });
    assert.notEqual(exitCode, 3);
    assert.deepEqual(JSON.parse(output.join('')), feedback);
  } finally {
    if (previous === undefined) delete process.env.MURM_JUDGE_SERVICE_URL;
    else process.env.MURM_JUDGE_SERVICE_URL = previous;
    server.close();
  }
});

test('Mission CLI submits an explicit empty Material selection', async t => {
  const invocations = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    invocations.push(JSON.parse(body));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, result: { submitted: true } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const keys = ['MURM_BRIDGE_URL', 'MURM_BRIDGE_TOKEN'];
  const before = keys.map(key => [key, process.env[key]]);
  t.after(() => { for (const [key, value] of before) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  Object.assign(process.env, { MURM_BRIDGE_URL: `http://127.0.0.1:${server.address().port}`, MURM_BRIDGE_TOKEN: 'local-test' });
  await assert.rejects(runSwarmCli(['mission', 'submit', '--request-id', 'implicit-materials'], { stdout: { write() {} } }), /explicit/);
  assert.equal(invocations.length, 0);
  await runSwarmCli(['mission', 'submit', '--materials', '[]', '--request-id', 'stable-final'], { stdout: { write() {} } });
  assert.deepEqual(invocations[0], { operation: 'mission_submit', operation_id: 'stable-final', payload: { material_ids: [] } });
  for (const [args, payload] of [[[], {}], [['submission:fixed'], { submission_id: 'submission:fixed' }]]) {
    const output = [];
    await runSwarmCli(['mission', 'submission', 'view', ...args, '--request-id', 'read-submission'],
      { stdout: { write: value => output.push(value) } });
    assert.deepEqual(invocations.at(-1), { operation: 'mission_submission_get', operation_id: 'read-submission', payload });
    assert.deepEqual(JSON.parse(output.join('')), { submitted: true });
  }
});

test('deployment check HTTP allowance is scoped and explicit timeout still wins', async t => {
  const keys = ['MURM_BRIDGE_URL', 'MURM_BRIDGE_TOKEN', 'MURM_CLI_CHECK_REQUEST_TIMEOUT_MS'];
  const restore = keys.map(key => [key, process.env[key]]);
  t.after(() => { for (const [key, value] of restore) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the fixed local request */ }
    setTimeout(() => { response.setHeader('content-type', 'application/json'); response.end('{}'); }, 80);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  process.env.MURM_BRIDGE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.MURM_BRIDGE_TOKEN = 'local-test';
  process.env.MURM_CLI_CHECK_REQUEST_TIMEOUT_MS = '10';
  let help = '';
  await runSwarmCli(['judge', 'check', '--help'], { stdout: { write(value) { help += value; } } });
  assert.match(help, /HTTP request \(default 10\)/);
  help = '';
  await runSwarmCli(['task', 'view', '--help'], { stdout: { write(value) { help += value; } } });
  assert.match(help, /HTTP request \(default 30000\)/);
  const stdout = { write() {} };
  await assert.rejects(runSwarmCli(['judge', 'check'], { stdout }), { code: 'SERVICE_TIMEOUT' });
  assert.equal(await runSwarmCli(['task', 'view', 'task-1'], { stdout }), 0);
  assert.equal(await runSwarmCli(['judge', 'check', '--timeout-ms', '1000'], { stdout }), 0);
  process.env.MURM_CLI_CHECK_REQUEST_TIMEOUT_MS = 'invalid';
  await assert.rejects(runSwarmCli(['judge', 'check'], { stdout }), /timeout-ms must be between/);
});
