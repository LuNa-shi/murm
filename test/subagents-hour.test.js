import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { transport } from './fixtures/core-bot-service-backend.js';
import { configuration } from './fixtures/core-input-backend.js';
const hooks=registerHooks({resolve(specifier,context,next){
  if(specifier==='./pi-opensandbox-backend.js'&&context.parentURL?.endsWith('/src/core/index.js'))return {url:new URL('./fixtures/subagents-hour-backend.js',import.meta.url).href,shortCircuit:true};
  if(specifier==='./run-report.mjs'&&context.parentURL?.endsWith('/examples/subagents-environment/hour.mjs'))return {url:new URL('../src/environments/shared/run-report.js',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}});
const {runSubagentsHour}=await import('../examples/subagents-environment/hour.mjs');hooks.deregister();
const hash=value=>createHash('sha256').update(value).digest('hex');

async function setup(t,{changedSession=false,changedArchive=false,lateExit=false}={}) {
  transport.reset();transport.collectable=true;
  const outputDir=await mkdtemp(join(tmpdir(),'subagents-hour-'));t.after(()=>rm(outputDir,{recursive:true,force:true}));
  let tick=0,parentId,stageIndex,closed=false;const deadlineAt=Date.now()+6000000;
  const childIds=[],conclusions=[],files=new Map();let count=0;
  const keep=(id,path,text)=>{if(!files.has(id))files.set(id,new Map());files.get(id).set(path,text);};
  transport.onSpawn=options=>{if(!options.options.parentId)parentId=options.botId;};
  const call=async(operation,payload,operation_id)=>{
    const credentials=transport.spawns.get(parentId).credentials;
    const result=await (await fetch(transport.url+'/call',{method:'POST',headers:{authorization:`Bearer ${credentials.secretEnvironment.SWARMENV_BRIDGE_TOKEN}`},body:JSON.stringify({service_id:'bot',operation,payload,operation_id})})).json();
    assert.equal(result.ok,true,JSON.stringify(result));return result.result;
  };
  function arm(){transport.next=async inputId=>{
    arm();const row=transport.submissions.get(inputId);
    if(row.botId!==parentId){
      const task=JSON.parse(row.input),source=`print(${task.peer+task.stage})\n`,answers=[task.peer+task.stage];
      const output=JSON.stringify({stage:task.stage,child:task.peer,programming:{task:`task-${task.stage}-${task.peer}`,sourceSha256:hash(source),answersSha256:hash(JSON.stringify(answers))}});
      keep(row.botId,`hour-program-${task.stage}.py`,source);keep(row.botId,`hour-program-${task.stage}.stdout.json`,JSON.stringify(answers));keep(row.botId,`hour-results/stage-${task.stage}.json`,output);
      transport.spawns.get(row.botId).onEvent({type:'settled',outcome:'completed',output});
    }else if(row.input.startsWith('Prepare exactly')){
      for(let i=0;i<3;i++){const result=await call('spawn',{profile:'child'},`child-${i}`);assert.equal(result.initialInput,null);childIds.push(result.bot.id);}
      transport.spawns.get(parentId).onEvent({type:'settled',outcome:'completed',output:JSON.stringify({children:childIds})});
    }else if(row.input.startsWith('{"stage"')){
      const task=JSON.parse(row.input);stageIndex=task.stage;count=0;
      // This models natural parent-driven concurrent child admission, with no host semaphore.
      await Promise.all(childIds.map((id,peer)=>call('send',{bot_id:id,input:JSON.stringify({peer,stage:task.stage}),mode:'followUp'},`task-${task.stage}-${peer}`)));
    }else{
      const result=JSON.parse(row.input);count++;conclusions.push({childId:result.childId,eventSeq:result.eventSeq,quote:result.output});
      if(count===3){const output=JSON.stringify({stage:stageIndex,summary:'Use all earlier concrete results.',conclusions});keep(parentId,`hour-results/stage-${stageIndex}.json`,output);transport.spawns.get(parentId).onEvent({type:'settled',outcome:'completed',output});}
    }
  };}arm();
  transport.onCollect=async function*(botId){
    yield {type:'directory',path:'hour-results'};let totalBytes=0;const entries=[...(files.get(botId)??new Map())];
    for(const [path,text]of entries){const bytes=Buffer.from(changedArchive&&path==='hour-program-3.py'?'changed source':text);totalBytes+=bytes.length;yield {type:'file',path,bytes:bytes.length,mode:0o644};yield {type:'chunk',data:bytes.toString('base64')};yield {type:'fileEnd',sha256:hash(bytes)};}
    yield {type:'end',totalBytes,fileCount:entries.length,directoryCount:1};
  };
  return {outputDir,getTick:()=>tick,options:{backend:{...configuration,sandbox:{lifecycleBaseUrl:'http://127.0.0.1:1/v1'}},image:'test',outputDir,clock:()=>tick,waitForMs:async ms=>{tick+=ms;if(lateExit&&tick>=3600000)transport.spawns.get(parentId).onEvent({type:'exit',expected:false,reason:'controlled-last-wake'});},
    programming:{prompt:({peer,stage})=>`Implement finite task ${stage} for child ${peer}.`,verify:async({peer,stage,submission})=>submission?.task===`task-${stage}-${peer}`&&submission.sourceSha256===hash(`print(${peer+stage})\n`)&&submission.answersSha256===hash(JSON.stringify([peer+stage]))},
    quota:{url:configuration.models.default.upstream.url,receipt:()=>({profile:'time_only',deadlineAt,forwarded:1,active:0,closed,unknownRequests:1}),close:async()=>{closed=true;}},
    admit:async({runtime,botIds,workMs})=>({runtimeId:runtime.id,clockId:'controlled',observedAtMs:tick,workDeadlineAtMs:tick+workMs,stopAtMs:tick+workMs+600000,resources:botIds.map(botId=>({botId,sandboxId:'fixture-'+botId,expiresAtMs:Date.now()+6000000}))}),
    observeSessions:async({resources})=>resources.map((row,index)=>{const sessionId=`00000000-0000-0000-0000-${String(index+(changedSession&&tick>0?10:0)).padStart(12,'0')}`;return {...row,sessionId,sessionFile:`2026-11-23T00-00-00Z_${sessionId}.jsonl`};}),
  }};
}

test('controlled subagents hour retains all original peers, four quarters and real required program exports',async t=>{
  const {options,getTick}=await setup(t);const report=await runSubagentsHour(options);
  assert.equal(report.businessFailure,null,JSON.stringify(report));assert.equal(report.cleanupFailure,null,JSON.stringify(report));
  assert.equal(report.result.state,'controlled');assert.equal(report.result.durationMs,3600000);assert.equal(getTick(),3600000);
  assert.equal(report.result.evidence.length,4);assert.equal(report.archives.children.length,12);assert.equal(report.archives.parents.length,4);
  assert.equal(transport.spawns.size,4);assert.equal(report.quota.closed,true);assert.equal(report.quota.unknownRequests,1);
  assert.deepEqual(JSON.parse(await readFile(report.reportPath,'utf8')).quota,report.quota);
});

test('a changed actual Session fails before later stages and still retains the closed time-only owner receipt',async t=>{
  const {options}=await setup(t,{changedSession:true});const report=await runSubagentsHour(options);
  assert.equal(report.businessFailure.code,'SUBAGENTS_SESSION_CHANGED');assert.equal(report.archives,undefined);assert.equal(report.quota.closed,true);
});


test('late unexpected exit cannot be hidden by planned whole-tree stop',async t=>{
  const {options}=await setup(t,{lateExit:true});const report=await runSubagentsHour(options);
  assert.ok(report.businessFailure);assert.equal(report.archives,undefined);assert.equal(report.quota.closed,true);
});

test('consistent Worker archive hashes cannot hide changed source bytes from the adopted digest',async t=>{
  const {options}=await setup(t,{changedArchive:true});const report=await runSubagentsHour(options);
  assert.equal(report.businessFailure,null);assert.equal(report.cleanupFailure.code,'SUBAGENTS_ARCHIVE_INVALID');assert.equal(report.archives,undefined);assert.equal(report.quota.closed,true);
});

test('model owner closure has a finite deadline and unknown closure remains a failed receipt',async t=>{
  const {options}=await setup(t,{changedSession:true});options.budgets={cleanupMs:60};
  options.quota.close=()=>new Promise(()=>{});
  const started=performance.now();const report=await runSubagentsHour(options);
  assert.equal(report.businessFailure.code,'SUBAGENTS_SESSION_CHANGED');
  assert.equal(report.modelOwnerFailure.code,'SUBAGENTS_MODEL_CLOSE_UNKNOWN');assert.equal(report.quota.closed,false);
  assert.ok(performance.now()-started<2000);
});
