import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFlatTaskStores } from './fixtures/flat-task-stores.js';
import { createFlatPublicationServices } from '../src/environments/flat/publication-services.js';
import { ServiceRegistry, snapshotServiceRegistry, invokeService } from '../src/core/services.js';
import { createHash } from 'node:crypto';
import { prepareFlatInputs } from '../src/environments/flat/prepare-inputs.js';
import { stableStringify, makeEnvelope } from '../src/protocol/envelope.js';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'flat-publication-'));
  const stores = await createFlatTaskStores(root);
  stores.tasks.contextService = stores.context;
  t.after(async () => { stores.close(); await rm(root, { recursive:true, force:true }); });
  const botId = 'actual-bot';
  stores.tasks.registerBot({ botId, missionId:stores.missionId, legacySlotId:'slot:A', selectionDeadline:new Date(Date.now()+60000).toISOString() });
  stores.tasks.markCoreBotReady(botId);
  let execution = stores.tasks.takeTask(stores.task.task_id, { owner_ref:botId, core_id:'slot:A', take_key:'fixed-take' }).execution;
  await prepareFlatInputs({execution, taskService:stores.tasks, missionWorkspace:stores.workspace, workspaceId:stores.workspaceId, workspaceManager:stores.manager, contextService:stores.context, check() {}});
  execution=stores.tasks.getExecution(execution.execution_id);
  execution = stores.tasks.dispatch('start_execution', { core_id:'slot:A' }, makeEnvelope({ actorRef:botId, taskId:execution.task_id, executionId:execution.execution_id, specVersion:execution.spec_version, stateVersion:execution.state_version, fencingVersion:execution.fencing_version })).execution;
  const runtime = { id:'runtime:flat', async get(id) { assert.equal(id,botId); return {id,profile:'researcher',status:'running'}; } };
  const publication = createFlatPublicationServices({ runtime, taskService:stores.tasks, contextService:stores.context, missionId:stores.missionId, missionWorkspace:stores.workspace, workspaceId:stores.workspaceId, deadline:()=>Date.now()+60000, ...options });
  const registry = new ServiceRegistry();
  for (const registration of publication.registrations) registry.registerService(registration);
  const registrations = snapshotServiceRegistry(registry);
  const call = (service,operation,input={},requestId=operation) => invokeService(registrations.get(service), { operation,input,envelope:{operation_id:requestId}, caller:{runtimeId:runtime.id,botId,profile:'researcher'} });
  return {...stores,root,botId,runtime,publication,call,execution};
}

test('flat Material publication and linked finish preserve actual ownership, public bytes and duplicate identity', async t => {
  const finished=[];
  const f=await fixture(t,{onFinish: row=>finished.push(row)});
  const published=await f.call('context','context_publish_material',{content:'Fixed public result',title:'A verified small result'},'publish');
  assert.equal(f.context.getMaterial(published.material.material_id).content,'Fixed public result');
  assert.equal(published.material.producer_execution_id,f.execution.execution_id);
  assert.deepEqual(await f.call('context','context_publish_material',{content:'Fixed public result',title:'A verified small result'},'publish'),published);
  await assert.rejects(f.call('context','context_publish_material',{content:'Different result'},'publish'),{code:'CONFLICT'});
  await assert.rejects(f.call('task','task_finish',{outcome:'done',material_ids:[published.material.material_id]},'unlinked'),{code:'INVALID_CONTRACT'});
  await f.call('task','task_link_material',{task_id:f.task.task_id,material_id:published.material.material_id,role:'experience'},'link');
  const result=await f.call('task','task_finish',{outcome:'done',material_ids:[published.material.material_id]},'finish');
  assert.equal(result.disposition,'closing');
  assert.equal(f.tasks.getTask(f.task.task_id).state,'RUNNING');
  assert.equal(f.tasks.getExecution(f.execution.execution_id).state,'CLOSING');
  assert.deepEqual(await f.call('task','task_finish',{outcome:'done',material_ids:[published.material.material_id]},'finish'),result);
  assert.equal(finished.length,1);
  await assert.rejects(f.call('context','context_publish_material',{content:'Late write'},'late'),{code:'NOT_ALLOWED'});
});


test('flat Workspace save captures trusted bytes once and keeps immutable revision provenance', async t => {
  let f, captures=0;
  const files={'input.txt':Buffer.from('fixed λ\n'),'result.txt':Buffer.from('Fixed actual guest result\n')};
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const manifest=Object.fromEntries(Object.entries(files).map(([path,bytes])=>[path,{bytes:bytes.length,content_hash:hash(bytes)}]));
  f=await fixture(t,{async snapshotProject({botId,executionId,fencingVersion}) {
    captures++; assert.equal(botId,f.botId);
    return {execution_id:executionId,binding_version:fencingVersion,state:'ACTIVE',files:Object.fromEntries(Object.entries(files).map(([p,b])=>[p,b.toString('base64')])),manifest,content_hash:hash(stableStringify(manifest))};
  }});
  const saved=await f.call('workspace','workspace_save',{},'save');
  assert.notEqual(saved.revision,'0.1');
  const published=await f.workspace.exportRevision({workspaceId:f.workspaceId,revision:saved.revision});
  assert.equal(Buffer.from(published.files['result.txt']).toString(),'Fixed actual guest result\n');
  const provenance=f.workspace.readDeliveryRevision({workspaceId:f.workspaceId,missionId:f.missionId,revision:saved.revision});
  assert.equal(provenance.source.bot_id,f.botId);
  assert.equal(provenance.source.execution_id,f.execution.execution_id);
  assert.equal(provenance.source.fencing_version,f.execution.fencing_version);
  assert.deepEqual(await f.call('workspace','workspace_save',{},'save'),saved);
  assert.equal(captures,1);
  await assert.rejects(f.call('workspace','workspace_save',{files:{'fake.txt':'fake'}},'forged'),{code:'SERVICE_INPUT_INVALID'});
});

test('flat publication explicitly refuses Workspace save without a trusted snapshot binding',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.call('workspace','workspace_save',{},'unbound'),{code:'SERVICE_NOT_READY'});
  assert.equal((await f.workspace.listRevisions({workspaceId:f.workspaceId})).length,1);
});

test('fencing during a trusted capture prevents Workspace publication',async t=>{
  let f;
  f=await fixture(t,{async snapshotProject({executionId}) {
    const execution=f.tasks.getExecution(executionId);
    f.tasks.dispatch('fence_execution',{reason:'Fixed concurrent ownership change'},makeEnvelope({actorRef:'host',taskId:execution.task_id,executionId,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version}));
    return {files:{},manifest:{},content_hash:'invalid'};
  }});
  await assert.rejects(f.call('workspace','workspace_save',{},'stale'),error=>error.code==='WORKSPACE_REQUEST_ABORTED' && error.details.cause_code==='NOT_ALLOWED');
  assert.equal((await f.workspace.listRevisions({workspaceId:f.workspaceId})).length,1);
});

test('malformed trusted snapshot evidence cannot create a public revision',async t=>{
  const f=await fixture(t,{async snapshotProject({executionId,fencingVersion}) {
    return {execution_id:executionId,binding_version:fencingVersion,state:'ACTIVE',files:{'result.txt':Buffer.from('actual').toString('base64')},manifest:{'result.txt':{bytes:6,content_hash:'forged'}},content_hash:'forged'};
  }});
  await assert.rejects(f.call('workspace','workspace_save',{},'invalid'),{code:'INVALID_CONTRACT'});
  assert.equal((await f.workspace.listRevisions({workspaceId:f.workspaceId})).length,1);
});
