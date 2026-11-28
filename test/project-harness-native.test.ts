import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInstalledHarnessRpc } from './fixtures/installed-harness-rpc.js';
import { streamResponse } from './fixtures/core-controlled-upstream.js';
import { createSubstrateUpstream } from './fixtures/substrate-upstream.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { createNativeEvidenceDirectory, execute, installNativeNotesExample } from './fixtures/notes-installed-package.js';

const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

test('installed Notes and Messages use the supplied prompt and project in both Worker Sandboxes', {
  skip: process.env.MURM_PROJECT_NATIVE_TEST !== '1' && 'Requires the local OpenSandbox Worker',
  timeout: 240_000,
}, async t => {
  const image = process.env.MURM_CORE_TEST_IMAGE;
  assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  const installation = await installNativeNotesExample();
  t.after(installation.close);
  const project = join(installation.directory, 'plain-project');
  await mkdir(project);
  const evidenceDir = await createNativeEvidenceDirectory('project-handoffs');
  const prompt = 'Use the current project to identify the value in slot.txt and record the evidence.';
  const evidence = [];
  for (const scenario of ['notes', 'messages', 'messages-http'] as const) {
    await t.test(scenario, async t => {
      const id = scenario === 'notes' ? 'notes' : 'messages';
      let external: { url: string; token: string } | undefined;
      if (scenario === 'messages-http') {
        const token = randomBytes(24).toString('hex');
        const service = fork(new URL('./fixtures/issue-236-message-server.js', import.meta.url), [], {
          env: { MURM_TEST_MESSAGE_TOKEN: token }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        t.after(() => { service.kill(); });
        const [port] = await once(service, 'message', { signal: AbortSignal.timeout(5_000) });
        external = { url: `http://127.0.0.1:${port}`, token };
      }
      const value = `${scenario}-observation-from-project-file`;
      await writeFile(join(project, 'slot.txt'), value + '\n');
      let arrivals = 0;
      let failure;
      const roles: string[] = [];
      const server = createServer(async (req, res) => {
        try {
          assert.equal(req.url, '/v1/responses');
          assert.ok(++arrivals <= 6);
          const body = await new Response(req).json();
          const last = body.input.filter(row => row.role === 'user').at(-1);
          const input = typeof last.content === 'string' ? last.content : last.content.map(part => part.text).join('');
          assert.ok(input.includes(prompt));
          const reader = input.includes('murm-notes-') || input.includes('messages get');
          const followup = input.includes('murm-notes-followup-');
          const role = followup ? 'followup' : reader ? 'reader' : 'writer';
          const callId = 'project_' + role;
          const key = id === 'notes' ? 'project-observation' : /handoff-[\da-f-]+/.exec(input)?.[0];
          assert.ok(key);
          const marker = 'PROJECT_SERVICE_OK';
          const shellCheck = "set -euo pipefail; test \"$(pwd)\" = /workspace/project; test -s slot.txt;";
          const getId = id === 'notes' ? 'project-notes-get' : key + '-get';
          const putId = id === 'notes' ? 'project-notes-put' : key + '-put';
          let command: string;
          if (followup) {
            const files = JSON.parse(input);
            assert.match(files.artifact, /^murm-notes-[a-f0-9-]+\.md$/);
            assert.match(files.followup, /^murm-notes-followup-[a-f0-9-]+\.md$/);
            assert.ok(body.input.some(row => row.type === 'function_call_output' && row.call_id === 'project_reader'),
              'followup model request retains the previous reader turn');
            command = `cp -- ${files.artifact} ${files.followup}; cmp ${files.followup} slot.txt;`;
          } else if (reader) {
            const artifact = /murm-(?:notes|message)-[a-f0-9-]+\.(?:md|txt)/.exec(input)?.[0];
            assert.ok(artifact);
            command = `swarm ${id} get --key ${key} --request-id ${getId} | jq -er .text > ${artifact}; cmp ${artifact} slot.txt;`;
          } else {
            command = `jq -n --arg key ${quote(key)} --arg text "$(cat slot.txt)" '{key:$key,text:$text}' | swarm ${id} put --stdin --request-id ${putId} >/dev/null;`;
          }
          const reply = body.input.find(row => row.type === 'function_call_output' && row.call_id === callId);
          let item;
          if (reply) {
            assert.match(String(reply.output), new RegExp(marker));
            roles.push(role);
            item = { type: 'message', id: callId, role: 'assistant', status: 'completed',
              content: [{ type: 'output_text', text: marker, annotations: [] }] };
          } else {
            item = { type: 'function_call', id: callId, call_id: callId, name: 'bash',
              arguments: JSON.stringify({ command: `${shellCheck} ${command} printf '%s\\n' ${marker}`, timeout: 20 }) };
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(streamResponse('k3', arrivals, item));
        } catch (error) {
          failure = error;
          res.writeHead(400);
          res.end('Controlled project handoff did not match the expected protocol');
        }
      }).listen(0, '127.0.0.1');
      await once(server, 'listening');
      t.after(() => { server.closeAllConnections(); server.close(); });
      const config = {
        sandbox: {
          lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
          endpointHost: process.env.MURM_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1',
          isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
        },
        connection: { advertiseHost: process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1',
          modelGateway: { requestTimeoutMs: 20_000, maxOutputTokens: 2048 } },
        models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: {
          url: `http://127.0.0.1:${server.address().port}/v1/responses`, headers: {},
        } } },
        image, workTimeoutMs: 90_000, turnTimeoutMs: 35_000, closeTimeoutMs: 30_000, cleanupTimeoutMs: 30_000,
      };
      const configPath = join(evidenceDir, scenario + '.mjs');
      await writeFile(configPath, `const config = ${JSON.stringify(config)};
config.sandbox.apiKey = process.env.MURM_CORE_TEST_API_KEY;
if (process.env.MURM_TEST_MESSAGES_URL) config.externalMessages = { url: process.env.MURM_TEST_MESSAGES_URL, token: process.env.MURM_TEST_MESSAGES_TOKEN };
export default config;
`, { mode: 0o600 });
      const { result, status, observation } = await runInstalledHarnessRpc(installation, {
        harness: id, cwd: project, prompt, configPath, outputDir: join(evidenceDir, scenario), timeoutMs: 115_000,
        ...(external ? { env: { MURM_TEST_MESSAGES_URL: external.url, MURM_TEST_MESSAGES_TOKEN: external.token } } : {}),
      }).catch(error => { assert.ifError(failure); throw error; });
      assert.ifError(failure);
      assert.equal(status, 0);
      assert.equal(observation.businessObserved, true);
      assert.equal(result.outcome, 'completed');
      assert.equal(result.cleanup.status, 'complete');
      assert.equal(result.acceptance.status, 'not-run');
      assert.equal(await readFile(result.prompt.path, 'utf8'), prompt);
      assert.ok(result.cleanup.receipt.agents.every(agent => agent.execution === 'stopped' && agent.cleanup === 'complete'));
      assert.deepEqual(roles, id === 'notes' ? ['writer', 'reader', 'followup'] : ['writer', 'reader']);
      const paths = result.artifacts.map(artifact => artifact.path);
      const files = paths.find(path => path.endsWith('/artifacts/files'));
      if (id === 'notes') {
        const business = result.result.business;
        assert.deepEqual(await readFile(business.followup), await readFile(business.artifact));
      }
      assert.ok(files);
      const name = id === 'notes' ? `murm-notes-${result.runId}.md` : `murm-message-${result.runId}.txt`;
      assert.equal(await readFile(join(files, name), 'utf8'), value + '\n');
      assert.equal(await readFile(join(project, 'slot.txt'), 'utf8'), value + '\n');
      assert.deepEqual(await ownedContainers(result.result.runtimeId), []);
      if (external) {
        const response = await fetch(`${external.url}/fixture`, { headers: { authorization: `Bearer ${external.token}` } });
        assert.equal(response.status, 200);
        const state = await response.json();
        assert.equal(state.original.text, 'pre-existing service data');
        assert.deepEqual(state.calls.map(call => call.operation), ['put', 'get']);
        assert.notEqual(state.calls[0].caller, state.calls[1].caller);
      }
      evidence.push({ id: scenario, runId: result.runId, runtimeId: result.result.runtimeId, digest: result.initial.digest,
        artifactVerified: true, resourcesClean: true, observation });
    });
  }
  await writeFile(join(evidenceDir, 'verification.json'), JSON.stringify({
    package: installation.metadata, image, controlledProvider: true, evidence,
  }, null, 2), { mode: 0o600 });
});

test('installed TaskPool routes fenced feedback to an installed native execution and publishes to seeded main', {
  skip: process.env.MURM_PROJECT_NATIVE_TEST !== '1' && 'Requires the local OpenSandbox Worker',
  timeout: 200_000,
}, async t => {
  const image = process.env.MURM_CORE_TEST_IMAGE;
  assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  const installation = await installNativeNotesExample();
  t.after(installation.close);
  const project = join(installation.directory, 'plain-project');
  await mkdir(project);
  const slot = 'TASKPOOL_PROJECT_ENTRY_A39';
  await writeFile(join(project, '.slot'), slot + '\n');
  await writeFile(join(project, 'payload'), Buffer.from([0, 255, 89]), { mode: 0o755 });
  await writeFile(join(project, '.env.example'), 'PROJECT_FLAG=enabled\n');
  await mkdir(join(project, '.swarm'));
  await writeFile(join(project, '.swarm', 'workspace.json'), '{"project":true}\n');
  await writeFile(join(project, '.swarm-staging'), 'ordinary file\n');
  const evidence = await createNativeEvidenceDirectory('project-taskpool');
  const prompt = 'Use the project slot to prepare an evidence file and publish it in the Mission Workspace.';
  const feedback = 'TASKPOOL_CURRENT_EXECUTION_FEEDBACK';
  const binding = Promise.withResolvers<string>();
  const release = Promise.withResolvers<void>();
  const claim = `python3 - <<'MURM_PROJECT_TEST'
import os,json,subprocess,stat
def cli(*args):
 p = subprocess.run(['swarm',*args],capture_output=True,text=True,timeout=30)
 assert p.returncode==0, p.stderr
 return json.loads(p.stdout)
def verify_tree():
 assert os.getcwd()=='/workspace/project'
 assert open('payload','rb').read()==bytes([0,255,89])
 assert os.stat('payload').st_mode & stat.S_IXUSR
 assert open('.slot').read().strip()
 assert open('.env.example').read().strip() == 'PROJECT_FLAG=enabled'
 assert json.load(open('.swarm/workspace.json')) == {'project':True}
 assert open('.swarm-staging').read().strip() == 'ordinary file'
verify_tree()
try:
 open('before-take.txt','w').close()
except OSError:
 pass
else:
 raise AssertionError('The discovery project allows writes')
task=cli('task','create','--gap','Collect project evidence','--priority','medium',
 '--summary','Export the project slot','--expected-output','A saved and merged result',
 '--acceptance-conditions','["Export evidence"]','--request-id','project-propose')['task']['task_id']
take=cli('task','take',task,'--request-id','project-take')
assert take['execution']['state']=='RUNNING'
verify_tree()
print('TAKEN_TASK:' + task)
MURM_PROJECT_TEST`;
  const deliver = `python3 - <<'MURM_PROJECT_TEST'
import json,subprocess
def cli(*args):
 p = subprocess.run(['swarm',*args],capture_output=True,text=True,timeout=30)
 assert p.returncode==0, p.stderr
 return json.loads(p.stdout)
with open('delivery.txt','w') as out:
 out.write(open('.slot').read())
saved=cli('workspace','save','--request-id','project-save')
merged=cli('workspace','merge','--from',saved['revision'],'--request-id','project-merge')
assert merged['main_revision']!=saved['revision']
cli('task','finish','--outcome','done','--request-id','project-finish')
print('PROJECT_TASKPOOL_OK')
MURM_PROJECT_TEST`;
  let calls = 0;
  let feedbackObserved = false;
  let failure: unknown;
  const server = createServer(async (req, res) => {
    try {
      assert.ok(++calls <= 8);
      const { input } = await new Response(req).json();
      const users = input.filter(row => row.role === 'user').flatMap(row => row.content)
        .map(part => typeof part === 'string' ? part : part.text).join('\n');
      assert.ok(users.includes(prompt));
      const output = id => input.find(row => row.type === 'function_call_output' && row.call_id === id)?.output;
      const tool = (id, command) => ({ type: 'function_call', id: id + '_work', call_id: id, name: 'bash',
        arguments: JSON.stringify({ command, timeout: 90 }) });
      const reply = (id, text) => ({ type: 'message', id, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }] });
      let item;
      if (output('project_taskpool_deliver')) {
        assert.match(String(output('project_taskpool_deliver')), /PROJECT_TASKPOOL_OK/);
        item = reply('taskpool_done', 'Completed Task');
      } else if (users.includes(feedback)) {
        feedbackObserved = true;
        item = tool('project_taskpool_deliver', deliver);
      } else if (output('project_taskpool_claim')) {
        const taskId = /TAKEN_TASK:([^\s]+)/.exec(String(output('project_taskpool_claim')))?.[1];
        assert.ok(taskId);
        binding.resolve(taskId);
        await release.promise;
        item = reply('taskpool_claimed', 'Claimed the Task');
      } else {
        item = tool('project_taskpool_claim', claim);
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(streamResponse('k3', calls, item));
    } catch (error) {
      failure = error;
      res.writeHead(400);
      res.end('Unexpected TaskPool model request');
    }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { release.resolve(); server.closeAllConnections(); server.close(); });
  const configuration = {
    image, capacity: 1, workTimeoutMs: 100_000, closeTimeoutMs: 35_000,
    sandbox: {
      lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
      endpointHost: process.env.MURM_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1',
      isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
    },
    connection: { advertiseHost: process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1',
      modelGateway: { requestTimeoutMs: 20_000, maxOutputTokens: 2048 } },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: {
      url: `http://127.0.0.1:${server.address().port}/v1/responses`, headers: {},
    } } },
  };
  const configPath = join(evidence, 'config.mjs');
  await writeFile(configPath, `const config = ${JSON.stringify(configuration)};
config.sandbox.apiKey = process.env.MURM_CORE_TEST_API_KEY;
export default config;
`, { mode: 0o600 });
  const { result, observation } = await runInstalledHarnessRpc(installation, {
    harness: 'taskpool', cwd: project, prompt, configPath, outputDir: join(evidence, 'output'), timeoutMs: 155_000,
    async interact(session) {
      const taskId = await binding.promise;
      const receipts: any[] = [];
      const unsubscribe = session.onEvent(event => {
        if (event.type === 'operation' && event.operation === 'input') receipts.push(event);
      });
      const getReceipt = async (id: string) => {
        for (let attempts = 0; attempts < 200; attempts++) {
          const found = receipts.find(event => event.requestId === id);
          if (found) return found.result.result;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.fail('No operation receipt for ' + id);
      };
      try {
        const parameters = { taskId, input: feedback, mode: 'steer' };
        assert.equal((await session.input(parameters, { requestId: 'directed-feedback' })).status, 'accepted');
        const sent = await getReceipt('directed-feedback');
        assert.ok(sent.executionId && Number.isSafeInteger(sent.fence));
        assert.equal(sent.status, 'accepted');
        await session.input({ ...parameters, taskId: 'missing-task' }, { requestId: 'missing-feedback' });
        const missing = await getReceipt('missing-feedback');
        assert.equal(missing.status, 'not_submitted');
        assert.equal(missing.reason, 'task-not-found');
        assert.equal((await session.input(parameters, { requestId: 'directed-feedback' })).status, 'accepted');
      } finally {
        unsubscribe();
        release.resolve();
      }
    },
  });
  assert.ifError(failure);
  assert.equal(feedbackObserved, true);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.cleanup.status, 'complete');
  assert.equal(result.acceptance.status, 'not-run');
  const workspace = result.artifacts.find(artifact => artifact.kind === 'mission-workspace');
  assert.notEqual(workspace.revision, '0.1');
  const { stdout: observed } = await execute('git', ['-C', workspace.path, 'show', `${workspace.commit}:delivery.txt`]);
  assert.equal(observed, slot + '\n');
  const { stdout: mode } = await execute('git', ['-C', workspace.path, 'ls-tree', workspace.commit, 'payload']);
  assert.match(mode, /^100755 blob/);
  const { stdout: configExample } = await execute('git', ['-C', workspace.path, 'show', `${workspace.commit}:.env.example`]);
  assert.equal(configExample, 'PROJECT_FLAG=enabled\n');
  const { stdout: projectMetadata } = await execute('git', ['-C', workspace.path, 'show', `${workspace.commit}:.swarm/workspace.json`]);
  assert.deepEqual(JSON.parse(projectMetadata), { project: true });
  await assert.rejects(readFile(join(project, 'delivery.txt')), { code: 'ENOENT' });
  assert.deepEqual(await ownedContainers(result.result.runtimeId), []);
  await writeFile(join(evidence, 'verification.json'), JSON.stringify({
    package: installation.metadata, image, controlledProvider: true, runtimeId: result.result.runtimeId, projectDigest: result.initial.digest,
    main: workspace.revision, commit: workspace.commit, cleanup: 'complete', observation,
  }, null, 2), { mode: 0o600 });
});

