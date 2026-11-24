import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { transport } from './fixtures/core-bot-service-backend.js';
import { configuration } from './fixtures/core-input-backend.js';
import { hourParentPrompt, hourStageInstructions, hourChildPrompt } from '../examples/subagents-environment/prompts.mjs';
import { verifySubagentsInputs } from '../examples/subagents-environment/hour-artifacts.mjs';
import { readSubagentsStageResult } from '../examples/subagents-environment/stages.mjs';
const hooks=registerHooks({resolve(specifier,context,next){
  if(specifier==='./pi-opensandbox-backend.js'&&context.parentURL?.endsWith('/src/core/index.js'))return {url:new URL('./fixtures/subagents-hour-backend.js',import.meta.url).href,shortCircuit:true};
  if(specifier==='./run-report.mjs'&&context.parentURL?.endsWith('/examples/subagents-environment/hour.mjs'))return {url:new URL('../src/environments/shared/run-report.js',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}});
const {runSubagentsHour}=await import('../examples/subagents-environment/hour.mjs');hooks.deregister();
const hash=value=>createHash('sha256').update(value).digest('hex');

async function setup(t,{changedSession=false,changedArchive=false,lateExit=false,queuedParent=false,verbatimTasks=false,
  narratedResults=false,childTrailer=false,fractionalLastWake=false,exhaustedLastWake=false,prepareFraming='exact'}={}) {
  transport.reset();transport.collectable=true;
  const outputDir=await mkdtemp(join(tmpdir(),'subagents-hour-'));t.after(()=>rm(outputDir,{recursive:true,force:true}));
  let tick=0,parentId,stageIndex,closed=false;const deadlineAt=Date.now()+6000000;
  const childIds=[],conclusions=[],files=new Map();let count=0;
  let parentRunning=false;const parentQueue=[],yields=[];
  function settleParent(output,kind) {
    if(kind)yields.push(kind);
    parentRunning=false;
    transport.spawns.get(parentId).onEvent({type:'settled',outcome:'completed',output});
    if(parentQueue.length){const next=parentQueue.shift();setImmediate(()=>next());}
  }
  const keep=(id,path,text)=>{if(!files.has(id))files.set(id,new Map());files.get(id).set(path,text);};
  transport.onSpawn=options=>{if(!options.options.parentId)parentId=options.botId;};
  const call=async(operation,payload,operation_id)=>{
    const credentials=transport.spawns.get(parentId).credentials;
    const result=await (await fetch(transport.url+'/call',{method:'POST',headers:{authorization:`Bearer ${credentials.secretEnvironment.SWARMENV_BRIDGE_TOKEN}`},body:JSON.stringify({service_id:'bot',operation,payload,operation_id})})).json();
    assert.equal(result.ok,true,JSON.stringify(result));return result.result;
  };
  function arm(){transport.next=async inputId=>{
    arm();const row=transport.submissions.get(inputId);
    if(queuedParent&&row.botId===parentId&&parentRunning){
      row.receipt={status:'accepted',disposition:'queued'};
      parentQueue.push(()=>execute(row));return;
    }
    // Native send acknowledges before the model finishes its turn.
    if(queuedParent&&row.botId===parentId){void execute(row);return;}
    await execute(row);
  };}
  async function execute(row){
    if(row.botId===parentId)parentRunning=true;
    if(row.botId!==parentId){
      let task;
      if(verbatimTasks){
        const [,stage,problem]=row.input.match(/Implement finite stage (\d+) problem (\d+)/);
        const assignment=row.input.match(/^Assigned stage (\d+), child (\d+)\./);
        task={stage:Number(stage),peer:Number(problem)-35,declaredStage:Number(assignment?.[1]??stage),declaredChild:Number(assignment?.[2]??0)};
      }else task=JSON.parse(row.input);
      const source=`print(${task.peer+task.stage})\n`,answers=[task.peer+task.stage];
      const output=JSON.stringify({stage:task.declaredStage??task.stage,child:task.declaredChild??task.peer,programming:{task:`task-${task.stage}-${task.peer}`,sourceSha256:hash(source),answersSha256:hash(JSON.stringify(answers))}});
      const directory=task.peer===0?'':'programs/';
      keep(row.botId,`${directory}hour-program-${task.stage}.py`,source);keep(row.botId,`${directory}hour-program-${task.stage}.stdout.json`,JSON.stringify(answers));keep(row.botId,`hour-results/stage-${task.stage}.json`,output);
      if(task.peer===0)await new Promise(resolve=>setTimeout(resolve,10));
      let completed=output;
      if(task.peer===1&&task.stage===0){
        if(childTrailer)completed=`${output}\nThe result is above.`;
        else if(narratedResults)completed=`The requested files were saved.\n\n${output}`;
      }
      transport.spawns.get(row.botId).onEvent({type:'settled',outcome:'completed',output:completed});
    }else if(row.input.startsWith('Prepare exactly')){
      for(let i=0;i<3;i++){const result=await call('spawn',{profile:'child'},`child-${i}`);assert.equal(result.initialInput,null);childIds.push(result.bot.id);}
      const prepared=JSON.stringify({children:childIds,...(prepareFraming==='extra'?{extra:true}:{})});
      settleParent(prepareFraming==='narrated'?'Three actual children are ready.\n\n'+prepared:prepareFraming==='fenced'?'```json\n'+prepared+'\n```':prepareFraming==='trailing'?prepared+'\nPreparation completed.':prepareFraming==='prose'?'Three children are ready.':prepared);
    }else if(row.input.startsWith('{"stage"')){
      const task=JSON.parse(row.input);stageIndex=task.stage;count=0;
      // This models natural parent-driven concurrent child admission, with no host semaphore.
      await Promise.all(childIds.map((id,peer)=>call('send',{bot_id:id,input:verbatimTasks?task.tasks.find(entry=>entry.childId===id).prompt:JSON.stringify({peer,stage:task.stage}),mode:'followUp'},`task-${task.stage}-${peer}`)));
      if(queuedParent&&hourParentPrompt.includes('End the current turn immediately after dispatch')&&task.instructions.includes('End the current turn immediately after dispatch'))settleParent('Tasks dispatched.', 'dispatch');
    }else{
      const result=JSON.parse(row.input);count++;conclusions.push({childId:result.childId,eventSeq:result.eventSeq,quote:result.output});
      if(count===3){const output=JSON.stringify({stage:stageIndex,summary:'Use all earlier concrete results.',conclusions});keep(parentId,`hour-results/stage-${stageIndex}.json`,output);
        settleParent(narratedResults&&stageIndex===1?`I retained the original results.\n\n${output}`:output,'final');}
      else if(queuedParent&&hourParentPrompt.includes('End this turn immediately if fewer than three'))settleParent('Awaiting remaining child results.','incomplete');
    }
  }arm();
  transport.onCollect=async function*(botId){
    const entries=[...(files.get(botId)??new Map())];
    const directories=new Set(['hour-results',...entries.filter(([path])=>path.includes('/')).map(([path])=>path.split('/')[0])]);
    for(const path of directories)yield {type:'directory',path};
    let totalBytes=0;
    for(const [path,text]of entries){const bytes=Buffer.from(changedArchive&&path.endsWith('hour-program-3.py')?'changed source':text);totalBytes+=bytes.length;yield {type:'file',path,bytes:bytes.length,mode:0o644};yield {type:'chunk',data:bytes.toString('base64')};yield {type:'fileEnd',sha256:hash(bytes)};}
    yield {type:'end',totalBytes,fileCount:entries.length,directoryCount:directories.size};
  };
  return {outputDir,getTick:()=>tick,yields,options:{backend:{...configuration,sandbox:{lifecycleBaseUrl:'http://127.0.0.1:1/v1'}},image:'test',outputDir,clock:()=>tick,waitForMs:async ms=>{tick+=ms;if(tick===3_300_000){if(fractionalLastWake)tick+=0.25;else if(exhaustedLastWake)tick+=299_999.75;}if(lateExit&&tick>=3600000)transport.spawns.get(parentId).onEvent({type:'exit',expected:false,reason:'controlled-last-wake'});},
    programming:{prompt:({peer,stage})=>`Implement finite stage ${stage} problem ${peer+35}.`,verify:async({peer,stage,submission})=>submission?.task===`task-${stage}-${peer}`&&submission.sourceSha256===hash(`print(${peer+stage})\n`)&&submission.answersSha256===hash(JSON.stringify([peer+stage]))},
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
  const admissions=report.result.childAdmissions;
  assert.equal(admissions.length,12);
  assert.equal(new Set(admissions.map(row=>row.inputId)).size,12);
  assert.notDeepEqual(report.result.childIds,report.routing.childIds);
  assert.equal(report.archives.children.filter(row=>row.files.some(file=>file.path.startsWith('programs/'))).length,8);
  for(const {stage,botId,inputId,forwardedToParentInputId} of admissions){
    const group=report.result.evidence[stage];
    assert.equal(transport.submissions.get(inputId).botId,botId);
    assert.equal(transport.submissions.get(forwardedToParentInputId).botId,group.parent.botId);
    const child=group.children.find(row=>row.botId===botId);
    assert.equal(child.forwardedToParentInputId,forwardedToParentInputId);
    assert.equal(Object.hasOwn(child,'inputId'),false);
  }
  const stages=structuredClone(report.routing.stages);
  stages[0].children[0].receipt.inputId=admissions[0].inputId;
  await assert.rejects(verifySubagentsInputs({outputDir:options.outputDir,runtimeId:report.runtimeId,
    parentId:report.result.evidence[0].parent.botId,childIds:report.result.childIds,stages}),{code:'SUBAGENTS_INPUT_EVIDENCE_INVALID'});
  assert.equal(transport.spawns.size,4);assert.equal(report.quota.closed,true);assert.equal(report.quota.unknownRequests,1);
  assert.deepEqual(JSON.parse(await readFile(report.reportPath,'utf8')).quota,report.quota);
});

test('a changed actual Session fails before later stages and still retains the closed time-only owner receipt',async t=>{
  const {options}=await setup(t,{changedSession:true});const report=await runSubagentsHour(options);
  assert.equal(report.businessFailure.code,'SUBAGENTS_SESSION_CHANGED');assert.equal(report.archives,undefined);assert.equal(report.quota.closed,true);
});

test('verbatim Bot Service task forwarding retains the specific stage and child assignment',async t=>{
  const {options}=await setup(t,{verbatimTasks:true});
  const report=await runSubagentsHour(options);
  assert.equal(report.businessFailure,null,JSON.stringify({businessFailure:report.businessFailure}));
  assert.equal(report.cleanupFailure,null);
  assert.equal(report.archives.children.length,12);
  for(const stage of report.routing.stages){
    assert.deepEqual(stage.children.map(child=>{
      const result=JSON.parse(child.result.output);
      return [result.stage,result.child];
    }),[[stage.stage,0],[stage.stage,1],[stage.stage,2]]);
  }
});

test('terminal JSON is checked and archived while earlier narration remains in the original adoption quote',async t=>{
  const {options}=await setup(t,{narratedResults:true,verbatimTasks:true});options.budgets={turnMs:1000};
  const report=await runSubagentsHour(options);
  assert.equal(report.businessFailure,null,JSON.stringify({businessFailure:report.businessFailure}));
  assert.equal(report.cleanupFailure,null);
  const stage=report.routing.stages[0];
  const narrated=stage.children[1].result;
  assert.match(narrated.output,/^The requested files were saved\.\n\n\{/);
  assert.equal(stage.conclusions.find(row=>row.childId===narrated.childId).quote,narrated.output);
  assert.equal(report.routing.stages[3].conclusions.find(row=>row.childId===narrated.childId).quote,narrated.output);
  assert.match(report.routing.stages[1].parent.settled.output,/^I retained the original results\.\n\n\{/);
  assert.equal(report.archives.children.length,12);
  assert.equal(report.archives.parents.length,4);
});

test('nonterminal JSON does not satisfy the stage verifier',async t=>{
  const {options}=await setup(t,{childTrailer:true});options.budgets={turnMs:1000};
  const report=await runSubagentsHour(options);
  assert.equal(report.businessFailure.code,'STAGE_RESULT_INVALID');
  assert.equal(report.archives,undefined);
  assert.equal(report.quota.closed,true);
});

test('terminal JSON cannot be confused with an unfinished Markdown code block',()=>{
  const result='{"stage":0}';
  assert.throws(()=>readSubagentsStageResult(`Checked.\n\x60\x60\x60json\n${result}`));
  assert.throws(()=>readSubagentsStageResult(`  ~~~json\n${result}`));
  assert.deepEqual(readSubagentsStageResult(`Checked.\n${result}\n`),{payload:result,value:{stage:0}});
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


test('queued parent followUps require dispatch and incomplete turns to yield before exact final adoption',async t=>{
  assert.match(hourChildPrompt,/last nonempty line/);
  assert.match(hourParentPrompt,/last nonempty line/);
  assert.match(hourStageInstructions,/last nonempty line/);
  const {options,yields}=await setup(t,{queuedParent:true});options.budgets={turnMs:1000};
  const report=await runSubagentsHour(options);
  assert.equal(report.businessFailure,null,JSON.stringify(report));
  assert.equal(report.cleanupFailure,null,JSON.stringify(report));
  assert.deepEqual(yields,Array.from({length:4},()=>['dispatch','incomplete','incomplete','final']).flat());
  assert.equal(report.routing.stages.length,4);
  for(const stage of report.routing.stages){
    assert.equal(stage.parent.settled.outcome,'completed');
    assert.equal(JSON.parse(stage.parent.settled.output).conclusions.length,(stage.stage+1)*3);
    assert.equal(stage.children.length,3);
    assert.ok(stage.children.some(child=>child.receipt.disposition==='queued'));
    assert.ok(stage.children.every(child=>['queued','started'].includes(child.receipt.disposition)));
    for(const child of stage.children){
      const exact=JSON.parse(stage.parent.settled.output).conclusions.find(row=>row.childId===child.result.childId&&row.eventSeq===child.result.eventSeq);
      assert.equal(exact.quote,child.result.output);
    }
  }
});

// Native monotonic clocks need not land on integer millisecond boundaries.
test('fractional final-stage wake floors remaining wait without extending the hour',async t=>{
  const {options,getTick}=await setup(t,{fractionalLastWake:true});const report=await runSubagentsHour(options);
  assert.equal(report.businessFailure,null,JSON.stringify(report.businessFailure));
  assert.equal(report.cleanupFailure,null,JSON.stringify(report.cleanupFailure));
  assert.equal(report.result.state,'controlled');assert.equal(report.result.durationMs,3_600_000);
  assert.equal(getTick(),3_600_000);assert.equal(report.result.evidence.length,4);
  assert.equal(report.result.evidence[3].atMs,3_300_000.25);
  assert.equal(report.archives.children.length,12);assert.equal(report.archives.parents.length,4);
});

test('less than one millisecond of final-stage allowance cannot be rounded up into work',async t=>{
 const {options}=await setup(t,{exhaustedLastWake:true});let verified=0;const verify=options.programming.verify;
 options.programming.verify=async context=>{verified++;return verify(context);};
 const report=await runSubagentsHour(options);assert.ok(report.businessFailure);assert.equal(report.result,null);
 assert.equal(verified,9);assert.equal(report.cleanup.cleanup,'complete');
});

test('preparation accepts a complete final unfenced JSON object after prose while retaining original direct children',async t=>{
 const {options}=await setup(t,{prepareFraming:'narrated'});const report=await runSubagentsHour(options);
 assert.equal(report.businessFailure,null,JSON.stringify(report.businessFailure));assert.equal(report.cleanupFailure,null);
 assert.equal(report.result.evidence.length,4);assert.equal(report.result.childIds.length,3);assert.equal(new Set(report.result.childIds).size,3);
 assert.equal(report.result.childAdmissions.length,12);assert.equal(report.archives.children.length,12);
});
for(const prepareFraming of ['fenced','trailing','prose','extra'])test(`preparation rejects ${prepareFraming} framing without starting staged work`,async t=>{
 const {options}=await setup(t,{prepareFraming});const report=await runSubagentsHour(options);
 assert.equal(report.businessFailure?.code,'SUBAGENTS_PREPARE_INVALID');assert.equal(report.result,null);
 assert.equal(report.cleanup.cleanup,'complete');
});
