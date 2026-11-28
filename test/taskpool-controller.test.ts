import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { request } from 'node:http';
import { createTaskPoolPublicationServices } from '../examples/taskpool/services/workspace/publication-services.js';
import { ServiceRegistry } from '../src/core/services.js';
import { transport, controls } from './fixtures/taskpool-controller-backend.js';
import { createTaskPoolStores } from './fixtures/taskpool-task-stores.js';
import { createTaskPoolController } from '../examples/taskpool/harness/controller.js';
import { makeEnvelope } from '../examples/taskpool/persistence/envelope.js';
const hooks=registerHooks({resolve(specifier,context,next){
  if(specifier==='./sandbox/opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return {url:new URL('./fixtures/taskpool-controller-backend.js',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}});
const {createRuntime}=await import('../src/core/index.js'); hooks.deregister();
async function fixture(t,options={}) {
  const root=await mkdtemp(join(tmpdir(),'taskpool-controller-'));
  const stores=await createTaskPoolStores(root); transport.reset();controls.stopError=null;controls.destroyError=null;
  let runtime, controller;
  const services = new ServiceRegistry();
  let publication;
  if (options.onFinish) {
    publication = createTaskPoolPublicationServices({ runtime: () => runtime, taskService: stores.tasks,
      contextService: stores.context, missionWorkspace: stores.workspace, missionId: stores.missionId,
      workspaceId: stores.workspaceId, deadline: () => Date.now() + 60000,
      onFinish(receipt) { options.onFinish(receipt); controller.notify(); } });
    for (const registration of publication.registrations) services.registerService(registration);
  }
  runtime=await createRuntime({sandbox: {},profiles:{researcher:{prompt:'Fixed',model:'default',image:'fixture',writable:false,services:publication?{task:['task_finish']}:{}}},services,maxAgents:options.capacity??2,outputDir:root});
  const accepted=id=>{transport.confirm(id,'started');transport.next=accepted;}; transport.next=accepted;
  const reads={beforeGet:null};
  controller=createTaskPoolController({runtime:{...runtime,async get(id){await reads.beforeGet?.();return runtime.get(id);}},taskService:stores.tasks,missionId:stores.missionId,capacity:1,deadlineAt:Date.now()+60000,heartbeatMs:10000,stallMs:30000,...options});
  t.after(async()=>{controls.stopError=null;controls.destroyError=null;publication?.close();await controller.close();await runtime.close();stores.close();await rm(root,{recursive:true,force:true});});
  options.captureController?.(controller);
  await options.beforeStart?.(stores);
  await controller.start();
  const agent=controller.snapshot().agents[0];
  function take() {
    let execution=stores.tasks.takeTask(stores.task.task_id,{owner_ref:agent.agentId,core_id:agent.legacySlotId,take_key:'fixed'}).execution;
    execution=stores.tasks.dispatch('start_execution',{core_id:agent.legacySlotId},makeEnvelope({actorRef:agent.agentId,taskId:execution.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version})).execution;
    return execution;
  }
  return {...stores,root,runtime,controller,agent,take,reads,settle(outcome='completed'){transport.listeners.get(agent.agentId)({type:'settled',outcome});}};
}

test('flat settled continues an unfinished owned Execution without declaring Task success',async t=>{
  const f=await fixture(t); const execution=f.take();
  f.settle(); await f.controller.flush();
  const snapshot=f.controller.snapshot();
  assert.equal(f.tasks.getTask(f.task.task_id).state,'RUNNING');
  assert.equal(f.tasks.getExecution(execution.execution_id).state,'RUNNING');
  assert.equal(snapshot.inputs.length,2);
  assert.deepEqual(snapshot.inputs.map(row=>[row.source,row.mode,row.status]),[['discovery','followUp','accepted'],['continuation','followUp','accepted']]);
  assert.equal(snapshot.decisions.at(-1).reason,'unfinished-execution');
  assert.equal(snapshot.decisions.at(-1).executionId,execution.execution_id);
  assert.ok(snapshot.decisions.at(-1).remainingMs>0);
});

test('TaskPool owns one durable handoff warning at the persisted threshold without completing work',async t=>{
  const f=await fixture(t);const execution=f.take();
  let enqueues=0,signals=0;const enqueue=f.tasks.enqueueNotification.bind(f.tasks);
  f.tasks.enqueueNotification=(...args)=>{enqueues++;return enqueue(...args);};
  const unsubscribe=f.tasks.subscribeNotifications(()=>signals++);t.after(unsubscribe);
  const deadline=new Date(Date.now()+30000).toISOString();
  f.tasks.db.prepare('UPDATE executions SET handoff_deadline = ?, execution_deadline = ? WHERE execution_id = ?')
    .run(new Date(Date.now()+20000).toISOString(),deadline,execution.execution_id);
  await f.controller.tick();
  assert.equal(f.tasks.listUnprocessedNotifications(f.task.task_id,execution.execution_id).length,0);
  f.tasks.db.prepare('UPDATE executions SET handoff_deadline = ? WHERE execution_id = ?').run(new Date(Date.now()-1).toISOString(),execution.execution_id);
  await f.controller.tick();
  const warnings=f.tasks.listUnprocessedNotifications(f.task.task_id,execution.execution_id);
  assert.equal(warnings.length,1);const warning=warnings[0];
  assert.equal(warning.notification_type,'handoff_warning');
  assert.equal(warning.payload.deadline,deadline);
  assert.ok(warning.recipient_delivery.delivered_at);
  assert.equal(warning.handled_at,null);
  const submitted=f.controller.snapshot().inputs.filter(row=>row.source==='handoff-warning');
  assert.equal(submitted.length,1);assert.equal(submitted[0].mode,'followUp');assert.equal(submitted[0].status,'accepted');
  const sent=[...transport.submissions.values()].filter(row=>row.input.includes(warning.notification_id));
  assert.equal(sent.length,1);assert.match(sent[0].input,/Stop expanding work, save existing files and research content, then finish with the actual outcome/);
  await f.controller.tick();f.settle();await f.controller.flush();await f.controller.tick();
  assert.equal([...transport.submissions.values()].filter(row=>row.input.includes(warning.notification_id)).length,1);
  assert.equal(enqueues,1);assert.equal(signals,1);
  assert.ok(f.tasks.getExecution(execution.execution_id).handoff_reminder_sent_at);
  assert.equal(f.tasks.getExecution(execution.execution_id).state,'RUNNING');assert.equal(f.tasks.getTask(f.task.task_id).state,'RUNNING');
});

function dueHandoff(f,execution) {
  f.tasks.db.prepare('UPDATE executions SET handoff_deadline = ?, execution_deadline = ? WHERE execution_id = ?')
    .run(new Date(Date.now()-1).toISOString(),new Date(Date.now()+30000).toISOString(),execution.execution_id);
}

test('handoff warning accepts an idle Agent and recovers a temporarily unavailable public lookup',async t=>{
  const f=await fixture(t,{automaticContinuation:false});const execution=f.take();dueHandoff(f,execution);
  f.settle();await f.controller.flush();assert.equal((await f.runtime.get(f.agent.agentId)).status,'idle');
  f.reads.beforeGet=()=>{f.reads.beforeGet=null;throw new Error('controlled unavailable lookup');};
  const count=transport.submissions.size;
  await f.controller.tick();assert.equal(transport.submissions.size,count);
  await f.controller.tick();await f.controller.tick();
  const warning=f.tasks.listUnprocessedNotifications(f.task.task_id,execution.execution_id)[0];
  assert.ok(warning.recipient_delivery.delivered_at);
  assert.equal([...transport.submissions.values()].filter(row=>row.input.includes(warning.notification_id)).length,1);
  assert.deepEqual(f.controller.snapshot().failures,[]);
});

test('handoff warning unknown admission retains its original identity and original lease without another input',async t=>{
  const f=await fixture(t);const execution=f.take();dueHandoff(f,execution);transport.next=undefined;
  await f.controller.tick();
  const first=f.controller.snapshot().inputs.find(row=>row.source==='handoff-warning');
  assert.equal(first.status,'unknown');const count=transport.submissions.size;
  const warning=f.tasks.listUnprocessedNotifications(f.task.task_id,execution.execution_id)[0];
  assert.equal(warning.recipient_delivery,null);assert.equal(warning.delivery_attempts,1);
  const before=f.tasks.getExecution(execution.execution_id).state_version;
  f.settle();await f.controller.flush();await f.controller.tick();
  assert.equal(transport.submissions.size,count);assert.equal(f.controller.snapshot().inputs.filter(row=>row.source==='handoff-warning').length,1);
  assert.ok(f.tasks.getExecution(execution.execution_id).state_version>before);
  assert.equal(f.tasks.getExecution(execution.execution_id).state,'RUNNING');
});

for(const fault of ['reminder-ack','enqueue','enqueue-ack','delivery-receipt']) test(`handoff warning recovers a ${fault} failure without repeating admitted input`,async t=>{
  const f=await fixture(t);const execution=f.take();dueHandoff(f,execution);
  const method=fault==='reminder-ack'?'dispatch':fault.startsWith('enqueue')?'enqueueNotification':'markNotificationDelivered';
  const original=f.tasks[method].bind(f.tasks);let failed=false;
  f.tasks[method]=(...args)=>{if(!failed && (fault!=='reminder-ack'||args[0]==='record_handoff_reminder')){failed=true;if(['reminder-ack','enqueue-ack'].includes(fault)) original(...args);throw new Error('controlled receipt failure');}return original(...args);};
  await f.controller.tick();
  assert.ok(f.tasks.getExecution(execution.execution_id).handoff_reminder_sent_at);
  assert.equal(f.tasks.getExecution(execution.execution_id).state,'RUNNING');
  await f.controller.tick();await f.controller.tick();
  const warnings=f.tasks.listUnprocessedNotifications(f.task.task_id,execution.execution_id);
  assert.equal(warnings.length,1);assert.ok(warnings[0].recipient_delivery.delivered_at);
  assert.deepEqual(f.controller.snapshot().failures,[]);
  assert.ok(f.controller.snapshot().decisions.some(row=>row.reason==='handoff-warning-pending'));
  assert.equal(warnings[0].delivery_attempts,2);
  assert.equal([...transport.submissions.values()].filter(row=>row.input.includes(warnings[0].notification_id)).length,1);
});

test('handoff pending evidence suppresses throwable secrets and records one safe category across repeated failures',async t=>{
  const f=await fixture(t);const execution=f.take();dueHandoff(f,execution);
  const enqueue=f.tasks.enqueueNotification.bind(f.tasks);let attempts=0;
  f.tasks.enqueueNotification=(...args)=>{
    if(++attempts<=2) throw Object.assign(new Error('Bearer sk-PRIVATE_WARNING_CREDENTIAL /home/private/PRIVATE_WARNING_PATH'),{code:'PRIVATE_WARNING_ERROR_CODE'});
    return enqueue(...args);
  };
  await f.controller.tick();await f.controller.tick();
  const pending=f.controller.snapshot();
  assert.doesNotMatch(JSON.stringify(pending),/PRIVATE_WARNING_|Bearer|sk-/);
  assert.deepEqual(pending.failures,[]);
  assert.deepEqual(pending.decisions.filter(row=>row.reason==='handoff-warning-pending').map(row=>row.code),['HANDOFF_WARNING_PENDING']);
  await f.controller.tick();await f.controller.tick();
  const recovered=f.controller.snapshot();
  assert.deepEqual(recovered.failures,[]);
  assert.doesNotMatch(JSON.stringify(recovered),/PRIVATE_WARNING_|Bearer|sk-/);
  assert.equal(recovered.decisions.filter(row=>row.reason==='handoff-warning-pending').length,1);
  const warning=f.tasks.listUnprocessedNotifications(f.task.task_id,execution.execution_id)[0];
  assert.ok(warning.recipient_delivery.delivered_at);
  assert.equal([...transport.submissions.values()].filter(row=>row.input.includes(warning.notification_id)).length,1);
});

test('handoff warning retains its original fence when a deferred admission becomes available',async t=>{
  const f=await fixture(t);const execution=f.take();dueHandoff(f,execution);
  f.reads.beforeGet=()=>{f.reads.beforeGet=null;f.tasks.db.prepare('UPDATE executions SET fencing_version = fencing_version + 1 WHERE execution_id = ?').run(execution.execution_id);};
  await f.controller.tick();await f.controller.tick();
  const warning=f.tasks.listUnprocessedNotifications(f.task.task_id,execution.execution_id)[0];
  assert.equal([...transport.submissions.values()].some(row=>row.input.includes(warning.notification_id)),false);
  assert.ok(f.controller.snapshot().inputs.filter(row=>row.source==='handoff-warning').every(row=>row.status==='not_submitted'));
});

for(const boundary of ['finish','fence','lease']) test(`handoff warning rechecks ${boundary} after final Core lookup`,async t=>{
  const f=await fixture(t);const execution=f.take();dueHandoff(f,execution);
  f.reads.beforeGet=()=>{
    f.reads.beforeGet=null;
    if(boundary==='finish') {
      const current=f.tasks.getExecution(execution.execution_id);
      f.tasks.dispatch('task_finish',{outcome:'incomplete'},makeEnvelope({actorRef:f.agent.agentId,taskId:current.task_id,executionId:current.execution_id,specVersion:current.spec_version,stateVersion:current.state_version,fencingVersion:current.fencing_version}));
    } else if(boundary==='fence') f.tasks.db.prepare('UPDATE executions SET fencing_version = fencing_version + 1 WHERE execution_id = ?').run(execution.execution_id);
    else f.tasks.db.prepare('UPDATE executions SET lease_expires_at = ? WHERE execution_id = ?').run(new Date(Date.now()-1).toISOString(),execution.execution_id);
  };
  await f.controller.tick();
  const input=f.controller.snapshot().inputs.find(row=>row.source==='handoff-warning');
  assert.equal(input.status,'not_submitted');assert.equal(input.reason,'task-binding-changed');
  const warning=f.tasks.listUnprocessedNotifications(f.task.task_id,execution.execution_id)[0];
  assert.equal([...transport.submissions.values()].some(row=>row.input.includes(warning.notification_id)),false);
  assert.equal(warning.recipient_delivery,null);
});

test('directed feedback shares controller ordering, explicit mode and original input identity',async t=>{
  const f=await fixture(t);const execution=f.take();
  const first=await f.controller.feedback({taskId:f.task.task_id,input:'Check this fixed case',requestId:'feedback-one',mode:'steer'});
  assert.equal(first.status,'accepted');assert.equal(first.agentId,f.agent.agentId);assert.equal(first.executionId,execution.execution_id);assert.equal(first.mode,'steer');
  assert.deepEqual(await f.controller.feedback({taskId:f.task.task_id,input:'Check this fixed case',requestId:'feedback-one',mode:'steer'}),first);
  assert.throws(()=>f.controller.feedback({taskId:f.task.task_id,input:'Different',requestId:'feedback-one',mode:'steer'}),{code:'CONFLICT'});
  assert.equal([...transport.submissions.values()].filter(row=>row.input==='Check this fixed case').length,1);
  f.tasks.dispatch('task_finish',{outcome:'done'},makeEnvelope({actorRef:f.agent.agentId,taskId:execution.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version}));
  const rejected=await f.controller.feedback({taskId:f.task.task_id,input:'Late',requestId:'late'});
  assert.equal(rejected.status,'not_submitted');assert.equal(rejected.reason,'task-not-running');
  assert.equal([...transport.submissions.values()].some(row=>row.input==='Late'),false);
});

test('unknown feedback remains under its original ID and prevents automatic continuation',async t=>{
  const f=await fixture(t);f.take();transport.next=undefined;
  const result=await f.controller.feedback({taskId:f.task.task_id,input:'Uncertain feedback',requestId:'unknown'});
  assert.equal(result.status,'unknown');
  const count=transport.submissions.size;
  f.settle();await f.controller.flush();
  assert.equal(transport.submissions.size,count);
  assert.deepEqual(await f.controller.feedback({taskId:f.task.task_id,input:'Uncertain feedback',requestId:'unknown'}),result);
});

test('accepted finish is finalized after public stop and replacement starts a fresh readonly Agent',async t=>{
  const f=await fixture(t);const execution=f.take();
  const second=f.tasks.createTask({mission_id:f.missionId,gap:'One more fixed result',priority:'medium',summary:'Second fixed Task',expected_output:'Result',acceptance_conditions:['Result']},makeEnvelope({actorRef:'host'})).task;
  f.tasks.dispatch('task_finish',{outcome:'done'},makeEnvelope({actorRef:f.agent.agentId,taskId:execution.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version}));
  await f.controller.tick();
  assert.equal(f.tasks.getTask(f.task.task_id).state,'DONE');
  assert.equal(f.tasks.getExecution(execution.execution_id).state,'SUCCEEDED');
  assert.equal(f.tasks.getAgent(f.agent.agentId).state,'CLOSED');
  const rows=f.controller.snapshot().agents;
  assert.equal(rows.length,2);assert.notEqual(rows[0].agentId,rows[1].agentId);assert.equal(rows[0].released,true);assert.equal(rows[1].slot,rows[0].slot);
  assert.equal(f.tasks.getAgent(rows[1].agentId).state,'UNBOUND');
  assert.equal(f.tasks.getTask(second.task_id).state,'OPEN');
});


test('accepted Bridge finish survives a disconnected caller and closes through the TaskPool controller', { timeout: 8000 }, async t => {
  let client, finishReceipt;
  const f = await fixture(t, { onFinish(receipt) {
    finishReceipt = receipt;
    assert.equal(f.tasks.getExecution(execution.execution_id).state, 'CLOSING');
    assert.equal(f.tasks.getTask(f.task.task_id).state, 'RUNNING');
    assert.equal(f.controller.snapshot().agents[0].released, false);
    // The real HTTP caller disappears after durable admission, before reply.
    client.destroy();
  } });
  const execution = f.take();
  let closed = 0;
  const unsubscribe = f.tasks.subscribeTaskEvents(event => {
    if (event.kind === 'task_finish_closed' && event.execution_id === execution.execution_id) closed++;
  });
  t.after(unsubscribe);
  const credentials = controls.credentials.get(f.agent.agentId);
  const url = new URL(credentials.environment.MURM_BRIDGE_URL);
  url.hostname = '127.0.0.1';
  const disconnected = new Promise((resolve, reject) => {
    client = request(new URL('/call', url), { method: 'POST', headers: {
      authorization: `Bearer ${credentials.secretEnvironment.MURM_BRIDGE_TOKEN}`,
      'content-type': 'application/json',
    } });
    client.on('response', response => { response.resume(); reject(new Error('Caller must disconnect before receiving a finish reply')); });
    client.on('error', error => { if (!finishReceipt) reject(error); });
    client.on('close', resolve);
    client.end(JSON.stringify({ service_id: 'task', operation: 'task_finish',
      operation_id: 'finish-disconnected', payload: { outcome: 'done' } }));
  });
  t.after(() => client.destroy());
  await disconnected;
  // Join only queued host work; no tick, settled event or caller retry drives cleanup.
  await f.controller.flush();
  assert.equal(finishReceipt.requestId, 'finish-disconnected');
  assert.equal(finishReceipt.executionId, execution.execution_id);
  assert.equal(f.tasks.getTask(f.task.task_id).state, 'DONE');
  assert.equal(f.tasks.getExecution(execution.execution_id).state, 'SUCCEEDED');
  assert.equal(f.tasks.getAgent(f.agent.agentId).state, 'CLOSED');
  assert.equal((await f.runtime.get(f.agent.agentId)).status, 'closed');
  assert.equal(f.controller.snapshot().agents[0].released, true);
  assert.equal(closed, 1);
  await f.controller.flush();
  assert.equal(closed, 1);
});

test('execution unknown retains its Task owner and occupied Slot until stop reconciliation',async t=>{
  const f=await fixture(t);const execution=f.take();
  controls.stopError=Object.assign(new Error('Fixed stop uncertainty'),{code:'OPERATION_UNKNOWN'});
  f.settle('failed');await f.controller.flush();
  assert.equal(f.tasks.getExecution(execution.execution_id).state,'RUNNING');
  assert.equal(f.tasks.getAgent(f.agent.agentId).state,'CLOSING');
  assert.equal(f.controller.snapshot().agents.length,1);
  assert.equal(f.controller.snapshot().agents[0].lastStop.execution,'unknown');
  controls.stopError=null;await f.controller.tick();
  assert.equal(f.tasks.getExecution(execution.execution_id).state,'FAILED');
  assert.equal(f.controller.snapshot().agents.length,2);
});

test('confirmed execution stop and pending cleanup release Task outcome but retain the occupied Slot',async t=>{
  const f=await fixture(t);const execution=f.take();
  controls.destroyError=new Error('Fixed physical deletion failure');
  f.settle('aborted');await f.controller.flush();
  assert.equal(f.tasks.getExecution(execution.execution_id).state,'FAILED');
  const snapshot=f.controller.snapshot();assert.equal(snapshot.agents.length,1);
  assert.equal(snapshot.agents[0].lastStop.execution,'stopped');assert.equal(snapshot.agents[0].lastStop.cleanup,'pending');assert.equal(snapshot.agents[0].released,false);
  assert.notEqual(f.tasks.getTask(f.task.task_id).state,'DONE');
  controls.destroyError=null;await f.controller.tick();
  assert.equal(f.controller.snapshot().agents.length,2);
});

test('incomplete finish retains its owner through unknown stop and retries cleanup before Slot reuse', async t => {
  const f = await fixture(t);
  const execution = f.take();
  const envelope = makeEnvelope({
    operationId: 'incomplete-finish-cleanup', actorRef: f.agent.agentId,
    taskId: execution.task_id, executionId: execution.execution_id,
    specVersion: execution.spec_version, stateVersion: execution.state_version,
    fencingVersion: execution.fencing_version,
  });
  f.tasks.dispatch('task_finish', { outcome: 'incomplete', reason: 'Continue in a fresh Agent' }, envelope);

  controls.stopError = Object.assign(new Error('Worker stop is unconfirmed'), { code: 'OPERATION_UNKNOWN' });
  await f.controller.tick();
  assert.equal(f.tasks.getExecution(execution.execution_id).state, 'CLOSING');
  assert.equal(f.tasks.getTask(f.task.task_id).state, 'RUNNING');
  assert.equal(f.tasks.listEligibleTasks().length, 0);
  assert.equal(f.controller.snapshot().agents.length, 1);
  assert.equal(f.controller.snapshot().agents[0].lastStop.execution, 'unknown');
  assert.equal(f.controller.snapshot().agents[0].released, false);

  controls.stopError = null;
  controls.destroyError = new Error('Sandbox deletion is unconfirmed');
  await f.controller.tick();
  assert.equal(f.tasks.getExecution(execution.execution_id).state, 'HANDED_OFF');
  assert.equal(f.tasks.getTask(f.task.task_id).state, 'OPEN');
  assert.equal(f.tasks.getAgent(f.agent.agentId).state, 'CLOSING');
  assert.equal(f.controller.snapshot().agents.length, 1);
  assert.equal(f.controller.snapshot().agents[0].lastStop.execution, 'stopped');
  assert.equal(f.controller.snapshot().agents[0].lastStop.cleanup, 'pending');
  assert.equal(f.controller.snapshot().agents[0].released, false);

  controls.destroyError = null;
  await f.controller.tick();
  const rows = f.controller.snapshot().agents;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].released, true);
  assert.equal(f.tasks.getAgent(f.agent.agentId).state, 'CLOSED');
  assert.equal(rows[1].slot, rows[0].slot);
  assert.notEqual(rows[1].agentId, f.agent.agentId);
  const successor = f.tasks.takeTask(f.task.task_id, {
    owner_ref: rows[1].agentId, core_id: rows[1].legacySlotId, take_key: 'successor-after-cleanup',
  }).execution;
  await f.controller.tick();
  assert.equal(f.tasks.getTask(f.task.task_id).state, 'RUNNING');
  assert.equal(f.tasks.getActiveExecutionForCore(rows[1].legacySlotId).execution_id, successor.execution_id);
  assert.equal(f.tasks.getExecution(execution.execution_id).state, 'HANDED_OFF');
  assert.equal(f.controller.snapshot().agents.length, 2);
});

test('host close records intent for a still-unbound discovery Agent before finalizing its domain Slot',async t=>{
  const f=await fixture(t);
  assert.equal(f.tasks.getAgent(f.agent.agentId).state,'UNBOUND');
  f.controller.halt();
  const receipt=await f.runtime.close();
  assert.equal(receipt.cleanup,'complete');
  await f.controller.reconcileClose(receipt);
  assert.equal(f.tasks.getAgent(f.agent.agentId).state,'CLOSED');
  const row=f.controller.snapshot().agents[0];
  assert.equal(row.lastStop.execution,'stopped');assert.equal(row.lastStop.cleanup,'complete');assert.equal(row.released,true);
});

test('host close with unknown execution retains its active Task owner until a stopped receipt is reconciled',async t=>{
  const f=await fixture(t);const execution=f.take();
  controls.stopError=Object.assign(new Error('Fixed host close uncertainty'),{code:'OPERATION_UNKNOWN'});
  f.controller.halt();
  const unknown=await f.runtime.close({timeoutMs:100});
  await f.controller.reconcileClose(unknown);
  assert.equal(f.tasks.getAgent(f.agent.agentId).state,'CLOSING');assert.equal(f.tasks.getTask(f.task.task_id).state,'RUNNING');
  assert.equal(f.tasks.getExecution(execution.execution_id).owner_ref,f.agent.agentId);assert.equal(f.tasks.getExecution(execution.execution_id).state,'RUNNING');
  assert.equal(f.controller.snapshot().agents[0].released,false);
  controls.stopError=null;
  await f.controller.reconcileClose(await f.runtime.close());
  assert.equal(f.tasks.getAgent(f.agent.agentId).state,'CLOSED');assert.equal(f.tasks.getExecution(execution.execution_id).state,'FAILED');
  assert.equal(f.controller.snapshot().agents[0].released,true);
});

test('feedback selected before a close race is recorded without dispatch or retargeting',async t=>{
  const f=await fixture(t);const execution=f.take();
  const pending=f.controller.feedback({taskId:f.task.task_id,input:'Must not arrive after finish',requestId:'racing'});
  f.tasks.dispatch('task_finish',{outcome:'done'},makeEnvelope({actorRef:f.agent.agentId,taskId:execution.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version}));
  const result=await pending;
  assert.equal(result.status,'not_submitted');
  assert.equal([...transport.submissions.values()].some(row=>row.input==='Must not arrive after finish'),false);
});

test('settled discovery after selection deadline stops the old Agent before any further discovery',async t=>{
  const f=await fixture(t,{selectionMs:30});
  await new Promise(resolve=>setTimeout(resolve,45));
  f.settle();await f.controller.flush();
  const snapshot=f.controller.snapshot();
  assert.equal(snapshot.agents[0].stopReason,'domain-deadline');
  assert.equal(snapshot.agents[0].released,true);
  assert.equal(snapshot.inputs.filter(row=>row.agentId===f.agent.agentId).length,1);
  assert.equal(snapshot.agents.length,2);
  assert.equal(f.tasks.getAgent(f.agent.agentId).state,'CLOSED');
  assert.equal((await f.runtime.get(f.agent.agentId)).status,'closed');
  assert.equal(f.tasks.listExecutions(f.task.task_id).length,0);
  assert.equal(f.tasks.getAgent(snapshot.agents[1].agentId).execution_id,null);
});

test('unknown input prevents resend but does not suppress the original Agent hard deadline',async t=>{
  const f=await fixture(t,{hardBudgetMs:60});const execution=f.take();transport.next=undefined;
  const result=await f.controller.feedback({taskId:f.task.task_id,input:'Uncertain bounded feedback',requestId:'bounded-unknown'});
  assert.equal(result.status,'unknown');
  await new Promise(resolve=>setTimeout(resolve,75));
  await f.controller.tick();
  const snapshot=f.controller.snapshot();
  assert.equal(snapshot.agents[0].stopReason,'domain-deadline');
  assert.equal(f.tasks.getExecution(execution.execution_id).state,'FAILED');
  assert.equal(snapshot.agents[0].released,true);
  assert.equal(snapshot.inputs.filter(row=>row.requestId==='bounded-unknown').length,1);
});

for(const budget of ['discovery','continuation']) test(`${budget} limit stops the old Agent and replacement uses a new identity`,async t=>{
  const f=await fixture(t,{discoveryLimit:1,continuationLimit:1});
  const execution=budget==='continuation'?f.take():null;
  f.settle();await f.controller.flush();
  if(execution) {f.settle();await f.controller.flush();}
  const snapshot=f.controller.snapshot();
  assert.equal(snapshot.agents[0].stopReason,`${budget}-budget`);
  assert.equal(snapshot.agents[0].released,true);
  assert.notEqual(snapshot.agents[1].agentId,f.agent.agentId);
  assert.equal(snapshot.inputs.filter(row=>row.agentId===f.agent.agentId).length,execution?2:1);
  if(execution) assert.equal(f.tasks.getExecution(execution.execution_id).state,'FAILED');
});

test('stall stops an unfinished Execution and records actual domain and budget evidence',async t=>{
  const f=await fixture(t,{stallMs:30});const execution=f.take();
  await new Promise(resolve=>setTimeout(resolve,45));await f.controller.tick();
  const snapshot=f.controller.snapshot();
  assert.equal(snapshot.agents[0].stopReason,'stall-budget');
  assert.equal(f.tasks.getExecution(execution.execution_id).state,'FAILED');
  const decision=snapshot.decisions.find(row=>row.reason==='slot-released');
  assert.equal(decision.executionId,execution.execution_id);
  assert.ok(decision.hardDeadline);assert.equal(decision.stallRemainingMs,0);
  const premise=snapshot.decisions.find(row=>row.reason==='stall-budget');
  assert.equal(premise.executionState,'RUNNING');assert.equal(premise.taskState,'RUNNING');
});

test('fatal Worker failure still stops an uncertain input without resubmitting it',async t=>{
  const f=await fixture(t);const execution=f.take();transport.next=undefined;
  const original=await f.controller.feedback({taskId:f.task.task_id,input:'Uncertain fatal feedback',requestId:'fatal-unknown'});
  transport.listeners.get(f.agent.agentId)({type:'error',fatal:true,error:{code:'WORKER_FAILED'}});
  await f.controller.flush();
  const snapshot=f.controller.snapshot();
  assert.equal(original.status,'unknown');assert.equal(snapshot.agents[0].stopReason,'worker-failed');
  assert.equal(f.tasks.getExecution(execution.execution_id).state,'FAILED');
  assert.equal(snapshot.inputs.filter(row=>row.requestId==='fatal-unknown').length,1);
});

test('feedback rechecks domain ownership after the final asynchronous public Core lookup',async t=>{
  const f=await fixture(t);const execution=f.take();
  f.reads.beforeGet=()=>{
    f.reads.beforeGet=null;
    f.tasks.dispatch('task_finish',{outcome:'done'},makeEnvelope({actorRef:f.agent.agentId,taskId:execution.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version}));
  };
  const receipt=await f.controller.feedback({taskId:f.task.task_id,input:'Must not cross lookup race',requestId:'lookup-race'});
  assert.equal(receipt.status,'not_submitted');assert.equal(receipt.reason,'task-binding-changed');
  assert.equal(receipt.executionState,'CLOSING');assert.equal(receipt.ownerState,'CLOSING');
  assert.equal([...transport.submissions.values()].some(row=>row.input==='Must not cross lookup race'),false);
});

test('unknown input retains its original lease heartbeat without allowing another input',async t=>{
  const f=await fixture(t);const execution=f.take();transport.next=undefined;
  await f.controller.feedback({taskId:f.task.task_id,input:'Unknown receipt with owned live work',requestId:'lease-unknown'});
  const before=f.tasks.getExecution(execution.execution_id),count=transport.submissions.size;
  await f.controller.tick();
  const after=f.tasks.getExecution(execution.execution_id);
  assert.ok(after.state_version>before.state_version,'Original owned Execution must retain its heartbeat while admission is unknown');
  assert.equal(after.state,'RUNNING');assert.equal(transport.submissions.size,count);
});


test('flat reconciliation repairs dependency state before discovery and after missed notifications',async t=>{
  let dependent;
  const f=await fixture(t,{beforeStart({tasks,task,missionId}) {
    dependent=tasks.createTask({mission_id:missionId,gap:'Track a fixed prerequisite',priority:'medium',summary:'Dependent work',expected_output:'Result',acceptance_conditions:['Verified'],depends_on:[task.task_id]},makeEnvelope({actorRef:'host'})).task;
    // Simulate an OPEN row whose prerequisite changed in another writer.
    tasks.db.prepare("UPDATE tasks SET state='OPEN', block_reason=NULL WHERE task_id=?").run(dependent.task_id);
  }});
  assert.equal(f.tasks.getTask(dependent.task_id).state,'BLOCKED');
  const execution=f.take();
  f.tasks.dispatch('task_finish',{outcome:'done'},makeEnvelope({actorRef:f.agent.agentId,taskId:execution.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version}));
  await f.controller.tick();
  assert.equal(f.tasks.getTask(dependent.task_id).state,'OPEN');
  assert.equal(f.tasks.getTask(f.task.task_id).state,'DONE');
  const current=f.tasks.getTask(dependent.task_id);
  f.tasks.db.prepare("UPDATE tasks SET state='BLOCKED',block_reason='dependency:missed-update' WHERE task_id=?").run(current.task_id);
  await f.controller.tick();
  assert.equal(f.tasks.getTask(current.task_id).state,'OPEN');
  // Operator/checker blocks remain authoritative; repair cannot erase them.
  f.tasks.db.prepare("UPDATE tasks SET state='BLOCKED',block_reason='operator-review' WHERE task_id=?").run(current.task_id);
  await f.controller.tick();
  assert.equal(f.tasks.getTask(current.task_id).block_reason,'operator-review');
});

test('flat discovery continues with no eligible work and reads public changes without a wake hint',async t=>{
  const f=await fixture(t);
  const execution=f.take();
  // Leave a free successor after an incomplete attempt, then block available work.
  f.tasks.dispatch('task_finish',{outcome:'incomplete'},makeEnvelope({actorRef:f.agent.agentId,taskId:execution.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version}));
  await f.controller.tick();
  const successor=f.controller.snapshot().agents.at(-1);
  const before=f.controller.snapshot().inputs.length;
  f.tasks.db.prepare("UPDATE tasks SET state='BLOCKED',block_reason='operator-review' WHERE task_id=?").run(f.task.task_id);
  assert.deepEqual(f.tasks.listEligibleTasks({missionId:f.missionId}),[]);
  transport.listeners.get(successor.agentId)({type:'settled',outcome:'completed'});
  await f.controller.flush();
  assert.equal(f.controller.snapshot().inputs.length,before+1);
  // Publish while discovery is already in flight; its next settled event must
  // continue on the same Agent without a separate public-change notification.
  await f.workspace.save({workspaceId:f.workspaceId,baseRevision:'0.1',requestId:'during-discovery',files:{'input.txt':'new shared evidence'}});
  transport.listeners.get(successor.agentId)({type:'settled',outcome:'completed'});
  await f.controller.flush();
  const inputs=f.controller.snapshot().inputs;
  assert.equal(inputs.length,before+2);
  assert.equal(inputs.at(-1).agentId,successor.agentId);
  assert.equal(inputs.at(-1).source,'discovery');
});

test('flat halt during the final asynchronous discovery lookup prevents late input and refill',async t=>{
  const f=await fixture(t);const before=transport.submissions.size;
  f.reads.beforeGet=()=>{f.reads.beforeGet=null;f.controller.halt();};
  f.settle();await f.controller.flush();
  assert.equal(transport.submissions.size,before);
  assert.equal(f.controller.snapshot().agents.length,1);
  assert.equal(f.controller.snapshot().inputs.at(-1).status,'not_submitted');
  await f.controller.tick();
  assert.equal(transport.submissions.size,before);
});

for (const source of ['discovery', 'continuation', 'user']) {
  test(`taskpool Mission stop during the final Core lookup fences ${source} input`, async t => {
    const f = await fixture(t);
    if (source !== 'discovery') f.take();
    const before = transport.submissions.size;
    f.reads.beforeGet = () => {
      f.reads.beforeGet = null;
      f.tasks.setMissionStopReader(id => id === f.missionId);
    };

    if (source === 'user') {
      await f.controller.feedback({ taskId: f.task.task_id, input: 'Do not dispatch after Mission stop', requestId: 'mission-stop-race' });
    } else {
      f.settle();
      await f.controller.flush();
    }

    assert.equal(transport.submissions.size, before);
    const completion = await f.controller.wait();
    assert.equal(completion.completion, 'mission-stopped');
    const input = completion.inputs.at(-1);
    assert.equal(input.source, source);
    assert.equal(input.status, 'not_submitted');
    assert.equal(input.reason, 'mission-stopped');
    await f.controller.tick();
    assert.equal(f.controller.snapshot().agents.length, 1);
  });
}

test('taskpool Mission stop during discovery prevents allocation of the next slot', async t => {
  const f = await fixture(t, {
    capacity: 2,
    beforeStart({ tasks, missionId }) {
      transport.next = id => {
        tasks.setMissionStopReader(value => value === missionId);
        transport.confirm(id, 'started');
      };
    },
  });
  assert.equal(transport.listeners.size, 1);
  assert.equal(transport.submissions.size, 1);
  const completion = await f.controller.wait();
  assert.equal(completion.completion, 'mission-stopped');
  assert.equal(completion.agents.length, 1);
});

test('Material publication and correction during discovery stay visible without an idle-loop wake scheduler',async t=>{
  const f=await fixture(t,{capacity:2});const execution=f.take();
  const reader=f.controller.snapshot().agents.find(row=>row.agentId!==f.agent.agentId);
  const envelope=id=>{
    const current=f.tasks.getExecution(execution.execution_id);
    return makeEnvelope({operationId:id,actorRef:f.agent.agentId,taskId:current.task_id,executionId:current.execution_id,specVersion:current.spec_version,stateVersion:current.state_version,fencingVersion:current.fencing_version});
  };
  const before=f.controller.snapshot().inputs.filter(row=>row.agentId===reader.agentId).length;
  const material=f.context.dispatch('context_publish_material',{content:'A shared claim'},envelope('during-reader-discovery')).material;
  f.context.dispatch('material_dispute',{material_id:material.material_id,claim:'A shared claim',reason:'The claim requires independent checking'},envelope('correct-during-discovery'));
  const read=f.context.dispatch('context_get_material',{material_id:material.material_id},makeEnvelope({actorRef:reader.agentId,operationId:'reader-sees-correction'}));
  assert.equal(read.material.material_id,material.material_id);
  assert.equal(f.context.listMaterialRelations({material_id:material.material_id}).length,1);
  transport.listeners.get(reader.agentId)({type:'settled',outcome:'completed'});
  await f.controller.flush();
  const inputs=f.controller.snapshot().inputs.filter(row=>row.agentId===reader.agentId);
  assert.equal(inputs.length,before+1);
  assert.equal(inputs.at(-1).source,'discovery');
  assert.equal(f.tasks.getExecution(execution.execution_id).state,'RUNNING');
});


test('four public Core Agents discover an empty Mission and stop without inventing Tasks or Executions',async t=>{
  const missionId='mission:empty-discovery';
  const f=await fixture(t,{missionId,capacity:4,beforeStart({tasks}) {
    tasks.createMission({mission_id:missionId,goal:'Investigate distinct open questions'},makeEnvelope({actorRef:'host'}));
  }});
  const started=f.controller.snapshot();
  assert.equal(started.agents.length,4);
  assert.equal(new Set(started.agents.map(row=>row.agentId)).size,4);
  assert.deepEqual(f.tasks.listMissionTasks({mission_id:missionId}),[]);
  assert.ok(started.agents.every(row=>f.tasks.getAgent(row.agentId).state==='UNBOUND'));
  assert.equal(started.inputs.filter(row=>row.source==='discovery'&&row.status==='accepted').length,4);
  transport.listeners.get(started.agents[0].agentId)({type:'settled',outcome:'completed'});
  await f.controller.flush();
  assert.equal(f.controller.snapshot().inputs.length,5);
  assert.equal(f.tasks.listActiveExecutions().length,0);
  await f.controller.close();
  const stopped=f.controller.snapshot();
  assert.equal(stopped.agents.length,4);
  assert.ok(stopped.agents.every(row=>row.released && row.lastStop.execution==='stopped'&&row.lastStop.cleanup==='complete'));
  assert.ok(stopped.agents.every(row=>f.tasks.getAgent(row.agentId).state==='CLOSED'));
  assert.deepEqual(f.tasks.listMissionTasks({mission_id:missionId}),[]);
});

test('optional host admission sees the complete four-slot team before any discovery input', async t => {
  let admitted = false;
  const f = await fixture(t, { capacity: 4, async beforeInitialDispatch({ runtime, agentIds, signal }) {
    assert.equal(agentIds.length, 4); assert.equal(new Set(agentIds).size, 4);
    assert.equal(transport.submissions.size, 0); assert.equal(signal.aborted, false);
    assert.ok((await Promise.all(agentIds.map(id => runtime.get(id)))).every(agent => agent.status === 'idle'));
    admitted = true;
  } });
  assert.equal(admitted, true); assert.equal(f.controller.snapshot().inputs.length, 4);
});

test('autonomous discovery sends original selection guidance with the live run and Agent deadlines', async t => {
  const runDeadline = Date.now() + 35000;
  let admitted = false;
  const f = await fixture(t, { autonomousTasks: true, selectionMs: 15000,
    discoveryContext: 'Original problem:\nexample : True := by trivial',
    activeDeadline: () => admitted ? runDeadline : runDeadline + 10000,
    beforeInitialDispatch() { admitted = true; } });
  const agent = f.tasks.getAgent(f.agent.agentId);
  const sent = [...transport.submissions.values()].at(-1).input;
  for (const value of [agent.agent_id, agent.selection_deadline, agent.hard_deadline, new Date(runDeadline).toISOString(), f.tasks.getMission(f.missionId).goal]) {
    assert.ok(sent.includes(value), 'Discovery input should include current public Mission and Agent timing');
  }
  assert.ok(sent.includes(`swarm task list --states '["ready","running"]'`));
  assert.match(sent, /If the pool is empty, propose a first concrete/);
  assert.match(sent, /multiple Tasks during discovery and during your Execution/);
  assert.match(sent, /example : True := by trivial/);
  assert.match(sent, /swarm task create --help/);
  assert.match(sent, /distinct, checkable contribution/);
  assert.match(sent, /remain in this Session/);
});

test('failed pre-discovery host admission sends no model input', async t => {
  await assert.rejects(fixture(t, { capacity: 4, beforeInitialDispatch() {
    throw Object.assign(new Error('Actual lifetime unavailable'), { code: 'HOUR_LIFETIME_UNCONFIRMED' });
  } }), { code: 'HOUR_LIFETIME_UNCONFIRMED' });
  assert.equal(transport.submissions.size, 0);
});


test('closing TaskPool cancels a held pre-discovery admission and never sends late inputs', async t => {
  const entered=Promise.withResolvers(),release=Promise.withResolvers(); let controller;
  const starting=fixture(t,{capacity:4,captureController:value=>{controller=value;},
    beforeInitialDispatch({signal}) {entered.resolve(signal);return release.promise;},
  }).then(value=>({value}),error=>({error}));
  const signal=await entered.promise;
  const closing=controller.close({timeoutMs:1000});
  const result=await starting; assert.equal(result.error.code,'NOT_ALLOWED'); assert.equal(signal.aborted,true);
  release.resolve(); await closing;
  assert.equal(transport.submissions.size,0);
});

test('host-controlled TaskPool keeps the same running Execution after settle and accepts explicit followUp', async t => {
  const f=await fixture(t,{automaticContinuation:false}); const execution=f.take();
  f.settle();await f.controller.flush();
  assert.equal(f.controller.snapshot().inputs.length,1);
  assert.equal(f.tasks.getExecution(execution.execution_id).state,'RUNNING');
  const sent=await f.controller.feedback({taskId:f.task.task_id,input:'Next frozen programming group',requestId:'host-group-1',mode:'followUp'});
  assert.equal(sent.status,'accepted');assert.equal(sent.agentId,f.agent.agentId);
  assert.equal(f.tasks.getAgent(f.agent.agentId).execution_id,execution.execution_id);
});

test('optional ready-task refill does not create idle discovery Agents for work already owned', async t => {
  const f=await fixture(t,{capacity:4,refillWhenNoReadyTask:false,beforeStart(stores){
    stores.tasks.takeTask(stores.task.task_id,{owner_ref:'existing-owner',take_key:'existing-owned'});
  }});
  assert.equal(f.controller.snapshot().agents.length,0);
  assert.equal(transport.submissions.size,0);
});

test('Mission completion policy keeps discovery open after every existing Task is cancelled', async t => {
  const f = await fixture(t, { completionPolicy: 'mission', beforeStart(stores) {
    for (const task of stores.tasks.listTasks({ missionId: stores.missionId, scanAll: true, availableOnly: false, states: ['OPEN','BLOCKED'], limit: 100 })) {
      stores.tasks.registerAgent({ agentId: 'cancel-observer', missionId: stores.missionId, legacySlotId: 'cancel-slot', selectionDeadline: new Date(Date.now()+60000).toISOString() });
      stores.tasks.markCoreAgentReady('cancel-observer');
      stores.tasks.dispatch('task_cancel', { task_id: task.task_id, expected_spec_version: task.spec_version, expected_state_version: task.state_version, reason: 'Retire existing work' }, makeEnvelope({ actorRef: 'cancel-observer' }));
      stores.tasks.requestAgentStop('cancel-observer', 'Observer done');
      stores.tasks.finalizeAgentClose('cancel-observer');
    }
  } });
  assert.equal(f.controller.snapshot().completion, null);
  assert.equal(f.controller.snapshot().agents.length, 1);
  assert.equal(f.controller.snapshot().inputs[0].source, 'discovery');
});

test('ordinary material notification reaches the active owner once without interrupting its Session', async t => {
  const f = await fixture(t); const execution = f.take();
  const notification = f.tasks.enqueueNotification({ deliveryKey: 'available-lemma', missionId: f.missionId,
    recipientTaskId: f.task.task_id, type: 'material_available', materialId: f.material.material_id,
    payload: { material_id: f.material.material_id } });
  await f.controller.tick(); await f.controller.tick();
  const sent = f.controller.snapshot().inputs.filter(row => row.source === 'notification');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].mode, 'followUp');
  assert.equal(sent[0].executionId, execution.execution_id);
  assert.equal(sent[0].status, 'accepted');
  assert.equal([...transport.submissions.values()].filter(row => row.input.includes(notification.notification_id)).length, 1);
  assert.ok(f.tasks.listUnprocessedNotifications(f.task.task_id, execution.execution_id)[0].recipient_delivery.delivered_at);
  assert.equal(f.tasks.getAgent(f.agent.agentId).execution_id, execution.execution_id);
});

