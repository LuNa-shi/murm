import { runtimeSettings } from './fixtures/core-runtime-settings.js';
import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createRuntime } from '@luna-shi/murm';
import { ServiceRegistry } from '@luna-shi/murm';

import { createMessageService } from '../examples/messages/messages.js';
import { createGhIssuesService } from '../examples/services/github-issues/index.js';
import { runInput } from '../src/harness/run-input.js';
import { streamResponse } from './fixtures/core-controlled-upstream.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';

const execute = promisify(execFile);
const marker = 'BRIDGE_SERVICE_VERIFIED';
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
const call = (service, operation, input, request) =>
  `printf '%s' ${quote(JSON.stringify(input))} | swarm ${service} ${operation} --stdin --request-id ${request}`;

function failure(command, query) {
  return `if ${command} > cli-error.json 2>&1; then exit 73; fi; jq -e ${quote(query)} cli-error.json >/dev/null`;
}

function bridgeDenied(service, operation, payload, operationId) {
  const body = quote(JSON.stringify({ service_id: service, operation, payload, operation_id: operationId }));
  return `curl -sS -H "Authorization: Bearer $MURM_BRIDGE_TOKEN" -H 'Content-Type: application/json' --data ${body} "$MURM_BRIDGE_URL/call" | jq -e '.error.code == "NOT_ALLOWED"' >/dev/null`;
}

async function openHarness(t, label, registrations, profiles, commands) {
  const image = process.env.MURM_CORE_TEST_IMAGE;
  assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  const outputDir = join(process.cwd(), 'experiments', `issue-236-${label}-${Date.now()}`);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  let requests = 0;
  const upstream = createServer(async (request, response) => {
    try {
      const body = await new Response(request).json();
      const user = body.input.filter(item => item.role === 'user').at(-1);
      const name = typeof user.content === 'string' ? user.content : user.content.map(item => item.text).join('');
      const script = commands[name];
      assert.ok(script && request.url === '/v1/responses' && ++requests <= 2 * Object.keys(commands).length);
      const callId = `bash_${name}`;
      const reply = body.input.find(item => item.type === 'function_call_output' && item.call_id === callId);
      let item;
      if (reply) {
        assert.equal(reply.output.trim(), marker);
        item = { type: 'message', id: `msg_${name}`, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: marker, annotations: [] }] };
      } else item = { type: 'function_call', id: `fc_${name}`, call_id: callId, name: 'bash',
        arguments: JSON.stringify({ command: `set -euo pipefail; ${script}; printf '%s\\n' ${marker}`, timeout: 35 }) };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(streamResponse('k3', requests, item));
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'The controlled Bash check did not produce its marker' } }));
    }
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.close(); upstream.closeAllConnections(); });
  const services = new ServiceRegistry();
  for (const registration of registrations) services.registerService(registration);
  for (const profile of Object.values(profiles)) Object.assign(profile, { image, model: 'default', writable: true });
  const host = process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const runtime = await createRuntime({ profiles, services, outputDir, maxAgents: Object.keys(profiles).length,
    ...runtimeSettings({ sandbox: {
      lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
      apiKey: process.env.MURM_CORE_TEST_API_KEY,
      resourceLimits: { cpu: '1', memory: '1Gi' },
    }, bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` }, modelGateway: { host: '0.0.0.0', advertiseHost: host },
    models: { default: { provider: 'kimi_proxy', model: 'k3',
      upstream: { url: `http://127.0.0.1:${upstream.address().port}/v1/responses`, headers: {} } } },
    isolation: { network: 'api' } }),
  });
  t.after(async () => {
    assert.equal((await runtime.close()).cleanup, 'complete');
    assert.deepEqual(await ownedContainers(runtime.id), []);
  });
  const turn = async (agent, name) => {
    const result = await runInput(runtime, agent.id, name, { requestId: name, timeoutMs: 60_000 });
    assert.equal(result.settled.output, marker);
  };
  return { runtime, turn, outputDir };
}

const artifact = (path: string) => ({ paths: [path], includeGit: false, maxBytes: 32_768, required: true });

