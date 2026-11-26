import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTaskPoolStores } from './fixtures/taskpool-task-stores.js';
import { controls } from './fixtures/taskpool-controller-backend.js';
import { createTaskPoolTaskService } from '../src/harnesses/taskpool/task-service.js';
import { ServiceRegistry } from '../src/core/services.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
const hooks=registerHooks({resolve(specifier,context,next) {
  if(specifier==='./pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return {url:new URL('./fixtures/taskpool-controller-backend.js',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}});
const {createRuntime}=await import('@murm/core');hooks.deregister();
const execute=promisify(execFile);
async function fixture(t, { coordination = true, autonomousTasks = false } = {}) {
  const root=await mkdtemp(join(tmpdir(),'taskpool-coordination-'));
  const stores=await createTaskPoolStores(root);
  stores.tasks.contextService=stores.context;
  let runtime;
  const discovery=createTaskPoolTaskService({runtime:()=>runtime,taskService:stores.tasks,contextService:stores.context,missionWorkspace:stores.workspace,workspaceManager:stores.manager,missionId:stores.missionId,workspaceId:stores.workspaceId,missionDeadline:()=>Date.now()+60000,autonomousTasks});
  const services = new ServiceRegistry();
  services.registerService(discovery);
  const allowed = { task: discovery.manifest.capabilities.map(capability => capability.operation) };
  if (!coordination) allowed.task = allowed.task.filter(operation => !['task_revise','task_cancel'].includes(operation));
  runtime=await createRuntime({backend:{},profiles:{researcher:{prompt:'Revise unowned public Task responsibilities',model:'default',image:'fixture',writable:false,services:allowed}},services,maxAgents:2,outputDir:root});
  t.after(async()=>{await discovery.close();await runtime.close({timeoutMs:1000});stores.close();await rm(root,{recursive:true,force:true});});
  const cli=async(agent,...args)=>{
    const credentials=controls.credentials.get(agent.id);assert.ok(credentials);
    const env={...process.env,...credentials.environment,...credentials.secretEnvironment};
    const url=new URL(env.MURM_BRIDGE_URL);url.hostname='127.0.0.1';env.MURM_BRIDGE_URL=url.href.replace(/\/$/,'');
    const {stdout}=await execute(process.execPath,[new URL('../scripts/swarm.js',import.meta.url).pathname,...args],{env,timeout:15000});return JSON.parse(stdout);
  };
  const agents=[];
  for(let i=0;i<2;i++) {

    const agent=await runtime.spawn({profile:'researcher',requestId:`contributor-${i}`});agents.push(agent);
    stores.tasks.registerAgent({agentId:agent.id,missionId:stores.missionId,legacySlotId:`taskpool-slot:${i}`,selectionDeadline:new Date(Date.now()+60000).toISOString()});stores.tasks.markCoreAgentReady(agent.id);
    if (i === 0) await cli(agent,'task','take',stores.task.task_id,'--request-id',`take-${i}`);
  }
  return {...stores,root,runtime,agents,cli:(...args)=>cli(agents[0],...args),cliFor:cli};
}



const versionArgs = task => ['--expected-spec-version',String(task.spec_version),'--expected-state-version',String(task.state_version)];
function proposal(f, summary, extra = {}) {
  return f.tasks.createTask({mission_id:f.missionId,gap:'Independent responsibility',priority:'medium',summary,expected_output:'Note',acceptance_conditions:['Evidence'],...extra},makeEnvelope({actorRef:'host'})).task;
}

test('unbound Core Bridge CLI revises and cancels with original CAS, history and replay without grants', async t => {
  const f = await fixture(t);
  const editor = f.agents[1];
  const original = proposal(f,'Original responsibility');
  assert.deepEqual(f.tasks.getAgent(editor.id).coordination_permissions,[]);
  const revise = () => f.cliFor(editor,'task','revise',original.task_id,...versionArgs(original),'--changes','{"priority":"high"}','--reason','Correct priority','--request-id','revise');
  const revised = await revise();
  assert.equal(revised.task.priority,2);
  assert.equal(revised.task.spec_version,original.spec_version+1);
  assert.equal(revised.revision.actor_ref,editor.id);
  assert.deepEqual(await revise(),revised);
  await assert.rejects(f.cliFor(editor,'task','take',original.task_id,'--request-id','revise'),error=>/CONFLICT/.test(error.stderr));
  await assert.rejects(f.cliFor(editor,'task','revise',original.task_id,...versionArgs(original),'--changes','{"priority":"low"}','--reason','Changed replay','--request-id','revise'),error=>/CONFLICT/.test(error.stderr));
  await assert.rejects(f.cliFor(editor,'task','revise',original.task_id,...versionArgs(original),'--changes','{"priority":"low"}','--reason','Stale observation','--request-id','stale'),error=>/STALE_VERSION/.test(error.stderr));
  const cancel = () => f.cliFor(editor,'task','cancel',original.task_id,...versionArgs(revised.task),'--reason','Retire unowned responsibility','--request-id','cancel');
  const cancelled = await cancel();
  assert.equal(cancelled.task.state,'CANCELED');
  assert.equal(cancelled.cancellation.actor_ref,editor.id);
  assert.deepEqual(await cancel(),cancelled);
  f.tasks.requestAgentStop(editor.id,'Withdraw domain authority');
  await assert.rejects(cancel(),error=>/NOT_ALLOWED/.test(error.stderr));
  await f.runtime.stop(editor.id);
  await assert.rejects(cancel(),error=>/NOT_ALLOWED/.test(error.stderr));
});


test('unbound Task corrections reject ACTIVE callers, owned targets, foreign Missions and stale cancel versions', async t => {
  const f = await fixture(t);
  const editor = f.agents[1];
  const target = proposal(f,'Unowned target');
  const cancelArgs = task => ['task','cancel',task.task_id,...versionArgs(task),'--reason','Retire responsibility'];
  await assert.rejects(f.cli(...cancelArgs(target),'--request-id','active'),error=>/NOT_ALLOWED/.test(error.stderr));
  const owned = f.tasks.getTask(f.task.task_id);
  await assert.rejects(f.cliFor(editor,...cancelArgs(owned),'--request-id','owned'),error=>/NOT_ALLOWED/.test(error.stderr));
  await assert.rejects(f.cliFor(editor,'task','revise',owned.task_id,...versionArgs(owned),'--changes','{"priority":"high"}','--reason','Owned responsibility','--request-id','owned-revise'),error=>/NOT_ALLOWED/.test(error.stderr));
  f.tasks.createMission({mission_id:'foreign',goal:'Independent Mission'},makeEnvelope({actorRef:'host'}));
  const foreign = proposal(f,'Foreign target',{mission_id:'foreign'});
  await assert.rejects(f.cliFor(editor,...cancelArgs(foreign),'--request-id','foreign'),error=>/NOT_ALLOWED/.test(error.stderr));
  await assert.rejects(f.cliFor(editor,'task','revise',foreign.task_id,...versionArgs(foreign),'--changes','{"priority":"high"}','--reason','Wrong scope','--request-id','foreign-revise'),error=>/NOT_ALLOWED/.test(error.stderr));
  await f.cliFor(editor,'task','revise',target.task_id,...versionArgs(target),'--changes','{"priority":"high"}','--reason','Correct priority','--request-id','advance');
  await assert.rejects(f.cliFor(editor,...cancelArgs(target),'--request-id','stale-cancel'),error=>/STALE_VERSION/.test(error.stderr));
  const before = f.tasks.getTask(target.task_id);
  await assert.rejects(f.cli('task','revise',target.task_id,...versionArgs(before),'--changes','{"priority":"low"}','--reason','ACTIVE may not edit','--request-id','active-revise'),error=>/NOT_ALLOWED/.test(error.stderr));
  assert.equal(f.tasks.getTask(target.task_id).spec_version,before.spec_version);
});

test('Task correction registration confers no Profile permission or dependency-replacement grant', async t => {
  const f = await fixture(t,{coordination:false});
  const target = proposal(f,'Protected by Profile');
  await assert.rejects(f.cliFor(f.agents[1],'task','cancel',target.task_id,...versionArgs(target),'--reason','No Profile permission','--request-id','denied'),error=>/NOT_ALLOWED/.test(error.stderr));
  assert.equal(f.tasks.getTask(target.task_id).state,'OPEN');
  assert.deepEqual(f.tasks.getAgent(f.agents[1].id).coordination_permissions,[]);
  await assert.rejects(f.cliFor(f.agents[1],'task','dependency-replace',target.task_id,'--from-task-id','old','--to-task-id','new',...versionArgs(target),'--reason','No grant','--request-id','replace-denied'),error=>/NOT_ALLOWED/.test(error.stderr));
});


test('autonomous proposals through Core Bridge keep active responsibility and inject Mission and Workspace', async t => {
  const f = await fixture(t, { autonomousTasks: true });
  const initial = f.tasks.getAgent(f.agents[0].id).execution_id;
  const create = agent => f.cliFor(agent, 'task', 'create', '--summary', 'Prove a missing lemma', '--gap', 'The root proof needs a finite bound', '--expected-output', 'A checked lemma', '--acceptance-conditions', '["Lemma compiles"]', '--priority', 'high', '--request-id', 'proposal');
  const active = await create(f.agents[0]);
  assert.equal(active.task.mission_id, f.missionId);
  assert.equal(active.task.workspace.workspace_id, f.workspaceId);
  assert.equal(active.task.creation.actor_ref, f.agents[0].id);
  assert.equal(f.tasks.getAgent(f.agents[0].id).execution_id, initial);
  assert.deepEqual(await create(f.agents[0]), active);
  await assert.rejects(f.cliFor(f.agents[0], 'task', 'create', '--summary', 'Changed proposal', '--gap', 'Different gap', '--expected-output', 'Lemma', '--acceptance-conditions', '["Compiles"]', '--priority', 'high', '--request-id', 'proposal'), error => /CONFLICT/.test(error.stderr));
  const unbound = await create(f.agents[1]);
  assert.notEqual(unbound.task.task_id, active.task.task_id);
  assert.equal(f.tasks.getAgent(f.agents[1].id).state, 'UNBOUND');
  await assert.rejects(f.cliFor(f.agents[1], 'task', 'create', '--summary', 'Spoof', '--gap', 'Foreign', '--expected-output', 'Lemma', '--acceptance-conditions', '["Compiles"]', '--priority', 'high', '--mission-id', 'foreign', '--request-id', 'spoof'), error => /SERVICE_INPUT_INVALID|INVALID_CONTRACT|NOT_ALLOWED/.test(error.stderr));
  f.tasks.requestAgentStop(f.agents[0].id, 'End original responsibility', { terminalState: 'FAILED' });
  await assert.rejects(create(f.agents[0]), error => /NOT_ALLOWED/.test(error.stderr));
});
