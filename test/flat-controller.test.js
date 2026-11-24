import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { request } from 'node:http';
import { createFlatPublicationServices } from '../src/environments/flat/publication-services.js';
import { ServiceRegistry } from '../src/core/services.js';
import { transport, controls } from './fixtures/flat-controller-backend.js';
import { createFlatTaskStores } from './fixtures/flat-task-stores.js';
import { createFlatController } from '../src/environments/flat/controller.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
const hooks=registerHooks({resolve(specifier,context,next){
  if(specifier==='./pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return {url:new URL('./fixtures/flat-controller-backend.js',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}});
const {createRuntime}=await import('../src/core/index.js'); hooks.deregister();
async function fixture(t,options={}) {
  const root=await mkdtemp(join(tmpdir(),'flat-controller-'));
  const stores=await createFlatTaskStores(root); transport.reset();controls.stopError=null;controls.destroyError=null;
  let runtime, controller;
  const services = new ServiceRegistry();
  let publication;
  if (options.onFinish) {
    publication = createFlatPublicationServices({ runtime: () => runtime, taskService: stores.tasks,
      contextService: stores.context, missionWorkspace: stores.workspace, missionId: stores.missionId,
      workspaceId: stores.workspaceId, deadline: () => Date.now() + 60000,
      onFinish(receipt) { options.onFinish(receipt); controller.notify(); } });
    for (const registration of publication.registrations) services.registerService(registration);
  }
  runtime=await createRuntime({backend:{},profiles:{researcher:{prompt:'Fixed',model:'default',image:'fixture',writable:false,services:publication?{task:['task_finish']}:{}}},services,maxBots:options.capacity??2,outputDir:root});
  const accepted=id=>{transport.confirm(id,'started');transport.next=accepted;}; transport.next=accepted;
  const reads={beforeGet:null};
  controller=createFlatController({runtime:{...runtime,async get(id){await reads.beforeGet?.();return runtime.get(id);}},taskService:stores.tasks,missionId:stores.missionId,capacity:1,deadlineAt:Date.now()+60000,heartbeatMs:10000,stallMs:30000,...options});
  t.after(async()=>{controls.stopError=null;controls.destroyError=null;publication?.close();await controller.close();await runtime.close();stores.close();await rm(root,{recursive:true,force:true});});
  options.captureController?.(controller);
  await options.beforeStart?.(stores);
  await controller.start();
  const bot=controller.snapshot().bots[0];
  function take() {
    let execution=stores.tasks.takeTask(stores.task.task_id,{owner_ref:bot.botId,core_id:bot.legacySlotId,take_key:'fixed'}).execution;
    execution=stores.tasks.dispatch('start_execution',{core_id:bot.legacySlotId},makeEnvelope({actorRef:bot.botId,taskId:execution.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version})).execution;
    return execution;
  }
  return {...stores,root,runtime,controller,bot,take,reads,settle(outcome='completed'){transport.listeners.get(bot.botId)({type:'settled',outcome});}};
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

test('directed feedback shares controller ordering, explicit mode and original input identity',async t=>{
  const f=await fixture(t);const execution=f.take();
  const first=await f.controller.feedback({taskId:f.task.task_id,input:'Check this fixed case',requestId:'feedback-one',mode:'steer'});
  assert.equal(first.status,'accepted');assert.equal(first.botId,f.bot.botId);assert.equal(first.executionId,execution.execution_id);assert.equal(first.mode,'steer');
  assert.deepEqual(await f.controller.feedback({taskId:f.task.task_id,input:'Check this fixed case',requestId:'feedback-one',mode:'steer'}),first);
  assert.throws(()=>f.controller.feedback({taskId:f.task.task_id,input:'Different',requestId:'feedback-one',mode:'steer'}),{code:'CONFLICT'});
  assert.equal([...transport.submissions.values()].filter(row=>row.input==='Check this fixed case').length,1);
  f.tasks.dispatch('task_finish',{outcome:'done'},makeEnvelope({actorRef:f.bot.botId,taskId:execution.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version}));
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

test('accepted finish is finalized after public stop and replacement starts a fresh readonly Bot',async t=>{
  const f=await fixture(t);const execution=f.take();
  const second=f.tasks.createTask({mission_id:f.missionId,gap:'One more fixed result',priority:'medium',summary:'Second fixed Task',expected_output:'Result',acceptance_conditions:['Result']},makeEnvelope({actorRef:'host'})).task;
  f.tasks.dispatch('task_finish',{outcome:'done'},makeEnvelope({actorRef:f.bot.botId,taskId:execution.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version}));
  await f.controller.tick();
  assert.equal(f.tasks.getTask(f.task.task_id).state,'DONE');
  assert.equal(f.tasks.getExecution(execution.execution_id).state,'SUCCEEDED');
  assert.equal(f.tasks.getBot(f.bot.botId).state,'CLOSED');
  const rows=f.controller.snapshot().bots;
  assert.equal(rows.length,2);assert.notEqual(rows[0].botId,rows[1].botId);assert.equal(rows[0].released,true);assert.equal(rows[1].slot,rows[0].slot);
  assert.equal(f.tasks.getBot(rows[1].botId).state,'UNBOUND');
  assert.equal(f.tasks.getTask(second.task_id).state,'OPEN');
});


test('accepted Bridge finish survives a disconnected caller and closes through the Flat controller', { timeout: 8000 }, async t => {
  let client, finishReceipt;
  const f = await fixture(t, { onFinish(receipt) {
    finishReceipt = receipt;
    assert.equal(f.tasks.getExecution(execution.execution_id).state, 'CLOSING');
    assert.equal(f.tasks.getTask(f.task.task_id).state, 'RUNNING');
    assert.equal(f.controller.snapshot().bots[0].released, false);
    // The real HTTP caller disappears after durable admission, before reply.
    client.destroy();
  } });
  const execution = f.take();
  let closed = 0;
  const unsubscribe = f.tasks.subscribeTaskEvents(event => {
    if (event.kind === 'task_finish_closed' && event.execution_id === execution.execution_id) closed++;
  });
  t.after(unsubscribe);
  const credentials = controls.credentials.get(f.bot.botId);
  const url = new URL(credentials.environment.SWARMENV_BRIDGE_URL);
  url.hostname = '127.0.0.1';
  const disconnected = new Promise((resolve, reject) => {
    client = request(new URL('/call', url), { method: 'POST', headers: {
      authorization: `Bearer ${credentials.secretEnvironment.SWARMENV_BRIDGE_TOKEN}`,
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
  assert.equal(f.tasks.getBot(f.bot.botId).state, 'CLOSED');
  assert.equal((await f.runtime.get(f.bot.botId)).status, 'closed');
  assert.equal(f.controller.snapshot().bots[0].released, true);
  assert.equal(closed, 1);
  await f.controller.flush();
  assert.equal(closed, 1);
});

test('execution unknown retains its Task owner and occupied Slot until stop reconciliation',async t=>{
  const f=await fixture(t);const execution=f.take();
  controls.stopError=Object.assign(new Error('Fixed stop uncertainty'),{code:'OPERATION_UNKNOWN'});
  f.settle('failed');await f.controller.flush();
  assert.equal(f.tasks.getExecution(execution.execution_id).state,'RUNNING');
  assert.equal(f.tasks.getBot(f.bot.botId).state,'CLOSING');
  assert.equal(f.controller.snapshot().bots.length,1);
  assert.equal(f.controller.snapshot().bots[0].lastStop.execution,'unknown');
  controls.stopError=null;await f.controller.tick();
  assert.equal(f.tasks.getExecution(execution.execution_id).state,'FAILED');
  assert.equal(f.controller.snapshot().bots.length,2);
});

test('confirmed execution stop and pending cleanup release Task outcome but retain the occupied Slot',async t=>{
  const f=await fixture(t);const execution=f.take();
  controls.destroyError=new Error('Fixed physical deletion failure');
  f.settle('aborted');await f.controller.flush();
  assert.equal(f.tasks.getExecution(execution.execution_id).state,'FAILED');
  const snapshot=f.controller.snapshot();assert.equal(snapshot.bots.length,1);
  assert.equal(snapshot.bots[0].lastStop.execution,'stopped');assert.equal(snapshot.bots[0].lastStop.cleanup,'pending');assert.equal(snapshot.bots[0].released,false);
  assert.notEqual(f.tasks.getTask(f.task.task_id).state,'DONE');
  controls.destroyError=null;await f.controller.tick();
  assert.equal(f.controller.snapshot().bots.length,2);
});

test('incomplete finish retains its owner through unknown stop and retries cleanup before Slot reuse', async t => {
  const f = await fixture(t);
  const execution = f.take();
  const envelope = makeEnvelope({
    operationId: 'incomplete-finish-cleanup', actorRef: f.bot.botId,
    taskId: execution.task_id, executionId: execution.execution_id,
    specVersion: execution.spec_version, stateVersion: execution.state_version,
    fencingVersion: execution.fencing_version,
  });
  f.tasks.dispatch('task_finish', { outcome: 'incomplete', reason: 'Continue in a fresh Bot' }, envelope);

  controls.stopError = Object.assign(new Error('Worker stop is unconfirmed'), { code: 'OPERATION_UNKNOWN' });
  await f.controller.tick();
  assert.equal(f.tasks.getExecution(execution.execution_id).state, 'CLOSING');
  assert.equal(f.tasks.getTask(f.task.task_id).state, 'RUNNING');
  assert.equal(f.tasks.listEligibleTasks().length, 0);
  assert.equal(f.controller.snapshot().bots.length, 1);
  assert.equal(f.controller.snapshot().bots[0].lastStop.execution, 'unknown');
  assert.equal(f.controller.snapshot().bots[0].released, false);

  controls.stopError = null;
  controls.destroyError = new Error('Sandbox deletion is unconfirmed');
  await f.controller.tick();
  assert.equal(f.tasks.getExecution(execution.execution_id).state, 'HANDED_OFF');
  assert.equal(f.tasks.getTask(f.task.task_id).state, 'OPEN');
  assert.equal(f.tasks.getBot(f.bot.botId).state, 'CLOSING');
  assert.equal(f.controller.snapshot().bots.length, 1);
  assert.equal(f.controller.snapshot().bots[0].lastStop.execution, 'stopped');
  assert.equal(f.controller.snapshot().bots[0].lastStop.cleanup, 'pending');
  assert.equal(f.controller.snapshot().bots[0].released, false);

  controls.destroyError = null;
  await f.controller.tick();
  const rows = f.controller.snapshot().bots;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].released, true);
  assert.equal(f.tasks.getBot(f.bot.botId).state, 'CLOSED');
  assert.equal(rows[1].slot, rows[0].slot);
  assert.notEqual(rows[1].botId, f.bot.botId);
  const successor = f.tasks.takeTask(f.task.task_id, {
    owner_ref: rows[1].botId, core_id: rows[1].legacySlotId, take_key: 'successor-after-cleanup',
  }).execution;
  await f.controller.tick();
  assert.equal(f.tasks.getTask(f.task.task_id).state, 'RUNNING');
  assert.equal(f.tasks.getActiveExecutionForCore(rows[1].legacySlotId).execution_id, successor.execution_id);
  assert.equal(f.tasks.getExecution(execution.execution_id).state, 'HANDED_OFF');
  assert.equal(f.controller.snapshot().bots.length, 2);
});

test('host close records intent for a still-unbound discovery Bot before finalizing its domain Slot',async t=>{
  const f=await fixture(t);
  assert.equal(f.tasks.getBot(f.bot.botId).state,'UNBOUND');
  f.controller.halt();
  const receipt=await f.runtime.close();
  assert.equal(receipt.cleanup,'complete');
  await f.controller.reconcileClose(receipt);
  assert.equal(f.tasks.getBot(f.bot.botId).state,'CLOSED');
  const row=f.controller.snapshot().bots[0];
  assert.equal(row.lastStop.execution,'stopped');assert.equal(row.lastStop.cleanup,'complete');assert.equal(row.released,true);
});

test('host close with unknown execution retains its active Task owner until a stopped receipt is reconciled',async t=>{
  const f=await fixture(t);const execution=f.take();
  f.controller.halt();controls.stopError=Object.assign(new Error('Fixed host close uncertainty'),{code:'OPERATION_UNKNOWN'});
  const unknown=await f.runtime.close({timeoutMs:100});
  await f.controller.reconcileClose(unknown);
  assert.equal(f.tasks.getBot(f.bot.botId).state,'CLOSING');assert.equal(f.tasks.getTask(f.task.task_id).state,'RUNNING');
  assert.equal(f.tasks.getExecution(execution.execution_id).owner_ref,f.bot.botId);assert.equal(f.tasks.getExecution(execution.execution_id).state,'RUNNING');
  assert.equal(f.controller.snapshot().bots[0].released,false);
  controls.stopError=null;
  await f.controller.reconcileClose(await f.runtime.close());
  assert.equal(f.tasks.getBot(f.bot.botId).state,'CLOSED');assert.equal(f.tasks.getExecution(execution.execution_id).state,'FAILED');
  assert.equal(f.controller.snapshot().bots[0].released,true);
});

test('feedback selected before a close race is recorded without dispatch or retargeting',async t=>{
  const f=await fixture(t);const execution=f.take();
  const pending=f.controller.feedback({taskId:f.task.task_id,input:'Must not arrive after finish',requestId:'racing'});
  f.tasks.dispatch('task_finish',{outcome:'done'},makeEnvelope({actorRef:f.bot.botId,taskId:execution.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version}));
  const result=await pending;
  assert.equal(result.status,'not_submitted');
  assert.equal([...transport.submissions.values()].some(row=>row.input==='Must not arrive after finish'),false);
});

test('settled discovery after selection deadline stops the old Bot before any further discovery',async t=>{
  const f=await fixture(t,{selectionMs:30});
  await new Promise(resolve=>setTimeout(resolve,45));
  f.settle();await f.controller.flush();
  const snapshot=f.controller.snapshot();
  assert.equal(snapshot.bots[0].stopReason,'domain-deadline');
  assert.equal(snapshot.bots[0].released,true);
  assert.equal(snapshot.inputs.filter(row=>row.botId===f.bot.botId).length,1);
  assert.equal(snapshot.bots.length,2);
});

test('unknown input prevents resend but does not suppress the original Bot hard deadline',async t=>{
  const f=await fixture(t,{hardBudgetMs:60});const execution=f.take();transport.next=undefined;
  const result=await f.controller.feedback({taskId:f.task.task_id,input:'Uncertain bounded feedback',requestId:'bounded-unknown'});
  assert.equal(result.status,'unknown');
  await new Promise(resolve=>setTimeout(resolve,75));
  await f.controller.tick();
  const snapshot=f.controller.snapshot();
  assert.equal(snapshot.bots[0].stopReason,'domain-deadline');
  assert.equal(f.tasks.getExecution(execution.execution_id).state,'FAILED');
  assert.equal(snapshot.bots[0].released,true);
  assert.equal(snapshot.inputs.filter(row=>row.requestId==='bounded-unknown').length,1);
});

for(const budget of ['discovery','continuation']) test(`${budget} limit stops the old Bot and replacement uses a new identity`,async t=>{
  const f=await fixture(t,{discoveryLimit:1,continuationLimit:1});
  const execution=budget==='continuation'?f.take():null;
  f.settle();await f.controller.flush();
  if(execution) {f.settle();await f.controller.flush();}
  const snapshot=f.controller.snapshot();
  assert.equal(snapshot.bots[0].stopReason,`${budget}-budget`);
  assert.equal(snapshot.bots[0].released,true);
  assert.notEqual(snapshot.bots[1].botId,f.bot.botId);
  assert.equal(snapshot.inputs.filter(row=>row.botId===f.bot.botId).length,execution?2:1);
  if(execution) assert.equal(f.tasks.getExecution(execution.execution_id).state,'FAILED');
});

test('stall stops an unfinished Execution and records actual domain and budget evidence',async t=>{
  const f=await fixture(t,{stallMs:30});const execution=f.take();
  await new Promise(resolve=>setTimeout(resolve,45));await f.controller.tick();
  const snapshot=f.controller.snapshot();
  assert.equal(snapshot.bots[0].stopReason,'stall-budget');
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
  transport.listeners.get(f.bot.botId)({type:'error',fatal:true,error:{code:'WORKER_FAILED'}});
  await f.controller.flush();
  const snapshot=f.controller.snapshot();
  assert.equal(original.status,'unknown');assert.equal(snapshot.bots[0].stopReason,'worker-failed');
  assert.equal(f.tasks.getExecution(execution.execution_id).state,'FAILED');
  assert.equal(snapshot.inputs.filter(row=>row.requestId==='fatal-unknown').length,1);
});

test('feedback rechecks domain ownership after the final asynchronous public Core lookup',async t=>{
  const f=await fixture(t);const execution=f.take();
  f.reads.beforeGet=()=>{
    f.reads.beforeGet=null;
    f.tasks.dispatch('task_finish',{outcome:'done'},makeEnvelope({actorRef:f.bot.botId,taskId:execution.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version}));
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
  f.tasks.dispatch('task_finish',{outcome:'done'},makeEnvelope({actorRef:f.bot.botId,taskId:execution.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version}));
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
  f.tasks.dispatch('task_finish',{outcome:'incomplete'},makeEnvelope({actorRef:f.bot.botId,taskId:execution.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version}));
  await f.controller.tick();
  const successor=f.controller.snapshot().bots.at(-1);
  const before=f.controller.snapshot().inputs.length;
  f.tasks.db.prepare("UPDATE tasks SET state='BLOCKED',block_reason='operator-review' WHERE task_id=?").run(f.task.task_id);
  assert.deepEqual(f.tasks.listEligibleTasks({missionId:f.missionId}),[]);
  transport.listeners.get(successor.botId)({type:'settled',outcome:'completed'});
  await f.controller.flush();
  assert.equal(f.controller.snapshot().inputs.length,before+1);
  // Publish while discovery is already in flight; its next settled event must
  // continue on the same Bot without a separate public-change notification.
  await f.workspace.save({workspaceId:f.workspaceId,baseRevision:'0.1',requestId:'during-discovery',files:{'input.txt':'new shared evidence'}});
  transport.listeners.get(successor.botId)({type:'settled',outcome:'completed'});
  await f.controller.flush();
  const inputs=f.controller.snapshot().inputs;
  assert.equal(inputs.length,before+2);
  assert.equal(inputs.at(-1).botId,successor.botId);
  assert.equal(inputs.at(-1).source,'discovery');
});

test('flat halt during the final asynchronous discovery lookup prevents late input and refill',async t=>{
  const f=await fixture(t);const before=transport.submissions.size;
  f.reads.beforeGet=()=>{f.reads.beforeGet=null;f.controller.halt();};
  f.settle();await f.controller.flush();
  assert.equal(transport.submissions.size,before);
  assert.equal(f.controller.snapshot().bots.length,1);
  assert.equal(f.controller.snapshot().inputs.at(-1).status,'not_submitted');
  await f.controller.tick();
  assert.equal(transport.submissions.size,before);
});

for (const source of ['discovery', 'continuation', 'user']) {
  test(`flat Mission stop during the final Core lookup fences ${source} input`, async t => {
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
    assert.equal(f.controller.snapshot().bots.length, 1);
  });
}

test('flat Mission stop during discovery prevents allocation of the next slot', async t => {
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
  assert.equal(completion.bots.length, 1);
});

test('Material publication and correction during discovery stay visible without an idle-loop wake scheduler',async t=>{
  const f=await fixture(t,{capacity:2});const execution=f.take();
  const reader=f.controller.snapshot().bots.find(row=>row.botId!==f.bot.botId);
  const envelope=id=>{
    const current=f.tasks.getExecution(execution.execution_id);
    return makeEnvelope({operationId:id,actorRef:f.bot.botId,taskId:current.task_id,executionId:current.execution_id,specVersion:current.spec_version,stateVersion:current.state_version,fencingVersion:current.fencing_version});
  };
  const before=f.controller.snapshot().inputs.filter(row=>row.botId===reader.botId).length;
  const material=f.context.dispatch('context_publish_material',{content:'A shared claim'},envelope('during-reader-discovery')).material;
  f.context.dispatch('material_dispute',{material_id:material.material_id,claim:'A shared claim',reason:'The claim requires independent checking'},envelope('correct-during-discovery'));
  const read=f.context.dispatch('context_get_material',{material_id:material.material_id},makeEnvelope({actorRef:reader.botId,operationId:'reader-sees-correction'}));
  assert.equal(read.material.material_id,material.material_id);
  assert.equal(f.context.listMaterialRelations({material_id:material.material_id}).length,1);
  transport.listeners.get(reader.botId)({type:'settled',outcome:'completed'});
  await f.controller.flush();
  const inputs=f.controller.snapshot().inputs.filter(row=>row.botId===reader.botId);
  assert.equal(inputs.length,before+1);
  assert.equal(inputs.at(-1).source,'discovery');
  assert.equal(f.tasks.getExecution(execution.execution_id).state,'RUNNING');
});


test('four public Core Bots discover an empty Mission and stop without inventing Tasks or Executions',async t=>{
  const missionId='mission:empty-discovery';
  const f=await fixture(t,{missionId,capacity:4,beforeStart({tasks}) {
    tasks.createMission({mission_id:missionId,goal:'Investigate distinct open questions'},makeEnvelope({actorRef:'host'}));
  }});
  const started=f.controller.snapshot();
  assert.equal(started.bots.length,4);
  assert.equal(new Set(started.bots.map(row=>row.botId)).size,4);
  assert.deepEqual(f.tasks.listMissionTasks({mission_id:missionId}),[]);
  assert.ok(started.bots.every(row=>f.tasks.getBot(row.botId).state==='UNBOUND'));
  assert.equal(started.inputs.filter(row=>row.source==='discovery'&&row.status==='accepted').length,4);
  transport.listeners.get(started.bots[0].botId)({type:'settled',outcome:'completed'});
  await f.controller.flush();
  assert.equal(f.controller.snapshot().inputs.length,5);
  assert.equal(f.tasks.listActiveExecutions().length,0);
  await f.controller.close();
  const stopped=f.controller.snapshot();
  assert.equal(stopped.bots.length,4);
  assert.ok(stopped.bots.every(row=>row.released && row.lastStop.execution==='stopped'&&row.lastStop.cleanup==='complete'));
  assert.ok(stopped.bots.every(row=>f.tasks.getBot(row.botId).state==='CLOSED'));
  assert.deepEqual(f.tasks.listMissionTasks({mission_id:missionId}),[]);
});

test('optional host admission sees the complete four-slot team before any discovery input', async t => {
  let admitted = false;
  const f = await fixture(t, { capacity: 4, async beforeInitialDispatch({ runtime, botIds, signal }) {
    assert.equal(botIds.length, 4); assert.equal(new Set(botIds).size, 4);
    assert.equal(transport.submissions.size, 0); assert.equal(signal.aborted, false);
    assert.ok((await Promise.all(botIds.map(id => runtime.get(id)))).every(bot => bot.status === 'idle'));
    admitted = true;
  } });
  assert.equal(admitted, true); assert.equal(f.controller.snapshot().inputs.length, 4);
});

test('failed pre-discovery host admission sends no model input', async t => {
  await assert.rejects(fixture(t, { capacity: 4, beforeInitialDispatch() {
    throw Object.assign(new Error('Actual lifetime unavailable'), { code: 'HOUR_LIFETIME_UNCONFIRMED' });
  } }), { code: 'HOUR_LIFETIME_UNCONFIRMED' });
  assert.equal(transport.submissions.size, 0);
});


test('closing Flat cancels a held pre-discovery admission and never sends late inputs', async t => {
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

test('host-controlled Flat keeps the same running Execution after settle and accepts explicit followUp', async t => {
  const f=await fixture(t,{automaticContinuation:false}); const execution=f.take();
  f.settle();await f.controller.flush();
  assert.equal(f.controller.snapshot().inputs.length,1);
  assert.equal(f.tasks.getExecution(execution.execution_id).state,'RUNNING');
  const sent=await f.controller.feedback({taskId:f.task.task_id,input:'Next frozen programming group',requestId:'host-group-1',mode:'followUp'});
  assert.equal(sent.status,'accepted');assert.equal(sent.botId,f.bot.botId);
  assert.equal(f.tasks.getBot(f.bot.botId).execution_id,execution.execution_id);
});

test('optional ready-task refill does not create idle discovery Bots for work already owned', async t => {
  const f=await fixture(t,{capacity:4,refillWhenNoReadyTask:false,beforeStart(stores){
    stores.tasks.takeTask(stores.task.task_id,{owner_ref:'existing-owner',take_key:'existing-owned'});
  }});
  assert.equal(f.controller.snapshot().bots.length,0);
  assert.equal(transport.submissions.size,0);
});
