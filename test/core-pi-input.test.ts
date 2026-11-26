import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { provider } from './fixtures/core-pi-transport.js';
import { createNotesService, notesManifest } from './fixtures/core-notes-service.js';

// Controlled OpenSandbox and Docker boundary, with the actual Core adapter.
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/src/core/opensandbox-backend.js') &&
      /\/runtime\/(opensandbox-manager|docker-agent-network|docker-agent-disk)\.js$/.test(specifier)) {
    return { url: new URL('./fixtures/core-pi-transport.js', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { createRuntime } = await import('@murm/core');
const { createPiOpenSandboxBackend } = await import('@murm/core/backends/pi-opensandbox');
const { ServiceRegistry } = await import('@murm/core/services');
hooks.deregister();

async function setup(t, { upstreamUrl = 'http://127.0.0.1:1/v1/responses', services = new ServiceRegistry(), permissions = {}, writable = true, maxAgents = 1, upstreamHeaders = {} } = {}) {
  provider.reset();
  const outputDir = await mkdtemp(join(tmpdir(), 'core-pi-input-'));
  const runtime = await createRuntime({
    backend: createPiOpenSandboxBackend({
      sandbox: { lifecycleBaseUrl: 'http://127.0.0.1:1/v1' },
      bridge: { host: '127.0.0.1', publicUrl: 'http://172.17.0.1:{port}' },
      modelGateway: { host: '127.0.0.1', advertiseHost: '172.17.0.1' },
      models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: upstreamUrl, headers: upstreamHeaders } } },
      isolation: { network: 'local-docker', disk: { bytes: 32 * 1024 ** 2, inodes: 2048 } },
    }),
    profiles: { worker: { prompt: 'fixed', model: 'default', image: 'test', writable, services: permissions } },
    services, maxAgents, outputDir,
  });
  t.after(async () => { await runtime.close(); await rm(outputDir, { recursive: true, force: true }); });
  return { runtime, outputDir, agent: await runtime.spawn({ requestId: 'spawn', profile: 'worker' }) };
}

function bridgeCall(agentId, operation = 'list_services', payload = {}) {
  const startup = provider.starts.get(agentId);
  return fetch(startup.env.MURM_BRIDGE_URL.replace('172.17.0.1', '127.0.0.1') + '/call', {
    method: 'POST', headers: { authorization: `Bearer ${startup.secretEnvironment.MURM_BRIDGE_TOKEN}`,
      'content-type': 'application/json' }, body: JSON.stringify({ operation, operation_id: 'fixed-operation', ...payload }),
  });
}

test('adapter receipt recovery never repeats a prompt after a socket failure', async t => {
  const { runtime, agent } = await setup(t);
  provider.wait = async () => { throw Object.assign(new Error('lost socket'), { code: 'SERVICE_UNAVAILABLE' }); };
  const unknown = await runtime.send(agent.id, 'fixed', { requestId: 'one' });
  assert.equal(unknown.status, 'unknown');
  provider.responses.set(unknown.inputId, { response: { id: unknown.inputId, command: 'prompt', success: true, data: { disposition: 'started' } }, records: [] });
  const accepted = await runtime.send(agent.id, 'fixed', { requestId: 'one' });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.inputId, unknown.inputId);
  assert.equal(provider.messages.filter(message => message.type === 'prompt').length, 1);
  assert.equal(provider.messages.filter(message => message.type === 'get_rpc_result').length, 1);
});

test('prompt acknowledgement replays unread Worker prefix before its own response', async t => {
  const { runtime, agent } = await setup(t);
  const events = [];
  runtime.onEvent(event => events.push(event));
  provider.publish({ type: 'agent_start' });
  provider.wrapperReplay = true;
  provider.wait = async message => {
    const response = { type: 'response', id: message.id, command: 'prompt', success: true, data: { disposition: 'started' } };
    provider.publish(response);
    provider.responses.set(message.id, { response });
    provider.publish({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'fast' }], stopReason: 'stop' } });
    provider.publish({ type: 'agent_settled' });
  };
  const receipt = await runtime.send(agent.id, 'fixed', { requestId: 'unread-prefix' });
  assert.equal(receipt.status, 'accepted');
  assert.equal(events.some(event => event.type === 'error'), false);
  assert.equal(events.find(event => event.type === 'settled')?.output, 'fast');
  assert.equal((await runtime.get(agent.id)).status, 'idle');
});

