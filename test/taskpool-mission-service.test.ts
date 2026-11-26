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
import { createTaskPoolMissionService } from '../src/harnesses/taskpool/mission-service.js';
import { createMissionCoordination } from '../src/harnesses/taskpool/mission-coordination.js';
import { createTaskPoolTaskService } from '../src/harnesses/taskpool/task-service.js';
import { createTaskPoolAgentCoordinator } from '../src/harnesses/taskpool/agent-coordinator.js';
import { ServiceRegistry } from '../src/core/services.js';
const hooks=registerHooks({resolve(specifier,context,next) {
  if(specifier==='./pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return {url:new URL('./fixtures/taskpool-controller-backend.js',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}});
const {createRuntime}=await import('@murm/core');hooks.deregister();
const execute=promisify(execFile);
const checkerIdentity={checker_ref:'fixed-final',checker_version:'1',environment_ref:'controlled'};
async function fixture(t,{permissions=['mission_submit'],registered=permissions,profileAllows=true}={}) {
  const root=await mkdtemp(join(tmpdir(),'flat-mission-'));
  const stores=await createTaskPoolStores(root);
  stores.tasks.db.prepare('UPDATE missions SET acceptance_conditions_json=? WHERE mission_id=?').run(JSON.stringify({required_check:checkerIdentity}),stores.missionId);
  const calls=[];
  const store=createMissionCoordination({taskService:stores.tasks,contextService:stores.context,workspace:stores.workspace,
    missionId:stores.missionId,workspaceId:stores.workspaceId,deadline:()=>Date.now()+60000,
    checker:{identity:checkerIdentity,timeoutMs:5000,check:input=>new Promise(resolve=>calls.push({input,resolve}))}});
  let runtime;
  const policy={beforeGet:null,deadline:Date.now()+60000};
  const mission=createTaskPoolMissionService({runtime:()=>({...runtime,async get(id){const result=await runtime.get(id);await policy.beforeGet?.();return result;}}),taskService:stores.tasks,
    missionWorkspace:stores.workspace,missionId:stores.missionId,workspaceId:stores.workspaceId,missionCoordination:store,coordinationPermissions:permissions,deadline:()=>policy.deadline});
  const discovery=createTaskPoolTaskService({runtime:()=>runtime,taskService:stores.tasks,contextService:stores.context,missionWorkspace:stores.workspace,workspaceManager:stores.manager,
    missionId:stores.missionId,workspaceId:stores.workspaceId,missionDeadline:()=>Date.now()+60000});
  const services=new ServiceRegistry();services.registerService(mission);services.registerService(discovery);
  runtime=await createRuntime({backend:{},profiles:{researcher:{prompt:'Submit only fixed public results',model:'default',image:'fixture',writable:false,
    services:{task:discovery.manifest.capabilities.map(cap=>cap.operation),mission:mission.manifest.capabilities.filter(cap=>profileAllows||cap.operation!=='mission_submit').map(cap=>cap.operation)}}},services,maxAgents:1,outputDir:root});
  const coordinator=createTaskPoolAgentCoordinator({runtime,taskService:stores.tasks,missionId:stores.missionId,coordinationPermissions:registered});
  const agent=await coordinator.spawn({profile:'researcher',requestId:'coordinator',legacySlotId:'flat-slot',selectionDeadline:new Date(Date.now()+60000).toISOString()});
  t.after(async()=>{mission.close();await discovery.close();for(const call of calls)call.resolve({verdict:'FAIL'});await store.shutdown();await runtime.close({timeoutMs:1000});stores.close();await rm(root,{recursive:true,force:true});});
  const cli=async(...args)=>{
    const credentials=controls.credentials.get(agent.id),env={...process.env,...credentials.environment,...credentials.secretEnvironment};
    const url=new URL(env.MURM_BRIDGE_URL);url.hostname='127.0.0.1';env.MURM_BRIDGE_URL=url.origin;
    return JSON.parse((await execute(process.execPath,[new URL('../scripts/swarm.js',import.meta.url).pathname,...args],{env,timeout:10000})).stdout);
  };
  return {...stores,root,store,mission,runtime,agent,policy,calls,cli};
}

test('Core Mission CLI freezes fixed bytes with a granted UNBOUND actor and preserves durable replay',async t=>{
  const f=await fixture(t);
  assert.equal((await f.cli('mission','view')).mission_id,f.missionId);
  assert.deepEqual(await f.cli('mission','submission','view','missing'),{ok:true,result:null});
  for(const args of [['mission','view'],['mission','submission','view']]) {
    await assert.rejects(f.cli(...args,'--mission-id','foreign'),error=>/NOT_ALLOWED/.test(error.stderr));
  }
  const pending=await f.cli('mission','submit','--material-ids','[]','--request-id','fixed-final');
  assert.equal(pending.state,'pending');assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].input.files['input.txt'].toString(),'fixed λ\n');
  const stored=await f.store.get({missionId:f.missionId,submissionId:pending.submission_id});
  assert.equal(stored.actor_ref,f.agent.id);assert.equal(stored.execution_id,null);assert.deepEqual(stored.material_ids,[]);
  f.calls[0].resolve({verdict:'FAIL',diagnostic:'The fixed candidate does not pass'});await f.store.waitForIdle();
  const observed=await f.cli('mission','submission','view',pending.submission_id);
  assert.equal(observed.state,'failed');
  assert.equal((await f.cli('mission','submit','--material-ids','[]','--request-id','fixed-final')).submission_id,pending.submission_id);
  assert.equal(f.calls.length,1);
  await assert.rejects(f.cli('mission','submit','--material-ids','["changed"]','--request-id','fixed-final'),error=>/CONFLICT/.test(error.stderr));
  assert.equal((await f.cli('mission','submit','--material-ids','[]','--request-id','fixed-final')).submission_id,pending.submission_id);
  f.tasks.db.prepare('UPDATE agents SET coordination_permissions_json=? WHERE agent_id=?').run('[]',f.agent.id);
  let replays=0;const submit=f.store.submit.bind(f.store);f.store.submit=(...args)=>{replays++;return submit(...args);};
  await assert.rejects(f.cli('mission','submit','--material-ids','[]','--request-id','fixed-final'),error=>/NOT_ALLOWED/.test(error.stderr));
  assert.equal(replays,0);
  assert.equal((await f.cli('mission','submission','view',pending.submission_id)).state,'failed');
  await f.runtime.stop(f.agent.id,{timeoutMs:1000});
  await assert.rejects(f.cli('mission','submission','view',pending.submission_id),error=>/NOT_ALLOWED/.test(error.stderr));
});

test('Mission submit defaults to denial and requires independent Profile, host and registered grants',async t=>{
  for(const options of [{permissions:[]},{registered:[]},{profileAllows:false}]) {
    const f=await fixture(t,options);
    await assert.rejects(f.cli('mission','submit','--material-ids','[]','--request-id','denied'),error=>/NOT_ALLOWED/.test(error.stderr));
    assert.equal(f.calls.length,0);
  }
});

test('Mission submit binds ACTIVE authority and rejects withdrawal during Core lookup before store admission',async t=>{
  const f=await fixture(t);
  const taken=await f.cli('task','take',f.task.task_id,'--request-id','take');
  const pending=await f.cli('mission','submit','--material-ids','[]','--request-id','active-final');
  const stored=await f.store.get({missionId:f.missionId,submissionId:pending.submission_id});
  assert.equal(stored.execution_id,taken.execution.execution_id);assert.equal(stored.task_id,f.task.task_id);
  f.calls[0].resolve({verdict:'FAIL'});await f.store.waitForIdle();
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  f.policy.beforeGet=async()=>{entered.resolve();await release.promise;};
  const attempt=f.cli('mission','submit','--material-ids','[]','--request-id','withdrawn');
  await entered.promise;
  f.tasks.db.prepare('UPDATE agents SET coordination_permissions_json=? WHERE agent_id=?').run('[]',f.agent.id);
  release.resolve();await assert.rejects(attempt,error=>/NOT_ALLOWED/.test(error.stderr));
  assert.equal(f.calls.length,1);
});

for(const boundary of ['stop','deadline','binding']) test(`Mission submission rejects ${boundary} withdrawal during Core lookup`,async t=>{
  const f=await fixture(t);
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  f.policy.beforeGet=async()=>{entered.resolve();await release.promise;};
  const attempt=f.cli('mission','submit','--material-ids','[]','--request-id','withdrawn');
  await entered.promise;
  try {
    if(boundary==='stop') f.tasks.requestAgentStop(f.agent.id,'Host withdrew coordinator');
    else if(boundary==='deadline') f.policy.deadline=Date.now()-1;
    else await f.cli('task','take',f.task.task_id,'--request-id','new-binding');
  } finally {release.resolve();}
  await assert.rejects(attempt,error=>new RegExp(boundary==='binding'?'FENCED':'NOT_ALLOWED').test(error.stderr));
  assert.equal(f.calls.length,0);
});

test('normal Flat host keeps the explicit Mission checker caller-owned after its Agents close',async t=>{
  const {runTaskPoolHarness}=await import('../src/harnesses/taskpool/harness.js');
  for(const {coordinationPermissions,enabled} of [{coordinationPermissions:[],enabled:false},{coordinationPermissions:[],enabled:true},{coordinationPermissions:['mission_submit'],enabled:true}]) {
    const root=await mkdtemp(join(tmpdir(),'flat-mission-host-')),stores=await createTaskPoolStores(root);
    stores.tasks.db.prepare('UPDATE missions SET acceptance_conditions_json=? WHERE mission_id=?').run(JSON.stringify({required_check:checkerIdentity}),stores.missionId);
    const calls=[];
    const store=createMissionCoordination({taskService:stores.tasks,contextService:stores.context,workspace:stores.workspace,workspaceId:stores.workspaceId,missionId:stores.missionId,
      deadline:Date.now()+60000,checker:{identity:checkerIdentity,timeoutMs:5000,check:input=>new Promise(resolve=>calls.push({input,resolve}))}});
    t.after(async()=>{for(const call of calls)call.resolve({verdict:'FAIL'});await store.shutdown();stores.close();await rm(root,{recursive:true,force:true});});
    transport.reset();controls.credentials.clear();controls.stopError=null;controls.destroyError=null;
    const accept=id=>{transport.confirm(id,'started');transport.next=accept;};transport.next=accept;
    let submissionId;
    const report=await runTaskPoolHarness({taskService:stores.tasks,contextService:stores.context,missionWorkspace:stores.workspace,workspaceManager:stores.manager,
      missionId:stores.missionId,workspaceId:stores.workspaceId,outputDir:root,deadlineAt:Date.now()+30000,backend:{},model:'default',image:'fixture',capacity:1,
      missionCoordination:enabled?store:null,coordinationPermissions,snapshotProject:async()=>{throw new Error('No live capture required');},
      async drive(controller) {
        const agentId=controller.snapshot().agents[0].agentId;
        assert.deepEqual(stores.tasks.getAgent(agentId).coordination_permissions,coordinationPermissions);
        const credentials=controls.credentials.get(agentId),env={...process.env,...credentials.environment,...credentials.secretEnvironment};
        const url=new URL(env.MURM_BRIDGE_URL);url.hostname='127.0.0.1';env.MURM_BRIDGE_URL=url.origin;
        const cli=async(...args)=>JSON.parse((await execute(process.execPath,[new URL('../scripts/swarm.js',import.meta.url).pathname,...args],{env,timeout:10000})).stdout);
        if(enabled) assert.equal((await cli('mission','view')).mission_id,stores.missionId);
        else await assert.rejects(cli('mission','view'),error=>/NOT_ALLOWED/.test(error.stderr));
        const attempt=()=>cli('mission','submit','--material-ids','[]','--request-id','normal-host');
        if(coordinationPermissions.length) submissionId=(await attempt()).submission_id;
        else await assert.rejects(attempt(),error=>/NOT_ALLOWED/.test(error.stderr));
        controller.halt('controlled-host-stop');
      },
    });
    assert.equal(report.cleanup.cleanup,'complete');assert.equal(report.cleanupFailure,null);
    if(coordinationPermissions.length) {
      assert.equal(store.shuttingDown,false);assert.equal(calls.length,1);
      calls[0].resolve({verdict:'PASS'});await store.waitForIdle();
      assert.equal((await store.describe({missionId:stores.missionId,workspaceId:stores.workspaceId,submissionId})).state,'accepted');
    } else assert.equal(calls.length,0);
  }
});


test('normal math Flat reports a trusted accepted Mission as business success with an active Task', async t => {
  const { runTaskPoolHarness } = await import('../src/harnesses/taskpool/harness.js');
  const root = await mkdtemp(join(tmpdir(), 'flat-math-acceptance-'));
  const stores = await createTaskPoolStores(root);
  stores.tasks.db.prepare('UPDATE missions SET acceptance_conditions_json=? WHERE mission_id=?').run(JSON.stringify({ required_check: checkerIdentity }), stores.missionId);
  const store = createMissionCoordination({ taskService: stores.tasks, contextService: stores.context, workspace: stores.workspace, workspaceId: stores.workspaceId, missionId: stores.missionId,
    deadline: Date.now()+60000, checker: { identity: checkerIdentity, timeoutMs: 5000, async check() { return { verdict: 'PASS' }; } } });
  t.after(async () => { await store.shutdown(); stores.close(); await rm(root, { recursive: true, force: true }); });
  transport.reset(); controls.credentials.clear(); controls.stopError = null; controls.destroyError = null;
  const accept = id => { transport.confirm(id, 'started'); transport.next = accept; }; transport.next = accept;
  const report = await runTaskPoolHarness({ taskService: stores.tasks, contextService: stores.context, missionWorkspace: stores.workspace, workspaceManager: stores.manager,
    missionId: stores.missionId, workspaceId: stores.workspaceId, outputDir: root, deadlineAt: Date.now()+30000, backend: {}, model: 'default', image: 'fixture', capacity: 1,
    completionPolicy: 'mission', autonomousTasks: true, missionCoordination: store, coordinationPermissions: ['mission_submit'],
    async drive(controller) {
      const agentId = controller.snapshot().agents[0].agentId;
      const credentials = controls.credentials.get(agentId), env = { ...process.env, ...credentials.environment, ...credentials.secretEnvironment };
      const url = new URL(env.MURM_BRIDGE_URL); url.hostname = '127.0.0.1'; env.MURM_BRIDGE_URL = url.origin;
      const cli = async (...args) => JSON.parse((await execute(process.execPath, [new URL('../scripts/swarm.js', import.meta.url).pathname, ...args], { env, timeout: 10000 })).stdout);
      await cli('task', 'take', stores.task.task_id, '--request-id', 'take');
      await cli('mission', 'submit', '--material-ids', '[]', '--request-id', 'accept');
      await store.waitForIdle();
      await controller.tick();
    },
  });
  assert.equal(report.businessFailure, null, JSON.stringify(report.businessFailure));
  assert.equal(report.result.completion, 'mission-accepted');
  assert.equal(report.result.missionAcceptance.state, 'accepted');
  assert.equal(report.cleanup.cleanup, 'complete');
  assert.ok(stores.tasks.getAcceptedSubmission(stores.missionId));
});
