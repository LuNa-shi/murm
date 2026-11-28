import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { test } from 'node:test';

// This function is serialized into the candidate image. Every network peer is
// loopback in that container, and every model response is scripted here.
async function nativeCodexWorkerProbe() {
  const { default: assert } = await import('node:assert/strict');
  const { spawn } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const { once } = await import('node:events');
  const { readFile, readdir } = await import('node:fs/promises');
  const { createServer } = await import('node:http');
  const { setTimeout: delay } = await import('node:timers/promises');
  const origin = 'http://127.0.0.1:44100';
  const authorization = 'Bearer local-codex-control-probe';
  const deadline = Date.now() + 50_000;
  const bodies: any[] = [];
  const held = new Map<number, any>();
  let failure: Error | undefined;
  let worker: ReturnType<typeof spawn> | undefined;

  async function until(check: () => unknown | Promise<unknown>) {
    while (!await check()) {
      if (failure) throw failure;
      assert.ok(Date.now() < deadline, 'Native Codex probe exceeded its deadline');
      await delay(10);
    }
  }

  function stream(number: number, item: any) {
    const event = (type: string, fields: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields as object })}\n\n`;
    const response = { id: `resp_control_${number}`, object: 'response', model: 'murm-control-probe', status: 'completed', output: [item],
      usage: { input_tokens: 20, output_tokens: 20, total_tokens: 40 } };
    let value = event('response.created', { response: { ...response, status: 'in_progress', output: [] } });
    value += event('response.output_item.added', { output_index: 0, item: item.type === 'function_call' ? { ...item, arguments: '' } : { ...item, content: [] } });
    if (item.type === 'function_call') {
      value += event('response.function_call_arguments.delta', { output_index: 0, item_id: item.id, delta: item.arguments });
      value += event('response.function_call_arguments.done', { output_index: 0, item_id: item.id, arguments: item.arguments });
    } else value += event('response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: item.content[0].text });
    value += event('response.output_item.done', { output_index: 0, item });
    return value + event('response.completed', { response });
  }

  const command = (id: string, cmd: string) => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name: 'exec_command',
    arguments: JSON.stringify({ cmd, yield_time_ms: 1000, max_output_tokens: 128 }) });
  const upstream = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/responses');
      assert.equal(request.headers.authorization, 'Bearer local-gateway-token');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert.ok(bytes < 2 * 1024 ** 2);
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.model, 'murm-control-probe');
      bodies.push(body);
      const number = bodies.length;
      assert.ok(number <= 5, 'Codex sent an unexpected additional native request');
      if ([1, 3].includes(number)) { held.set(number, response); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (number === 2) {
        assert.ok(JSON.stringify(body.input).includes('CONTROL_STEER'));
        response.end(stream(number, command('first', "printf '%s\\n' first >> control-count.txt")));
      } else if (number === 4) {
        assert.ok(JSON.stringify(body.input).includes('CONTROL_WAKE'));
        assert.ok(!JSON.stringify(body.input).includes('CONTROL_DISCARD'));
        response.end(stream(number, command('wakeup', "test \"$(cat control-count.txt)\" = first && printf '%s\\n' resumed >> control-count.txt")));
      } else {
        assert.ok(body.input.some((item: any) => item.type === 'function_call_output' && item.call_id === 'wakeup'));
        response.end(stream(number, { type: 'message', id: 'msg_control_done', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'CONTROL_DONE', annotations: [] }] }));
      }
    } catch (error) {
      failure = error as Error;
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: failure.message } }));
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamAddress = upstream.address() as { port: number };

  async function post(path: string, input: unknown) {
    const response = await fetch(origin + path, { method: 'POST', headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(input), signal: AbortSignal.timeout(8_000) });
    return { status: response.status, body: await response.json() as any };
  }
  const rpc = (message: unknown) => post('/rpc', { message, timeout_ms: 5_000, since: 0 });
  const records = async () => (await rpc({ type: 'get_state', since: 0 })).body.result.records as any[];

  // This single-use relay drops the first response only after the Worker has
  // produced it. Recovery must use the original input ID after that socket loss.
  const relay = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    try {
      const forwarded = await fetch(origin + '/rpc', { method: 'POST', headers: { authorization, 'content-type': 'application/json' },
        body: Buffer.concat(chunks), signal: AbortSignal.timeout(8_000) });
      await forwarded.arrayBuffer();
    } finally { response.destroy(); }
  });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  const relayAddress = relay.address() as { port: number };
  try {
    worker = spawn(process.execPath, ['/opt/murm/agent-worker.mjs', '--token', 'local-codex-control-probe'], { stdio: 'ignore' });
    await until(() => fetch(origin + '/health').then(response => response.ok, () => false));
    const started = await post('/start', { contract_version: 'murm-core-v2', resources: [], command: 'codex', args: [], writable: true,
      system_prompt: 'Execute only the explicit input and use local files for evidence.', system_prompt_path: '/workspace/runtime/profile-prompt.txt',
      codex: { model: 'murm-control-probe', baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1` }, secret_env: { OPENAI_API_KEY: 'local-gateway-token' } });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const backend = started.body.result.backend;
    assert.equal(backend.kind, 'codex');
    assert.equal(backend.version, '0.172.0');
    assert.equal(backend.authMode, 'api-key');
    const threadId = backend.threadId;
    assert.ok(typeof threadId === 'string' && threadId);
    const input = { type: 'prompt', id: 'control-initial', message: 'CONTROL_INITIAL', streamingBehavior: 'steer' };
    await assert.rejects(fetch(`http://127.0.0.1:${relayAddress.port}`, { method: 'POST', body: JSON.stringify({ message: input, timeout_ms: 5_000 }),
      signal: AbortSignal.timeout(8_000) }));
    await until(() => held.has(1));
    const recovered = await rpc({ type: 'get_rpc_result', id: input.id });
    assert.equal(recovered.body.result.state, 'complete');
    assert.equal(recovered.body.result.response.data.disposition, 'started');
    assert.equal((await rpc(input)).body.result.response.id, input.id);
    assert.equal((await rpc({ ...input, message: 'changed' })).body.code, 'CONFLICT');
    assert.equal(bodies.length, 1);
    const steer = await rpc({ type: 'steer', id: 'control-steer', message: 'CONTROL_STEER', onlyWhileActive: true });
    assert.equal(steer.body.result.response.data.disposition, 'queued');
    held.get(1).writeHead(200, { 'content-type': 'text/event-stream' });
    held.get(1).end(stream(1, { type: 'message', id: 'msg_initial_boundary', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'INITIAL_BOUNDARY', annotations: [] }] }));
    await until(() => held.has(3));
    assert.ok(JSON.stringify(bodies[1].input).includes('CONTROL_STEER'), 'Active steer was absent from the next native model request');
    const firstOutput = bodies[2].input.find((item: any) => item.type === 'function_call_output' && item.call_id === 'first');
    assert.ok(firstOutput, JSON.stringify({ inputKinds: bodies[2].input.map((item: any) => ({ type: item.type, name: item.name, call_id: item.call_id })), tools: bodies[1].tools?.map((tool: any) => ({ type: tool.type, name: tool.name })) }));
    assert.ok(!JSON.stringify(firstOutput).includes('Error'), JSON.stringify(firstOutput));
    const queued = await rpc({ type: 'follow_up', id: 'control-discard', message: 'CONTROL_DISCARD', onlyWhileActive: true });
    assert.equal(queued.body.result.response.data.disposition, 'queued');
    const interrupted = await rpc({ type: 'core_interrupt', id: 'control-interrupt', executionEpoch: 1 });
    assert.equal(interrupted.body.result.response.success, true, JSON.stringify(interrupted.body));
    assert.deepEqual(interrupted.body.result.response.data.discardedInputHashes,
      [createHash('sha256').update('CONTROL_DISCARD').digest('hex')]);
    assert.ok((await records()).some(record => record.type === 'agent_settled' && record.aborted));
    assert.equal((await rpc({ type: 'get_state', id: 'after-interrupt' })).body.result.response.data.sessionId, threadId);
    const wake = await rpc({ type: 'prompt', id: 'control-wake', message: 'CONTROL_WAKE', streamingBehavior: 'steer', executionEpoch: 1 });
    assert.equal(wake.body.result.response.data.disposition, 'started');
    await until(async () => (await records()).some(record => record.type === 'message_end' && record.message.content?.some((part: any) => part.text === 'CONTROL_DONE')));
    assert.equal(await readFile('/workspace/project/control-count.txt', 'utf8'), 'first\nresumed\n');
    assert.equal((await rpc({ type: 'get_state', id: 'after-wake' })).body.result.response.data.sessionId, threadId);
    const stopped = await post('/stop', {});
    assert.equal(stopped.body.result.stopped, true);
    const sessionNames = (await readdir('/workspace/runtime/codex-home/sessions', { recursive: true })).filter(name => name.endsWith('.jsonl'));
    assert.equal(sessionNames.length, 1);
    const native = await readFile(`/workspace/runtime/codex-home/sessions/${sessionNames[0]}`, 'utf8');
    assert.ok(native.split('\n').some(line => { try { const row = JSON.parse(line); return row.type === 'session_meta' && row.payload.id === threadId; } catch { return false; } }));
    assert.ok(!failure, failure?.message);
    console.log(JSON.stringify({ version: backend.version, nativeRequests: bodies.length, originalReceiptRecovered: true, conflict: true,
      activeSteerConsumed: true, queuedInputDiscarded: true, interrupted: true, sameThreadResumed: true, nativeSessionFiles: sessionNames.length, stopped: true }));
  } finally {
    worker?.kill('SIGTERM');
    relay.closeAllConnections(); relay.close();
    upstream.closeAllConnections(); upstream.close();
  }
}

