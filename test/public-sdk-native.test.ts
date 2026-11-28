import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { streamResponse } from './fixtures/core-controlled-upstream.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { createNativeEvidenceDirectory, execute, preparePackageArchive } from './fixtures/notes-installed-package.js';

const requestLimit = 6;
const marker = 'SDK_HANDOFF_STAGE_OK';
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const call = (op: string, payload: unknown, operationId: string) =>
  `printf '%s' ${quote(JSON.stringify(payload))} | swarm messages ${op} --stdin --request-id ${operationId}`;

type Scenario = 'in-process' | 'external' | 'without-handoff' | 'cancelled';

async function scriptedResponses(t, executor: 'pi' | 'codex', mode: Scenario) {
  const model = executor === 'pi' ? 'k3' : 'gpt-5.4';
  const observations = [];
  let failed: unknown;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/responses');
      assert.ok(observations.length < requestLimit);
      const payload = await new Response(request).json();
      const user = payload.input.filter(item => item.role === 'user').at(-1);
      const input = typeof user.content === 'string' ? user.content : user.content.map(item => item.text).join('');
      const [_, role, key] = /^(Publish|Receive) (handoff-[\da-f-]+):/.exec(input) ?? [];
      assert.ok(key);
      assert.doesNotMatch(input, /[a-f0-9]{48}/);
      const callId = `sdk_${role.toLowerCase()}`;
      const toolReply = payload.input.find(item => item.type === 'function_call_output' && item.call_id === callId)?.output;
      const commands = role === 'Publish'
        ? [
          `if ${call('get', { key }, 'sdk-denied')} > denied.json 2>&1; then exit 73; fi`,
          "jq -e '.code == \"CLI_ERROR\"' denied.json >/dev/null",
          ...(mode === 'external' ? [
            `if ${call('put', { key: 'lost', text: 'write survived the lost reply' }, 'lost-response-write')} > lost.json 2>&1; then exit 74; fi`,
            "jq -e '.details.request_outcome == \"unknown\" and .details.operation_id == \"lost-response-write\"' lost.json >/dev/null",
          ] : []),
          ...(mode === 'without-handoff' || mode === 'cancelled' ? []
            : [`swarm messages put --input handoff-input.json --request-id ${key}-put >/dev/null`]),
        ]
        : [
          `if ${call('get', { key: 17 }, 'sdk-bad-parameter')} > bad.json 2>&1; then exit 75; fi`,
          "jq -e '.code == \"SERVICE_INPUT_INVALID\"' bad.json >/dev/null",
          `swarm messages get --key ${key} --request-id ${key}-get | jq -er .text > received.txt`,
        ];
      const command = `set -euo pipefail; ${commands.join('; ')}; printf '%s\\n' ${marker}`;
      let item;
      if (toolReply !== undefined) {
        assert.ok(toolReply.trim().endsWith(marker));
        assert.doesNotMatch(toolReply, /[a-f0-9]{48}/);
        item = { type: 'message', id: `message_${role}`, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: marker, annotations: [] }] };
      } else {
        const args = executor === 'pi' ? { command, timeout: 30 } : { cmd: command, yield_time_ms: 10000, max_output_tokens: 2048 };
        item = { type: 'function_call', id: `function_${role}`, call_id: callId,
          name: executor === 'pi' ? 'bash' : 'exec_command', arguments: JSON.stringify(args) };
      }
      observations.push({ role, key, toolReply: toolReply !== undefined });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(streamResponse(model, observations.length, item));
    } catch (error) {
      failed = error;
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Controlled SDK response failed its expected application protocol' } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  return { url: `http://127.0.0.1:${server.address().port}/v1/responses`, model, observations, failure: () => failed };
}