test('Run evidence preserves actual native execution and tool boundaries with Worker identity', async t => {
  const { runtime, agent, outputDir } = await setup(t, { upstreamHeaders: { authorization: 'Bearer native-private-marker' } });
  provider.wrapperReplay = true;
  provider.wait = async message => {
    provider.publish({ type: 'agent_start', worker_at: '2026-11-25T10:00:00.000Z' });
    provider.publish({ type: 'tool_execution_start', worker_at: '2026-11-25T10:00:01.000Z', toolCallId: 'tool-1', toolName: 'bash', args: { command: 'echo native-private-marker', apiKey: 'field-private-marker' } });
    provider.publish({ type: 'tool_execution_end', worker_at: '2026-11-25T10:00:02.000Z', toolCallId: 'tool-1', toolName: 'bash', result: { content: [{ type: 'text', text: 'hello' }] }, isError: false });
    provider.publish({ type: 'agent_settled', worker_at: '2026-11-25T10:00:03.000Z' });
    provider.responses.set(message.id, { response: { id: message.id, command: 'prompt', success: true, data: { disposition: 'started' } } });
  };
  await runtime.send(agent.id, 'fixed', { requestId: 'native-boundaries' });
  await runtime.close();
  const records = (await readFile(join(outputDir, runtime.id, 'evidence.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const native = records.filter(row => row.type === 'native');
  assert.deepEqual(native.map(row => row.eventType), ['agent_start', 'tool_execution_start', 'tool_execution_end', 'agent_settled']);
  assert.deepEqual(native.map(row => row.workerSequence), [1, 2, 3, 4]);
  assert.equal(native[0].schemaVersion, 1);
  assert.equal(native[0].agentId, agent.id);
  assert.equal(native[0].workerAt, '2026-11-25T10:00:00.000Z');
  assert.equal(native[1].event.toolCallId, 'tool-1');
  assert.equal(native[1].event.args.command, 'echo [redacted]');
  assert.equal(native[1].event.args.apiKey, '[redacted]');
  assert.equal(native[2].event.result.content[0].text, 'hello');
  assert.equal(native[3].outcome, 'completed');
  assert.equal(typeof native[0].runtimeId, 'string');
});

test('a response for another input cannot establish acceptance or rejection', async t => {
  const { runtime, agent } = await setup(t);
  provider.wait = async message => provider.responses.set(message.id, { response: {
    id: 'other-input', command: 'prompt', success: false, error: 'unrelated rejection',
  } });
  const receipt = await runtime.send(agent.id, 'fixed', { requestId: 'wrong-response' });
  assert.equal(receipt.status, 'unknown');
});

test('handled receipt cannot restore idle after actual Pi execution begins', async t => {
  const { runtime, agent } = await setup(t);
  const events = [];
  runtime.onEvent(event => events.push(event));
  provider.wrapperReplay = true;
  provider.wait = async message => {
    provider.publish({ type: 'agent_start' });
    provider.publish({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Active execution output' }], stopReason: 'toolUse' } });
    provider.responses.set(message.id, { response: { id: message.id, command: 'prompt', success: true, data: { disposition: 'handled' } } });
  };
  const receipt = await runtime.send(agent.id, '/local-command', { requestId: 'execution-before-handled' });
  assert.equal(receipt.disposition, 'handled');
  const snapshot = await runtime.get(agent.id);
  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.latestOutput, 'Active execution output');
  assert.deepEqual(events.map(event => event.type), ['output']);
});

test('unknown original submission stays unknown when receipt lookup loses authorization or the Agent closes', async t => {
  const { runtime, agent } = await setup(t);
  const first = await runtime.send(agent.id, 'fixed', { requestId: 'uncertain' });
  assert.equal(first.status, 'unknown');
  provider.queryError = Object.assign(new Error('query unavailable'), { code: 'NOT_ALLOWED' });
  assert.deepEqual(await runtime.send(agent.id, 'fixed', { requestId: 'uncertain' }), first);
  await runtime.stop(agent.id);
  assert.deepEqual(await runtime.send(agent.id, 'fixed', { requestId: 'uncertain' }), first);
  assert.equal(provider.messages.filter(message => message.type === 'prompt').length, 1);
});

test('execution boundaries clear old output and preserve aborted outcome', async t => {
  const { runtime, agent } = await setup(t);
  const events = [];
  runtime.onEvent(event => events.push(event));
  provider.publish({ type: 'agent_start' });
  provider.publish({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'old' }], stopReason: 'stop' } });
  provider.publish({ type: 'agent_settled' });
  provider.publish({ type: 'agent_start' });
  provider.publish({ type: 'agent_settled' });
  provider.publish({ type: 'agent_start' });
  provider.publish({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'aborted' } });
  provider.publish({ type: 'agent_settled' });
  const deadline = Date.now() + 1000;
  while (events.filter(event => event.type === 'settled').length < 3 && Date.now() < deadline) await delay(10);
  const settled = events.filter(event => event.type === 'settled');
  assert.equal(settled[0].output, 'old');
  assert.equal(settled[1].output, '');
  assert.equal(settled[2].outcome, 'aborted');
});

