import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createFlatTaskStores } from './fixtures/flat-task-stores.js';
import { controls } from './fixtures/flat-controller-backend.js';
import { createFlatTaskService } from '../src/environments/flat/task-service.js';
import { createFlatPublicationServices } from '../src/environments/flat/publication-services.js';
import { ServiceRegistry } from '../src/core/services.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
const hooks=registerHooks({resolve(specifier,context,next) {
  if(specifier==='./pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return {url:new URL('./fixtures/flat-controller-backend.js',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}});
const {createRuntime}=await import('@swarmenv/core');hooks.deregister();
const execute=promisify(execFile);
async function fixture(t, { feedbackAllowed = true } = {}) {
  const root=await mkdtemp(join(tmpdir(),'flat-feedback-'));
  const stores=await createFlatTaskStores(root);
  stores.tasks.contextService=stores.context;
  let runtime;
  const policy={deadlineAt:Date.now()+60000,beforeGet:null};
  const discovery=createFlatTaskService({runtime:()=>runtime,taskService:stores.tasks,contextService:stores.context,missionWorkspace:stores.workspace,workspaceManager:stores.manager,missionId:stores.missionId,workspaceId:stores.workspaceId,missionDeadline:()=>Date.now()+60000});
  const publication=createFlatPublicationServices({runtime:()=>({...runtime,async get(id){const result=await runtime.get(id);await policy.beforeGet?.();return result;}}),taskService:stores.tasks,contextService:stores.context,missionWorkspace:stores.workspace,missionId:stores.missionId,workspaceId:stores.workspaceId,deadline:()=>policy.deadlineAt});
  const services=new ServiceRegistry();services.registerService(publication.composeTask(discovery));
  for(const row of publication.registrations.filter(row=>row.manifest.id!=='task')) services.registerService(row);
  const allowed=Object.fromEntries(publication.registrations.map(row=>[row.manifest.id,row.manifest.capabilities.map(cap=>cap.operation)]));
  allowed.task.push(...discovery.manifest.capabilities.map(cap=>cap.operation));
  if(!feedbackAllowed) allowed.task=allowed.task.filter(operation=>operation!=='task_feedback');
  runtime=await createRuntime({backend:{},profiles:{researcher:{prompt:'Handle notifications using the actual Task binding',model:'default',image:'fixture',writable:false,services:allowed}},services,maxBots:2,outputDir:root});
  t.after(async()=>{publication.close();await discovery.close();await runtime.close({timeoutMs:1000});await publication.waitForMerges?.({timeoutMs:1000});stores.close();await rm(root,{recursive:true,force:true});});
  const cli=async(bot,...args)=>{
    const credentials=controls.credentials.get(bot.id);assert.ok(credentials);
    const env={...process.env,...credentials.environment,...credentials.secretEnvironment};
    const url=new URL(env.SWARMENV_BRIDGE_URL);url.hostname='127.0.0.1';env.SWARMENV_BRIDGE_URL=url.href.replace(/\/$/,'');
    const {stdout}=await execute(process.execPath,[new URL('../scripts/swarm.js',import.meta.url).pathname,...args],{env,timeout:15000});return JSON.parse(stdout);
  };
  const bots=[];
  for(let i=0;i<2;i++) {

    const bot=await runtime.spawn({profile:'researcher',requestId:`contributor-${i}`});bots.push(bot);
    stores.tasks.registerBot({botId:bot.id,missionId:stores.missionId,legacySlotId:`flat-slot:${i}`,selectionDeadline:new Date(Date.now()+60000).toISOString()});stores.tasks.markCoreBotReady(bot.id);
    if (i === 0) await cli(bot,'task','take',stores.task.task_id,'--request-id',`take-${i}`);
  }
  return {...stores,root,publication,runtime,bots,policy,cli:(...args)=>cli(bots[0],...args),cliFor:cli};
}


const feedbackArgs=(notificationId,requestId='handle')=>['task','feedback','--notification-id',notificationId,'--decision','relevant','--action','inspected','--request-id',requestId];
function notice(f,{taskId=f.task.task_id,executionId=f.tasks.getBot(f.bots[0].id).execution_id,key='fixed',missionId=f.missionId}={}) {
  return f.tasks.enqueueNotification({deliveryKey:key,missionId,recipientTaskId:taskId,recipientExecutionId:executionId,type:'handoff_warning',payload:{execution_id:executionId,deadline:new Date(Date.now()+60000).toISOString()}});
}

test('current Core Task CLI handles its durable notification once with actual actor and stable replay',async t=>{
  const f=await fixture(t),notification=notice(f);
  const result=await f.cli(...feedbackArgs(notification.notification_id));
  assert.equal(result.receipt.execution_id,f.tasks.getBot(f.bots[0].id).execution_id);
  assert.equal(result.receipt.handling_decision,'relevant');assert.equal(result.receipt.handling_action,'inspected');
  assert.equal(result.execution.owner_ref,f.bots[0].id);assert.equal(result.execution.state,'RUNNING');assert.equal(result.task.state,'RUNNING');
  assert.deepEqual(await f.cli(...feedbackArgs(notification.notification_id)),result);
  const changed=feedbackArgs(notification.notification_id);changed[changed.indexOf('--action')+1]='different';
  await assert.rejects(f.cli(...changed),error=>/CONFLICT/.test(error.stderr));
  assert.deepEqual(f.tasks.listUnprocessedNotifications(f.task.task_id,result.execution.execution_id),[]);
});

test('feedback replay repeats actual lease and stop admission before returning a durable receipt',async t=>{
  for(const revoke of ['lease','stop']) {
    const f=await fixture(t),notification=notice(f),args=feedbackArgs(notification.notification_id);
    const result=await f.cli(...args);
    if(revoke==='lease') f.tasks.db.prepare('UPDATE executions SET lease_expires_at = ? WHERE execution_id = ?').run(new Date(Date.now()-1).toISOString(),result.execution.execution_id);
    else f.tasks.requestBotStop(f.bots[0].id,'End authority',{terminalState:'FAILED'});
    await assert.rejects(f.cli(...args),error=>/NOT_ALLOWED|FENCED/.test(error.stderr));
  }
});

test('feedback cannot handle another Task or Mission notification through its current Execution',async t=>{
  const f=await fixture(t);
  for(const missionId of [f.missionId,'foreign-feedback']) {
    if(missionId!==f.missionId) f.tasks.createMission({mission_id:missionId,goal:'Other Mission'},makeEnvelope({actorRef:'host'}));
    const other=f.tasks.createTask({mission_id:missionId,gap:'Other recipient',priority:'medium',summary:'Separate work',expected_output:'Note',acceptance_conditions:['Recorded']},makeEnvelope({actorRef:'host'})).task;
    const notification=notice(f,{missionId,taskId:other.task_id,executionId:null,key:missionId});
    await assert.rejects(f.cli(...feedbackArgs(notification.notification_id,missionId)),error=>/NOT_ALLOWED/.test(error.stderr));
    assert.equal(f.tasks.listUnprocessedNotifications(other.task_id,null)[0].handled_at,null);
  }
});

test('feedback capability grants no unbound authority and does not follow from registration alone',async t=>{
  const f=await fixture(t),notification=notice(f);
  await assert.rejects(f.cliFor(f.bots[1],...feedbackArgs(notification.notification_id)),error=>/NOT_ALLOWED/.test(error.stderr));
  const denied=await fixture(t,{feedbackAllowed:false}),other=notice(denied);
  await assert.rejects(denied.cli(...feedbackArgs(other.notification_id)),error=>/NOT_ALLOWED/.test(error.stderr));
});

for(const boundary of ['stop','lease','deadline','fence']) test(`feedback rechecks ${boundary} after asynchronous Core lookup`,async t=>{
  const f=await fixture(t),notification=notice(f);
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  f.policy.beforeGet=async()=>{entered.resolve();await release.promise;};
  const pending=f.cli(...feedbackArgs(notification.notification_id));await entered.promise;
  const executionId=f.tasks.getBot(f.bots[0].id).execution_id;
  if(boundary==='stop') f.tasks.requestBotStop(f.bots[0].id,'Host stop',{terminalState:'FAILED'});
  else if(boundary==='deadline') f.policy.deadlineAt=Date.now()-1;
  else if(boundary==='lease') f.tasks.db.prepare('UPDATE executions SET lease_expires_at = ? WHERE execution_id = ?').run(new Date(Date.now()-1).toISOString(),executionId);
  else f.tasks.db.prepare('UPDATE executions SET fencing_version = fencing_version + 1 WHERE execution_id = ?').run(executionId);
  release.resolve();
  await assert.rejects(pending,error=>/NOT_ALLOWED|FENCED/.test(error.stderr));
  assert.equal(f.tasks.listNotifications({recipientTaskId:f.task.task_id})[0].handled_at,null);
});

test('feedback recovers its durable handling after a lost dispatch acknowledgement without handling again',async t=>{
  const f=await fixture(t),notification=notice(f),args=feedbackArgs(notification.notification_id);
  const dispatch=f.tasks.dispatch.bind(f.tasks);let original;
  f.tasks.dispatch=(operation,...rest)=>{
    const result=dispatch(operation,...rest);
    if(operation==='task_feedback' && !original) {original=result;throw Object.assign(new Error('controlled lost acknowledgement'),{code:'SERVICE_UNAVAILABLE'});}
    return result;
  };
  await assert.rejects(f.cli(...args),error=>/SERVICE_UNAVAILABLE/.test(error.stderr));
  assert.ok(original.receipt.handled_at);
  assert.deepEqual(await f.cli(...args),JSON.parse(JSON.stringify(original)));
  assert.equal(f.tasks.listNotifications({recipientTaskId:f.task.task_id})[0].handled_at,original.receipt.handled_at);
});

test('feedback preserves specifically addressed live Execution exclusion and terminal addressed Execution handling',async t=>{
  const f=await fixture(t);
  const other=f.tasks.createTask({mission_id:f.missionId,gap:'Other active recipient',priority:'medium',summary:'Parallel receipt',expected_output:'Note',acceptance_conditions:['Stored']},makeEnvelope({actorRef:'host'})).task;
  await f.cliFor(f.bots[1],'task','take',other.task_id,'--request-id','parallel');
  const addressed=f.tasks.getExecution(f.tasks.getBot(f.bots[1].id).execution_id);
  const notification=notice(f,{executionId:addressed.execution_id});
  await assert.rejects(f.cli(...feedbackArgs(notification.notification_id)),error=>/NOT_ALLOWED/.test(error.stderr));
  f.tasks.dispatch('stop_execution',{terminal_state:'FAILED'},makeEnvelope({actorRef:f.bots[1].id,taskId:addressed.task_id,executionId:addressed.execution_id,specVersion:addressed.spec_version,stateVersion:addressed.state_version,fencingVersion:addressed.fencing_version}));
  const result=await f.cli(...feedbackArgs(notification.notification_id));
  assert.equal(result.receipt.execution_id,f.tasks.getBot(f.bots[0].id).execution_id);
});
