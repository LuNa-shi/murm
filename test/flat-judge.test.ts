import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createFlatTaskStores } from './fixtures/flat-task-stores.js';
import { controls, transport } from './fixtures/flat-controller-backend.js';
import { createFlatTaskService } from '../src/environments/flat/task-service.js';
import { createFlatPublicationServices } from '../src/environments/flat/publication-services.js';
import { ServiceRegistry } from '../src/core/services.js';
import { makeEnvelope } from '../src/protocol/envelope.js';
import { JudgeService } from '../src/judge/judge-service.js';
const hooks=registerHooks({resolve(specifier,context,next) {
  if(specifier==='./pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return {url:new URL('./fixtures/flat-controller-backend.js',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}});
const {createRuntime}=await import('../src/core/index.js');hooks.deregister();
const {runFlatEnvironment}=await import('../src/environments/flat/environment.js');
const execute=promisify(execFile);

async function fixture(t,options={}) {
  const root=await mkdtemp(join(tmpdir(),'flat-judge-'));
  const stores=await createFlatTaskStores(root);
  const checked=[];
  const judge=new JudgeService(':memory:',{taskService:stores.tasks,missionBudget:options.missionBudget,
    fixtureManifest:{fixture_id:'public-source',putnambench_commit:'a'.repeat(40),problem_file:'input.txt',problem_file_hash:'b'.repeat(64),lean_toolchain:'leanprover/lean4:v4.33.1',mathlib_version:'test',checker_ref:'lean',checker_version:'test',environment_ref:'test'},
    checker:{preflight:async()=>({status:'healthy',checker_process_status:'completed',evidence:{input_binding_verified:true,toolchain_version_verified:true,checker_version_verified:true}}),
      check:async input=>{checked.push(input);return {verdict:'PASS',evidence:{checker_started:true,exit_code:0,diagnostic:'Fixed public input checked',private_internal_field:'private checker stream'}};}}});
  let runtime,deadlineAt=Date.now()+60000;
  stores.tasks.contextService=stores.context;
  const discovery=createFlatTaskService({runtime:()=>runtime,taskService:stores.tasks,contextService:stores.context,missionWorkspace:stores.workspace,workspaceManager:stores.manager,missionId:stores.missionId,workspaceId:stores.workspaceId,missionDeadline:()=>deadlineAt});
  const publication=createFlatPublicationServices({runtime:()=>runtime,taskService:stores.tasks,contextService:stores.context,missionWorkspace:stores.workspace,missionId:stores.missionId,workspaceId:stores.workspaceId,deadline:()=>deadlineAt,judgeService:judge});
  const services=new ServiceRegistry();services.registerService(publication.composeTask(discovery));
  for(const row of publication.registrations.filter(row=>row.manifest.id!=='task')) services.registerService(row);
  const allowed=Object.fromEntries(publication.registrations.map(row=>[row.manifest.id,row.manifest.capabilities.map(cap=>cap.operation)]));
  allowed.task.push(...discovery.manifest.capabilities.map(cap=>cap.operation));
  runtime=await createRuntime({backend:{},profiles:{researcher:{prompt:'Check a fixed public revision',model:'default',image:'fixture',writable:false,services:allowed}},services,maxBots:1,outputDir:root});
  t.after(async()=>{publication.close();await discovery.close();await runtime.close({timeoutMs:1000});await judge.waitForIdle();judge.close();stores.close();await rm(root,{recursive:true,force:true});});
  const bot=await runtime.spawn({profile:'researcher',requestId:'fixed-checker'});
  stores.tasks.registerBot({botId:bot.id,missionId:stores.missionId,legacySlotId:'flat-slot:checker',selectionDeadline:new Date(Date.now()+60000).toISOString()});
  stores.tasks.markCoreBotReady(bot.id);
  const cli=async(...args)=>{
    const credentials=controls.credentials.get(bot.id);assert.ok(credentials);
    const env={...process.env,...credentials.environment,...credentials.secretEnvironment};
    const url=new URL(env.SWARMENV_BRIDGE_URL);url.hostname='127.0.0.1';env.SWARMENV_BRIDGE_URL=url.href.replace(/\/$/,'');
    const {stdout}=await execute(process.execPath,[new URL('../scripts/swarm.js',import.meta.url).pathname,...args],{env,timeout:15000});return JSON.parse(stdout);
  };
  await cli('task','take',stores.task.task_id,'--request-id','fixed-take');
  return {...stores,judge,checked,cli,bot,runtime,publication,expireMission:()=>{deadlineAt=Date.now()-1;}};
}

test('Core CLI checks an immutable public file through the configured Judge without live capture',async t=>{
  const f=await fixture(t);
  const result=await f.cli('judge','check','--revision','0.1','--path','input.txt','--request-id','fixed-check');
  assert.equal(result.verdict,'PASS');assert.equal(result.target_task_id,f.task.task_id);
  assert.equal(f.checked.length,1);assert.equal(f.checked[0].workspace_source.content,'fixed λ\n');
  assert.equal(result.workspace_input.workspace_id,f.workspaceId);assert.equal(result.workspace_input.revision,'0.1');
  assert.doesNotMatch(JSON.stringify(result),/private checker stream/);
  assert.deepEqual(await f.cli('judge','check','--revision','0.1','--path','input.txt','--request-id','fixed-check'),result);
  assert.deepEqual(await f.cli('judge','result','--request-key','fixed-check'),result);
  assert.deepEqual(await f.cli('judge','result','--check-result-id',result.check_result_id),result);
  await assert.rejects(f.cli('judge','check','--revision','0.1','--path','input.txt','--request-id','fixed-check','--workspace-id','foreign-workspace'),error=>/CONFLICT/.test(error.stderr));
  assert.equal(f.checked.length,1);
  assert.equal(f.judge.getMissionCheckBudget(f.missionId).admitted_requests,1);
});

test('Judge request aliases preserve the exact containing Workspace tree',async t=>{
  const f=await fixture(t);
  const checked=await f.cli('judge','check','--revision','0.1','--path','input.txt','--request-id','first-tree');
  const later=await f.workspace.save({workspaceId:f.workspaceId,baseRevision:'0.1',requestId:'second-tree',
    files:{'input.txt':'fixed λ\n','sibling.txt':'changed surrounding tree\n'}});
  const args=['judge','check','--revision',later.revision,'--path','input.txt'];
  const second=await f.cli(...args,'--request-id','second-check');
  assert.equal(second.workspace_input.git_tree,later.git_tree);
  assert.equal(second.workspace_input.content_hash,checked.workspace_input.content_hash);
  assert.notEqual(second.check_result_id,checked.check_result_id);
  assert.notEqual(second.workspace_input.git_tree,checked.workspace_input.git_tree);
  const alias=await f.cli(...args,'--request-id','alias-check');
  const explicit=await f.cli(...args,'--request-id','explicit-check','--request-key','explicit-judge-alias');
  assert.equal(alias.check_result_id,second.check_result_id);
  assert.equal(explicit.check_result_id,second.check_result_id);
  assert.deepEqual(await f.cli('judge','result','--request-key','alias-check'),second);
  assert.deepEqual(await f.cli('judge','result','--request-key','explicit-judge-alias'),second);
  await assert.rejects(f.cli('judge','check','--revision','0.1','--path','input.txt',
    '--request-id','explicit-conflict','--request-key','explicit-judge-alias'),error=>/CONFLICT/.test(error.stderr));
  assert.equal(f.checked.length,2);
});

for(const change of ['fence','deadline']) test(`Judge never starts if ${change} changes during immutable export`,async t=>{
  const f=await fixture(t);
  const original=f.workspace.exportRevision.bind(f.workspace);
  f.workspace.exportRevision=async input=>{
    const snapshot=await original(input);
    const bot=f.tasks.getBot(f.bot.id),execution=f.tasks.getExecution(bot.execution_id);
    if(change==='fence') f.tasks.dispatch('fence_execution',{reason:'concurrent ownership change'},makeEnvelope({actorRef:'host',taskId:execution.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version}));
    if(change==='deadline') f.expireMission();
    return snapshot;
  };
  await assert.rejects(f.cli('judge','check','--revision','0.1','--path','input.txt'),error=>/NOT_ALLOWED|FENCED/.test(error.stderr));
  assert.equal(f.checked.length,0);assert.equal(f.judge.getMissionCheckBudget(f.missionId).admitted_requests,0);
});

test('Judge source inputs cannot choose another Workspace, mutable main or escaping paths',async t=>{
  const f=await fixture(t);
  for(const args of [
    ['--revision','0.1','--path','input.txt','--workspace-id','other'],
    ['--revision','main','--path','input.txt'],
    ['--revision','0.1','--path','../input.txt'],
    ['--revision','0.1','--path','missing.txt'],
  ]) await assert.rejects(f.cli('judge','check',...args));
  assert.equal(f.checked.length,0);
});

test('Judge CLI refuses a result whose target Task belongs to another Mission',async t=>{
  const f=await fixture(t),host=()=>makeEnvelope({actorRef:'host'});
  f.tasks.createMission({mission_id:'other-mission',goal:'Foreign result'},host());
  const task=f.tasks.createTask({mission_id:'other-mission',gap:'Foreign fixed input',priority:'medium',summary:'Foreign',expected_output:'Result',acceptance_conditions:['Fixed result']},host()).task;
  let execution=f.tasks.takeTask(task.task_id,{owner_ref:'foreign-owner',take_key:'foreign'}).execution;
  const envelope=()=>makeEnvelope({actorRef:'foreign-owner',taskId:task.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version});
  execution=f.tasks.dispatch('start_execution',{},envelope()).execution;
  const foreign=await f.judge.checkWorkspaceSource({source:{content:'Foreign input'},request_key:'foreign-check'},envelope());
  assert.equal(foreign.verdict,'PASS');
  await assert.rejects(f.cli('judge','result','--check-result-id',foreign.check_result_id),error=>/NOT_ALLOWED/.test(error.stderr));
  await assert.rejects(f.cli('judge','result','--request-key','foreign-check'),error=>/NOT_ALLOWED/.test(error.stderr));
});

test('a cached Judge request cannot bypass a later Execution fence',async t=>{
  const f=await fixture(t);
  await f.cli('judge','check','--revision','0.1','--path','input.txt','--request-id','before-fence');
  const execution=f.tasks.getExecution(f.tasks.getBot(f.bot.id).execution_id);
  f.tasks.dispatch('fence_execution',{reason:'ownership withdrawn'},makeEnvelope({actorRef:'host',taskId:execution.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version}));
  await assert.rejects(f.cli('judge','check','--revision','0.1','--path','input.txt','--request-id','before-fence'),error=>/NOT_ALLOWED|FENCED/.test(error.stderr));
  assert.equal(f.checked.length,1);
});

test('Judge result lookup preserves the existing absent-result response',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await f.cli('judge','result','--check-result-id','absent-result'),{ok:true,result:null});
  assert.deepEqual(await f.cli('judge','result','--request-key','absent-key'),{ok:true,result:null});
});

test('Judge result lookup rechecks Mission deadline before falling back to an explicit key',async t=>{
  const f=await fixture(t);
  const dispatch=f.judge.dispatch.bind(f.judge);
  let lookups=0;
  f.judge.dispatch=async (operation,...args)=>{
    const result=await dispatch(operation,...args);
    if(operation==='get_check_result' && ++lookups===1) {
      assert.equal(result,null);
      f.expireMission();
    }
    return result;
  };
  await assert.rejects(f.cli('judge','result','--request-key','expired-key'),error=>/NOT_ALLOWED/.test(error.stderr));
  assert.equal(lookups,1);
});

for(const closing of ['Flat close','Core revoke']) test(`a held Judge preflight cannot launch source after ${closing}`,async t=>{
  const f=await fixture(t);
  const entered=Promise.withResolvers(),held=Promise.withResolvers();
  const healthy={status:'healthy',checker_process_status:'completed',evidence:{input_binding_verified:true,toolchain_version_verified:true,checker_version_verified:true}};
  f.judge.checker.preflight=async ({startProcess})=>startProcess(async()=>{entered.resolve();await held.promise;return healthy;});
  const checked=f.cli('judge','check','--revision','0.1','--path','input.txt','--request-id','held-check');
  const outcome=checked.then(result=>({result}),error=>({error}));
  await entered.promise;
  if(closing==='Flat close') f.publication.close();
  else await f.runtime.stop(f.bot.id,{timeoutMs:1000});
  held.resolve();
  await outcome;
  assert.equal(f.checked.length,0,'No source checker may start after authority is withdrawn');
});


test('Flat reports bounded pending Judge work and never closes the shared provider',async t=>{
  const f=await fixture(t);
  const entered=Promise.withResolvers(),held=Promise.withResolvers();
  f.judge.checker.check=async input=>input.startProcess(async()=>{
    if(input.workspace_source.content==='fixed λ\n') {entered.resolve();await held.promise;}
    return {verdict:'PASS',evidence:{checker_started:true,exit_code:0}};
  });
  const own=f.cli('judge','check','--revision','0.1','--path','input.txt','--request-id','owned-source').catch(error=>error);
  await entered.promise;
  try {
    const receipt=f.publication.close();
    assert.equal(receipt.cleanup,'pending');assert.equal(receipt.pending.length,1);
    assert.equal(receipt.pending[0].requestId,'owned-source');assert.equal(receipt.pending[0].botId,f.bot.id);
    const bounded=await f.publication.waitForJudges({timeoutMs:10});
    assert.equal(bounded.cleanup,'pending');assert.equal(bounded.pending[0].requestId,'owned-source');
    const execution=f.tasks.getExecution(f.tasks.getBot(f.bot.id).execution_id);
    const envelope=makeEnvelope({actorRef:f.bot.id,taskId:execution.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version});
    const other=await f.judge.dispatch('workspace_check',{source:{content:'Unrelated provider work'},request_key:'unrelated-provider'},envelope);
    assert.equal(other.verdict,'PASS','Closing Flat must leave unrelated shared Judge work usable');
  } finally {held.resolve();await own;}
  assert.deepEqual(await f.publication.waitForJudges({timeoutMs:1000}),{cleanup:'complete',pending:[]});
});


test('Environment saves owned pending Judge identities when an already started source exceeds close wait',async t=>{
  const root=await mkdtemp(join(tmpdir(),'flat-judge-report-'));
  const stores=await createFlatTaskStores(root);
  const entered=Promise.withResolvers(),held=Promise.withResolvers();
  const judge=new JudgeService(':memory:',{taskService:stores.tasks,
    fixtureManifest:{fixture_id:'public-source',putnambench_commit:'a'.repeat(40),problem_file:'input.txt',problem_file_hash:'b'.repeat(64),lean_toolchain:'leanprover/lean4:v4.33.1',mathlib_version:'test',checker_ref:'lean',checker_version:'test',environment_ref:'test'},
    checker:{preflight:async()=>({status:'healthy',checker_process_status:'completed',evidence:{input_binding_verified:true,toolchain_version_verified:true,checker_version_verified:true}}),
      check:async ({startProcess})=>startProcess(async()=>{entered.resolve();await held.promise;return {verdict:'PASS',evidence:{checker_started:true,exit_code:0}};})}});
  t.after(async()=>{held.resolve();await judge.waitForIdle();judge.close();stores.close();await rm(root,{recursive:true,force:true});});
  transport.reset();const accept=id=>{transport.confirm(id,'started');transport.next=accept;};transport.next=accept;
  let checking;
  try {
    const report=await runFlatEnvironment({backend:{},model:'default',image:'fixture',capacity:1,outputDir:root,
      taskService:stores.tasks,contextService:stores.context,missionWorkspace:stores.workspace,workspaceManager:stores.manager,missionId:stores.missionId,workspaceId:stores.workspaceId,
      deadlineAt:Date.now()+60000,closeTimeoutMs:1000,judgeService:judge,snapshotProject(){throw new Error('No live capture belongs in this test');},
      async drive(controller) {
        const botId=controller.snapshot().bots[0].botId,credentials=controls.credentials.get(botId);
        const env={...process.env,...credentials.environment,...credentials.secretEnvironment};
        const url=new URL(env.SWARMENV_BRIDGE_URL);url.hostname='127.0.0.1';env.SWARMENV_BRIDGE_URL=url.href.replace(/\/$/,'');
        const cli=(...args)=>execute(process.execPath,[new URL('../scripts/swarm.js',import.meta.url).pathname,...args],{env,timeout:15000});
        await cli('task','take',stores.task.task_id,'--request-id','report-take');
        checking=cli('judge','check','--revision','0.1','--path','input.txt','--request-id','report-held-source').catch(error=>error);
        await entered.promise;controller.halt('host-stop');
      }});
    assert.equal(report.cleanup.cleanup,'complete','Core cleanup is independent of the caller-owned Judge');
    const domain=report.result??report.businessFailure.details[0];
    assert.equal(domain.judge.cleanup,'pending');
    assert.equal(domain.judge.pending[0].requestId,'report-held-source');
    assert.ok(['FLAT_JUDGE_CLEANUP_PENDING','CLOSE_WAIT_TIMEOUT'].includes(report.cleanupFailure.code));
    held.resolve();await checking;await judge.waitForIdle();
    assert.equal(domain.judge.cleanup,'pending','Later checker completion cannot rewrite the saved report projection');
  } finally {held.resolve();await checking;transport.reset();}
});

test('closing a queued Flat request releases only its reservation and leaves unrelated Judge work running',async t=>{
  const f=await fixture(t,{missionBudget:{maxConcurrent:1,maxQueued:2,queueWaitMs:10000}});
  const entered=Promise.withResolvers(),held=Promise.withResolvers();let sourceStarts=0;
  f.judge.checker.check=async input=>input.startProcess(async()=>{
    sourceStarts++;
    if(input.workspace_source.content==='Unrelated held slot') {entered.resolve();await held.promise;}
    return {verdict:'PASS',evidence:{checker_started:true,exit_code:0}};
  });
  const execution=f.tasks.getExecution(f.tasks.getBot(f.bot.id).execution_id);
  const envelope=makeEnvelope({actorRef:f.bot.id,taskId:execution.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version});
  const other=f.judge.dispatch('workspace_check',{source:{content:'Unrelated held slot'},request_key:'held-unrelated'},envelope);
  await entered.promise;
  const own=f.cli('judge','check','--revision','0.1','--path','input.txt','--request-id','queued-owned').catch(error=>error);
  try {
    for(let i=0;f.judge.getMissionCheckBudget(f.missionId).queued_requests!==1;i++) {assert.ok(i<500);await new Promise(resolve=>setTimeout(resolve,10));}
    f.publication.close();
    assert.deepEqual(await f.publication.waitForJudges({timeoutMs:2000}),{cleanup:'complete',pending:[]});
    await own;
    assert.equal(sourceStarts,1);assert.equal(f.judge.getMissionCheckBudget(f.missionId).active_requests,1);
  } finally {held.resolve();await other;await own;}
});

for(const verdict of ['PASS','FAIL']) test(`identical concurrent Judge replay preserves owned work and final ${verdict} identity`,async t=>{
  const f=await fixture(t);
  const entered=Promise.withResolvers(),held=Promise.withResolvers();let starts=0;
  f.judge.checker.check=async input=>input.startProcess(async()=>{
    starts++;entered.resolve();await held.promise;
    return {verdict,evidence:{checker_started:true,exit_code:verdict==='PASS'?0:1}};
  });
  const args=['judge','check','--revision','0.1','--path','input.txt','--request-id','identical-held'];
  const receipt=()=>f.cli(...args).catch(error=>{
    if(verdict==='FAIL' && error.stdout) return JSON.parse(error.stdout);
    throw error;
  });
  const first=receipt().then(result=>({result}),error=>({error}));
  await entered.promise;
  let replaySettled=false;
  const replay=receipt().then(result=>{replaySettled=true;return {result};},error=>{replaySettled=true;return {error};});
  try {
    await Promise.race([replay,new Promise(resolve=>setTimeout(resolve,1000))]);
    assert.equal(replaySettled,false,'Concurrent replay must await the original terminal receipt');
    const pending=f.publication.judgeStatus();
    assert.equal(pending.cleanup,'pending');assert.equal(pending.pending.length,1);
    assert.equal(pending.pending[0].requestId,'identical-held');
    assert.equal(starts,1);
    held.resolve();
    const [a,b]=await Promise.all([first,replay]);
    assert.ifError(a.error);assert.ifError(b.error);
    assert.equal(a.result.verdict,verdict);assert.deepEqual(b.result,a.result);
    assert.deepEqual(await receipt(),a.result,'Authorized later replay keeps durable Judge identity');
    assert.equal(starts,1);
  } finally {held.resolve();await Promise.all([first,replay]);}
});

test('closing during identical Judge replay retains the original active operation',async t=>{
  const f=await fixture(t);
  const entered=Promise.withResolvers(),held=Promise.withResolvers();
  f.judge.checker.check=async input=>input.startProcess(async()=>{
    entered.resolve();await held.promise;return {verdict:'PASS',evidence:{checker_started:true,exit_code:0}};
  });
  const args=['judge','check','--revision','0.1','--path','input.txt','--request-id','close-identical'];
  const first=f.cli(...args).catch(error=>error);
  await entered.promise;
  const replay=f.cli(...args).catch(error=>error);
  try {
    await Promise.race([replay,new Promise(resolve=>setTimeout(resolve,1000))]);
    const receipt=f.publication.close();
    assert.equal(receipt.cleanup,'pending');assert.equal(receipt.pending.length,1);
    assert.equal(receipt.pending[0].requestId,'close-identical');
    assert.equal((await f.publication.waitForJudges({timeoutMs:10})).cleanup,'pending');
  } finally {held.resolve();await Promise.all([first,replay]);}
  assert.deepEqual(await f.publication.waitForJudges({timeoutMs:1000}),{cleanup:'complete',pending:[]});
});
