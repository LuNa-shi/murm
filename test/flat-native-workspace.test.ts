import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createPiOpenSandboxBackend } from '@swarmenv/core/backends/pi-opensandbox';
import { runFlatEnvironment } from '../src/environments/flat/environment.js';
import { TaskService } from '../src/task/task-service.js';
import { ContextService } from '../src/context/context-service.js';
import { MissionWorkspace } from '../src/runtime/mission-workspace.js';
import { WorkspaceManager } from '../src/runtime/workspace-manager.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
import { streamResponse } from './fixtures/core-controlled-upstream.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { sessionEvidence } from './fixtures/core-session-evidence.js';
import { openSandboxBotKey } from '../src/runtime/opensandbox-metadata.js';

const execute = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function script(role, revision = null) {
  const commands = role === 'finish' ? `
finished=cli('task','finish','--outcome','done','--request-id','B-finish')
result={'role':'finish','same_process':os.getcwd()==before,'finished':finished}
` : revision === null ? `
listed=cli('task','list','--state','ready','--request-id',ROLE+'-list')
created=cli('task','create','--gap','Exercise native collaborative file transfer','--priority','medium','--summary','Native '+ROLE,'--expected-output','Saved exact guest bytes','--acceptance-conditions','["Public bytes match guest bytes"]','--request-id',ROLE+'-create')
task=created['task']['task_id']
taken=cli('task','take',task,'--request-id',ROLE+'-take')
assert taken['execution']['state']=='RUNNING'
assert os.getcwd()==before
if ROLE=='A':
 text=('native λ '+secrets.token_hex(32)+'\\n').encode('utf8')
 binary=secrets.token_bytes(97)+bytes([0,255,128])
 open('lemma.txt','wb').write(text)
 open('lemma.bin','wb').write(binary)
else:
 open('consumer.txt','wb').write(b'CONSUMER_PROGRESS\\n')
saved=cli('workspace','save','--request-id',ROLE+'-save')
material=cli('material','publish','--content','Native '+ROLE+' saved '+saved['revision'],'--request-id',ROLE+'-material')
cli('task','link','--task-id',task,'--material-id',material['material']['material_id'],'--role','experience','--request-id',ROLE+'-link')
result={'role':ROLE,'task':task,'execution':taken['execution']['execution_id'],'revision':saved['revision'],'same_process':os.getcwd()==before,'material':material['material']['material_id']}
if ROLE=='A':
 result.update({'text':text.hex(),'binary':binary.hex()})
` : `
assert open('consumer.txt','rb').read()==b'CONSUMER_PROGRESS\\n'
applied=cli('workspace','apply','--from',${JSON.stringify(revision)},'--request-id','B-apply')
assert open('consumer.txt','rb').read()==b'CONSUMER_PROGRESS\\n'
text=open('lemma.txt','rb').read()
binary=open('lemma.bin','rb').read()
open('consumer.txt','ab').write(b'ADOPTED_LEMMA\\n')
saved=cli('workspace','save','--request-id','B-integrated-save')
result={'role':'B-apply','revision':saved['revision'],'text':text.hex(),'binary':binary.hex(),'same_process':os.getcwd()==before,'applied':applied,'parents':saved['parents']}
`;
  return `python3 - <<'FLAT_NATIVE_SCRIPT'\nimport os,json,subprocess,secrets\nROLE=${JSON.stringify(role)}\nbefore=os.getcwd()\nassert before=='/workspace/project'\ndef cli(*args):\n p=subprocess.run(['swarm']+list(args),capture_output=True,text=True,timeout=45)\n assert p.returncode==0, p.stderr\n return json.loads(p.stdout)\n${commands}\nprint(json.dumps(result))\nFLAT_NATIVE_SCRIPT`;
}