test('configured material notifications steer while dependency notices and continuations remain followUp', async t => {
  const f = await fixture(t, { materialNotificationMode: 'steer' }); const execution = f.take();
  const material = f.tasks.enqueueNotification({ deliveryKey: 'steered-material', missionId: f.missionId,
    recipientTaskId: f.task.task_id, type: 'material_available', materialId: f.material.material_id,
    payload: { material_id: f.material.material_id } });
  const dependency = f.tasks.enqueueNotification({ deliveryKey: 'queued-dependency', missionId: f.missionId,
    recipientTaskId: f.task.task_id, type: 'task_reopened', payload: { task_id: f.task.task_id } });
  await f.controller.tick(); await f.controller.tick();
  f.settle(); await f.controller.flush();
  const sent = f.controller.snapshot().inputs;
  const notices = sent.filter(row => row.source === 'notification');
  assert.equal(notices.length, 2);
  assert.deepEqual(new Map(notices.map(row => [row.requestId, [row.mode, row.executionId, row.status]])), new Map([
    [`taskpool:notification:${execution.execution_id}:${material.notification_id}`, ['steer', execution.execution_id, 'accepted']],
    [`taskpool:notification:${execution.execution_id}:${dependency.notification_id}`, ['followUp', execution.execution_id, 'accepted']],
  ]));
  assert.equal(sent.at(-1).source, 'continuation');
  assert.equal(sent.at(-1).mode, 'followUp');
});

