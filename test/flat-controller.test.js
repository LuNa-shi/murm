import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
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
  const runtime=await createRuntime({backend:{},profiles:{researcher:{prompt:'Fixed',model:'default',image:'fixture',writable:false,services:{}}},services:new ServiceRegistry(),maxBots:2,outputDir:root});
  const accepted=id=>{transport.confirm(id,'started');transport.next=accepted;}; transport.next=accepted;
  const reads={beforeGet:null};
  const controller=createFlatController({runtime:{...runtime,async get(id){await reads.beforeGet?.();return runtime.get(id);}},taskService:stores.tasks,missionId:stores.missionId,capacity:1,deadlineAt:Date.now()+60000,heartbeatMs:10000,stallMs:30000,...options});
  t.after(async()=>{controls.stopError=null;controls.destroyError=null;await controller.close();await runtime.close();stores.close();await rm(root,{recursive:true,force:true});});
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