test('a clean external project typechecks and runs the same public handoff on Pi, Codex and the existing HTTP Service', {
  skip: process.env.MURM_SDK_NATIVE_REAL !== '1' && 'Requires the local OpenSandbox acceptance environment',
  timeout: 240_000,
}, async t => {
  const image = process.env.MURM_CORE_TEST_IMAGE;
  assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  const evidence = await createNativeEvidenceDirectory('public-sdk');
  const project = await mkdtemp(join(tmpdir(), 'murm-public-sdk-consumer-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const root = resolve(import.meta.dirname, '../..');
  assert.ok(relative(root, await realpath(project)).startsWith('..'));
  const packed = await preparePackageArchive(evidence, undefined, { requireCleanCheckout: true });
  const packageSha256 = createHash('sha256').update(await readFile(packed.archive)).digest('hex');
  const typeScriptVersion = JSON.parse(await readFile(join(root, 'node_modules/typescript/package.json'), 'utf8')).version;
  const nodeTypesVersion = JSON.parse(await readFile(join(root, 'node_modules/@types/node/package.json'), 'utf8')).version;
  await writeFile(join(project, 'package.json'), JSON.stringify({ type: 'module', private: true }));
  const env = { ...process.env };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  await execute('npm', ['install', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund', packed.archive,
    `typescript@${typeScriptVersion}`, `@types/node@${nodeTypesVersion}`], { cwd: project, env, timeout: 90_000 });
  const installed = join(project, 'node_modules/@luna-shi/murm');
  assert.equal((await lstat(installed)).isSymbolicLink(), false);
  for (const name of ['handoff.ts', 'handoff-config.ts', 'messages.ts', 'tsconfig.handoff.json']) {
    await copyFile(join(installed, 'examples/messages', name), join(project, name));
  }
  await execute(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.handoff.json'], { cwd: project, env });
  const pins = { sourceCommit: packed.sourceCommit, packageSha256, image, typeScriptVersion, nodeTypesVersion,
    hostNodeVersion: process.version };
  const results = [];
  for (const [executor, mode, source = 'installed'] of [
    ['pi', 'in-process'], ['codex', 'in-process'], ['pi', 'external'], ['pi', 'without-handoff'], ['pi', 'cancelled'],
    ['pi', 'in-process', 'checkout'],
  ] as const) {
    await t.test(`${executor} ${mode} (${source})`, async scenario => {
      let external: { url: string; token: string } | undefined;
      if (mode === 'external') {
        const token = randomBytes(24).toString('hex');
        const child = fork(new URL('./fixtures/issue-236-message-server.js', import.meta.url), [], {
          env: { MURM_TEST_MESSAGE_TOKEN: token }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        scenario.after(() => child.kill());
        const [port] = await once(child, 'message', { signal: AbortSignal.timeout(5_000) });
        external = { url: `http://127.0.0.1:${port}`, token };
      }
      const upstream = await scriptedResponses(scenario, executor, mode);
      const output = join(evidence, `${executor}-${mode}-${source}`);
      let entry = source === 'installed' ? 'build/handoff.js' : 'dist/examples/messages/handoff.js';
      if (mode === 'without-handoff' || mode === 'cancelled') {
        entry = 'fixture.mjs';
        await writeFile(join(project, entry), `
import { handoffConfig } from './build/handoff-config.js';
import { runMessageHandoff } from './build/handoff.js';
const config = handoffConfig();
config.workTimeoutMs = ${mode === 'without-handoff' ? 12000 : 45000};
const abort = new AbortController();
const result = await runMessageHandoff(config, abort.signal, update => {
  if (${mode === 'cancelled'} && update.type === 'output') abort.abort();
});
process.stdout.write(JSON.stringify(result));
`);
      }
      const { stdout, stderr } = await execute(process.execPath, [entry], {
        cwd: source === 'installed' ? project : root, timeout: 95_000, env: {
        ...env,
        MURM_SDK_IMAGE: image,
        MURM_SDK_EXECUTOR: executor,
        MURM_SDK_LIFECYCLE_URL: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
        MURM_SDK_ENDPOINT_HOST: process.env.MURM_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1',
        MURM_SDK_LIFECYCLE_TOKEN: process.env.MURM_CORE_TEST_API_KEY,
        MURM_SDK_ADVERTISE_HOST: process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1',
        MURM_SDK_MODEL_URL: upstream.url, MURM_SDK_MODEL_ID: upstream.model, MURM_SDK_MODEL_TOKEN: '',
        MURM_SDK_MODEL_PROVIDER: executor === 'pi' ? 'kimi_proxy' : 'openai',
        MURM_SDK_OUTPUT: output, MURM_SDK_MESSAGE_URL: external?.url, MURM_SDK_MESSAGE_TOKEN: external?.token,
      } });
      const { report, submissions, key } = JSON.parse(stdout);
      assert.equal(upstream.failure(), undefined);
      assert.equal(report.coreClose.status, 'complete');
      assert.equal(report.reportSaveFailure, null);
      assert.deepEqual(await ownedContainers(report.runtimeId), []);
      const runDir = join(output, report.runtimeId);
      const events = (await readFile(join(runDir, 'evidence.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const sandboxes = events.filter(row => row.type === 'spawn' && row.state === 'ready');
      assert.deepEqual(sandboxes.map(row => row.agentId), submissions.map(item => item.agentId));
      assert.equal(new Set(sandboxes.map(row => row.sandboxId)).size, submissions.length);
      for (const { sandboxId, versions } of sandboxes) {
        assert.match(sandboxId, /^[a-f0-9-]+$/);
        assert.ok(versions[`${executor}Version`] && versions.nodeVersion);
      }
      const { reportPath, ...savedFields } = report;
      assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), savedFields);
      if (mode === 'without-handoff' || mode === 'cancelled') {
        assert.equal(report.business.status, mode === 'without-handoff' ? 'failed' : 'cancelled');
        assert.equal(report.business.error.code, mode === 'without-handoff' ? 'HANDOFF_SERVICE_UNCONFIRMED' : 'HANDOFF_CANCELLED');
        assert.equal(submissions.length, 1);
        assert.equal(report.artifactVerification.status, mode === 'without-handoff' ? 'failed' : 'not-requested');
        if (mode === 'without-handoff') assert.deepEqual(upstream.observations.map(item => item.role), ['Publish', 'Publish']);
        else assert.ok(upstream.observations.every(item => item.role === 'Publish'));
      } else {
        assert.match(stderr, /^settled$/m);
        assert.equal(report.business.status, 'completed');
        assert.equal(report.artifactVerification.status, 'passed');
        assert.equal(submissions.length, 2);
        assert.notEqual(submissions[0].agentId, submissions[1].agentId);
        assert.deepEqual(upstream.observations.map(item => item.role), ['Publish', 'Publish', 'Receive', 'Receive']);
        const trace = (await readFile(join(runDir, 'service-calls.jsonl'), 'utf8'))
          .trim().split('\n').map(line => JSON.parse(line));
        const publish = trace.find(row => row.phase === 'settled' && row.operation_id === `${key}-put`);
        const received = trace.find(row => row.phase === 'settled' && row.operation_id === `${key}-get`);
        assert.equal(publish.caller.agentId, submissions[0].agentId);
        assert.equal(received.caller.agentId, submissions[1].agentId);
        assert.equal(publish.output.text, received.output.text);
        const files = report.coreClose.receipt.agents.find(row => row.agentId === submissions[1].agentId)
          .artifacts.find(path => path.endsWith('/artifacts/files'));
        assert.equal(await readFile(join(files, 'received.txt'), 'utf8'), `${received.output.text}\n`);
        if (external) {
          const response = await fetch(`${external.url}/fixture`, { headers: { authorization: `Bearer ${external.token}` } });
          const state = await response.json();
          assert.equal(state.original.text, 'pre-existing service data');
          assert.equal(state.unknown.text, 'write survived the lost reply');
          assert.deepEqual(state.calls.map(call => call.operationId), ['lost-response-write', `${key}-put`, `${key}-get`]);
          assert.doesNotMatch(JSON.stringify(trace), new RegExp(external.token));
        }
      }
      results.push({ executor, mode, source, runtimeId: report.runtimeId, business: report.business.status,
        report: relative(evidence, report.reportPath), artifact: report.artifactVerification.status,
        submissions: submissions.length, cleanup: report.coreClose.status, sandboxes: sandboxes.map(row => row.versions) });
    });
  }
  await t.test('installed Codex rejects unsupported Context Fork authority before allocation', async () => {
    await writeFile(join(project, 'unsupported.mjs'), `
import assert from 'node:assert/strict';
import { createRuntime, createSandbox, getExecutorCapabilities, ServiceRegistry } from '@luna-shi/murm';
import { handoffConfig } from './build/handoff-config.js';
const config = handoffConfig();
assert.equal(getExecutorCapabilities(config.executor).contextFork, false);
await assert.rejects(createRuntime({ sandbox: createSandbox(config.sandbox), executor: config.executor, models: config.models, connection: config.connection, services: new ServiceRegistry(), maxAgents: 1, outputDir: config.outputDir,
  profiles: { worker: { model: 'default', image: config.image, writable: true, services: {}, allowContextFork: true } } }), error => {
  assert.equal(error.code, 'INVALID_CONTRACT');
  assert.equal(error.cleanup, 'complete');
  assert.match(error.message, /does not support Profile Context Fork authority/);
  process.stdout.write(error.runtimeId);
  return true;
});
`);
    const output = join(evidence, 'unsupported');
    const { stdout: runtimeId } = await execute(process.execPath, ['unsupported.mjs'], { cwd: project, env: {
      ...env, MURM_SDK_IMAGE: image, MURM_SDK_EXECUTOR: 'codex', MURM_SDK_OUTPUT: output,
      MURM_SDK_MODEL_ID: 'gpt-5.4', MURM_SDK_MODEL_URL: 'http://127.0.0.1:1/v1/responses',
      MURM_SDK_LIFECYCLE_URL: 'http://127.0.0.1:1/v1', MURM_SDK_MESSAGE_URL: '',
    } });
    assert.match(runtimeId, /^[a-f0-9-]+$/);
    await assert.rejects(readdir(output), { code: 'ENOENT' });
    assert.deepEqual(await ownedContainers(runtimeId), []);
    results.push({ executor: 'codex', mode: 'unsupported-context-fork', rejection: 'INVALID_CONTRACT', allocations: 0 });
  });
  await writeFile(join(evidence, 'acceptance.json'), JSON.stringify({ ...pins, results }, null, 2) + '\n', { mode: 0o600 });
  t.diagnostic(`Fixed installed SDK evidence: ${evidence}`);
});
