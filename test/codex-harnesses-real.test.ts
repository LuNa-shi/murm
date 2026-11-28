import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { streamResponse } from './fixtures/core-controlled-upstream.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { sessionEvidence } from './fixtures/core-session-evidence.js';
import { createNativeEvidenceDirectory, execute, installNativeNotesExample } from './fixtures/notes-installed-package.js';

test('installed normal Subagents adopts a Service handoff through two overlapping Codex Agents', {
  skip: process.env.MURM_CODEX_SUBAGENTS_REAL_TEST !== '1' && 'Requires local Codex/OpenSandbox opt-in',
  timeout: 340_000,
}, async t => {
  const image = process.env.MURM_CORE_TEST_IMAGE;
  assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  const evidenceDir = await createNativeEvidenceDirectory('codex-subagents');
  const installed = await installNativeNotesExample();
  const outputRoot = join(evidenceDir, 'output');
  const project = join(installed.directory, 'plain-project');
  await mkdir(project);
  await writeFile(join(project, '.settings'), 'seed configuration');
  await writeFile(join(project, 'seed.bin'), Buffer.from([0, 179, 255]));
  await chmod(join(project, 'seed.bin'), 0o755);
  const uuid = /^[a-f0-9-]{36}$/;
  let runtimeOutput = outputRoot;
  async function currentRuntimes() {
    const runs = (await readdir(outputRoot).catch(() => [])).filter(id => uuid.test(id));
    if (runs.length !== 1) return [];
    runtimeOutput = join(outputRoot, runs[0]);
    return (await readdir(runtimeOutput)).filter(id => uuid.test(id));
  }
  const initialFileCheck = "test \"$(pwd)\" = /workspace/project && test -x seed.bin && test \"$(od -An -tx1 seed.bin | tr -d ' \\n')\" = 00b3ff && grep -qx 'seed configuration' .settings";

  const handoff = 'SERVICE_HANDOFF_225';
  let arrivals = 0;
  let childStarted = false;
  let childInitialRequests = 0;
  let childAdopted = false;
  let overlapped = false;
  let failure;
  let sessions;
  let child;
  let releaseChild;
  const childMayProceed = new Promise(resolve => { releaseChild = resolve; });
  const tool = (id, cmd) => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name: 'exec_command',
    arguments: JSON.stringify({ cmd, yield_time_ms: 10000, max_output_tokens: 4096 }) });
  const text = (id, value) => ({ type: 'message', id, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: value, annotations: [] }] });
  const call = (operation, input, id) => tool(id,
    `printf '%s' '${JSON.stringify(input)}' | swarm collaboration ${operation} --stdin --request-id ${id}`);
  const outputText = value => {
    assert.equal(typeof value, 'string');
    assert.match(value, /Process exited with code 0/);
    const start = value.indexOf('Output:\n');
    assert.ok(start >= 0);
    return value.slice(start + 'Output:\n'.length).trim();
  };
  const server = createServer(async (request, response) => {
    const ordinal = ++arrivals;
    let stage = 'bounds';
    try {
      assert.ok(!failure && ordinal <= 14);
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/responses');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 2 * 1024 ** 2); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.model, 'gpt-5.4');
      const users = body.input.filter(item => item.role === 'user').flatMap(item => item.content ?? [])
        .map(item => typeof item === 'string' ? item : item.text ?? '').join('\n');
      const output = id => body.input.find(item => item.type === 'function_call_output' && item.call_id === id)?.output;
      let item;
      if (users.includes('CHILD_TASK_225')) {
        if (!output('child-work')) {
          stage = 'child-active';
          childInitialRequests++;
          assert.ok(childInitialRequests <= 2);
          if (childStarted) {
            assert.ok(users.includes(handoff), 'Active steer must reach the next native model request');
          } else {
            childStarted = true;
            await childMayProceed;
          }
          item = tool('child-work', initialFileCheck + " && printf '%s' CHILD_FILE_225 > child.txt && sleep 0.2");
        } else {
          stage = 'child-handoff';
          outputText(output('child-work'));
          assert.ok(users.includes(handoff), 'The Service handoff must occur in a subsequent native user input');
          assert.equal(childAdopted, false);
          childAdopted = true;
          item = text('child-result', `CHILD_ADOPTED_${handoff}`);
        }
      } else {
        assert.ok(users.includes('ROOT_TASK_225'));
        if (!output('root-initial-files')) {
          stage = 'root-initial-files';
          item = tool('root-initial-files', initialFileCheck + ' && printf ROOT_INITIAL_VERIFIED');
        } else if (!output('spawn-worker')) {
          stage = 'root-spawn';
          assert.equal(outputText(output('root-initial-files')), 'ROOT_INITIAL_VERIFIED');
          await writeFile(join(project, 'seed.bin'), Buffer.from([1]));
          await writeFile(join(project, '.settings'), 'host changed after capture');
          item = call('spawn_agent', { task_name: 'worker', message: 'CHILD_TASK_225', fork_turns: 'none' }, 'spawn-worker');
        } else if (!output('handoff-worker')) {
          stage = 'root-overlap';
          const started = JSON.parse(outputText(output('spawn-worker')));
          assert.equal(started.task_name, '/root/worker');
          const deadline = Date.now() + 5000;
          while (!childStarted && Date.now() < deadline) await delay(25);
          assert.ok(childStarted && !childAdopted, 'Root and Child must have overlapping native execution');
          overlapped = true;
          const runtimeIds = await currentRuntimes();
          assert.equal(runtimeIds.length, 1);
          const containers = (await ownedContainers(runtimeIds[0])).sort();
          assert.equal(containers.length, 2);
          sessions = await Promise.all(containers.map(async container => ({ container,
            ...await sessionEvidence(container, execute, 'codex') })));
          assert.equal(new Set(sessions.map(row => row.sessionId)).size, 2);
          item = call('send_message', { target: 'worker', message: handoff }, 'handoff-worker');
        } else if (!output('wait-worker')) {
          stage = 'root-handoff-accepted';
          const receipt = JSON.parse(outputText(output('handoff-worker')));
          assert.equal(receipt.status, 'queued');
          releaseChild();
          item = call('wait_agent', { timeout_ms: 10000 }, 'wait-worker');
        } else if (!output('save-result')) {
          stage = 'root-adopts';
          const delivered = JSON.parse(outputText(output('wait-worker')));
          assert.equal(delivered.reason, 'message');
          assert.ok(delivered.messages.some(message => message.text === `CHILD_ADOPTED_${handoff}`));
          assert.ok(childAdopted);
          item = tool('save-result', `printf '%s\\n' '${handoff}' > delivery.txt; cat delivery.txt`);
        } else {
          stage = 'root-artifact';
          assert.equal(outputText(output('save-result')), handoff);
          item = text('root-complete', 'CODEX_TEAM_COMPLETE_225');
        }
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(streamResponse('gpt-5.4', ordinal, item));
    } catch (error) {
      failure ??= { stage, ordinal, message: String(error) };
      releaseChild();
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'CONTROLLED_CODEX_HARNESS_FAILED' } }));
      child?.kill('SIGTERM');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    releaseChild(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const host = process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const config = { image, maxAgents: 2, maxDepth: 1,
    workTimeoutMs: 90000, closeTimeoutMs: 25000,
    collect: { paths: ['delivery.txt'], includeGit: false, maxBytes: 4096, required: true },
    executor: 'codex',
    sandbox: { lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
      resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20000,
      isolation: { network: 'api' } },
    connection: {
      advertiseHost: host,
      modelGateway: { maxOutputTokens: null, requestTimeoutMs: 30000 },
    },
    models: { default: { provider: 'openai', model: 'gpt-5.4',
      upstream: { url: `http://127.0.0.1:${server.address().port}/v1/responses`, headers: {} } } },
  };
  await writeFile(join(evidenceDir, 'config.mjs'), `const config = ${JSON.stringify(config)};
config.sandbox.apiKey = process.env.MURM_CORE_TEST_API_KEY;
export default config;\n`, { mode: 0o600 });
  const proof = { package: installed.metadata, image, executor: 'codex', failure: true };
  t.after(async () => {
    const ids = await currentRuntimes();
    proof.resources = {};
    for (const id of ids) proof.resources[id] = { empty: (await ownedContainers(id)).length === 0 };
    proof.upstream = { arrivals, failure, overlapped, childAdopted, childInitialRequests };
    proof.sessions = sessions;
    proof.failure ||= Boolean(failure) || !overlapped || !childAdopted || ids.length !== 1 ||
      Object.values(proof.resources).some(row => !row.empty);
    await writeFile(join(evidenceDir, 'acceptance.json'), JSON.stringify(proof, null, 2), { mode: 0o600 });
    assert.equal(proof.failure, false, JSON.stringify(failure));
    await installed.close();
  });
  let stdout = ''; let stderrBytes = 0; let expired = false;
  const outcome = await new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['node_modules/.bin/murm', '--harness', 'subagents', '--cwd', project,
      '--prompt', 'ROOT_TASK_225', '--config', join(evidenceDir, 'config.mjs'), '--output-dir', outputRoot],
      { cwd: installed.directory, env: installed.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); }, 120000);
    const hardTimer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 150000);
    child.stdout.on('data', data => {
      if (stdout.length + data.length > 8 * 1024 ** 2) { expired = true; child.kill('SIGTERM'); }
      else stdout += data;
    });
    child.stderr.on('data', data => { stderrBytes += data.length; });
    child.once('error', error => { clearTimeout(timer); clearTimeout(hardTimer); reject(error); });
    child.once('close', code => { clearTimeout(timer); clearTimeout(hardTimer); resolve(code); });
  });
  const outer = JSON.parse(stdout.trim()).result;
  assert.equal(outer.harness.id, 'subagents');
  assert.equal(outer.initial.fileCount, 2);
  assert.equal(await readFile(outer.prompt.path, 'utf8'), 'ROOT_TASK_225');
  await currentRuntimes();
  const report = JSON.parse(await readFile(outer.result.reportPath, 'utf8'));
  proof.report = report;
  assert.equal(outcome, 0, `Harness exited with ${stderrBytes} diagnostic bytes; ${JSON.stringify(failure)}`);
  assert.equal(expired, false);
  assert.equal(report.businessFailure, null);
  assert.equal(report.cleanupFailure, null);
  assert.equal(report.reportSaveFailure, null);
  assert.equal(report.result.output, 'CODEX_TEAM_COMPLETE_225');
  assert.equal(report.cleanup.cleanup, 'complete');
  assert.equal(report.cleanup.agents.length, 2);
  assert.ok(report.cleanup.agents.every(agent => agent.execution === 'stopped' && agent.cleanup === 'complete' && agent.sessionArchive));
  const root = report.cleanup.agents.find(agent => agent.agentId === report.result.rootId);
  const files = root.artifacts.find(path => path.endsWith('/artifacts/files'));
  assert.equal(await readFile(join(files, 'delivery.txt'), 'utf8'), handoff + '\n');
  const trace = (await readFile(join(runtimeOutput, report.runtimeId, 'service-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(trace.length >= 3);
  assert.equal((await ownedContainers(report.runtimeId)).length, 0);
  assert.deepEqual(await readFile(join(project, 'seed.bin')), Buffer.from([1]));
  assert.equal(await readFile(join(project, '.settings'), 'utf8'), 'host changed after capture');
  proof.project = { capturedDigest: outer.initial.digest, rootAndChildFilesVerified: true, sourceUnchangedByAgents: true };
  proof.failure = false;
});
