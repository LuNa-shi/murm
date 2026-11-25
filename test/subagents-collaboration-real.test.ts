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

  function tool(id, command, timeout = 35) {
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
        result = tool('team-guards', `set -eu
swarm collaboration list_agents --path-prefix /root/fast
swarm collaboration list_agents --path-prefix /root/fastest
if swarm collaboration send_message --target /other/fast --message outside --request-id outside 2>&1; then exit 31; fi
if swarm collaboration spawn_agent --task-name extra --message extra --fork-turns none --request-id extra 2>&1; then exit 32; fi`);
      } else if (output('team-guards') && !output('wait-user')) {
        const [matching, adjacent, outside, full] = String(output('team-guards')).trim().split('\n').map(JSON.parse);
        assert.deepEqual(matching.map(member => member.path).sort(), ['/root/fast', '/root/fast/grand']);
        assert.deepEqual(adjacent, []);
        assert.equal(outside.code, 'NOT_ALLOWED');
        assert.equal(full.code, 'CONFLICT');
        result = call('wait_agent', { timeout_ms: 10_000 }, 'wait-user');
      } else {
        assert.equal(output('wait-first') !== undefined, false, 'Root saw no child result before its first wait expired');
        result = call('wait_agent', { timeout_ms: 30_000 }, 'wait-first');
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
  const config = { image, outputDir, maxAgents: 4, maxDepth: 2, workTimeoutMs: 90_000, closeTimeoutMs: 25_000, goal: 'ROOT_TASK',
    backend: {
      sandbox: { lifecycleBaseUrl: process.env.SWARMENV_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
        endpointHost: process.env.SWARMENV_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', apiKey: process.env.SWARMENV_CORE_TEST_API_KEY },
      bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` },
      modelGateway: { host: '0.0.0.0', advertiseHost: host, maxOutputTokens: 512, requestTimeoutMs: 60_000 },
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

for (const workspaceMode of ['private', 'shared']) {
  test(`normal Subagents interrupts one Child and restores its notice and ${workspaceMode} files`, {
    skip: process.env.SWARMENV_SUBAGENTS_COLLABORATION_TEST !== '1' && 'Requires local Pi/OpenSandbox',
    timeout: 150_000,
  }, async t => {
    const image = process.env.SWARMENV_CORE_TEST_IMAGE;
    assert.ok(image);
    const outputDir = join(process.cwd(), 'experiments', 'subagents-continuity-' + Date.now());
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    let requests = 0;
    let upstreamError;
    let heldTool = false;
    let peerStarted = false;
    let peerFinished = false;
    let resumed = false;
    let releasePeer;
    const peerMayFinish = new Promise(resolve => { releasePeer = resolve; });
    const bash = (id, command, timeout = 20) => ({
      type: 'function_call', name: 'bash', id: 'fc_' + id, call_id: id, arguments: JSON.stringify({ command, timeout }),
    });
    const call = (op, args, id) => bash(id, `printf '%s' '${JSON.stringify(args)}' | swarm collaboration ${op} --stdin --request-id ${id}`);
    const text = (id, value) => ({ type: 'message', id, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: value, annotations: [] }] });
    const server = createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const { input } = JSON.parse(Buffer.concat(chunks).toString());
        const number = ++requests;
        assert.ok(number <= 30);
        const userText = input.filter(item => item.role === 'user').flatMap(item => item.content ?? []).map(item => item.text ?? '').join('\n');
        const output = id => input.find(item => item.type === 'function_call_output' && item.call_id === id)?.output;
        let result;
        if (userText.includes('CONTINUE_TARGET')) {
          assert.ok(userText.includes('TARGET_TASK'));
          assert.equal(userText.match(/NOTICE_IN_QUEUE/g)?.length, 1);
          assert.ok(peerStarted && !peerFinished);
          if (!output('read-target')) {
            result = bash('read-target', 'cat continuity.txt; test ! -e interrupted-marker.txt');
          } else {
            assert.equal(output('read-target').trim(), 'ORIGINAL_FILE');
            resumed = true;
            releasePeer();
            result = text('target-final', 'TARGET_CONTINUED');
          }
        } else if (userText.includes('TARGET_TASK')) {
          assert.equal(heldTool, false, 'the old execution must not get another model request');
          heldTool = true;
          result = bash('held-target', "printf '%s' ORIGINAL_FILE > continuity.txt; sleep 18; touch interrupted-marker.txt");
        } else if (userText.includes('PEER_TASK')) {
          peerStarted = true;
          await peerMayFinish;
          peerFinished = true;
          result = text('peer-final', 'PEER_CONTINUED');
        } else if (!output('target-spawn')) {
          result = call('spawn_agent', { task_name: 'target', message: 'TARGET_TASK', fork_turns: 'none' }, 'target-spawn');
        } else if (!output('peer-spawn')) {
          result = call('spawn_agent', { task_name: 'peer', message: 'PEER_TASK', fork_turns: 'none' }, 'peer-spawn');
        } else if (!output('queued-notice')) {
          const deadline = Date.now() + 2000;
          while ((!heldTool || !peerStarted) && Date.now() < deadline) await delay(25);
          assert.ok(heldTool && peerStarted);
          result = call('send_message', { target: 'target', message: 'NOTICE_IN_QUEUE' }, 'queued-notice');
        } else if (!output('target-interrupt')) {
          assert.match(String(output('queued-notice')), /queued/);
          result = call('interrupt_agent', { target: 'target' }, 'target-interrupt');
        } else if (!output('target-followup')) {
          assert.match(String(output('target-interrupt')), /interrupted/);
          result = call('followup_task', { target: 'target', message: 'CONTINUE_TARGET' }, 'target-followup');
        } else if (resumed && peerFinished) {
          if (!output('file-policy')) result = bash('file-policy', workspaceMode === 'shared'
            ? 'cat continuity.txt | tee delivery.txt'
            : "test ! -e continuity.txt && printf PRIVATE | tee delivery.txt");
          else {
            assert.equal(output('file-policy').trim(), workspaceMode === 'shared' ? 'ORIGINAL_FILE' : 'PRIVATE');
            result = text('root-final', 'CONTINUITY_OK');
          }
        } else {
          result = call('wait_agent', { timeout_ms: 10_000 }, 'closing-wait-' + number);
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(streamResponse('k3', number, result));
      } catch (error) {
        upstreamError = error;
        releasePeer();
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: String(error) } }));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      releasePeer();
      server.closeAllConnections();
      return new Promise(resolve => server.close(resolve));
    });
    const host = process.env.SWARMENV_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
    const report = await runSubagentsEnvironment({ image, outputDir, maxAgents: 3, maxDepth: 1, goal: 'CONTINUITY_ROOT',
      workTimeoutMs: 65_000, closeTimeoutMs: 25_000,
      collect: { paths: ['delivery.txt'], includeGit: false, maxBytes: 4096, required: true },
      ...(workspaceMode === 'shared' ? { workspace: { root: { id: 'team', mode: 'read-write' }, child: { id: 'team', mode: 'read-write' } } } : {}),
      backend: {
        sandbox: { lifecycleBaseUrl: process.env.SWARMENV_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
          endpointHost: process.env.SWARMENV_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', apiKey: process.env.SWARMENV_CORE_TEST_API_KEY },
        bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` },
        modelGateway: { host: '0.0.0.0', advertiseHost: host, maxOutputTokens: 512, requestTimeoutMs: 25_000 },
        models: { default: { provider: 'kimi_proxy', model: 'k3',
          upstream: { url: `http://127.0.0.1:${server.address().port}/v1/responses`, headers: {} } } },
        isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
      },
    });
    assert.equal(upstreamError, undefined);
    assert.equal(report.businessFailure, null, JSON.stringify(report.businessFailure));
    assert.equal(report.result.output, 'CONTINUITY_OK');
    assert.ok(resumed && peerFinished);
    assert.equal(report.cleanupFailure, null);
    assert.equal(report.cleanup.bots.length, 3);
    assert.ok(report.cleanup.bots.every(bot => bot.sessionArchive));
    const root = report.cleanup.bots.find(bot => bot.botId === report.result.rootId);
    const files = root.artifacts.find(path => path.endsWith('/artifacts/files'));
    assert.equal(await readFile(join(files, 'delivery.txt'), 'utf8'), workspaceMode === 'shared' ? 'ORIGINAL_FILE' : 'PRIVATE');
    assert.equal((await ownedContainers(report.runtimeId)).length, 0);
  });
}
