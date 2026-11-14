import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { runSwarmCli } from '../src/cli/swarm-cli.js';

test('swarm CLI exposes offline help at every level', async () => {
  let output = '';
  const stdout = { write: (value) => { output += value; } };
  assert.equal(await runSwarmCli(['--help'], { stdout }), 0);
  assert.match(output, /SWARMENV_<SERVICE>_SERVICE_URL/);
  output = '';
  await runSwarmCli(['task', 'view', '--help'], { stdout });
  assert.match(output, /Required: <task-id>/);
  assert.match(output, /--timeout-ms/);
});

test('swarm task command discovers a manifest and sends a typed JSON request', async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push({ url: request.url, method: request.method, body: request.method === 'POST' ? JSON.parse(await new Promise((resolve) => { let value = ''; request.on('data', (chunk) => { value += chunk; }); request.on('end', () => resolve(value)); })) : null });
    if (request.url === '/v1/manifest') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, result: { service_id: 'task', endpoint: { url: `http://127.0.0.1:${server.address().port}` }, capabilities: [{ name: 'task_view', operation: 'task_view', method: 'POST', path: '/v1/task_view' }] } }));
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, result: { task_id: 'task-1', state: 'OPEN' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const previous = process.env.SWARMENV_TASK_SERVICE_URL;
  process.env.SWARMENV_TASK_SERVICE_URL = endpoint;
  try {
    let output = '';
    await runSwarmCli(['task', 'view', '--task-id', 'task-1', '--json'], { stdout: { write: (value) => { output += value; } } });
    assert.match(output, /task-1/);
    const invocation = requests.find((request) => request.url === '/v1/task_view');
    assert.equal(invocation.body.input.task_id, 'task-1');
    assert.equal(invocation.body.envelope.actor_ref.startsWith('cli:'), true);
  } finally {
    if (previous === undefined) delete process.env.SWARMENV_TASK_SERVICE_URL;
    else process.env.SWARMENV_TASK_SERVICE_URL = previous;
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
  const previous = process.env.SWARMENV_JUDGE_SERVICE_URL;
  process.env.SWARMENV_JUDGE_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
  const output = [];
  try {
    const result = await runSwarmCli(['judge', 'result', '--check-result-id', 'check-1'], {
      stdout: { write: (value) => output.push(value) },
    });
    assert.equal(result, 3);
    assert.match(output.join(''), /source_failure/);
  } finally {
    if (previous === undefined) delete process.env.SWARMENV_JUDGE_SERVICE_URL;
    else process.env.SWARMENV_JUDGE_SERVICE_URL = previous;
    server.close();
  }
});