test('lost Worker history emits a fatal gap and never fabricates a later settled snapshot', async t => {
  const { runtime, agent } = await setup(t);
  const events = [];
  runtime.onEvent(event => events.push(event));
  provider.records.push({ type: 'agent_settled', worker_sequence: 9 });
  const deadline = Date.now() + 2500;
  while (!events.some(event => event.type === 'error' && event.fatal) && Date.now() < deadline) await delay(10);
  const gap = events.find(event => event.type === 'error');
  assert.equal(gap?.fatal, true);
  assert.match(gap.error.message, /gap/);
  assert.equal(events.some(event => event.type === 'settled'), false);
  await assert.rejects(runtime.send(agent.id, 'unsafe fresh input', { requestId: 'after-gap' }), { code: 'NOT_ALLOWED' });
  const closed = await runtime.close();
  const rows = (await readFile(closed.evidence.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const traceGap = rows.find(row => row.type === 'trace-gap');
  assert.equal(traceGap.agentId, agent.id);
  assert.equal(traceGap.expectedWorkerSequence, 1);
  assert.equal(traceGap.observedWorkerSequence, 9);
  assert.equal(rows.some(row => row.type === 'native' && row.eventType === 'agent_settled'), false);
});

test('a fatal history gap fences authority before subscribers while preserving receipts and owned cleanup', async t => {
  const { runtime, agent } = await setup(t, { writable: false });
  const unknown = await runtime.send(agent.id, 'original input', { requestId: 'original' });
  assert.equal(unknown.status, 'unknown');
  assert.equal((await bridgeCall(agent.id)).status, 200);
  let observed;
  const fatal = new Promise(resolve => runtime.onEvent(event => {
    if (event.type === 'error' && event.fatal) {
      observed = { event, snapshot: runtime.get(agent.id), denied: bridgeCall(agent.id) };
      resolve();
    }
  }));
  provider.records.push({ type: 'agent_settled', worker_sequence: 9 });
  await fatal;
  assert.equal((await observed.denied).status, 403);
  const snapshot = await observed.snapshot;
  assert.equal(snapshot.cursor, observed.event.seq);
  assert.match(snapshot.lastError.message, /gap/);
  assert.equal(snapshot.status, 'running'); // No evidence that Pi physically exited.
  await assert.rejects(runtime.send(agent.id, 'fresh input', { requestId: 'fresh' }), { code: 'NOT_ALLOWED' });
  await assert.rejects(runtime.files.prepare(agent.id, { requestId: 'prepare', files: {} }), { code: 'NOT_ALLOWED' });
  await assert.rejects(runtime.spawn({ profile: 'worker', parentId: agent.id, requestId: 'child' }), { code: 'NOT_ALLOWED' });
  await assert.rejects(runtime.spawn({ profile: 'worker', requestId: 'before-cleanup' }), { code: 'CONFLICT' });
  provider.responses.set(unknown.inputId, { response: { id: unknown.inputId, command: 'prompt', success: true, data: { disposition: 'started' } }, records: [] });
  assert.deepEqual(await runtime.send(agent.id, 'original input', { requestId: 'original' }), {
    inputId: unknown.inputId, status: 'accepted', disposition: 'started',
  });
  assert.equal(provider.messages.filter(message => message.type === 'prompt').length, 1);
  const stopped = await runtime.stop(agent.id);
  assert.equal(stopped.execution, 'stopped');
  assert.equal(stopped.cleanup, 'complete');
  assert.equal((await runtime.get(agent.id)).status, 'closed');
  provider.records = []; // The replacement has its own Worker record history.
  assert.equal((await runtime.spawn({ profile: 'worker', requestId: 'replacement' })).status, 'idle');
});

test('a fatal history gap revokes a held model stream and denies new model requests', { timeout: 5000 }, async t => {
  let requests = 0;
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the local scripted request. */ }
    requests++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: response.created\ndata: {"type":"response.created"}\n\n');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const { runtime, agent } = await setup(t, { upstreamUrl: `http://127.0.0.1:${upstream.address().port}/v1/responses` });
  const start = provider.starts.get(agent.id);
  const url = start.env.PI_KIMI_PROXY_BASE_URL.replace('172.17.0.1', '127.0.0.1') + '/responses';
  const call = requestId => fetch(url, { method: 'POST', headers: {
    authorization: `Bearer ${start.secretEnvironment.PI_KIMI_PROXY_API_KEY}`,
    'content-type': 'application/json', 'x-murm-request-id': requestId,
  }, body: JSON.stringify({ model: 'k3', input: 'fixed' }) });
  const response = await call('held');
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  const streamClosed = reader.read().then(value => value.done, () => true);
  const fatal = new Promise(resolve => runtime.onEvent(event => { if (event.fatal) resolve(); }));
  provider.records.push({ type: 'agent_settled', worker_sequence: 9 });
  await fatal;
  assert.equal(await streamClosed, true);
  assert.equal((await call('after-fatal')).status, 401);
  assert.equal(requests, 1);
});

test('fatal revocation cancels only its own pending Service and preserves unknown write outcomes', { timeout: 5000 }, async t => {
  const pending = new Map();
  let ready;
  const entered = new Promise(resolve => { ready = resolve; });
  const services = new ServiceRegistry();
  services.registerService({ manifest: {
    id: 'notes', title: 'Notes', purpose: 'Store a fixed note', provider_version: '1', contract_version: '2',
    endpoint: { transport: 'in-process' }, capabilities: [{
      name: 'put', operation: 'put', description: 'Store a note', side_effect: 'write', idempotent: true,
      help: { when: 'Store a note' }, input_schema: { type: 'object', properties: {}, additionalProperties: false },
      output_schema: { type: 'string' }, errors: [],
    }],
  }, adapter: { invoke: ({ caller, signal }) => new Promise(resolve => {
    pending.set(caller.agentId, { signal, resolve });
    if (pending.size === 2) ready();
  }) } });
  const { runtime, agent } = await setup(t, { services, permissions: { notes: ['put'] }, maxAgents: 2 });
  const other = await runtime.spawn({ profile: 'worker', requestId: 'other' });
  const firstWrite = bridgeCall(agent.id, 'put', { service_id: 'notes', payload: {} });
  const otherWrite = bridgeCall(other.id, 'put', { service_id: 'notes', payload: {} });
  await entered;
  provider.wait = async message => provider.responses.set(message.id, {
    response: { id: message.id, command: 'prompt', success: true, data: { disposition: 'started' } },
    records: [{ type: 'agent_settled', worker_sequence: 9 }],
  });
  await runtime.send(agent.id, 'trigger fixed gap', { requestId: 'gap' });
  assert.equal(pending.get(agent.id).signal.aborted, true);
  assert.equal(pending.get(other.id).signal.aborted, false);
  pending.get(agent.id).resolve('late result'); // Adapter did not roll back an already-started write.
  pending.get(other.id).resolve('other result');
  const failed = await firstWrite;
  assert.equal(failed.status, 503);
  const failure = await failed.json();
  assert.equal(failure.error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(failure.error.details.request_outcome, 'unknown');
  assert.equal(failure.error.details.operation_id, 'fixed-operation');
  assert.deepEqual(await (await otherWrite).json(), { ok: true, result: 'other result' });
  assert.equal((await bridgeCall(other.id)).status, 200);
});

test('a recoverable polling error preserves live Agent authority', { timeout: 5000 }, async t => {
  const { runtime, agent } = await setup(t);
  const error = new Promise(resolve => runtime.onEvent(event => { if (event.type === 'error') resolve(event); }));
  provider.pollError = Object.assign(new Error('controlled poll interruption'), { code: 'SERVICE_UNAVAILABLE' });
  assert.equal((await error).fatal, false);
  provider.pollError = undefined;
  assert.equal((await bridgeCall(agent.id)).status, 200);
  provider.wait = async message => provider.responses.set(message.id, {
    response: { id: message.id, command: 'prompt', success: true, data: { disposition: 'handled' } }, records: [],
  });
  assert.equal((await runtime.send(agent.id, 'after recovery', { requestId: 'recovered' })).status, 'accepted');
  assert.equal((await runtime.get(agent.id)).status, 'idle');
});

test('a healthy parent can still inspect and stop its fatal child', async t => {
  const { runtime, agent: parent } = await setup(t, { permissions: { agent: ['get', 'stop'] }, maxAgents: 2 });
  const child = await runtime.spawn({ profile: 'worker', parentId: parent.id, requestId: 'child' });
  provider.wait = async message => provider.responses.set(message.id, {
    response: { id: message.id, command: 'prompt', success: true, data: { disposition: 'started' } },
    records: [{ type: 'agent_settled', worker_sequence: 9 }],
  });
  await runtime.send(child.id, 'fixed gap', { requestId: 'gap' });
  const inspect = await bridgeCall(parent.id, 'get', { service_id: 'agent', payload: { agent_id: child.id } });
  assert.equal(inspect.status, 200);
  const snapshot = (await inspect.json()).result;
  assert.equal(snapshot.id, child.id);
  assert.match(snapshot.lastError.message, /gap/);
  assert.equal(Object.hasOwn(snapshot, 'unavailable'), false);
  const stopped = await bridgeCall(parent.id, 'stop', { service_id: 'agent', payload: { agent_id: child.id } });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).result.cleanup, 'complete');
  assert.equal((await bridgeCall(parent.id)).status, 200);
});

