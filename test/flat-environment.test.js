import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFlatTaskStores } from './fixtures/flat-task-stores.js';
import { registerHooks } from 'node:module';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stableStringify } from '../src/protocol/envelope.js';
import { transport, controls } from './fixtures/flat-controller-backend.js';
const hooks=registerHooks({resolve(specifier,context,next){
  if(specifier==='./pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return {url:new URL('./fixtures/flat-controller-backend.js',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}});
const {runFlatEnvironment}=await import('../src/environments/flat/environment.js');hooks.deregister();

test('flat host refuses unsupported live Workspace binding before creating any Runtime or Bot',async t=>{
  const root=await mkdtemp(join(tmpdir(),'flat-environment-'));
  const stores=await createFlatTaskStores(root);
  t.after(async()=>{stores.close();await rm(root,{recursive:true,force:true});});
  const report=await runFlatEnvironment({...stores,taskService:stores.tasks,contextService:stores.context,missionWorkspace:stores.workspace,workspaceManager:stores.manager,
    outputDir:root,deadlineAt:Date.now()+10000,backend:{},model:'default',image:'fixture'});
  assert.equal(report.businessFailure.code,'SERVICE_NOT_READY');
  assert.equal(report.cleanup,null);
  assert.equal(report.result,null);
  assert.ok(report.reportPath);
  const saved=JSON.parse(await readFile(report.reportPath,'utf8'));
  assert.equal(saved.businessFailure.code,'SERVICE_NOT_READY');
  assert.equal(stores.tasks.listExecutions(stores.task.task_id).length,0);
});


test('flat host composes public Bash publication and controller finish with durable public results after close',async t=>{
  const root=await mkdtemp(join(tmpdir(),'flat-closed-loop-'));
  const stores=await createFlatTaskStores(root);
  t.after(async()=>{stores.close();await rm(root,{recursive:true,force:true});});
  transport.reset();controls.credentials.clear();controls.stopError=null;controls.destroyError=null;
  const accept=id=>{transport.confirm(id,'started');transport.next=accept;};transport.next=accept;
  const files={'input.txt':Buffer.from('fixed λ\n'),'result.txt':Buffer.from('Fixed public result\n')};
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const manifest=Object.fromEntries(Object.entries(files).map(([path,bytes])=>[path,{bytes:bytes.length,content_hash:hash(bytes)}]));
  let materialId,revision,captures=0;
  const report=await runFlatEnvironment({...stores,taskService:stores.tasks,contextService:stores.context,missionWorkspace:stores.workspace,workspaceManager:stores.manager,
    outputDir:root,deadlineAt:Date.now()+10000,backend:{},model:'default',image:'fixture',capacity:1,
    async snapshotProject({executionId,fencingVersion}) {captures++;return {execution_id:executionId,binding_version:fencingVersion,state:'ACTIVE',files:Object.fromEntries(Object.entries(files).map(([path,bytes])=>[path,bytes.toString('base64')])),manifest,content_hash:hash(stableStringify(manifest))};},
    async drive(controller) {
      const bot=controller.snapshot().bots[0];
      const credentials=controls.credentials.get(bot.botId);
      const env={...process.env,...credentials.environment,...credentials.secretEnvironment};
      const bridge=new URL(env.SWARMENV_BRIDGE_URL);bridge.hostname='127.0.0.1';env.SWARMENV_BRIDGE_URL=bridge.href.replace(/\/$/,'');
      const cli=async args=>{const {stdout}=await promisify(execFile)(process.execPath,['scripts/swarm.mjs',...args],{env,timeout:5000});return JSON.parse(stdout);};
      await cli(['task','take',stores.task.task_id,'--request-id','take']);
      const attachment=Buffer.from([0,255,65,10]);
      const seed=await cli(['material','publish','--content','Original observation','--receiving-task-id',stores.task.task_id,
        '--title','t'.repeat(120),'--summary','s'.repeat(500),'--attachments',JSON.stringify([{name:'original.bin',content_base64:attachment.toString('base64')}]),'--request-id','seed']);
      const correctionInput=['material','publish','--content','Corrected observation','--supersedes',seed.material.material_id,
        '--expected-version','0','--supersede-reason','Fixed source correction','--attachments',JSON.stringify([{name:'copied.bin',content_hash:hash(attachment),
          source:{material_id:seed.material.material_id,attachment_name:'original.bin'}}]),'--request-id','correction'];
      const corrected=await cli(correctionInput);
      assert.deepEqual(await cli(correctionInput),corrected);
      const correction=await cli(['material','view',seed.material.material_id]);
      assert.equal(correction.active_successors[0].replacement_material_id,corrected.material.material_id);
      assert.equal(stores.context.getMaterial(corrected.material.material_id,{verifyIntegrity:true}).supersedes,seed.material.material_id);
      assert.deepEqual(corrected.material.attachments,[{name:'copied.bin',media_type:'application/octet-stream',content_hash:hash(attachment),size_bytes:4}]);
      const publicBefore=stores.context.publicChangeToken(stores.missionId);
      const rejectsInput=async args=>assert.rejects(cli(args),error=>JSON.parse(error.stderr).code==='SERVICE_INPUT_INVALID');
      for(const [option,value] of [['--title','t'.repeat(121)],['--summary','s'.repeat(501)],['--producer-task-id','forged'],
        ['--attachments',JSON.stringify(Array.from({length:17},(_,index)=>({name:`a${index}`,content_base64:'QQ=='})))],
        ['--attachments',JSON.stringify([{name:'copy',source:{material_id:seed.material.material_id,attachment_name:'original.bin',bot_id:'forged'},content_hash:hash(attachment)}])]]) {
        await rejectsInput(['material','publish','--content','Invalid publication',option,value,'--request-id',`invalid-${option}`]);
      }
      await assert.rejects(cli(['material','publish','--content','Stale correction','--supersedes',seed.material.material_id,
        '--expected-version','0','--supersede-reason','Stale observed relation','--request-id','stale-correction']),error=>JSON.parse(error.stderr).code==='STALE_VERSION');
      assert.deepEqual(stores.context.publicChangeToken(stores.missionId),publicBefore);
      await rejectsInput(['task','finish','--outcome','blocked','--blocker','invalid-string','--request-id','invalid-finish']);
      assert.equal(stores.tasks.getTask(stores.task.task_id).state,'RUNNING');
      const material=await cli(['material','publish','--content','Fixed public result','--request-id','publish']);materialId=material.material.material_id;
      await cli(['task','link','--task-id',stores.task.task_id,'--material-id',materialId,'--role','experience',
        '--receiving-task-id',stores.task.task_id,'--request-id','link']);
      const save=await cli(['workspace','save','--request-id','save']);revision=save.revision;
      assert.deepEqual(await cli(['workspace','save','--request-id','save']),save);
      assert.equal(captures,1,'Replaying a public CLI save must recover the original capture');
      await assert.rejects(cli(['workspace','save','--files','{}','--request-id','forged-save']),error=>
        JSON.parse(error.stderr).code==='SERVICE_INPUT_INVALID');
      assert.equal(captures,1,'Model-supplied files must fail before trusted capture');
      assert.equal((await stores.workspace.listRevisions({workspaceId:stores.workspaceId})).length,2);
      try {await cli(['task','finish','--outcome','done','--material-ids',JSON.stringify([materialId]),'--request-id','finish']);}
      catch(error) {assert.ok(stores.tasks.listExecutions(stores.task.task_id)[0].finish,'A lost reply must still have a durable accepted finish');}
      await controller.tick();
    },
  });
  assert.equal(report.businessFailure,null);assert.equal(report.cleanupFailure,null);assert.equal(report.cleanup.cleanup,'complete');
  assert.equal(report.result.completion,'all-tasks-terminal');assert.equal(report.result.bots[0].released,true);
  assert.equal(stores.tasks.getTask(stores.task.task_id).state,'DONE');
  assert.equal(stores.context.getMaterial(materialId).content,'Fixed public result');
  assert.equal(Buffer.from((await stores.workspace.exportRevision({workspaceId:stores.workspaceId,revision})).files['result.txt']).toString(),'Fixed public result\n');
  assert.equal(JSON.parse(await readFile(report.reportPath,'utf8')).result.bots[0].lastStop.execution,'stopped');
});