test('installed Substrate peers publish and cite bytes from the supplied project', {
  skip: process.env.MURM_PROJECT_NATIVE_TEST !== '1' && 'Requires the local OpenSandbox Worker',
  timeout: 190_000,
}, async t => {
  const image = process.env.MURM_CORE_TEST_IMAGE;
  assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  const installation = await installNativeNotesExample();
  t.after(installation.close);
  const project = join(installation.directory, 'plain-project');
  await mkdir(project);
  const evidence = await createNativeEvidenceDirectory('project-substrate');
  const projectSource = { file: 'question.txt', content: 'ARITHMETIC_SEED: 16+3=19.\n',
    prompt: 'Use the new question file to verify a result and cite the producer publication.' };
  await writeFile(join(project, projectSource.file), projectSource.content);
  const upstream = await createSubstrateUpstream({ deadlineAt: Date.now() + 110_000, projectSource });
  t.after(upstream.close);
  const configuration = {
    image, poolSize: 3, maxRounds: 2, workTimeoutMs: 95_000, turnTimeoutMs: 35_000, closeTimeoutMs: 30_000,
    sandbox: {
      lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
      endpointHost: process.env.MURM_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1',
      isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
    },
    connection: { advertiseHost: process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1',
      modelGateway: { requestTimeoutMs: 20_000, maxOutputTokens: 128 } },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: upstream.url, headers: {} } } },
  };
  const configPath = join(evidence, 'config.mjs');
  await writeFile(configPath, `const config = ${JSON.stringify(configuration)};
config.sandbox.apiKey = process.env.MURM_CORE_TEST_API_KEY;
export default config;
`, { mode: 0o600 });
  const { result, status, observation } = await runInstalledHarnessRpc(installation, {
    harness: 'substrate', cwd: project, prompt: projectSource.prompt, configPath, outputDir: join(evidence, 'output'), timeoutMs: 145_000,
  }).catch(error => { assert.ifError(upstream.receipt().failure); throw error; });
  assert.ifError(upstream.receipt().failure);
  assert.equal(status, 0);
  assert.equal(observation.businessObserved, true);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.cleanup.status, 'complete');
  assert.equal(result.acceptance.status, 'not-run');
  const { evidence: calls, failure } = upstream.receipt();
  assert.ifError(failure);
  const producer = calls.find(row => row.peer === 0 && row.cycle === 0).published;
  assert.equal(producer.content, projectSource.content);
  assert.ok(calls.find(row => row.peer === 1 && row.cycle === 1).published.references.includes(producer.address));
  assert.equal(result.cleanup.receipt.agents.length, 3);
  for (const agent of result.cleanup.receipt.agents) {
    const files = agent.artifacts.find(path => path.endsWith('/artifacts/files'));
    assert.equal(await readFile(join(files, projectSource.file), 'utf8'), projectSource.content);
  }
  assert.deepEqual(await ownedContainers(result.result.runtimeId), []);
  await writeFile(join(evidence, 'verification.json'), JSON.stringify({
    package: installation.metadata, image, controlledProvider: true, projectDigest: result.initial.digest,
    runtimeId: result.result.runtimeId, adoption: true, cleanup: 'complete', observation,
  }, null, 2), { mode: 0o600 });
});