test('native Codex Worker recovers dropped receipts, steers, interrupts and resumes its thread', {
  skip: process.env.MURM_CODEX_WORKER_REAL_TEST !== '1' && 'Opt in to the bounded local Codex CLI protocol probe',
  timeout: 80_000,
}, async t => {
  const run = promisify(execFile);
  const image = process.env.MURM_TEST_AGENT_IMAGE;
  assert.ok(image, 'MURM_TEST_AGENT_IMAGE must select the candidate Worker image');
  const imageId = (await run('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { timeout: 5_000 })).stdout.trim();
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  const probeId = randomUUID();
  const name = `murm-codex-control-${probeId}`;
  t.after(async () => {
    await run('docker', ['rm', '--force', name], { timeout: 5_000 }).catch(() => undefined);
    const remaining = await run('docker', ['ps', '--all', '--quiet', '--filter', `label=murm.codex-control-probe=${probeId}`], { timeout: 5_000 });
    assert.equal(remaining.stdout.trim(), '', 'Codex protocol probe must leave no owned container');
  });
  const result = await run('docker', ['run', '--rm', '--name', name, '--label', `murm.codex-control-probe=${probeId}`,
    '--cpus', '1', '--memory', '1g', '--pids-limit', '128', '--network', 'none', '--entrypoint', 'node', imageId,
    '--input-type=module', '-e', `await (${nativeCodexWorkerProbe.toString()})();`], { timeout: 70_000, maxBuffer: 128 * 1024 });
  assert.deepEqual(JSON.parse(result.stdout.trim()), { version: '0.172.0', nativeRequests: 5, originalReceiptRecovered: true, conflict: true,
    activeSteerConsumed: true, queuedInputDiscarded: true, interrupted: true, sameThreadResumed: true, nativeSessionFiles: 1, stopped: true });
});