test('private Pi compaction and retry events retain the Session and expose a failed turn for Environment policy', { timeout: 5000 }, async t => {
  const { runtime, agent } = await setup(t);
  provider.wait = async message => {
    provider.responses.set(message.id, { response: { id: message.id, command: 'prompt', success: true,
      data: { disposition: 'started' } }, records: [] });
  };
  assert.equal((await runtime.send(agent.id, 'fixed private-memory input', { requestId: 'private-memory' })).status, 'accepted');
  const settled = Promise.withResolvers();
  runtime.onEvent(event => { if (event.type === 'settled') settled.resolve(event); });
  provider.publish({ type: 'agent_start' });
  for (let index = 0; index < 4; index++) {
    provider.publish({ type: 'compaction_start' });
    provider.publish({ type: 'compaction_end', result: { tokensBefore: 1000, estimatedTokensAfter: 900 }, context_window: 1000 });
  }
  provider.publish({ type: 'compaction_end', result: null, aborted: false });
  provider.publish({ type: 'auto_retry_end', success: false, finalError: 'context token length exceeded' });
  provider.publish({ type: 'message_end', message: { role: 'assistant', stopReason: 'error',
    errorMessage: 'context length exceeded', content: [] } });
  provider.publish({ type: 'agent_settled' });
  const event = await settled.promise;
  assert.equal(event.outcome, 'failed');
  assert.equal(event.error.code, 'MODEL_ERROR');
  assert.equal((await runtime.get(agent.id)).status, 'idle');
  assert.equal(provider.starts.size, 1);
  assert.equal(provider.messages.filter(message => message.type === 'prompt').length, 1);
  assert.equal((await runtime.send(agent.id, 'explicit next input', { requestId: 'explicit-next' })).status, 'accepted');
  assert.equal(provider.starts.size, 1);
  assert.equal(provider.messages.filter(message => message.type === 'prompt').length, 2);
});

