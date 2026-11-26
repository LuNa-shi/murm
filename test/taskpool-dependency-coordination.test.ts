import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTaskPoolStores } from './fixtures/taskpool-task-stores.js';
import { controls, transport } from './fixtures/taskpool-controller-backend.js';
import { createTaskPoolAgentCoordinator } from '../src/harnesses/taskpool/agent-coordinator.js';
import { createTaskPoolTaskService, taskPoolResearcherProfile } from '../src/harnesses/taskpool/task-service.js';
import { ServiceRegistry } from '../src/core/services.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
const hooks=registerHooks({resolve(specifier,context,next) {
  if(specifier==='./opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return {url:new URL('./fixtures/taskpool-controller-backend.js',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}});
const {createRuntime}=await import('@murm/core');hooks.deregister();
const execute=promisify(execFile);
async function fixture(t, { coordinationPermissions = ['task_dependency_replace'], registeredPermissions = coordinationPermissions, profileAllows = true } = {}) {
  const root=await mkdtemp(join(tmpdir(),'taskpool-coordination-'));
  const stores=await createTaskPoolStores(root);
  stores.tasks.contextService=stores.context;
  let runtime;
  const lookup={beforeGet:null};
  const discovery=createTaskPoolTaskService({runtime:()=>({...runtime,async get(id){const result=await runtime.get(id);await lookup.beforeGet?.();return result;}}),taskService:stores.tasks,contextService:stores.context,missionWorkspace:stores.workspace,workspaceManager:stores.manager,missionId:stores.missionId,workspaceId:stores.workspaceId,missionDeadline:()=>Date.now()+60000,coordinationPermissions});
  const services = new ServiceRegistry();
  services.registerService(discovery);
  const allowed = { task: discovery.manifest.capabilities.map(capability => capability.operation) };
  if (!profileAllows) allowed.task=allowed.task.filter(operation=>operation!=='task_dependency_replace');
  runtime=await createRuntime({backend:{},profiles:{researcher:{prompt:'Revise unowned public Task responsibilities',model:'default',image:'fixture',writable:false,services:allowed}},services,maxAgents:2,outputDir:root});
  t.after(async()=>{await discovery.close();await runtime.close({timeoutMs:1000});stores.close();await rm(root,{recursive:true,force:true});});
  const cli=async(agent,...args)=>{
    const credentials=controls.credentials.get(agent.id);assert.ok(credentials);
    const env={...process.env,...credentials.environment,...credentials.secretEnvironment};
    const url=new URL(env.MURM_BRIDGE_URL);url.hostname='127.0.0.1';env.MURM_BRIDGE_URL=url.href.replace(/\/$/,'');
    const {stdout}=await execute(process.execPath,[new URL('../scripts/swarm.js',import.meta.url).pathname,...args],{env,timeout:15000});return JSON.parse(stdout);
  };
  const coordinator=createTaskPoolAgentCoordinator({runtime,taskService:stores.tasks,missionId:stores.missionId,coordinationPermissions:registeredPermissions});
  const agents=[];
  for(let i=0;i<2;i++) {

    const agent=await coordinator.spawn({profile:'researcher',requestId:`contributor-${i}`,legacySlotId:`taskpool-slot:${i}`,selectionDeadline:new Date(Date.now()+60000).toISOString()});agents.push(agent);
    if (i === 0) await cli(agent,'task','take',stores.task.task_id,'--request-id',`take-${i}`);
  }
  return {...stores,root,runtime,agents,lookup,cli:(...args)=>cli(agents[0],...args),cliFor:cli};
}



const versionArgs = task => ['--expected-spec-version',String(task.spec_version),'--expected-state-version',String(task.state_version)];
function proposal(f, summary, extra = {}) {
  return f.tasks.createTask({mission_id:f.missionId,gap:'Independent responsibility',priority:'medium',summary,expected_output:'Note',acceptance_conditions:['Evidence'],...extra},makeEnvelope({actorRef:'host'})).task;
}

function repairArgs(target, from, to, requestId) {
  return ['task','dependency-replace',target.task_id,'--from-task-id',from.task_id,'--to-task-id',to.task_id,
    ...versionArgs(target),'--reason','Replace the cancelled prerequisite with the corrected responsibility','--request-id',requestId];
}
async function cancelledDependency(f) {
  const old=proposal(f,'Old prerequisite'), replacement=proposal(f,'Corrected prerequisite'), other=proposal(f,'Unchanged prerequisite');
  const dependent=proposal(f,'Combine both prerequisites',{depends_on:[old.task_id,other.task_id]});
  const args=['task','cancel',old.task_id,...versionArgs(old),'--reason','The corrected responsibility replaces this proposal','--replacement',replacement.task_id,'--request-id',`cancel-${old.task_id}`];
  await assert.rejects(f.cli(...args),error=>/NOT_ALLOWED/.test(error.stderr));
  const cancelled=await f.cliFor(f.agents[1],...args);
  assert.equal(cancelled.task.state,'CANCELED');
  const viewed=await f.cli('task','view',dependent.task_id);
  return {old,replacement,other,dependent:viewed.task};
}

test('explicit host grant lets an ACTIVE Core CLI repair a cancelled dependency without changing other edges',async t=>{
  const f=await fixture(t);
  const {old,replacement,other,dependent}=await cancelledDependency(f);
  const args=repairArgs(dependent,old,replacement,'repair-active');
  const result=await f.cli(...args);
  assert.deepEqual(result.task.relations.depends_on.map(r=>r.related_task_id).sort(),[replacement.task_id,other.task_id].sort());
  assert.equal(result.task.relations.dependency_replacements.length,1);
  assert.equal(result.task.relations.dependency_replacements[0].actor_ref,f.agents[0].id);
  assert.equal(result.task.relations.dependency_replacements[0].execution_id,f.tasks.getAgent(f.agents[0].id).execution_id);
  assert.deepEqual(await f.cli(...args),result);
  await assert.rejects(f.cli(...repairArgs(dependent,old,other,'repair-active')),error=>/CONFLICT/.test(error.stderr));
  await assert.rejects(f.cli(...repairArgs(dependent,old,replacement,'stale')),error=>/STALE_VERSION/.test(error.stderr));
  const executionId=f.tasks.getAgent(f.agents[0].id).execution_id;
  f.tasks.db.prepare('UPDATE executions SET lease_expires_at = ? WHERE execution_id = ?').run(new Date(Date.now()-1).toISOString(),executionId);
  await assert.rejects(f.cli(...args),error=>/NOT_ALLOWED|FENCED/.test(error.stderr));
});

test('explicitly granted UNBOUND CLI repairs with context-free authority and repeats admission on replay',async t=>{
  const f=await fixture(t);
  const {old,replacement,other,dependent}=await cancelledDependency(f);
  const args=repairArgs(dependent,old,replacement,'repair-unbound');
  const result=await f.cliFor(f.agents[1],...args);
  assert.deepEqual(result.task.relations.depends_on.map(r=>r.related_task_id).sort(),[replacement.task_id,other.task_id].sort());
  const history=result.task.relations.dependency_replacements[0];
  assert.equal(history.actor_ref,f.agents[1].id);assert.equal(history.execution_id,null);
  assert.deepEqual(await f.cliFor(f.agents[1],...args),result);
  f.tasks.requestAgentStop(f.agents[1].id,'Revoke coordinator');
  await assert.rejects(f.cliFor(f.agents[1],...args),error=>/NOT_ALLOWED/.test(error.stderr));
});

test('Profile capability and registered grant are separate and both default to denied',async t=>{
  assert.equal(taskPoolResearcherProfile({}).services.task.includes('task_dependency_replace'),false);
  for(const options of [{coordinationPermissions:[]},{registeredPermissions:[]},{profileAllows:false}]) {
    const f=await fixture(t,options);
    const {old,replacement,dependent}=await cancelledDependency(f);
    await assert.rejects(f.cli(...repairArgs(dependent,old,replacement,'no-authority')),error=>/NOT_ALLOWED/.test(error.stderr));
    assert.equal(f.tasks.getTask(dependent.task_id).relations.dependency_replacements.length,0);
  }
});

test('dependency repair keeps Mission, target ownership and latest execution fences',async t=>{
  const f=await fixture(t);
  const {old,replacement,dependent}=await cancelledDependency(f);
  f.tasks.createMission({mission_id:'foreign',goal:'Other Mission'},makeEnvelope({actorRef:'host'}));
  const foreign=proposal(f,'Foreign responsibility',{mission_id:'foreign'});
  await assert.rejects(f.cli(...repairArgs(foreign,old,replacement,'foreign-target')),error=>/NOT_ALLOWED/.test(error.stderr));
  await assert.rejects(f.cli(...repairArgs(dependent,old,foreign,'foreign-edge')),error=>/INVALID_CONTRACT/.test(error.stderr));
  await assert.rejects(f.cli(...repairArgs(f.tasks.getTask(f.task.task_id),old,replacement,'owned-target')),error=>/NOT_ALLOWED/.test(error.stderr));
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  f.lookup.beforeGet=async()=>{entered.resolve();await release.promise;};
  const pending=f.cli(...repairArgs(dependent,old,replacement,'revoked-during-admission'));
  await entered.promise;
  const executionId=f.tasks.getAgent(f.agents[0].id).execution_id;
  f.tasks.db.prepare('UPDATE executions SET fencing_version = fencing_version + 1 WHERE execution_id = ?').run(executionId);
  release.resolve();
  await assert.rejects(pending,error=>/FENCED/.test(error.stderr));
  f.lookup.beforeGet=null;
  assert.equal(f.tasks.getTask(dependent.task_id).relations.dependency_replacements.length,0);
});

test('actual TaskPool host threads only explicit grants into frozen Profile, Service and registered Agents',async t=>{
  const {runTaskPoolHarness}=await import('../src/harnesses/taskpool/harness.js');
  for(const coordinationPermissions of [[],['task_dependency_replace']]) {
    const root=await mkdtemp(join(tmpdir(),'taskpool-host-coordination-'));
    const stores=await createTaskPoolStores(root);
    t.after(async()=>{stores.close();await rm(root,{recursive:true,force:true});});
    transport.reset();controls.credentials.clear();controls.stopError=null;controls.destroyError=null;
    const accept=id=>{transport.confirm(id,'started');transport.next=accept;};transport.next=accept;
    const report=await runTaskPoolHarness({taskService:stores.tasks,contextService:stores.context,missionWorkspace:stores.workspace,workspaceManager:stores.manager,
      missionId:stores.missionId,workspaceId:stores.workspaceId,outputDir:root,deadlineAt:Date.now()+30000,backend:{},model:'default',image:'fixture',capacity:1,
      coordinationPermissions,snapshotProject:async()=>{throw new Error('No capture required');},
      async drive(controller) {
        const agentId=controller.snapshot().agents[0].agentId;
        assert.deepEqual(stores.tasks.getAgent(agentId).coordination_permissions,coordinationPermissions);
        const credentials=controls.credentials.get(agentId),env={...process.env,...credentials.environment,...credentials.secretEnvironment};
        const url=new URL(env.MURM_BRIDGE_URL);url.hostname='127.0.0.1';env.MURM_BRIDGE_URL=url.href.replace(/\/$/,'');
        const cli=async(...args)=>JSON.parse((await execute(process.execPath,[new URL('../scripts/swarm.js',import.meta.url).pathname,...args],{env,timeout:15000})).stdout);
        const f={tasks:stores.tasks,missionId:stores.missionId};
        const old=proposal(f,'Retire old input'),replacement=proposal(f,'Corrected input'),dependent=proposal(f,'Combine input',{depends_on:[old.task_id]});
        await cli('task','cancel',old.task_id,...versionArgs(old),'--reason','Retire obsolete prerequisite','--request-id','host-cancel');
        const args=repairArgs(stores.tasks.getTask(dependent.task_id),old,replacement,'host-repair');
        if(coordinationPermissions.length) {
          const result=await cli(...args);
          assert.deepEqual(result.task.relations.depends_on.map(row=>row.related_task_id),[replacement.task_id]);
        } else await assert.rejects(cli(...args),error=>/NOT_ALLOWED/.test(error.stderr));
        controller.halt('controlled-host-stop');
      },
    });
    assert.equal(report.cleanup.cleanup,'complete');
    assert.equal(report.cleanupFailure,null);
    assert.equal(report.businessFailure.code,'TASKPOOL_BUSINESS_FAILED');
  }
});

test('coordination configuration rejects unrelated grants and never derives permission from a mutable input',()=>{
  for(const coordinationPermissions of [null,'task_dependency_replace',Array(1),['mission_force_submit'],['unknown']]) {
    assert.throws(()=>taskPoolResearcherProfile({coordinationPermissions}),{code:'INVALID_CONTRACT'});
  }
  assert.equal(taskPoolResearcherProfile({coordinationPermissions:['unsupersede']}).services.task.includes('unsupersede'),false);
  const coordinationPermissions=[];
  const profile=taskPoolResearcherProfile({coordinationPermissions});
  coordinationPermissions.push('task_dependency_replace');
  assert.equal(profile.services.task.includes('task_dependency_replace'),false);
});