test('ordinary notification unknown receipt keeps its input identity and never repeats delivery', async t => {
  const f = await fixture(t); const execution = f.take();
  const notification = f.tasks.enqueueNotification({ deliveryKey: 'unknown-material', missionId: f.missionId, recipientTaskId: f.task.task_id,
    type: 'material_available', materialId: f.material.material_id, payload: { material_id: f.material.material_id } });
  transport.next = undefined;
  await f.controller.tick();
  const first = f.controller.snapshot().inputs.find(row => row.source === 'notification');
  assert.equal(first.status, 'unknown');
  const count = transport.submissions.size;
  await f.controller.tick(); f.settle(); await f.controller.flush();
  assert.equal(transport.submissions.size, count);
  assert.equal(f.controller.snapshot().inputs.filter(row => row.source === 'notification').length, 1);
  assert.equal(f.tasks.listUnprocessedNotifications(f.task.task_id, execution.execution_id)[0].recipient_delivery, null);
  assert.ok([...transport.submissions.values()].some(row => row.input.includes(notification.notification_id)));
});

test('ordinary notification retries its delivery receipt without another model input', async t => {
  const f = await fixture(t); const execution = f.take();
  f.tasks.enqueueNotification({ deliveryKey: 'receipt-material', missionId: f.missionId, recipientTaskId: f.task.task_id,
    type: 'material_available', payload: { material_id: f.material.material_id } });
  const mark = f.tasks.markNotificationDelivered.bind(f.tasks); let failed = false;
  f.tasks.markNotificationDelivered = (...args) => { if (!failed) { failed = true; throw new Error('Receipt unavailable'); } return mark(...args); };
  await f.controller.tick(); await f.controller.tick();
  assert.equal(f.controller.snapshot().inputs.filter(row => row.source === 'notification').length, 1);
  assert.ok(f.tasks.listUnprocessedNotifications(f.task.task_id, execution.execution_id)[0].recipient_delivery.delivered_at);
});

test('ordinary notification rejects ownership withdrawn during final Core lookup', async t => {
  const f = await fixture(t); const execution = f.take();
  f.tasks.enqueueNotification({ deliveryKey: 'late-material', missionId: f.missionId, recipientTaskId: f.task.task_id,
    type: 'material_available', payload: { material_id: f.material.material_id } });
  f.reads.beforeGet = () => { f.reads.beforeGet = null;
    const current = f.tasks.getExecution(execution.execution_id);
    f.tasks.dispatch('task_finish', { outcome: 'incomplete' }, makeEnvelope({ actorRef: f.agent.agentId, taskId: current.task_id, executionId: current.execution_id, specVersion: current.spec_version, stateVersion: current.state_version, fencingVersion: current.fencing_version }));
  };
  await f.controller.tick();
  const input = f.controller.snapshot().inputs.find(row => row.source === 'notification');
  assert.equal(input.status, 'not_submitted');
  assert.equal(input.reason, 'task-binding-changed');
  assert.equal(f.tasks.listUnprocessedNotifications(f.task.task_id, execution.execution_id)[0].recipient_delivery, null);
});