async function closeHarness({ runtime, outputDir }, agent, path, credentials = []) {
  const before = await ownedContainers(runtime.id);
  assert.ok(before.length > 0);
  const close = await runtime.close();
  assert.equal(close.cleanup, 'complete');
  const folders = close.agents.find(row => row.agentId === agent.id).artifacts;
  const files = folders.find(value => value.endsWith('/artifacts/files'));
  assert.ok(files);
  const body = await readFile(join(files, path), 'utf8');
  const trace = await readFile(join(outputDir, runtime.id, 'service-calls.jsonl'), 'utf8');
  const summary = await readFile(join(outputDir, runtime.id, 'runtime.json'), 'utf8');
  for (const value of credentials) assert.ok(![trace, summary, body].some(text => text.includes(value)), 'Host credential leaked');
  const after = await ownedContainers(runtime.id);
  assert.deepEqual(after, []);
  return { body, rows: trace.trim().split('\n').map(JSON.parse).filter(row => row.phase === 'settled'), before, after };
}

for (const remote of [false, true]) test(`real Agents hand off a message through the ${remote ? 'pre-existing HTTP' : 'in-process'} Service`, {
  skip: process.env.MURM_ISSUE_236_MESSAGES_REAL !== '1', timeout: 150_000,
}, async t => {
  const secret = randomBytes(32).toString('hex');
  let url;
  const inspect = () => fetch(`${url}/fixture`, { headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(5_000) }).then(response => response.json());
  if (remote) {
    const child = fork(new URL('./fixtures/issue-236-message-server.js', import.meta.url), [], {
      env: { MURM_TEST_MESSAGE_TOKEN: secret }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    t.after(() => child.kill());
    const [port] = await once(child, 'message', { signal: AbortSignal.timeout(5_000) });
    url = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${url}/fixture`, { signal: AbortSignal.timeout(5_000) })).status, 403);
    assert.equal((await inspect()).original.text, 'pre-existing service data');
  }
  const commands = {
    WRITE: [failure(call('messages', 'get', { key: 'handoff' }, 'writer-cli-denied'), '.code == "CLI_ERROR" and (.message | contains("does not advertise capability"))'),
      bridgeDenied('messages', 'get', { key: 'handoff' }, 'writer-denied'),
      'swarm messages put --input seed.json --request-id writer-message >/dev/null',
      ...(remote ? [failure(call('messages', 'put', { key: 'lost', text: 'write survived the lost reply' }, 'lost-response-write'),
        '.code == "SERVICE_UNAVAILABLE" and .details.request_outcome == "unknown" and .details.operation_id == "lost-response-write"')] : [])].join('; '),
    READ: [failure(call('messages', 'get', { key: 123 }, 'reader-bad-input'), '.code == "SERVICE_INPUT_INVALID"'),
      `${call('messages', 'get', { key: 'handoff' }, 'reader-message')} | jq -er .text > received.txt`].join('; '),
  };
  const handoff = randomBytes(24).toString('hex');
  const harness = await openHarness(t, remote ? 'remote-messages' : 'local-messages', [createMessageService(remote ? { url, token: secret } : undefined)],
    { writer: { services: { messages: ['put'] } }, reader: { services: { messages: ['get'] }, collect: artifact('received.txt') } }, commands);
  const { runtime, turn, outputDir } = harness;
  const writer = await runtime.spawn({ profile: 'writer', requestId: 'writer', files: {
    'seed.json': { encoding: 'utf8', data: JSON.stringify({ key: 'handoff', text: handoff }) },
  } });
  const reader = await runtime.spawn({ profile: 'reader', requestId: 'reader' });
  await turn(writer, 'WRITE');
  await turn(reader, 'READ');
  const result = await closeHarness(harness, reader, 'received.txt', [secret]);
  assert.equal(result.body, `${handoff}\n`);
  assert.equal(result.rows.find(row => row.operation_id === 'writer-message').caller.agentId, writer.id);
  assert.equal(result.rows.find(row => row.operation_id === 'reader-message').caller.agentId, reader.id);
  assert.equal(result.rows.find(row => row.operation_id === 'writer-denied').error.code, 'NOT_ALLOWED');
  assert.equal(result.rows.find(row => row.operation_id === 'reader-bad-input').error.code, 'SERVICE_INPUT_INVALID');
  if (remote) {
    const after = await inspect();
    assert.equal(after.original.text, 'pre-existing service data');
    assert.equal(after.unknown.text, 'write survived the lost reply');
    assert.deepEqual(after.calls.map(row => row.operationId), ['writer-message', 'lost-response-write', 'reader-message']);
  }
  await writeFile(join(outputDir, 'acceptance.json'), JSON.stringify({ runtimeId: runtime.id, mode: remote ? 'existing-http' : 'in-process',
    writerId: writer.id, readerId: reader.id, artifactVerified: true, permissionsVerified: true, schemaVerified: true,
    ...(remote ? { externalDataRetained: true, lostWriteAppliedOnce: true } : {}), containersBefore: result.before, containersAfter: result.after }), { mode: 0o600 });
});

test('real Agent CLI authorizes a fixed read-only gh command on the application host', {
  skip: process.env.MURM_ISSUE_236_GH_REAL !== '1', timeout: 150_000,
}, async t => {
  const token = process.env.MURM_ISSUE_236_GH_TOKEN ?? (await execute('gh', ['auth', 'token'], { timeout: 5000 })).stdout.trim();
  const repository = process.env.MURM_ISSUE_236_GH_REPO ?? 'LuNa-shi/murm';
  const registration = createGhIssuesService({ repository, token });
  const query = { repository, limit: 5 };
  const commands = {
    DENIED: [failure(call('github', 'list_issues', query, 'gh-cli-denied'), '.code == "NOT_ALLOWED"'),
      bridgeDenied('github', 'list_issues', query, 'gh-profile-denied')].join('; '),
    GH: ['test -z "${GH_TOKEN+x}"', 'test -z "${GITHUB_TOKEN+x}"',
      failure(call('github', 'list_issues', { ...query, repository: 'example/unauthorized' }, 'gh-repo-denied'), '.code == "NOT_ALLOWED"'),
      failure(call('github', 'list_issues', { ...query, limit: 0 }, 'gh-bad-input'), '.code == "SERVICE_INPUT_INVALID"'),
      `${call('github', 'list_issues', query, 'gh-read')} > issues.json`, 'jq -e "length > 0" issues.json >/dev/null'].join('; '),
  };
  const harness = await openHarness(t, 'gh', [registration],
    { unauthorized: { services: {} }, reader: { services: { github: ['list_issues'] }, collect: artifact('issues.json') } }, commands);
  const { runtime, turn, outputDir } = harness;
  const unauthorized = await runtime.spawn({ profile: 'unauthorized', requestId: 'unauthorized' });
  const reader = await runtime.spawn({ profile: 'reader', requestId: 'reader' });
  await turn(unauthorized, 'DENIED');
  await turn(reader, 'GH');
  const result = await closeHarness(harness, reader, 'issues.json', [token]);
  const issues = JSON.parse(result.body);
  assert.ok(issues.length > 0 && issues.length <= 5);
  assert.ok(issues.every(item => Number.isSafeInteger(item.number) && typeof item.title === 'string'));
  assert.deepEqual(result.rows.find(row => row.operation_id === 'gh-read').output, issues);
  for (const [operation, error] of [['gh-profile-denied', 'NOT_ALLOWED'], ['gh-repo-denied', 'NOT_ALLOWED'], ['gh-bad-input', 'SERVICE_INPUT_INVALID']]) {
    assert.equal(result.rows.find(row => row.operation_id === operation).error.code, error);
  }
  const version = (await execute('gh', ['--version'], { timeout: 5000 })).stdout.split('\n')[0];
  await writeFile(join(outputDir, 'acceptance.json'), JSON.stringify({ runtimeId: runtime.id, version, repository, issueNumbers: issues.map(item => item.number),
    profileDenied: true, repositoryDenied: true, badInputDenied: true, credentialsAbsent: true,
    containersBefore: result.before, containersAfter: result.after }), { mode: 0o600 });
});
