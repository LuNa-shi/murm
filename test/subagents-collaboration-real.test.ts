import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { runSubagentsEnvironment } from '../examples/subagents-environment/main.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { streamResponse } from './fixtures/core-controlled-upstream.js';

test('normal Subagents resumes a waiting parent after the first child and accepts live user input', {
  skip: process.env.SWARMENV_SUBAGENTS_COLLABORATION_TEST !== '1' && 'Requires local Pi/OpenSandbox',
  timeout: 150_000,
}, async t => {
  const image = process.env.SWARMENV_CORE_TEST_IMAGE;
  assert.ok(image);
  const outputDir = join(process.cwd(), 'experiments', 'subagents-collaboration-' + Date.now());
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  let arrivals = 0;
  let upstreamError;
  let slowStarted = false;
  let slowFinished = false;
  let firstResultObserved = false;
  let supplementObserved = false;
  let releaseSlow;
  const slowMayFinish = new Promise(resolve => { releaseSlow = resolve; });

  function tool(id, command, timeout = 22) {
    return { type: 'function_call', name: 'bash', id: 'fc_' + id, call_id: id, arguments: JSON.stringify({ command, timeout }) };
  }
  function text(id, value) {
    return { type: 'message', id, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: value, annotations: [] }] };
  }
  const call = (op, args, id) => tool(id, `printf '%s' '${JSON.stringify(args)}' | swarm collaboration ${op} --stdin --request-id ${id}`);
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const number = ++arrivals;
      assert.ok(number <= 30);
      const users = body.input.filter(item => item.role === 'user')
        .flatMap(item => item.content ?? []).map(item => item.text ?? '');
      const output = id => body.input.find(item => item.type === 'function_call_output' && item.call_id === id)?.output;
      const userContains = value => users.some(item => item.includes(value));
      const contains = value => JSON.stringify(body.input).includes(value);
      let result;
      if (userContains('GRANDCHILD_TASK')) {
        assert.equal(userContains('ROOT_TASK'), false, 'none starts without the inherited root task');
        result = text('grandchild', 'GRANDCHILD_RESULT');
      } else if (userContains('FAST_CHILD_TASK')) {
        assert.ok(userContains('ROOT_TASK'), 'all includes the real inherited parent task');
        if (contains('GRANDCHILD_RESULT')) {
          assert.ok(contains('/root/fast/grand'));
          result = text('fast', 'FIRST_CHILD_RESULT');
        } else if (!output('spawn-grand')) {
          result = call('spawn_agent', { task_name: 'grand', message: 'GRANDCHILD_TASK', fork_turns: 'none' }, 'spawn-grand');
        } else {
          assert.ok(JSON.stringify(output('spawn-grand')).includes('/root/fast/grand'));
          result = call('wait_agent', { timeout_ms: 10_000 }, 'wait-grand');
        }
      } else if (userContains('SLOW_CHILD_TASK')) {
        slowStarted = true;
        await slowMayFinish;
        slowFinished = true;
        result = text('slow', 'SLOW_CHILD_RESULT');
      } else if (userContains('HOST_SUPPLEMENT')) {
        supplementObserved = true;
        releaseSlow();
        result = text('root-final', 'ROOT_WITH_SUPPLEMENT');
      } else if (!output('spawn-fast')) {
        result = call('spawn_agent', { task_name: 'fast', message: 'FAST_CHILD_TASK' }, 'spawn-fast');
      } else if (!output('spawn-slow')) {
        result = call('spawn_agent', { task_name: 'slow', message: 'SLOW_CHILD_TASK', fork_turns: 'none' }, 'spawn-slow');
      } else if (contains('FIRST_CHILD_RESULT') && !firstResultObserved) {
        assert.ok(contains('/root/fast'));
        const deadline = Date.now() + 3_000;
        while (!slowStarted && Date.now() < deadline) await delay(25);
        assert.ok(slowStarted && !slowFinished, 'the other Child is still executing when Root sees the first result');
        firstResultObserved = true;
        result = call('wait_agent', { timeout_ms: 10_000 }, 'wait-user');
      } else {
        assert.equal(output('wait-first') !== undefined, false, 'Root did not receive an empty first wait');
        result = call('wait_agent', { timeout_ms: 10_000 }, 'wait-first');
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(streamResponse('k3', number, result));
    } catch (error) {
      upstreamError = error;
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    releaseSlow();
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const host = process.env.SWARMENV_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const config = { image, outputDir, maxAgents: 4, maxDepth: 2, workTimeoutMs: 60_000, closeTimeoutMs: 25_000, goal: 'ROOT_TASK',
    backend: {
      sandbox: { lifecycleBaseUrl: process.env.SWARMENV_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
        endpointHost: process.env.SWARMENV_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', apiKey: process.env.SWARMENV_CORE_TEST_API_KEY },
      bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` },
      modelGateway: { host: '0.0.0.0', advertiseHost: host, maxOutputTokens: 512, requestTimeoutMs: 25_000 },
      models: { default: { provider: 'kimi_proxy', model: 'k3',
        upstream: { url: `http://127.0.0.1:${server.address().port}/v1/responses`, headers: {} } } },
      isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
    },
  };
  const report = await runSubagentsEnvironment(config, undefined, async (env, signal) => {
    for (;;) {
      signal.throwIfAborted();
      if (upstreamError) throw upstreamError;
      const state = env.collaborationState();
      if (firstResultObserved && state.members.some(member => member.botId === env.rootId && member.waiting)) break;
      await delay(25, undefined, { signal });
    }
    const receipt = await env.input('HOST_SUPPLEMENT', 'host-supplement');
    assert.equal(receipt.status, 'accepted');
    const reply = await env.waitForReply({ signal });
    assert.equal(reply.output, 'ROOT_WITH_SUPPLEMENT');
    return { rootId: env.rootId, final: reply.output };
  });
  assert.equal(upstreamError, undefined);
  assert.equal(report.businessFailure, null, JSON.stringify(report.businessFailure));
  assert.equal(report.cleanupFailure, null);
  assert.equal(report.reportSaveFailure, null);
  assert.ok(supplementObserved);
  assert.deepEqual(report.collaboration.members.map(member => member.path).sort(), ['/root', '/root/fast', '/root/fast/grand', '/root/slow']);
  assert.equal(report.cleanup.bots.length, 4);
  assert.equal((await ownedContainers(report.runtimeId)).length, 0);
  const serviceTrace = await readFile(join(outputDir, report.runtimeId, 'service-calls.jsonl'), 'utf8');
  assert.match(serviceTrace, /wait-user/);
});
