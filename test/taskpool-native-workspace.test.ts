import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { serviceCommand } from '../src/cli/service-command.js';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createPiOpenSandboxBackend } from '@murm/core/backends/pi-opensandbox';
import { runTaskPoolHarness } from '../src/harnesses/taskpool/harness.js';
import { TaskService } from '../src/task/task-service.js';
import { ContextService } from '../src/context/context-service.js';
import { MissionWorkspace } from '../src/runtime/mission-workspace.js';
import { WorkspaceManager } from '../src/runtime/workspace-manager.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
import { streamResponse } from './fixtures/core-controlled-upstream.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { sessionEvidence } from './fixtures/core-session-evidence.js';
import { openSandboxAgentKey } from '../src/runtime/opensandbox-metadata.js';

const execute = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function script(role, revision = null, notification = null, recipient = null) {
  const commands = role === 'finish' ? `
finished=cli('task','finish','--outcome','done','--request-id','B-finish')
result={'role':'finish','same_process':os.getcwd()==before,'finished':finished}
` : role === 'route' ? `
args=('task','link','--task-id',${JSON.stringify(recipient)},'--material-id',${JSON.stringify(notification?.material_id)},'--role','response')
link=cli(*args,'--request-id','A-route')
assert cli(*args,'--request-id','A-route')==link
result={'role':'route','same_process':os.getcwd()==before,'link':link['link']}
` : revision === null ? `
services=cli('service','list')['services']
listed=cli('task','list','--states','["ready","running"]','--request-id',ROLE+'-list')
public=cli('workspace','public-diff','--from','0.1','--to','main','--request-id',ROLE+'-public-diff')
assert public['from']['revision']=='0.1'
def propose(summary, request):
 return cli('task','create','--gap','Exercise native collaborative file transfer','--priority','medium','--summary',summary,'--expected-output','Saved exact guest bytes','--acceptance-conditions','["Public bytes match guest bytes"]','--request-id',request)['task']['task_id']
if ROLE=='C':
 task=next(row['task_id'] for row in listed['tasks'] if row['available'] and row['summary']=='Extra active0')
else:
 task=propose('Native '+ROLE,ROLE+'-create')
 if ROLE=='A':
  assert propose('Extra discovery','A-extra-discovery')!=task
taken=cli('task','take',task,'--request-id',ROLE+'-take')
assert taken['execution']['state']=='RUNNING'
if ROLE=='A':
 extras=[propose('Extra active'+str(i),'A-extra-active'+str(i)) for i in range(2)]
 assert len(set(extras+[task]))==3
assert os.getcwd()==before
if ROLE=='A':
 text=('native λ '+secrets.token_hex(32)+'\\n').encode('utf8')
 binary=secrets.token_bytes(97)+bytes([0,255,128])
 open('lemma.txt','wb').write(text)
 open('lemma.bin','wb').write(binary)
else:
 open('consumer.txt','wb').write(b'CONSUMER_PROGRESS\\n')
saved=cli('workspace','save','--request-id',ROLE+'-save')
material=cli('material','publish','--content',json.dumps({'revision':saved['revision'],'path':'lemma.txt' if ROLE=='A' else 'consumer.txt','outcome':'native file evidence'}),'--request-id',ROLE+'-material')
cli('task','link','--task-id',task,'--material-id',material['material']['material_id'],'--role','experience','--request-id',ROLE+'-link')
result={'role':ROLE,'task':task,'execution':taken['execution']['execution_id'],'revision':saved['revision'],'same_process':os.getcwd()==before,'material':material['material']['material_id'],'services':{service['id']:[cap['operation'] for cap in service['capabilities']] for service in services}}
if ROLE=='A':
 result.update({'text':text.hex(),'binary':binary.hex()})
` : `
material=cli('material','view',${JSON.stringify(notification?.material_id ?? '')})
assert material['material']['content']['revision']==${JSON.stringify(revision)}
assert material['material']['content']['path']=='lemma.txt'
published=cli('workspace','read','lemma.txt','--at',material['material']['content']['revision'])
assert 'native λ ' in published['content']
before_apply=cli('workspace','status','--request-id','B-status')
assert not before_apply['dirty']
assert open('consumer.txt','rb').read()==b'CONSUMER_PROGRESS\\n'
applied=cli('workspace','apply','--from',${JSON.stringify(revision)},'--request-id','B-apply')
assert open('consumer.txt','rb').read()==b'CONSUMER_PROGRESS\\n'
text=open('lemma.txt','rb').read()
binary=open('lemma.bin','rb').read()
open('consumer.txt','ab').write(b'ADOPTED_LEMMA\\n')
material_ids=json.dumps([${JSON.stringify(notification?.material_id ?? '')}])
cli('material','consume','--material-ids',material_ids,'--action','workspace','--impact','Applied the exact published lemma revision and amended the downstream file','--request-id','B-use')
saved=cli('workspace','save','--material-ids',material_ids,'--request-id','B-integrated-save')
feedback=cli('task','feedback','--notification-id',${JSON.stringify(notification?.notification_id ?? '')},'--decision','adopted','--action','applied_revision_and_saved_proof_progress','--request-id','B-adoption-feedback')
result={'feedback':feedback,'role':'B-apply','revision':saved['revision'],'text':text.hex(),'binary':binary.hex(),'same_process':os.getcwd()==before,'applied':applied,'parents':saved['parents']}
`;
  return `python3 - <<'TASKPOOL_NATIVE_SCRIPT'\nimport os,json,subprocess,secrets\nROLE=${JSON.stringify(role)}\nbefore=os.getcwd()\nassert before=='/workspace/project'\ndef cli(*args):\n p=subprocess.run(['swarm']+list(args),capture_output=True,text=True,timeout=45)\n assert p.returncode==0, p.stderr\n return json.loads(p.stdout)\n${commands}\nprint(json.dumps(result))\nTASKPOOL_NATIVE_SCRIPT`;
}