test('Gateway records both request bodies and complete success, rejection and interruption traces privately', { timeout: 6_000 }, async t => {
  const remoteSecret = 'remote-api-credential';
  const received = [];
  const upstream = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const payload = JSON.parse(text);
    received.push(payload);
    if (payload.input === 'reject') {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { detail: 'full rejection', echo: remoteSecret } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (payload.input === 'interrupt') {
      response.write('event: response.created\ndata: {"type":"response.created"}\n\n');
      return;
    }
    const event = { type: 'response.completed', response: { status: 'completed', model: 'k3',
      usage: { input_tokens: 20, output_tokens: 2 }, echo: remoteSecret, unicode: '中文😀' } };
    const bytes = Buffer.from('data: ' + JSON.stringify(event) + '\n\n');
    const boundary = bytes.indexOf(remoteSecret) + 7;
    response.write(bytes.subarray(0, boundary));
    await delay(30);
    response.end(bytes.subarray(boundary));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const { runtime, outputDir, agent } = await setup(t, {
    upstreamUrl: `http://127.0.0.1:${upstream.address().port}/v1/responses`,
    upstreamHeaders: { authorization: `Bearer ${remoteSecret}` },
  });
  const start = provider.starts.get(agent.id);
  const agentToken = start.secretEnvironment.PI_KIMI_PROXY_API_KEY;
  const base = start.env.PI_KIMI_PROXY_BASE_URL.replace('172.17.0.1', '127.0.0.1');
  const call = (id, input, signal) => fetch(base + '/responses', { method: 'POST', signal, headers: {
    authorization: `Bearer ${agentToken}`, 'content-type': 'application/json', 'x-murm-request-id': id,
  }, body: JSON.stringify({ input }) });
  const previousCall = { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{}' };
  const emptyAssistant = { type: 'message', id: 'msg_empty', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: '', annotations: [] }] };
  const toolOutput = { type: 'function_call_output', call_id: 'call_1', output: agentToken };
  await (await call('success', [previousCall, emptyAssistant, toolOutput])).text();
  assert.equal((await call('reject', 'reject')).status, 429);
  const abort = new AbortController();
  const partial = await call('interrupt', 'interrupt', abort.signal);
  const reader = partial.body.getReader();
  assert.equal((await reader.read()).done, false);
  abort.abort();
  await assert.rejects(reader.read());
  await runtime.close();
  const directory = join(outputDir, runtime.id, 'model-trace');
  const traces = new Map();
  for (const id of await readdir(directory)) {
    const path = join(directory, id);
    const contents = await Promise.all(['request.json', 'response.txt', 'result.json'].map(async filename => {
      assert.equal((await stat(join(path, filename))).mode & 0o777, 0o600);
      return readFile(join(path, filename), 'utf8');
    }));
    assert.ok(contents.every(value => !value.includes(remoteSecret) && !value.includes(agentToken)));
    const [request, response, result] = [JSON.parse(contents[0]), contents[1], JSON.parse(contents[2])];
    assert.equal(request.agentId, agent.id);
    assert.ok(result.endedAt >= request.startedAt);
    traces.set(request.requestId, { request, response, result });
  }
  assert.equal(traces.size, 3);
  assert.deepEqual(traces.get('success').request.before.input[1], emptyAssistant);
  assert.equal(received[0].input.length, 2);
  assert.deepEqual(traces.get('success').request.after.input, [previousCall, { ...toolOutput, output: '[redacted]' }]);
  assert.match(traces.get('success').response, /中文😀/);
  assert.deepEqual(traces.get('success').result.usage, { inputTokens: 20, outputTokens: 2 });
  assert.match(traces.get('reject').response, /full rejection/);
  assert.equal(traces.get('reject').result.upstreamStatus, 429);
  assert.match(traces.get('interrupt').response, /response.created/);
  assert.equal(traces.get('interrupt').result.reason, 'transport_interrupted');
});