test('native Flat creates work and saves and applies exact guest bytes in the original Session then replaces its finished Bot', {
  skip: process.env.SWARMENV_FLAT_NATIVE_WORKSPACE_TEST !== '1', timeout: 270_000,
}, async t => {
  const image = process.env.SWARMENV_CORE_TEST_IMAGE;
  assert.match(image ?? '', /(?:^sha256:|@sha256:)[a-f0-9]{64}$/);
  const outputDir = join(process.cwd(), 'experiments', `flat-native-workspace-${Date.now()}`);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const deadlineAt = Date.now() + 210_000;
  const tasks = new TaskService(join(outputDir, 'tasks.sqlite'));
  const context = new ContextService(join(outputDir, 'context.sqlite'), { taskService: tasks });
  const workspace = new MissionWorkspace({ rootDir: join(outputDir, 'public') });
  const manager = new WorkspaceManager({ rootDir: join(outputDir, 'private') });
  const missionId = 'flat:native-workspace';
  tasks.createMission({ mission_id: missionId, goal: 'Controlled native save and adoption check' }, makeEnvelope({ actorRef: 'host' }));
  const initial = await workspace.create({ missionId, workspaceId: 'native-workspace', initialFiles: { 'input.txt': 'fixed input\n' } });
  assert.equal(tasks.listTasks({ missionId, availableOnly: false }).length, 0);
  const evidence = {}, events = [], admissions = [];
  let arrivals = 0, starts = 0, failure, runtimeId, report;
  const awaiting = new Map();
  const evidenceFor = name => {
    if (evidence[name]) return Promise.resolve(evidence[name]);
    const deferred = Promise.withResolvers();
    awaiting.set(name, deferred);
    return deferred.promise;
  };
  const server = createServer(async (request, response) => {
    try {
      assert.ok(++arrivals <= 10 && Date.now() < deadlineAt);
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes < 4 * 1024 ** 2); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.model, 'k3');
      const lastUser = body.input.filter(row => row.role === 'user').at(-1);
      const text = typeof lastUser?.content === 'string' ? lastUser.content : lastUser?.content?.map(row => row.text ?? '').join('');
      const finishing = text === 'FLAT_NATIVE_FINISH';
      const apply = /^FLAT_NATIVE_APPLY (\d+\.\d+)$/.exec(text ?? '');
      let item;
      const role = finishing ? 'finish' : apply ? 'B-apply' : body.input.some(row => row.type === 'function_call' && row.call_id === 'native_C') ? 'C' : body.input.some(row => row.type === 'function_call' && row.call_id === 'native_A') ? 'A' : body.input.some(row => row.type === 'function_call' && row.call_id === 'native_B') ? 'B' : null;
      const output = role && body.input.findLast(row => row.type === 'function_call_output' && row.call_id === `native_${role}`)?.output;
      if (typeof output === 'string') {
        const result = JSON.parse(output.trim());
        assert.equal(result.role, role); assert.equal(result.same_process, true);
        evidence[role] = result; awaiting.get(role)?.resolve(result);
        item = { type: 'message', id: `native_final_${role}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `${role}_OK`, annotations: [] }] };
      } else {
        const next = finishing ? 'finish' : apply ? 'B-apply' : ['A', 'B', 'C'][starts++];
        assert.ok(finishing || apply || starts <= 3);
        item = { type: 'function_call', id: `native_call_${next}`, call_id: `native_${next}`, name: 'bash', arguments: JSON.stringify({ command: script(next, apply?.[1] ?? null), timeout: 120 }) };
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(streamResponse('k3', arrivals, item));
    } catch (error) {
      failure = String(error);
      for (const deferred of awaiting.values()) deferred.reject(error);
      response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: failure } }));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); context.close(); tasks.close(); });
  const host = process.env.SWARMENV_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const budget = setTimeout(() => { for (const deferred of awaiting.values()) deferred.reject(new Error('Native diagnostic deadline')); }, 210_000);
  t.after(() => clearTimeout(budget));
  try {
    report = await runFlatEnvironment({
      backend: createPiOpenSandboxBackend({ sandbox: {
        lifecycleBaseUrl: process.env.SWARMENV_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1', endpointHost: process.env.SWARMENV_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1',
        apiKey: process.env.SWARMENV_CORE_TEST_API_KEY, resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000 },
        bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` }, modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 150_000, maxOutputTokens: 4096 },
        models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: `http://127.0.0.1:${server.address().port}/v1/responses`, headers: {} } } },
        isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } } }),
      model: 'default', image, outputDir, taskService: tasks, contextService: context, missionWorkspace: workspace, workspaceManager: manager,
      missionId, workspaceId: initial.workspace_id, capacity: 2, deadlineAt, autonomousTasks: true, workspaceCapture: 'core',
      controller: { discoveryPrompt: 'FLAT_NATIVE_START', automaticContinuation: false, deliverNotifications: false, selectionMs: 180_000, hardBudgetMs: 210_000, stallMs: 180_000,
        beforeInitialDispatch({ botIds }) { admissions.push([...botIds]); } },
      handoff: { executionTimeoutMs: 180_000 }, closeTimeoutMs: 40_000,
      async drive(controller, runtime) {
        runtimeId = runtime.id;
        runtime.onEvent(event => events.push({ type: event.type, botId: event.botId, outcome: event.outcome }));
        const [a, b] = await Promise.all([evidenceFor('A'), evidenceFor('B')]);
        const bBot = tasks.getExecution(b.execution).owner_ref;
        const containers = await ownedContainers(runtime.id);
        const identities = await Promise.all(containers.map(async container => ({ container, botKey: JSON.parse((await execute('docker', ['inspect', '--format', '{{json .Config.Labels.bot_key}}', container])).stdout) })));
        const bContainer = identities.find(row => row.botKey === openSandboxBotKey(bBot)).container;
        while ((await runtime.get(bBot)).status !== 'idle') { assert.ok(Date.now() < deadlineAt); await wait(25); }
        const before = await sessionEvidence(bContainer, execute);
        assert.equal((await runtime.send(bBot, `FLAT_NATIVE_APPLY ${a.revision}`, { requestId: 'native-apply-turn', mode: 'followUp' })).status, 'accepted');
        const integrated = await evidenceFor('B-apply');
        while ((await runtime.get(bBot)).status !== 'idle') { assert.ok(Date.now() < deadlineAt); await wait(25); }
        assert.deepEqual(await sessionEvidence(bContainer, execute), before);
        assert.equal(integrated.text, a.text); assert.equal(integrated.binary, a.binary);
        assert.deepEqual(integrated.applied.parents, [b.revision, a.revision]);
        assert.deepEqual(integrated.parents, [b.revision, a.revision]);
        const exported = await workspace.exportRevision({ workspaceId: initial.workspace_id, revision: integrated.revision });
        assert.deepEqual(Buffer.from(exported.files['lemma.txt']), Buffer.from(a.text, 'hex'));
        assert.deepEqual(Buffer.from(exported.files['lemma.bin']), Buffer.from(a.binary, 'hex'));
        assert.equal(Buffer.from(exported.files['consumer.txt']).toString(), 'CONSUMER_PROGRESS\nADOPTED_LEMMA\n');
        assert.equal(exported.manifest['lemma.bin'].content_hash, sha256(Buffer.from(a.binary, 'hex')));
        assert.equal(tasks.listTasks({ missionId, availableOnly: false }).length, 2);
        evidence.session = before; evidence.hash = exported.manifest['lemma.bin'].content_hash;
        const bSlot = controller.snapshot().bots.find(row => row.botId === bBot).slot;
        assert.equal((await runtime.send(bBot, 'FLAT_NATIVE_FINISH', { requestId: 'native-finish-turn', mode: 'followUp' })).status, 'accepted');
        const replacement = await evidenceFor('C');
        const cBot = tasks.getExecution(replacement.execution).owner_ref;
        while ((await runtime.get(cBot)).status !== 'idle') { assert.ok(Date.now() < deadlineAt); await wait(25); }
        const rows = controller.snapshot().bots;
        assert.equal(tasks.getTask(b.task).state, 'DONE');
        assert.equal(tasks.getExecution(b.execution).state, 'SUCCEEDED');
        assert.equal(tasks.getBot(bBot).state, 'CLOSED');
        assert.equal(rows.find(row => row.botId === bBot).released, true);
        assert.notEqual(cBot, bBot);
        assert.equal(rows.find(row => row.botId === cBot).slot, bSlot);
        assert.equal((await ownedContainers(runtime.id)).includes(bContainer), false);
        assert.equal(admissions.length, 2);
        assert.ok(admissions[0].includes(bBot));
        assert.ok(admissions[1].includes(cBot));
        assert.equal(admissions[1].includes(bBot), false);
        evidence.replacement = { finishedBot: bBot, newBot: cBot, slot: bSlot, admissions };
        controller.halt('controlled-native-complete');
      },
    });
    assert.equal(failure, undefined, failure);
    assert.ok(arrivals >= 9 && arrivals <= 10); assert.equal(starts, 3);
    assert.equal(report.businessFailure?.code, 'FLAT_BUSINESS_FAILED');
    assert.equal(report.cleanupFailure, null); assert.equal(report.cleanup.cleanup, 'complete');
    assert.deepEqual(await ownedContainers(runtimeId), []);
    assert.ok(report.cleanup.bots.every(bot => bot.execution === 'stopped' && bot.cleanup === 'complete'));
    for (const bot of report.cleanup.bots) assert.equal(tasks.getBot(bot.botId).state, 'CLOSED');
    const trace = JSON.parse(await readFile(join(outputDir, runtimeId, 'runtime.json'), 'utf8'));
    assert.equal(trace.cleanup, 'complete');
    const calls = (await readFile(join(outputDir, runtimeId, 'service-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    for (const operation of ['task_create', 'task_take', 'workspace_save', 'workspace_apply', 'context_publish_material', 'task_finish']) {
      assert.ok(calls.some(row => row.operation === operation && row.phase === 'settled'), `Missing settled Service trace for ${operation}`);
    }
    assert.ok(calls.every(row => Number.isFinite(Date.parse(row.startedAt))));
  } finally {
    await writeFile(join(outputDir, 'acceptance.json'), JSON.stringify({ mode: 'scripted-local-native', image, runtimeId, arrivals, starts, failure, evidence, events, report }, null, 2), { mode: 0o600 });
  }
});
