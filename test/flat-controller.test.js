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
  const controller=createFlatController({runtime,taskService:stores.tasks,missionId:stores.missionId,capacity:1,deadlineAt:Date.now()+60000,heartbeatMs:10000,stallMs:30000,...options});
  t.after(async()=>{controls.stopError=null;controls.destroyError=null;await controller.close();await runtime.close();stores.close();await rm(root,{recursive:true,force:true});});
  await controller.start();
  const bot=controller.snapshot().bots[0];
  function take() {
    let execution=stores.tasks.takeTask(stores.task.task_id,{owner_ref:bot.botId,core_id:bot.legacySlotId,take_key:'fixed'}).execution;
    execution=stores.tasks.dispatch('start_execution',{core_id:bot.legacySlotId},makeEnvelope({actorRef:bot.botId,taskId:execution.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version})).execution;
    return execution;
  }
  return {...stores,root,runtime,controller,bot,take,settle(outcome='completed'){transport.listeners.get(bot.botId)({type:'settled',outcome});}};
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

test('feedback selected before a close race is recorded without dispatch or retargeting',async t=>{
  const f=await fixture(t);const execution=f.take();
  const pending=f.controller.feedback({taskId:f.task.task_id,input:'Must not arrive after finish',requestId:'racing'});
  f.tasks.dispatch('task_finish',{outcome:'done'},makeEnvelope({actorRef:f.bot.botId,taskId:execution.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version}));
  const result=await pending;
  assert.equal(result.status,'not_submitted');
  assert.equal([...transport.submissions.values()].some(row=>row.input==='Must not arrive after finish'),false);
});