const nativeOptions = {
  skip: process.env.MURM_TASKPOOL_NATIVE_WORKSPACE_TEST !== '1', timeout: 270_000,
};
test('native TaskPool saves and applies exact guest bytes in the original Session then replaces its finished Agent', nativeOptions,
  t => checkNativeAdoption(t, 'followUp'));
test('native TaskPool delivers a configured Material notice in a live tool loop and keeps the original Session', nativeOptions,
  t => checkNativeAdoption(t, 'steer'));

async function checkNativeAdoption(t, materialNotificationMode) {
  const image = process.env.MURM_CORE_TEST_IMAGE;
  assert.match(image ?? '', /(?:^sha256:|@sha256:)[a-f0-9]{64}$/);
  const outputDir = join(process.cwd(), 'experiments', `taskpool-native-workspace-${Date.now()}`);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const deadlineAt = Date.now() + 210_000;
  const tasks = new TaskService(join(outputDir, 'tasks.sqlite'));
  const context = new ContextService(join(outputDir, 'context.sqlite'), { taskService: tasks });
  const workspace = new MissionWorkspace({ rootDir: join(outputDir, 'public') });
  const manager = new WorkspaceManager({ rootDir: join(outputDir, 'private') });
  const missionId = 'taskpool:native-workspace';
  tasks.createMission({ mission_id: missionId, goal: 'Controlled native save and adoption check' }, makeEnvelope({ actorRef: 'host' }));
  const initial = await workspace.create({ missionId, workspaceId: 'native-workspace', initialFiles: { 'input.txt': 'fixed input\n' } });
  assert.equal(tasks.listTasks({ missionId, availableOnly: false }).length, 0);
  const evidence = {}, events = [], admissions = [], firstPrompts = new Map();
  const roles = materialNotificationMode === 'steer' ? ['A', 'B', 'D', 'E', 'C'] : ['A', 'B', 'C'];
  const capacity = roles.length - 1;
  const findNotice = () => evidence.B && tasks.listUnprocessedNotifications(evidence.B.task, evidence.B.execution)
    .find(row => row.notification_type === 'material_available' && row.material_id === evidence.A?.material);
  let arrivals = 0, starts = 0, notificationInputs = 0, adoptionNotification, failure, runtimeId, report;
  const continueB = Promise.withResolvers();
  const awaiting = new Map();
  const evidenceFor = name => {
    if (evidence[name]) return Promise.resolve(evidence[name]);
    const deferred = Promise.withResolvers();
    awaiting.set(name, deferred);
    return deferred.promise;
  };
  const server = createServer(async (request, response) => {
    try {
      assert.ok(++arrivals <= 20 && Date.now() < deadlineAt);
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes < 4 * 1024 ** 2); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.model, 'k3');
      const lastUser = body.input.filter(row => row.role === 'user').at(-1);
      const text = typeof lastUser?.content === 'string' ? lastUser.content : lastUser?.content?.map(row => row.text ?? '').join('');
      const finishing = text === 'TASKPOOL_NATIVE_FINISH';
      const routing = text === 'TASKPOOL_NATIVE_ROUTE';
      adoptionNotification ??= findNotice();
      const apply = adoptionNotification && text?.includes(adoptionNotification.notification_id) ? [text, evidence.A.revision] : null;
      if (apply) {
        assert.ok(text.includes(adoptionNotification.material_id));
        assert.ok(text.includes(evidence.A.task));
        assert.ok(text.includes(evidence.A.execution));
        assert.ok(body.input.some(row => row.type === 'function_call' && row.call_id === 'native_B'));
        const previous = body.input.find(row => row.type === 'function_call_output' && row.call_id === 'native_B');
        assert.equal(JSON.parse(previous.output.trim()).execution, evidence.B.execution);
        if (materialNotificationMode === 'steer') {
          const precedingTool = body.input.find(row => row.type === 'function_call_output' && row.call_id === 'native_B-loop');
          assert.equal(precedingTool?.output.trim(), 'NATIVE_LOOP_CONTINUED');
          assert.equal(body.input.some(row => row.role === 'assistant' && row.content?.some?.(part => part.text === 'B_OK')), false);
        }
      }
      let item;
      const role = finishing ? 'finish' : routing ? 'route' : apply ? 'B-apply'
        : roles.find(name => body.input.some(row => row.type === 'function_call' && row.call_id === `native_${name}`));
      const output = role && body.input.findLast(row => row.type === 'function_call_output' && row.call_id === `native_${role}`)?.output;
      if (typeof output === 'string') {
        const result = JSON.parse(output.trim());
        assert.equal(result.role, role); assert.equal(result.same_process, true);
        evidence[role] = result; awaiting.get(role)?.resolve(result);
        if (role === 'B' && materialNotificationMode === 'steer') {
          await continueB.promise;
          item = { type: 'function_call', id: 'native_call_B-loop', call_id: 'native_B-loop', name: 'bash',
            arguments: JSON.stringify({ command: 'printf "%s\\n" NATIVE_LOOP_CONTINUED' }) };
        } else {
          item = { type: 'message', id: `native_final_${role}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `${role}_OK`, annotations: [] }] };
        }
      } else {
        if (apply) notificationInputs++;
        const next = finishing ? 'finish' : routing ? 'route' : apply ? 'B-apply' : roles[starts++];
        assert.ok(next);
        if (roles.includes(next)) {
          const developer = body.input.find(row => row.role === 'developer')?.content;
          const system = typeof developer === 'string' ? developer : developer?.map(row => row.text ?? '').join('');
          assert.deepEqual(body.tools.map(tool => tool.name), ['read', 'write', 'edit', 'bash']);
          assert.match(system, /<services>/);
          assert.doesNotMatch(system, /<(docs|added_system_prompt)>/);
          assert.match(text, /Mission: taskpool:native-workspace/);
          assert.match(text, /FIXED_NATIVE_ORIGINAL_PROBLEM/);
          assert.match(text, /multiple Tasks during discovery and during your Execution/);
          firstPrompts.set(next, system);
        }
        const material = routing ? { material_id: evidence.A.material } : apply ? adoptionNotification : null;
        item = { type: 'function_call', id: `native_call_${next}`, call_id: `native_${next}`, name: 'bash', arguments: JSON.stringify({
          command: script(next, apply?.[1] ?? null, material, routing ? evidence.B.task : null), timeout: 120 }) };
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(streamResponse('k3', arrivals, item));
    } catch (error) {
      failure = String(error);
      for (const deferred of awaiting.values()) deferred.reject(error);
      response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: failure } }));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { continueB.resolve(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); context.close(); tasks.close(); });
  const host = process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const budget = setTimeout(() => { for (const deferred of awaiting.values()) deferred.reject(new Error('Native diagnostic deadline')); }, 210_000);
  t.after(() => clearTimeout(budget));
  try {
    report = await runTaskPoolHarness({
      backend: createPiOpenSandboxBackend({ sandbox: {
        lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1', endpointHost: process.env.MURM_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1',
        apiKey: process.env.MURM_CORE_TEST_API_KEY, resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000 },
        bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` }, modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 150_000, maxOutputTokens: 4096 },
        models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: `http://127.0.0.1:${server.address().port}/v1/responses`, headers: {} } } },
        isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } } }),
      model: 'default', image, outputDir, taskService: tasks, contextService: context, missionWorkspace: workspace, workspaceManager: manager,
      missionId, workspaceId: initial.workspace_id, capacity, deadlineAt, autonomousTasks: true, workspaceCapture: 'core', prompt: '',
      controller: { discoveryContext: 'FIXED_NATIVE_ORIGINAL_PROBLEM', automaticContinuation: false, deliverNotifications: true, materialNotificationMode, selectionMs: 180_000, hardBudgetMs: 210_000, stallMs: 180_000,
        beforeInitialDispatch({ agentIds }) { admissions.push([...agentIds]); } },
      handoff: { executionTimeoutMs: 180_000 }, closeTimeoutMs: 40_000,
      async drive(controller, runtime) {
        runtimeId = runtime.id;
        runtime.onEvent(event => events.push({ type: event.type, agentId: event.agentId, outcome: event.outcome }));
        const [a, b] = await Promise.all([evidenceFor('A'), evidenceFor('B')]);
        const bAgent = tasks.getExecution(b.execution).owner_ref;
        const containers = await ownedContainers(runtime.id);
        const identities = await Promise.all(containers.map(async container => ({ container, agentKey: JSON.parse((await execute('docker', ['inspect', '--format', '{{json .Config.Labels.agent_key}}', container])).stdout) })));
        const bContainer = identities.find(row => row.agentKey === openSandboxAgentKey(bAgent)).container;
        if (materialNotificationMode === 'steer') {
          assert.equal((await runtime.get(bAgent)).status, 'running');
          assert.equal(events.some(event => event.agentId === bAgent && event.type === 'settled'), false);
        } else {
          while ((await runtime.get(bAgent)).status !== 'idle') { assert.ok(Date.now() < deadlineAt); await wait(25); }
        }
        const before = await sessionEvidence(bContainer, execute);
        const aAgent = tasks.getExecution(a.execution).owner_ref;
        while ((await runtime.get(aAgent)).status !== 'idle') { assert.ok(Date.now() < deadlineAt); await wait(25); }
        assert.equal((await runtime.send(aAgent, 'TASKPOOL_NATIVE_ROUTE', { requestId: 'native-route-turn', mode: 'followUp' })).status, 'accepted');
        const routed = await evidenceFor('route');
        assert.equal(routed.link.task_id, b.task);
        assert.equal(routed.link.producer_execution_id, a.execution);
        adoptionNotification ??= findNotice();
        assert.ok(adoptionNotification, 'A response link must create a durable notice for B');
        await controller.tick();
        const admitted = controller.snapshot().inputs.find(row => row.requestId === `taskpool:notification:${b.execution}:${adoptionNotification.notification_id}`);
        assert.equal(admitted?.receipt.disposition, materialNotificationMode === 'steer' ? 'queued' : 'started');
        continueB.resolve();
        const integrated = await evidenceFor('B-apply');
        while ((await runtime.get(bAgent)).status !== 'idle') { assert.ok(Date.now() < deadlineAt); await wait(25); }
        assert.deepEqual(await sessionEvidence(bContainer, execute), before);
        assert.equal(integrated.feedback.receipt.execution_id, b.execution);
        assert.equal(integrated.feedback.receipt.notification_id, adoptionNotification.notification_id);
        assert.ok(integrated.feedback.receipt.handled_at);
        assert.equal(integrated.feedback.receipt.handling_decision, 'adopted');
        assert.equal(tasks.listUnprocessedNotifications(b.task, b.execution).some(row => row.notification_id === adoptionNotification.notification_id), false);
        await controller.tick(); await controller.tick();
        const notificationInputsRecorded = controller.snapshot().inputs.filter(row => row.source === 'notification' && row.requestId === `taskpool:notification:${b.execution}:${adoptionNotification.notification_id}`);
        assert.equal(notificationInputsRecorded.length, 1);
        assert.equal(notificationInputsRecorded[0].mode, materialNotificationMode);
        assert.equal(notificationInputsRecorded[0].agentId, bAgent);
        assert.equal(notificationInputsRecorded[0].status, 'accepted');
        evidence.notification = { notification: adoptionNotification, input: notificationInputsRecorded[0], receipt: integrated.feedback.receipt };
        assert.equal(integrated.text, a.text); assert.equal(integrated.binary, a.binary);
        assert.deepEqual(integrated.applied.parents, [b.revision, a.revision]);
        assert.deepEqual(integrated.parents, [b.revision, a.revision]);
        const exported = await workspace.exportRevision({ workspaceId: initial.workspace_id, revision: integrated.revision });
        assert.deepEqual(Buffer.from(exported.files['lemma.txt']), Buffer.from(a.text, 'hex'));
        assert.deepEqual(Buffer.from(exported.files['lemma.bin']), Buffer.from(a.binary, 'hex'));
        assert.equal(Buffer.from(exported.files['consumer.txt']).toString(), 'CONSUMER_PROGRESS\nADOPTED_LEMMA\n');
        assert.equal(exported.manifest['lemma.bin'].content_hash, sha256(Buffer.from(a.binary, 'hex')));
        const integratedSource = (await workspace.listRevisions({ workspaceId: initial.workspace_id }))
          .find(row => row.revision === integrated.revision)?.source;
        const use = integratedSource.material_uses[0];
        assert.equal(use.material_id, a.material);
        assert.equal(use.content_hash, context.getMaterial(a.material).content_hash);
        assert.equal(integratedSource.execution_id, b.execution);
        for (const role of roles.slice(0, capacity)) await evidenceFor(role);
        assert.equal(tasks.listTasks({ missionId, availableOnly: false }).length, capacity + 3);
        evidence.session = before; evidence.hash = exported.manifest['lemma.bin'].content_hash;
        const bSlot = controller.snapshot().agents.find(row => row.agentId === bAgent).slot;
        assert.equal((await runtime.send(bAgent, 'TASKPOOL_NATIVE_FINISH', { requestId: 'native-finish-turn', mode: 'followUp' })).status, 'accepted');
        const replacement = await evidenceFor('C');
        const cAgent = tasks.getExecution(replacement.execution).owner_ref;
        assert.equal(tasks.getTask(replacement.task).created_by, aAgent);
        while ((await runtime.get(cAgent)).status !== 'idle') { assert.ok(Date.now() < deadlineAt); await wait(25); }
        const rows = controller.snapshot().agents;
        assert.equal(tasks.getTask(b.task).state, 'DONE');
        assert.equal(tasks.getExecution(b.execution).state, 'SUCCEEDED');
        assert.equal(tasks.getAgent(bAgent).state, 'CLOSED');
        assert.equal(rows.find(row => row.agentId === bAgent).released, true);
        assert.notEqual(cAgent, bAgent);
        assert.equal(rows.find(row => row.agentId === cAgent).slot, bSlot);
        assert.equal((await ownedContainers(runtime.id)).includes(bContainer), false);
        assert.equal(admissions.length, 2);
        assert.ok(admissions[0].includes(bAgent));
        assert.ok(admissions[1].includes(cAgent));
        assert.equal(admissions[1].includes(bAgent), false);
        evidence.replacement = { finishedAgent: bAgent, newAgent: cAgent, slot: bSlot, admissions };
        controller.halt('controlled-native-complete');
      },
    });
    assert.equal(failure, undefined, failure);
    assert.equal(report.businessFailure?.code, 'TASKPOOL_BUSINESS_FAILED', report.businessFailure?.message);
    assert.ok(evidence.replacement, 'Drive must complete the entire route and cleanly replace B');
    assert.ok(arrivals >= roles.length * 2 + 4 && arrivals <= 20, `Unexpected provider request count: ${arrivals}`);
    assert.equal(starts, roles.length); assert.equal(notificationInputs, 1);
    for (const role of roles) {
      const expected = Object.entries(evidence[role].services).flatMap(([service, operations]) =>
        operations.map(operation => serviceCommand(service, operation))).sort();
      const advertised = [...firstPrompts.get(role).matchAll(/^- `(swarm [^`]+)`/gm)].map(match => match[1]).sort();
      assert.deepEqual(advertised, expected, `Service grants and startup directory differ for ${role}`);
    }
    assert.equal(report.businessFailure?.code, 'TASKPOOL_BUSINESS_FAILED');
    assert.equal(report.cleanupFailure, null); assert.equal(report.cleanup.cleanup, 'complete');
    assert.deepEqual(await ownedContainers(runtimeId), []);
    assert.ok(report.cleanup.agents.every(agent => agent.execution === 'stopped' && agent.cleanup === 'complete'));
    for (const agent of report.cleanup.agents) assert.equal(tasks.getAgent(agent.agentId).state, 'CLOSED');
    const trace = JSON.parse(await readFile(join(outputDir, runtimeId, 'runtime.json'), 'utf8'));
    assert.equal(trace.cleanup, 'complete');
    const calls = (await readFile(join(outputDir, runtimeId, 'service-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    for (const operation of ['task_create', 'task_take', 'workspace_save', 'workspace_apply', 'context_publish_material', 'task_finish', 'task_feedback']) {
      assert.ok(calls.some(row => row.operation === operation && row.phase === 'settled'), `Missing settled Service trace for ${operation}`);
    }
    assert.ok(calls.every(row => Number.isFinite(Date.parse(row.startedAt))));
  } finally {
    await writeFile(join(outputDir, 'acceptance.json'), JSON.stringify({ mode: 'scripted-local-native', image, runtimeId, arrivals, starts, failure, evidence, events, report }, null, 2), { mode: 0o600 });
  }
}
