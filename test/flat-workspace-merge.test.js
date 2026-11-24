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
import { ServiceRegistry, snapshotServiceRegistry, invokeService } from '../src/core/services.js';
import { SwarmEnvError } from '../src/errors.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
const hooks=registerHooks({resolve(specifier,context,next) {
  if(specifier==='./pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return {url:new URL('./fixtures/flat-controller-backend.js',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}});
const {createRuntime}=await import('@swarmenv/core');hooks.deregister();
const execute=promisify(execFile);
const identity={checker_ref:'fixed-tree',checker_version:'1',environment_ref:'controlled'};
async function fixture(t,options={}) {
  const root=await mkdtemp(join(tmpdir(),'flat-merge-'));
  const stores=await createFlatTaskStores(root,{mergeRequiredCheck:identity});
  stores.tasks.contextService=stores.context;
  let runtime;
  const checked=[];
  const discovery=createFlatTaskService({runtime:()=>runtime,taskService:stores.tasks,contextService:stores.context,missionWorkspace:stores.workspace,workspaceManager:stores.manager,missionId:stores.missionId,workspaceId:stores.workspaceId,missionDeadline:()=>Date.now()+60000});
  const publicationOptions={runtime:()=>runtime,taskService:stores.tasks,contextService:stores.context,missionWorkspace:stores.workspace,missionId:stores.missionId,workspaceId:stores.workspaceId,deadline:()=>Date.now()+60000,
    workspaceMergeChecker:options.disabled?null:{identity,timeoutMs:options.timeoutMs??5000,async check(plan) {checked.push(plan);await options.check?.(plan);return {verdict:options.verdict??'PASS',check_mode:'lean-project',checked_paths:['input.txt','a.txt','b.txt']};}}};
  const publication=createFlatPublicationServices(publicationOptions);
  const services=new ServiceRegistry();services.registerService(publication.composeTask(discovery));
  for(const row of publication.registrations.filter(row=>row.manifest.id!=='task')) services.registerService(row);
  const allowed=Object.fromEntries(publication.registrations.map(row=>[row.manifest.id,row.manifest.capabilities.map(cap=>cap.operation)]));
  allowed.task.push(...discovery.manifest.capabilities.map(cap=>cap.operation));
  runtime=await createRuntime({backend:{},profiles:{researcher:{prompt:'Merge fixed public inputs',model:'default',image:'fixture',writable:false,services:allowed}},services,maxBots:2,outputDir:root});
  t.after(async()=>{publication.close();await discovery.close();await runtime.close({timeoutMs:1000});await publication.waitForMerges?.({timeoutMs:1000});stores.close();await rm(root,{recursive:true,force:true});});
  const cli=async(bot,...args)=>{
    const credentials=controls.credentials.get(bot.id);assert.ok(credentials);
    const env={...process.env,...credentials.environment,...credentials.secretEnvironment};
    const url=new URL(env.SWARMENV_BRIDGE_URL);url.hostname='127.0.0.1';env.SWARMENV_BRIDGE_URL=url.href.replace(/\/$/,'');
    const {stdout}=await execute(process.execPath,[new URL('../scripts/swarm.mjs',import.meta.url).pathname,...args],{env,timeout:15000});return JSON.parse(stdout);
  };
  const bots=[];
  for(let i=0;i<2;i++) {
    const task=i===0?stores.task:stores.tasks.createTask({mission_id:stores.missionId,gap:'Second independent contribution',priority:'medium',summary:'Second file',expected_output:'File',acceptance_conditions:['Fixed artifact'],workspace:{workspace_id:stores.workspaceId,revision:'0.1'}},makeEnvelope({actorRef:'host'})).task;
    const bot=await runtime.spawn({profile:'researcher',requestId:`contributor-${i}`});bots.push(bot);
    stores.tasks.registerBot({botId:bot.id,missionId:stores.missionId,legacySlotId:`flat-slot:${i}`,selectionDeadline:new Date(Date.now()+60000).toISOString()});stores.tasks.markCoreBotReady(bot.id);
    await cli(bot,'task','take',task.task_id,'--request-id',`take-${i}`);
  }
  // The host supplies immutable public contributions. No live Core snapshot is installed.
  const revisions=[];
  for(let i=0;i<2;i++) {
    const execution=stores.tasks.getExecution(stores.tasks.getBot(bots[i].id).execution_id);
    revisions.push(await stores.workspace.save({workspaceId:stores.workspaceId,baseRevision:'0.1',files:{'input.txt':'fixed λ\n',[i?'b.txt':'a.txt']:i?'second contribution\n':'first contribution\n'},requestId:`published-${i}`,
      source:{operation:'save',mission_id:stores.missionId,task_id:execution.task_id,execution_id:execution.execution_id,bot_id:bots[i].id,fencing_version:execution.fencing_version}}));
  }
  return {...stores,publication,publicationOptions,runtime,bots,revisions,checked,cli:(...args)=>cli(bots[0],...args),cliFor:cli};
}

test('Core Bridge CLI checked merge integrates two fixed public contributors and replays its original result',async t=>{
  const f=await fixture(t);
  const first=await f.cli('workspace','merge','--from',f.revisions[0].revision,'--request-id','merge-a');
  const second=await f.cliFor(f.bots[1],'workspace','merge','--from',f.revisions[1].revision,'--request-id','merge-a');
  assert.equal(first.check.verdict,'PASS');assert.equal(second.check.verdict,'PASS');
  const exported=await f.workspace.exportRevision({workspaceId:f.workspaceId,revision:'main'});
  assert.equal(Buffer.from(exported.files['a.txt']).toString(),'first contribution\n');
  assert.equal(Buffer.from(exported.files['b.txt']).toString(),'second contribution\n');
  assert.deepEqual(Object.keys(f.checked[1].files).sort(),['a.txt','b.txt','input.txt']);
  assert.equal(second.check.checked_tree,exported.git_tree);
  const provenance=f.workspace.readDeliveryRevision({workspaceId:f.workspaceId,missionId:f.missionId,revision:second.main_revision});
  assert.equal(provenance.source.bot_id,f.bots[1].id);
  assert.equal(provenance.source.execution_id,f.tasks.getBot(f.bots[1].id).execution_id);
  assert.deepEqual(await f.cli('workspace','merge','--from',f.revisions[0].revision,'--request-id','merge-a'),first);
  assert.equal(f.checked.length,2);
  await assert.rejects(f.cli('workspace','merge','--from',f.revisions[1].revision,'--request-id','merge-a'),error=>/CONFLICT/.test(error.stderr));
  const execution=f.tasks.getExecution(f.tasks.getBot(f.bots[0].id).execution_id);
  f.tasks.dispatch('fence_execution',{reason:'Fence cached result'},makeEnvelope({actorRef:'host',taskId:execution.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version}));
  await assert.rejects(f.cli('workspace','merge','--from',f.revisions[0].revision,'--request-id','merge-a'));
});

for(const closing of ['Flat close','Core stop']) test(`checked merge retains pending cleanup and cannot publish after ${closing}`,async t=>{
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  let checkerSignal;
  const f=await fixture(t,{async check(plan) {checkerSignal=plan.signal;entered.resolve();await release.promise;}});
  const request=f.cli('workspace','merge','--from',f.revisions[0].revision,'--request-id','held-merge').then(()=>({ok:true}),error=>({error}));
  await entered.promise;
  try {
    if(closing==='Flat close') f.publication.close();else await f.runtime.stop(f.bots[0].id,{timeoutMs:1000});
    if(closing==='Flat close') assert.equal(checkerSignal.aborted,true);
    if(closing==='Core stop') assert.throws(()=>f.checked[0].startProcess(()=>assert.fail('revoked caller cannot start checker work')),{code:'NOT_ALLOWED'});
    const pending=await f.publication.waitForMerges({timeoutMs:10});
    assert.equal(pending.cleanup,'pending');assert.equal(pending.pending_checks,1);
    assert.equal((await f.workspace.get({workspaceId:f.workspaceId})).main_revision,'0.1');
  } finally {release.resolve();await request;}
  assert.equal((await f.publication.waitForMerges({timeoutMs:1000})).cleanup,'complete');
  assert.equal((await f.workspace.get({workspaceId:f.workspaceId})).main_revision,'0.1');
});

test('cached merge and concurrent duplicate replay require the same current Execution authority',async t=>{
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const f=await fixture(t,{async check(){entered.resolve();await release.promise;}});
  const attempt=()=>f.cli('workspace','merge','--from',f.revisions[0].revision,'--request-id','duplicate');
  const first=attempt().then(value=>({value}),error=>({error}));await entered.promise;
  const joined=attempt().then(value=>({value}),error=>({error}));
  // Wait for duplicate HTTP admission while the checker remains held.
  await new Promise(resolve=>setTimeout(resolve,150));
  const execution=f.tasks.getExecution(f.tasks.getBot(f.bots[0].id).execution_id);
  f.tasks.dispatch('fence_execution',{reason:'Owner revoked'},makeEnvelope({actorRef:'host',taskId:execution.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version}));
  release.resolve();
  const results=await Promise.all([first,joined]);assert.ok(results.every(result=>result.error));assert.equal(f.checked.length,1);
  assert.equal((await f.workspace.get({workspaceId:f.workspaceId})).main_revision,'0.1');
  await assert.rejects(attempt());
});

for(const change of ['MAIN_MOVED','freeze','failed check']) test(`checked merge preserves existing ${change} publication guard`,async t=>{
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const f=await fixture(t,{verdict:change==='failed check'?'FAIL':'PASS',async check(){entered.resolve();await release.promise;}});
  const attempt=f.cli('workspace','merge','--from',f.revisions[0].revision,'--request-id','publication-race').then(()=>({ok:true}),error=>({error}));
  await entered.promise;
  let expected='0.1';
  try {
    if(change==='MAIN_MOVED') expected=(await f.workspace.merge({workspaceId:f.workspaceId,fromRevision:f.revisions[1].revision,requestId:'external-integrator'})).main_revision;
    if(change==='freeze') await f.workspace.freeze({workspaceId:f.workspaceId,submissionId:'fixed-submit'});
  } finally {release.resolve();}
  const outcome=await attempt;assert.ok(outcome.error);
  assert.match(outcome.error.stderr,change==='MAIN_MOVED'?/MAIN_MOVED/:change==='freeze'?/MISSION_SUBMITTING/:/final Workspace tree check failed/);
  assert.equal((await f.workspace.get({workspaceId:f.workspaceId})).main_revision,expected);
});

test('checked merge is explicitly opted in and source arguments cannot select mutable or private input',async t=>{
  const disabled=await fixture(t,{disabled:true});
  await assert.rejects(disabled.cli('workspace','merge','--from',disabled.revisions[0].revision),error=>/NOT_ALLOWED/.test(error.stderr));
  const f=await fixture(t);
  for(const args of [['--from','main'],['--from',f.revisions[0].revision,'--workspace-id','foreign'],['--from',f.revisions[0].revision,'--files','{}']])
    await assert.rejects(f.cli('workspace','merge',...args));
  assert.equal(f.checked.length,0);
});


test('a timed-out checker retains ownership and cannot publish a late PASS',async t=>{
  const release=Promise.withResolvers();
  const f=await fixture(t,{timeoutMs:20,async check(){await release.promise;}});
  try {
    await assert.rejects(f.cli('workspace','merge','--from',f.revisions[0].revision,'--request-id','timeout'),error=>/SERVICE_TIMEOUT/.test(error.stderr));
    assert.equal(f.publication.mergeStatus().cleanup,'pending');
    assert.equal(f.publication.mergeStatus().pending_checks,1);
    f.publication.close();
    assert.equal((await f.publication.waitForMerges({timeoutMs:10})).cleanup,'pending');
  } finally {release.resolve();}
  assert.equal((await f.publication.waitForMerges({timeoutMs:1000})).cleanup,'complete');
  assert.equal((await f.workspace.get({workspaceId:f.workspaceId})).main_revision,'0.1');
});


for(const authority of ['Execution fence','Bridge revoke','Flat close']) test(`durable replay cannot return an old PASS after ${authority} during repository lock wait`,async t=>{
  const f=await fixture(t);
  const requestId='durable-replay';
  const published=await f.cli('workspace','merge','--from',f.revisions[0].revision,'--request-id',requestId);
  assert.equal(published.check.verdict,'PASS');
  // Recompose the public adapter without its process-local request cache. The
  // same actual Runtime/Execution and Git receipt remain the replay authority.
  const publication=createFlatPublicationServices(f.publicationOptions);
  t.after(async()=>{publication.close();await publication.waitForMerges({timeoutMs:1000});});
  const registry=new ServiceRegistry();
  registry.registerService(publication.registrations.find(row=>row.manifest.id==='workspace'));
  const registered=snapshotServiceRegistry(registry).get('workspace');
  const held=Promise.withResolvers(),locked=Promise.withResolvers(),entered=Promise.withResolvers();
  const lock=f.workspace.repository.locked(f.workspace.workspacePath(f.workspaceId),async()=>{locked.resolve();await held.promise;});
  await locked.promise;
  // Observe the actual public merge call entering the held Git resource; do
  // not replace its persistence/replay behavior.
  const merge=f.workspace.merge.bind(f.workspace);
  f.workspace.merge=options=>{const work=merge(options);entered.resolve();return work;};
  let revoked=false;
  const attempt=invokeService(registered,{operation:'workspace_merge',input:{from:f.revisions[0].revision},envelope:{operation_id:requestId},
    caller:{runtimeId:f.runtime.id,botId:f.bots[0].id,profile:'researcher'},
    assertAuthorized(){if(revoked) throw new SwarmEnvError('NOT_ALLOWED','Caller revoked');},
  }).then(value=>({value}),error=>({error}));
  await entered.promise;
  if(authority==='Execution fence') {
    const execution=f.tasks.getExecution(f.tasks.getBot(f.bots[0].id).execution_id);
    f.tasks.dispatch('fence_execution',{reason:'Revoke while replay waits'},makeEnvelope({actorRef:'host',taskId:execution.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version}));
  } else if(authority==='Bridge revoke') revoked=true; else publication.close();
  held.resolve();await lock;
  const result=await attempt;
  assert.ok(result.error,'revoked durable replay must not return the previously published PASS');
  assert.match(result.error.code,/NOT_ALLOWED|FENCED/);
  assert.equal(f.checked.length,1);
  assert.equal((await f.workspace.get({workspaceId:f.workspaceId})).main_revision,published.main_revision);
});

test('fresh checker failure keeps its original cause when authority is also withdrawn',async t=>{
  let f;
  f=await fixture(t,{async check(){
    const execution=f.tasks.getExecution(f.tasks.getBot(f.bots[0].id).execution_id);
    f.tasks.dispatch('fence_execution',{reason:'Concurrent checker failure'},makeEnvelope({actorRef:'host',taskId:execution.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version}));
    throw new SwarmEnvError('SERVICE_TIMEOUT','Controlled checker timeout');
  }});
  await assert.rejects(f.cli('workspace','merge','--from',f.revisions[0].revision,'--request-id','original-failure'),error=>/SERVICE_TIMEOUT/.test(error.stderr));
  assert.equal((await f.publication.waitForMerges({timeoutMs:1000})).cleanup,'complete');
  assert.equal((await f.workspace.get({workspaceId:f.workspaceId})).main_revision,'0.1');
});