test('public observation cuts a consistent snapshot and replays fast execution after its cursor', { timeout: 5000 }, async t => {
  const { runtime, agent, outputDir } = await setup(t);
  const subscription = runtime.observe();
  t.after(() => subscription.events.return());
  assert.equal(subscription.snapshot.runtimeState, 'open');
  assert.equal(subscription.snapshot.agents.find(item => item.id === agent.id)?.status, 'idle');
  provider.wrapperReplay = true;
  provider.wait = async message => {
    provider.publish({ type: 'agent_start' });
    provider.publish({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'body stored in Trace' }], stopReason: 'stop' } });
    provider.publish({ type: 'agent_settled' });
    provider.responses.set(message.id, { response: { id: message.id, command: 'prompt', success: true, data: { disposition: 'started' } } });
  };

  const receipt = await runtime.send(agent.id, 'private input text', { requestId: 'observe-fast' });
  const resumed = runtime.observe({ after: subscription.snapshot.cursor });
  t.after(() => resumed.events.return());
  assert.equal(resumed.snapshot, null);
  const updates = [];
  for await (const update of resumed.events) {
    assert.notEqual(update.type, 'gap');
    updates.push(update);
    if (update.type === 'input' && update.state === 'accepted') break;
  }
  const live = [];
  for (const _ of updates) live.push((await subscription.events.next()).value);
  assert.deepEqual(live, updates);
  const started = updates.find(item => item.type === 'execution' && item.phase === 'started');
  const settled = updates.find(item => item.type === 'execution' && item.phase === 'settled');
  assert.ok(started);
  assert.ok(settled);
  assert.equal(started.agent.execution, 'active');
  assert.equal(settled.agent.execution, 'inactive');
  assert.equal(started.association, 'unknown');
  assert.equal(settled.association, 'unknown');
  const accepted = updates.at(-1);
  assert.equal(accepted.requestId, 'observe-fast');
  assert.equal(accepted.inputId, receipt.inputId);
  assert.ok(accepted.cursor.sequence > started.cursor.sequence);
  assert.doesNotMatch(JSON.stringify(updates), /body stored in Trace|private input text/);
  await runtime.close();
  const records = (await readFile(join(outputDir, runtime.id, 'evidence.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.find(row => row.seq === started.recordSeq)?.eventType, 'agent_start');
  assert.equal(records.find(row => row.seq === settled.recordSeq)?.eventType, 'agent_settled');
});

test('a slow cursor gets a gap while a fast subscriber and cancellation remain independent', { timeout: 5000 }, async t => {
  const { runtime, agent } = await setup(t);
  const slow = runtime.observe();
  const fast = runtime.observe();
  const abort = new AbortController();
  const cancelled = runtime.observe({ signal: abort.signal });
  t.after(() => { slow.cancel(); fast.cancel(); cancelled.cancel(); });
  const cancelledWait = cancelled.events.next();
  abort.abort();
  assert.deepEqual(await cancelledWait, { done: true, value: undefined });
  provider.wait = async message => {
    provider.responses.set(message.id, { response: { id: message.id, command: 'prompt', success: true, data: { disposition: 'handled' } } });
  };
  const other = runtime.observe();
  const left = (async () => {
    for await (const _ of other.events) throw new Error('consumer isolated');
  })();
  const failed = assert.rejects(left, /consumer isolated/);

  for (let index = 0; index < 90; index++) {
    const requestId = `observe-burst-${index}`;
    await runtime.send(agent.id, 'fixed', { requestId });
    const received = [];
    for (let step = 0; step < 3; step++) received.push((await fast.events.next()).value);
    assert.deepEqual(received.map(update => update.state), ['registered', 'dispatched', 'accepted']);
    assert.ok(received.every(update => update.requestId === requestId));
  }
  await failed;
  const gap = (await slow.events.next()).value;
  assert.equal(gap.type, 'gap');
  assert.equal(gap.reason, 'slow-consumer');
  assert.deepEqual(gap.after, slow.snapshot.cursor);
  assert.equal((await slow.events.next()).done, true);

  const expired = runtime.observe({ after: slow.snapshot.cursor });
  t.after(() => expired.cancel());
  assert.equal((await expired.events.next()).value.reason, 'cursor-expired');
  assert.throws(() => runtime.observe({ after: { runtimeId: 'another-runtime', sequence: 0 } }), { code: 'INVALID_CONTRACT' });
  const fresh = runtime.observe();
  fresh.cancel();
  assert.equal(fresh.snapshot.agents.find(item => item.id === agent.id)?.status, 'idle');
});

test('public observation reports durable evidence loss alongside real-time observations', { timeout: 5000 }, async t => {
  const { runtime, agent, outputDir } = await setup(t);
  const subscription = runtime.observe();
  t.after(() => subscription.cancel());
  const evidence = join(outputDir, runtime.id, 'evidence.jsonl');
  while (true) {
    const check = runtime.observe();
    check.cancel();
    if (!check.snapshot.evidence.pending) break;
    await delay(1);
  }
  await rm(evidence);
  await mkdir(evidence);
  await runtime.send(agent.id, 'fixed', { requestId: 'observe-evidence-loss' });
  let lost;
  for await (const update of subscription.events) {
    if (update.type === 'persistence') { lost = update; break; }
  }
  assert.ok(lost.evidence.lost > 0);
  const snapshot = runtime.observe();
  snapshot.cancel();
  assert.ok(snapshot.snapshot.evidence.lost >= lost.evidence.lost);
  const receipt = await runtime.close();
  assert.equal(receipt.cleanup, 'pending');
  assert.ok(receipt.pending.some(item => item.error?.code === 'EVIDENCE_INCOMPLETE'));
});

test('public observation continues across pending and retried Runtime close', { timeout: 5000 }, async t => {
  const { runtime, agent, outputDir } = await setup(t);
  const subscription = runtime.observe();
  t.after(() => subscription.cancel());
  const summary = join(outputDir, runtime.id, 'runtime.json');
  await rm(summary);
  await mkdir(summary);
  const pending = await runtime.close();
  assert.equal(pending.cleanup, 'pending');
  const during = runtime.observe();
  during.cancel();
  assert.equal(during.snapshot.runtimeState, 'closing');
  assert.equal(during.snapshot.cleanup, 'pending');
  assert.equal(during.snapshot.agents.find(item => item.id === agent.id)?.cleanup?.status, 'complete');
  await rm(summary, { recursive: true });
  const closed = await runtime.close();
  assert.equal(closed.cleanup, 'complete');
  const states = [];
  for await (const update of subscription.events) {
    if (update.type === 'runtime') {
      states.push(update.runtimeState);
      if (update.runtimeState === 'closed') break;
    }
  }
  assert.deepEqual(states, ['closing', 'closing', 'closing', 'closed']);
  assert.equal(JSON.parse(await readFile(summary, 'utf8')).status, 'closed');
});

test('public Service observation matches the durable Bridge attempt identity', { timeout: 5000 }, async t => {
  const services = new ServiceRegistry();
  services.registerService({ manifest: notesManifest(), adapter: createNotesService().adapter });
  const { runtime, agent, outputDir } = await setup(t, { services, permissions: { notes: ['put'] } });
  const subscription = runtime.observe();
  t.after(() => subscription.cancel());
  const response = await bridgeCall(agent.id, 'put', { service_id: 'notes', payload: { key: 'trace', text: 'private note body' } });
  assert.equal(response.ok, true);
  const updates = [];
  for await (const update of subscription.events) {
    if (update.type === 'service') {
      updates.push(update);
      if (update.state === 'settled') break;
    }
  }
  assert.deepEqual(updates.map(update => update.state), ['validation', 'validation', 'invocation', 'settled']);
  assert.equal(new Set(updates.map(update => update.attemptId)).size, 1);
  assert.ok(updates.every(update => update.operationId === 'fixed-operation' && update.agentId === agent.id));
  assert.doesNotMatch(JSON.stringify(updates), /private note body/);
  await runtime.close();
  const records = (await readFile(join(outputDir, runtime.id, 'evidence.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  for (const update of updates) assert.equal(records.find(row => row.seq === update.recordSeq)?.attemptId, update.attemptId);
});

test('a spawn crossing the snapshot cursor is visible before the new Agent starts work', { timeout: 5000 }, async t => {
  const { runtime, agent } = await setup(t, { maxAgents: 2 });
  const observation = runtime.observe();
  t.after(() => observation.cancel());
  assert.deepEqual(observation.snapshot.agents.map(item => item.id), [agent.id]);
  const child = await runtime.spawn({ requestId: 'observe-child', profile: 'worker', parentId: agent.id });
  const statuses = [];
  for await (const item of observation.events) {
    if (item.type !== 'agent' || item.agent.id !== child.id) continue;
    assert.equal(item.agent.parentId, agent.id);
    statuses.push(item.agent.status);
    if (item.agent.status === 'idle') break;
  }
  assert.equal(statuses[0], 'starting');
  assert.equal(statuses.at(-1), 'idle');
});

test('an executor exit during a turn clears the public execution state', { timeout: 5000 }, async t => {
  const { runtime, agent } = await setup(t);
  const observation = runtime.observe();
  t.after(() => observation.cancel());
  provider.wrapperReplay = true;
  provider.wait = async message => {
    provider.publish({ type: 'agent_start' });
    provider.publish({ type: 'worker_exit', code: 1 });
    provider.responses.set(message.id, { response: { id: message.id, command: 'prompt', success: true, data: { disposition: 'started' } } });
  };
  await runtime.send(agent.id, 'fixed', { requestId: 'observe-exited-execution' });
  let exit;
  for await (const update of observation.events) {
    if (update.type === 'agent' && update.cause === 'exit') { exit = update; break; }
  }
  const replay = runtime.observe();
  replay.cancel();
  assert.equal(exit.agent.status, 'exited');
  assert.equal(exit.agent.execution, 'inactive');
  assert.deepEqual(replay.snapshot.agents.find(item => item.id === agent.id), exit.agent);
});
