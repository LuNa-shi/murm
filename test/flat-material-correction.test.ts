import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
const hooks=registerHooks({resolve(specifier,context,next) {
  if(specifier==='./pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return {url:new URL('./fixtures/flat-controller-backend.js',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}});
const {createRuntime}=await import('@swarmenv/core');hooks.deregister();
const execute=promisify(execFile);
async function fixture(t, { corrections = true, revokeAllowed = true, coordinationPermissions = [], registeredPermissions = coordinationPermissions } = {}) {
  const root=await mkdtemp(join(tmpdir(),'flat-material-'));
  const stores=await createFlatTaskStores(root);
  stores.tasks.contextService=stores.context;
  let runtime;
  const policy={deadlineAt:Date.now()+60000,beforeGet:null};
  const discovery=createFlatTaskService({runtime:()=>runtime,taskService:stores.tasks,contextService:stores.context,missionWorkspace:stores.workspace,workspaceManager:stores.manager,missionId:stores.missionId,workspaceId:stores.workspaceId,missionDeadline:()=>Date.now()+60000});
  const publication=createFlatPublicationServices({runtime:()=>({...runtime,async get(id){const result=await runtime.get(id);await policy.beforeGet?.();return result;}}),taskService:stores.tasks,contextService:stores.context,missionWorkspace:stores.workspace,missionId:stores.missionId,workspaceId:stores.workspaceId,deadline:()=>policy.deadlineAt,coordinationPermissions});
  const services=new ServiceRegistry();services.registerService(publication.composeTask(discovery));
  for(const row of publication.registrations.filter(row=>row.manifest.id!=='task')) services.registerService(row);
  const allowed=Object.fromEntries(publication.registrations.map(row=>[row.manifest.id,row.manifest.capabilities.map(cap=>cap.operation)]));
  allowed.task.push(...discovery.manifest.capabilities.map(cap=>cap.operation));
  if (!corrections) allowed.context = allowed.context.filter(operation => !['material_dispute','material_supersede','material_unsupersede'].includes(operation));
  if (!revokeAllowed) allowed.context=allowed.context.filter(operation=>operation!=='material_unsupersede');
  runtime=await createRuntime({backend:{},profiles:{researcher:{prompt:'Correct public Materials with current Task authority',model:'default',image:'fixture',writable:false,services:allowed}},services,maxBots:2,outputDir:root});
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
    stores.tasks.registerBot({botId:bot.id,missionId:stores.missionId,legacySlotId:`flat-slot:${i}`,coordinationPermissions:registeredPermissions,selectionDeadline:new Date(Date.now()+60000).toISOString()});stores.tasks.markCoreBotReady(bot.id);
    if (i === 0) await cli(bot,'task','take',stores.task.task_id,'--request-id',`take-${i}`);
  }
  return {...stores,root,publication,runtime,bots,policy,cli:(...args)=>cli(bots[0],...args),cliFor:cli};
}


test('Core Bridge Material CLI preserves correction CAS, dispute provenance and revocation replay', async t => {
  const f = await fixture(t);
  const a = (await f.cli('material', 'publish', '--content', 'Original complete account', '--request-id', 'a')).material;
  const b = (await f.cli('material', 'publish', '--content', 'Complete replacement', '--request-id', 'b')).material;
  assert.equal((await f.cli('material', 'view', a.material_id)).material.relation_version, 0);
  const dispute = await f.cli('material', 'dispute', a.material_id, '--claim', 'Boundary case', '--reason', 'Counterexample', '--request-id', 'dispute');
  assert.deepEqual(await f.cli('material', 'dispute', a.material_id, '--claim', 'Boundary case', '--reason', 'Counterexample', '--request-id', 'dispute'), dispute);
  await assert.rejects(f.cli('material','dispute',a.material_id,'--claim','Changed claim','--reason','Counterexample','--request-id','dispute'),error=>/CONFLICT/.test(error.stderr));
  const execution = f.tasks.getExecution(f.tasks.getBot(f.bots[0].id).execution_id);
  assert.equal(dispute.relation.actor_ref, f.bots[0].id);
  assert.equal(dispute.relation.producer_task_id, execution.task_id);
  assert.equal(dispute.relation.producer_execution_id, execution.execution_id);
  const supersede = () => f.cli('material', 'supersede', a.material_id, '--with', b.material_id, '--expected-version', '0', '--reason', 'Complete correction', '--request-id', 'supersede');
  const replacement = await supersede();
  assert.equal(replacement.material.relation_version, 1);
  assert.deepEqual(await supersede(), replacement);
  await assert.rejects(f.cli('material', 'supersede', a.material_id, '--with', b.material_id, '--expected-version', '0', '--reason', 'Stale observation', '--request-id', 'stale'), error => /STALE_VERSION/.test(error.stderr));
  const revoke = () => f.cli('material', 'unsupersede', a.material_id, '--with', b.material_id, '--expected-version', '1', '--reason', 'Recheck replacement', '--request-id', 'revoke');
  const reversed = await revoke();
  assert.equal(reversed.relation_version, 2);
  assert.deepEqual(await revoke(), reversed);
  const view = await f.cli('material', 'view', a.material_id);
  assert.equal(view.disputed, true);
  assert.equal(view.active_successors.length, 0);
  assert.equal(view.correction_events.filter(row => row.action === 'revoked').length, 1);
  f.tasks.dispatch('fence_execution', { reason: 'Withdraw writer' }, makeEnvelope({ actorRef: 'host', taskId: execution.task_id, executionId: execution.execution_id, specVersion: execution.spec_version, stateVersion: execution.state_version, fencingVersion: execution.fencing_version }));
  await assert.rejects(revoke(), error => /NOT_ALLOWED|FENCED/.test(error.stderr));
  await assert.rejects(supersede(), error => /NOT_ALLOWED|FENCED/.test(error.stderr));
  await assert.rejects(f.cli('material','dispute',a.material_id,'--claim','Boundary case','--reason','Counterexample','--request-id','dispute'),error=>/NOT_ALLOWED|FENCED/.test(error.stderr));
});


test('Core Bridge Material correction rejects cross-Mission data, forged provenance and unbound revocation', async t => {
  const f = await fixture(t);
  const a = (await f.cli('material', 'publish', '--content', 'Local original', '--request-id', 'a')).material;
  const b = (await f.cli('material', 'publish', '--content', 'Local replacement', '--request-id', 'b')).material;
  f.tasks.createMission({mission_id:'foreign',goal:'Separate Mission'}, makeEnvelope({actorRef:'host'}));
  const task = f.tasks.createTask({mission_id:'foreign',gap:'Independent producer',priority:'medium',summary:'Foreign proof',expected_output:'Note',acceptance_conditions:['Stored']}, makeEnvelope({actorRef:'host'})).task;
  let execution = f.tasks.takeTask(task.task_id,{owner_ref:'foreign-producer',take_key:'foreign'}).execution;
  const foreignEnvelope = () => makeEnvelope({actorRef:'foreign-producer',taskId:task.task_id,executionId:execution.execution_id,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version});
  execution = f.tasks.dispatch('start_execution',{},foreignEnvelope()).execution;
  const foreign = f.context.dispatch('context_publish_material',{content:'Foreign result'},foreignEnvelope()).material;
  for (const [index, origin, replacement] of [[0,a,foreign],[1,foreign,b]]) {
    await assert.rejects(f.cli('material','supersede',origin.material_id,'--with',replacement.material_id,'--expected-version','0','--reason','Invalid scope','--request-id',`cross-${index}`),error=>/NOT_ALLOWED/.test(error.stderr));
  }
  await assert.rejects(f.cli('material','dispute',foreign.material_id,'--claim','Other Mission','--reason','Invalid scope','--request-id','foreign-dispute'),error=>/NOT_ALLOWED/.test(error.stderr));
  const forged = join(f.root,'forged.json');
  await writeFile(forged,JSON.stringify({material_id:a.material_id,claim:'Forged actor',reason:'Invalid identity',actor_ref:f.bots[1].id}));
  await assert.rejects(f.cli('material','dispute','--input',forged,'--request-id','forged'),error=>/CLI_ERROR/.test(error.stderr) && /identity overrides are not allowed/.test(error.stderr));
  await f.cli('material','supersede',a.material_id,'--with',b.material_id,'--expected-version','0','--reason','Local correction','--request-id','replace');
  await assert.rejects(f.cliFor(f.bots[1],'material','unsupersede',a.material_id,'--with',b.material_id,'--expected-version','1','--reason','No coordination grant','--request-id','unbound'),error=>/NOT_ALLOWED/.test(error.stderr));
  assert.equal((await f.cli('material','view',a.material_id)).material.relation_version,1);
  assert.deepEqual(f.tasks.getBot(f.bots[1].id).coordination_permissions,[]);
});


test('registering Material corrections does not grant a Profile access to them', async t => {
  const f = await fixture(t, { corrections: false });
  const material = (await f.cli('material','publish','--content','Allowed publication','--request-id','published')).material;
  await assert.rejects(f.cli('material','dispute',material.material_id,'--claim','Unapproved operation','--reason','No Profile allowlist','--request-id','denied'),error=>/NOT_ALLOWED/.test(error.stderr));
  assert.equal((await f.cli('material','view',material.material_id)).disputed,false);
});


test('explicitly granted UNBOUND Core Context CLI revokes one supersession with original actor history and durable replay',async t=>{
  const f=await fixture(t,{coordinationPermissions:['unsupersede']});
  const a=(await f.cli('material','publish','--content','Original evidence','--request-id','origin')).material;
  const b=(await f.cli('material','publish','--content','Replacement evidence','--request-id','successor')).material;
  await f.cli('material','dispute',a.material_id,'--claim','Boundary remains','--reason','Independent dispute','--request-id','dispute');
  await f.cli('material','supersede',a.material_id,'--with',b.material_id,'--expected-version','0','--reason','Proposed correction','--request-id','supersede');
  const args=['material','unsupersede',a.material_id,'--with',b.material_id,'--expected-version','1','--reason','Correction does not cover the original','--request-id','unbound-revoke'];
  const result=await f.cliFor(f.bots[1],...args);
  assert.equal(result.relation_version,2);
  assert.deepEqual(await f.cliFor(f.bots[1],...args),result);
  const view=await f.cliFor(f.bots[1],'material','view',a.material_id);
  assert.equal(view.disputed,true);assert.equal(view.active_successors.length,0);
  const revoked=view.correction_events.filter(row=>row.action==='revoked');
  assert.equal(revoked.length,1);assert.equal(revoked[0].actor_ref,f.bots[1].id);
  assert.equal(revoked[0].producer_execution_id,null);
  const changed=[...args];changed[changed.indexOf('--reason')+1]='Changed request';
  await assert.rejects(f.cliFor(f.bots[1],...changed),error=>/CONFLICT/.test(error.stderr));
  const c=(await f.cli('material','publish','--content','Newer proposed successor','--request-id','new-successor')).material;
  await f.cli('material','supersede',a.material_id,'--with',c.material_id,'--expected-version','2','--reason','New correction','--request-id','new-relation');
  assert.deepEqual(await f.cliFor(f.bots[1],...args),result);
  const current=await f.cliFor(f.bots[1],'material','view',a.material_id);
  assert.equal(current.material.relation_version,3);
  assert.deepEqual(current.active_successors.map(row=>row.replacement_material_id),[c.material_id]);
  await assert.rejects(f.cliFor(f.bots[1],...args.slice(0,-1),'stale-revoke'),error=>/CONFLICT/.test(error.stderr));
  await assert.rejects(f.cliFor(f.bots[1],'material','unsupersede',a.material_id,'--with',c.material_id,'--expected-version','2','--reason','Stale matching successor','--request-id','stale-current'),error=>/STALE_VERSION/.test(error.stderr));
  const dispatch=f.context.dispatch.bind(f.context);let revocationDispatches=0;
  f.context.dispatch=(operation,...rest)=>{if(operation==='material_unsupersede')revocationDispatches++;return dispatch(operation,...rest);};
  f.tasks.db.prepare('UPDATE bots SET coordination_permissions_json = ? WHERE bot_id = ?').run('[]',f.bots[1].id);
  await assert.rejects(f.cliFor(f.bots[1],...args),error=>/NOT_ALLOWED/.test(error.stderr));
  assert.equal(revocationDispatches,0,'revoked grant must fail before Context durable replay');
});


async function replacementPair(f) {
  const a=(await f.cli('material','publish','--content','Initial account','--request-id','initial')).material;
  const b=(await f.cli('material','publish','--content','Replacement account','--request-id','replacement')).material;
  await f.cli('material','supersede',a.material_id,'--with',b.material_id,'--expected-version','0','--reason','Candidate replacement','--request-id','replace');
  const args=['material','unsupersede',a.material_id,'--with',b.material_id,'--expected-version','1','--reason','Retract replacement','--request-id','revoke'];
  return {a,b,args};
}

test('UNBOUND revocation requires both explicit host policy and persisted grant and grants no other Context write',async t=>{
  for(const options of [{coordinationPermissions:[],registeredPermissions:['unsupersede']},{coordinationPermissions:['unsupersede'],registeredPermissions:[]},{coordinationPermissions:['unsupersede'],revokeAllowed:false}]) {
    const f=await fixture(t,options),{args}=await replacementPair(f);
    await assert.rejects(f.cliFor(f.bots[1],...args),error=>/NOT_ALLOWED/.test(error.stderr));
  }
  const f=await fixture(t,{coordinationPermissions:['unsupersede']}),{a,b}=await replacementPair(f);
  for(const args of [
    ['material','publish','--content','Forbidden unbound publication','--request-id','publish-denied'],
    ['material','consume','--material-ids',JSON.stringify([a.material_id]),'--action','integration','--impact','Forbidden unbound consumption','--request-id','consume-denied'],
    ['material','dispute',a.material_id,'--claim','Unbound write','--reason','Forbidden','--request-id','dispute-denied'],
    ['material','supersede',a.material_id,'--with',b.material_id,'--expected-version','1','--reason','Forbidden','--request-id','supersede-denied'],
  ]) await assert.rejects(f.cliFor(f.bots[1],...args),error=>/NOT_ALLOWED/.test(error.stderr));
  assert.equal((await f.cli('material','view',a.material_id)).material.relation_version,1);
});

test('UNBOUND revocation repeats current grant, stop and deadline admission after Core lookup',async t=>{
  for(const revoke of [f=>f.tasks.db.prepare('UPDATE bots SET coordination_permissions_json = ? WHERE bot_id = ?').run('[]',f.bots[1].id),f=>{f.policy.deadlineAt=Date.now()-1;},f=>f.tasks.requestBotStop(f.bots[1].id,'Host withdrawal')]) {
    const f=await fixture(t,{coordinationPermissions:['unsupersede']}),{args}=await replacementPair(f);
    const entered=Promise.withResolvers(),release=Promise.withResolvers();
    f.policy.beforeGet=async()=>{entered.resolve();await release.promise;};
    const dispatch=f.context.dispatch.bind(f.context);let calls=0;
    f.context.dispatch=(operation,...rest)=>{if(operation==='material_unsupersede')calls++;return dispatch(operation,...rest);};
    const pending=f.cliFor(f.bots[1],...args);await entered.promise;revoke(f);release.resolve();
    await assert.rejects(pending,error=>/NOT_ALLOWED/.test(error.stderr));
    assert.equal(calls,0);
  }
});

test('normal Flat host wires explicit Material coordinator permission without adding a Task operation',async t=>{
  const {runFlatEnvironment}=await import('../src/environments/flat/environment.js');
  for(const coordinationPermissions of [[],['unsupersede']]) {
    const root=await mkdtemp(join(tmpdir(),'flat-material-host-')),stores=await createFlatTaskStores(root);
    t.after(async()=>{stores.close();await rm(root,{recursive:true,force:true});});
    transport.reset();controls.credentials.clear();controls.stopError=null;controls.destroyError=null;
    const accept=id=>{transport.confirm(id,'started');transport.next=accept;};transport.next=accept;
    const report=await runFlatEnvironment({taskService:stores.tasks,contextService:stores.context,missionWorkspace:stores.workspace,workspaceManager:stores.manager,
      missionId:stores.missionId,workspaceId:stores.workspaceId,outputDir:root,deadlineAt:Date.now()+30000,backend:{},model:'default',image:'fixture',capacity:2,
      coordinationPermissions,snapshotProject:async()=>{throw new Error('No capture required');},
      async drive(controller) {
        const bots=controller.snapshot().bots;
        for(const bot of bots) assert.deepEqual(stores.tasks.getBot(bot.botId).coordination_permissions,coordinationPermissions);
        const cli=async(bot,...args)=>{
          const credentials=controls.credentials.get(bot.botId),env={...process.env,...credentials.environment,...credentials.secretEnvironment};
          const url=new URL(env.SWARMENV_BRIDGE_URL);url.hostname='127.0.0.1';env.SWARMENV_BRIDGE_URL=url.href.replace(/\/$/,'');
          return JSON.parse((await execute(process.execPath,[new URL('../scripts/swarm.js',import.meta.url).pathname,...args],{env,timeout:15000})).stdout);
        };
        await cli(bots[0],'task','take',stores.task.task_id,'--request-id','take');
        const f={cli:(...args)=>cli(bots[0],...args)};const {a,args}=await replacementPair(f);
        if(coordinationPermissions.length) assert.equal((await cli(bots[1],...args)).relation_version,2);
        else await assert.rejects(cli(bots[1],...args),error=>/NOT_ALLOWED/.test(error.stderr));
        assert.equal((await cli(bots[1],'material','view',a.material_id)).active_successors.length,coordinationPermissions.length?0:1);
        controller.halt('controlled-host-stop');
      },
    });
    assert.equal(report.cleanup.cleanup,'complete');assert.equal(report.cleanupFailure,null);assert.equal(report.businessFailure.code,'FLAT_BUSINESS_FAILED');
  }
});


test('granted UNBOUND revocation preserves foreign-Mission boundaries and cannot acquire a new Execution during admission',async t=>{
  const f=await fixture(t,{coordinationPermissions:['unsupersede']}),{a,b,args}=await replacementPair(f);
  f.tasks.createMission({mission_id:'foreign',goal:'Foreign evidence'},makeEnvelope({actorRef:'host'}));
  const task=f.tasks.createTask({mission_id:'foreign',gap:'Independent evidence',priority:'medium',summary:'Foreign source',expected_output:'Note',acceptance_conditions:['Stored']},makeEnvelope({actorRef:'host'})).task;
  let foreign=f.tasks.takeTask(task.task_id,{owner_ref:'foreign-producer',take_key:'foreign'}).execution;
  const envelope=()=>makeEnvelope({actorRef:'foreign-producer',taskId:task.task_id,executionId:foreign.execution_id,specVersion:foreign.spec_version,stateVersion:foreign.state_version,fencingVersion:foreign.fencing_version});
  foreign=f.tasks.dispatch('start_execution',{},envelope()).execution;
  const material=f.context.dispatch('context_publish_material',{content:'Separate Mission account'},envelope()).material;
  for(const [origin,replacement] of [[a,material],[material,b]]) {
    await assert.rejects(f.cliFor(f.bots[1],'material','unsupersede',origin.material_id,'--with',replacement.material_id,'--expected-version','1','--reason','Invalid scope','--request-id',`foreign-${origin.material_id}`),error=>/NOT_ALLOWED/.test(error.stderr));
  }
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  f.policy.beforeGet=async()=>{entered.resolve();await release.promise;};
  const dispatch=f.context.dispatch.bind(f.context);let calls=0;
  f.context.dispatch=(operation,...rest)=>{if(operation==='material_unsupersede')calls++;return dispatch(operation,...rest);};
  const pending=f.cliFor(f.bots[1],...args);await entered.promise;
  const next=f.tasks.createTask({mission_id:f.missionId,gap:'Bind another responsibility',priority:'medium',summary:'Other work',expected_output:'Note',acceptance_conditions:['Stored']},makeEnvelope({actorRef:'host'})).task;
  try { await f.cliFor(f.bots[1],'task','take',next.task_id,'--request-id','new-binding'); }
  finally { release.resolve(); }
  await assert.rejects(pending,error=>/FENCED/.test(error.stderr));
  assert.equal(calls,0);
});
