import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile, rename, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntime } from '@swarmenv/core';
import { ServiceRegistry } from '@swarmenv/core/services';
import { createPiOpenSandboxBackend } from '@swarmenv/core/backends/pi-opensandbox';
import { runWithReport } from './run-report.mjs';
import { createSubagentsStages, readSubagentsStageResult } from './stages.mjs';
import { verifySubagentsArchives, verifySubagentsInputs } from './hour-artifacts.mjs';
import { hourParentPrompt, hourChildPrompt, hourPrepareInput, hourStageInstructions } from './prompts.mjs';
const HOUR = 3_600_000, RELEASES = [0,900_000,1_800_000,3_300_000];
const failure = code => Object.assign(new Error(code), {code});
const hash = value => createHash('sha256').update(value).digest('hex');

/** Actual Core composition. Injected clocks remain controlled evidence forever. */
export async function runSubagentsHour({backend,image,model='default',outputDir,programming,admit,observeSessions,quota,budgets,exportLimit=16*1024**2,clock,waitForMs,signal:ownerSignal},signal) {
  if (typeof programming?.prompt!=='function'||typeof programming?.verify!=='function'||typeof admit!=='function'||typeof observeSessions!=='function'||typeof quota?.receipt!=='function'||typeof quota?.close!=='function') throw failure('SUBAGENTS_HOUR_PREFLIGHT');
  const ownerUrl=quota.url;
  if(typeof ownerUrl!=='string'||!/^https?:\/\//.test(ownerUrl))throw failure('SUBAGENTS_HOUR_MODEL_OWNER');
  const limits={setupMs:600_000,workMs:3_900_000,cleanupMs:180_000,recoveryMs:300_000,marginMs:120_000,turnMs:600_000,...budgets};
  if (Object.keys(limits).some(key=>!['setupMs','workMs','cleanupMs','recoveryMs','marginMs','turnMs'].includes(key)) || Object.values(limits).some(value=>!Number.isSafeInteger(value)||value<1||value>2147483647) || limits.setupMs>600_000||limits.workMs<HOUR||limits.workMs>3_900_000||limits.cleanupMs>600_000||limits.recoveryMs>300_000||limits.marginMs>120_000 || !Number.isSafeInteger(exportLimit)||exportLimit<1) throw failure('SUBAGENTS_HOUR_BUDGET_INVALID');
  const now=clock??(()=>performance.now()); let last=-Infinity;
  const time=()=>{const value=now();if(!Number.isFinite(value)||value<last||value<0)throw failure('SUBAGENTS_HOUR_CLOCK');last=value;return value;};
  const life=new AbortController(),live=AbortSignal.any([life.signal,...(signal?[signal]:[]),...(ownerSignal?[ownerSignal]:[])]);
  let runtime,stages,parentId,childIds,botIds,lifetime,sessions,started,ended,unavailable=false,closing=false,unsubscribe,timer,archives,quotaReceipt,cleanupDeadline,ownerDeadline;
  const evidence=[]; let report,closeFailure,childAdmissions;
  const secrets=[backend?.sandbox?.apiKey,backend?.sandbox?.execdToken,...Object.values(backend?.models??{}).flatMap(row=>Object.values(row.upstream?.headers??{}))].filter(value=>typeof value==='string'&&value).flatMap(value=>[value,value.replace(/^(Bearer|Basic)\s+/i,'')]);
  const redact=value=>JSON.parse(JSON.stringify(value,(_key,item)=>typeof item==='string'?secrets.reduce((text,secret)=>text.replaceAll(secret,'[redacted]'),item):item));
  function meter(final=false) {
    const receipt=quota.receipt();
    ownerDeadline??=receipt?.deadlineAt;
    if(receipt?.deadlineAt!==ownerDeadline||quota.url!==ownerUrl||backend?.models?.[model]?.upstream?.url!==ownerUrl)throw failure('SUBAGENTS_HOUR_MODEL_OWNER');
    if(receipt?.profile!=='time_only'||!Number.isSafeInteger(receipt.active)||receipt.active<0||!Number.isSafeInteger(receipt.forwarded)||receipt.forwarded<0||!Number.isFinite(receipt.deadlineAt)||receipt.failure || !final && (receipt.closed||Date.now()>=receipt.deadlineAt) || final && (!receipt.closed||receipt.active!==0)) throw failure('SUBAGENTS_HOUR_MODEL_OWNER');
    return receipt; // Unknown usage is retained for observation, not a global failure policy.
  }
  async function liveBots() {
    live.throwIfAborted();meter();
    if(unavailable)throw failure('SUBAGENTS_HOUR_PEER_UNAVAILABLE');
    const bots=await Promise.all(botIds.map(id=>runtime.get(id)));
    if(bots.some((bot,index)=>bot.id!==botIds[index]||!['idle','running'].includes(bot.status)||index>0&&bot.parentId!==parentId))throw failure('SUBAGENTS_HOUR_PEER_UNAVAILABLE');
    if(started!==undefined && time()>=lifetime.workDeadlineAtMs)throw failure('SUBAGENTS_HOUR_LIFETIME');
  }
  async function pauseUntil(at) {
    while(time()<at){await (waitForMs?waitForMs(Math.min(30_000,at-last),live):delay(Math.min(30_000,at-last),undefined,{signal:live}));await liveBots();}
    await liveBots();
  }
  async function sessionSnapshot() {
    const observed=await bounded(()=>observeSessions({runtimeId:runtime.id,resources:lifetime.resources,signal:live,timeoutMs:Math.min(limits.turnMs,10_000)}),Math.min(limits.turnMs,10_000));
    if(!Array.isArray(observed)||observed.length!==4||new Set(observed.map(row=>row.botId)).size!==4||new Set(observed.map(row=>row.sessionId)).size!==4)throw failure('SUBAGENTS_SESSION_UNCONFIRMED');
    for(const botId of botIds){const row=observed.find(row=>row.botId===botId),resource=lifetime.resources.find(row=>row.botId===botId),old=sessions?.find(row=>row.botId===botId);
      if(!row||row.sandboxId!==resource?.sandboxId||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.sessionId??'')||typeof row.sessionFile!=='string'||row.sessionFile.includes('/')||!row.sessionFile.endsWith(`_${row.sessionId}.jsonl`)||old&&(old.sessionId!==row.sessionId||old.sessionFile!==row.sessionFile))throw failure('SUBAGENTS_SESSION_CHANGED');}
    sessions=observed.map(({botId,sandboxId,sessionId,sessionFile})=>({botId,sandboxId,sessionId,sessionFile}));return structuredClone(sessions);
  }
  async function bounded(operation,timeoutMs) {
    let timeout,aborted;
    try{return await Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(failure('SUBAGENTS_HOUR_DEADLINE')),timeoutMs);aborted=()=>reject(failure('SUBAGENTS_HOUR_ABORTED'));live.addEventListener('abort',aborted,{once:true});if(live.aborted)aborted();})]);}
    finally{clearTimeout(timeout);if(aborted)live.removeEventListener('abort',aborted);}
  }
  try {
    meter();timer=setTimeout(()=>life.abort(),limits.setupMs);
    report=await runWithReport({outputDir,closeTimeoutMs:limits.cleanupMs,redact:value=>redact({...value,routing:stages?.report(),quota:quotaReceipt}),
      async createRuntime(){live.throwIfAborted(); const collect={paths:['.'],includeGit:false,maxBytes:exportLimit,required:true}; const common={model,image,writable:true,collect};
        runtime=await createRuntime({backend:createPiOpenSandboxBackend(backend),outputDir,services:new ServiceRegistry(),maxBots:4,profiles:{parent:{...common,prompt:hourParentPrompt,services:{bot:['spawn','get','send','stop']},spawnProfiles:['child']},child:{...common,prompt:hourChildPrompt,services:{}}}});
        unsubscribe=runtime.onEvent(event=>{if(!closing&&(event.type==='exit'||event.type==='error'&&event.fatal)){unavailable=true;life.abort();}});
        return {...runtime,close(options){cleanupDeadline??=performance.now()+limits.cleanupMs;closing=true;stages?.stop();return runtime.close(options).then(async receipt=>{await stages?.drain();return receipt;});}};
      },
      async run(){
        parentId=(await runtime.spawn({profile:'parent',requestId:'hour-parent'})).id;
        // Preparation owns the only parent input source. The stage controller is
        // created afterwards and never uses a next-settled correlation shortcut.
        let handler,prepareTimer;
        const prepared=new Promise((resolve,reject)=>{handler=runtime.onEvent(event=>{if(event.botId===parentId&&event.type==='settled'){if(event.outcome==='completed')resolve(event);else reject(failure('SUBAGENTS_PREPARE_FAILED'));}});prepareTimer=setTimeout(()=>reject(failure('SUBAGENTS_PREPARE_DEADLINE')),limits.turnMs);});prepared.catch(()=>{});
        let receipt,event;
        try{
          receipt=await bounded(
            ()=>runtime.send(parentId,hourPrepareInput,{requestId:'hour-prepare',mode:'followUp'}),limits.turnMs);
          event=await bounded(()=>prepared,limits.turnMs);
        }
        finally{handler?.();clearTimeout(prepareTimer);}
        if(receipt.status!=='accepted'||receipt.disposition!=='started')throw failure('SUBAGENTS_PREPARE_INPUT_UNKNOWN');
        try{childIds=JSON.parse(event.output).children;}catch{throw failure('SUBAGENTS_PREPARE_INVALID');}
        stages=await createSubagentsStages(runtime,parentId,{childIds});botIds=[parentId,...childIds];await liveBots();
        lifetime=await bounded(()=>admit({runtime,outputDir,botIds,workMs:limits.workMs,cleanupMs:limits.cleanupMs,recoveryMs:limits.recoveryMs,marginMs:limits.marginMs,signal:live}),limits.turnMs);
        const observed=time();
        if(lifetime?.runtimeId!==runtime.id||typeof lifetime.clockId!=='string'||!lifetime.clockId||![lifetime.observedAtMs,lifetime.workDeadlineAtMs,lifetime.stopAtMs].every(Number.isFinite)||observed-lifetime.observedAtMs>5000||lifetime.observedAtMs>observed||lifetime.workDeadlineAtMs<lifetime.observedAtMs+limits.workMs||!Array.isArray(lifetime.resources)||lifetime.resources.length!==4||new Set(lifetime.resources.map(row=>row.botId)).size!==4||new Set(lifetime.resources.map(row=>row.sandboxId)).size!==4||lifetime.resources.some(row=>!botIds.includes(row.botId)||typeof row.sandboxId!=='string'||!row.sandboxId||!Number.isFinite(row.expiresAtMs)||row.expiresAtMs<lifetime.stopAtMs)||lifetime.stopAtMs<lifetime.workDeadlineAtMs)throw failure('SUBAGENTS_HOUR_LIFETIME');
        clearTimeout(timer);timer=setTimeout(()=>life.abort(),limits.workMs);
        // Start at the first actual task dispatch after trusted all-peer readiness.
        started=time();
        for(let stage=0;stage<4;stage++){
          await pauseUntil(started+RELEASES[stage]);
          const tasks=childIds.map((childId,peer)=>{
            const assignment=programming.prompt({peer,stage});
            if(typeof assignment!=='string'||!assignment.trim())throw failure('SUBAGENTS_PROGRAMMING_PROMPT');
            const prompt=`Assigned stage ${stage}, child ${peer}. In your saved and returned JSON set "stage" to ${stage} and "child" to ${peer}.\n\n${assignment}`;
            return {childId,child:peer,prompt};
          });
          const input=JSON.stringify({stage,tasks,instructions:hourStageInstructions});
          const result=await stages.runStage({stage,input,timeoutMs:Math.min(limits.turnMs,started+(stage===3?HOUR:(stage+1)*900_000)-time()),signal:live,
            async verify({index,output}){
              let value;
              try{({value}=readSubagentsStageResult(output));}catch{return false;}
              return value.stage===stage&&value.child===index&&await programming.verify({peer:index,stage,submission:value.programming})===true;
            },
          });
          const atMs=time();if(Math.floor((atMs-started)/900_000)!==stage)throw failure('SUBAGENTS_STAGE_LATE');
          evidence.push({stage,atMs,parent:{botId:parentId,inputId:result.parent.receipt.inputId,eventSeq:result.parent.settled.seq,sha256:hash(result.parent.settled.output)},children:result.children.map(row=>({botId:row.result.childId,eventSeq:row.result.eventSeq,forwardedToParentInputId:row.receipt.inputId,sha256:hash(row.result.output)})),sessions:await sessionSnapshot()});
          await liveBots();
        }
        await pauseUntil(started+HOUR);await sessionSnapshot();await liveBots();ended=time();
        if(ended-started<HOUR||evidence.length!==4)throw failure('SUBAGENTS_HOUR_INCOMPLETE');
        return {mode:'subagents',accepted:false,state:clock?'controlled':'work-verified',durationMs:ended-started,evidence,lifetime,sessions,childIds};
      },
      async afterClose(cleanup){
        if(cleanup.cleanup!=='complete'||cleanup.bots.length!==4||cleanup.bots.some(row=>!botIds?.includes(row.botId)||row.execution!=='stopped'||row.cleanup!=='complete'))throw failure('SUBAGENTS_HOUR_CLEANUP_PENDING');
        if(ended===undefined)return;
        const evidenceOptions={outputDir,runtimeId:runtime.id,parentId,childIds,stages:stages.report().stages};
        childAdmissions=await verifySubagentsInputs(evidenceOptions);
        archives=await verifySubagentsArchives({...evidenceOptions,maxBytes:exportLimit,programming});
      },
    });

  } catch(error) {
    report??={businessFailure:{code:error?.code??'SUBAGENTS_HOUR_FAILED'},cleanup:null,cleanupFailure:null,reportSaveFailure:null};
  } finally {
    clearTimeout(timer);closing=true;life.abort();unsubscribe?.();stages?.dispose();
    let ownerTimer;
    const closeMs=Math.max(1,Math.min(5000,(cleanupDeadline??performance.now()+limits.cleanupMs)-performance.now()));
    try{await Promise.race([Promise.resolve().then(()=>quota.close({timeoutMs:closeMs})),new Promise((_,reject)=>{ownerTimer=setTimeout(()=>reject(failure('SUBAGENTS_MODEL_CLOSE_UNKNOWN')),closeMs);})]);}catch{closeFailure={code:'SUBAGENTS_MODEL_CLOSE_UNKNOWN'};}finally{clearTimeout(ownerTimer);}
    try{quotaReceipt=quota.receipt();meter(true);}catch{closeFailure??={code:'SUBAGENTS_MODEL_CLOSE_UNKNOWN'};}

  }
  const result=redact({...report,mode:'subagents',accepted:false,archives,quota:quotaReceipt,modelOwnerFailure:closeFailure??null,businessFailure:report.businessFailure??closeFailure??null});
  if(result.result&&childAdmissions)result.result.childAdmissions=childAdmissions;
  if(result.result&&!result.businessFailure&&!result.cleanupFailure&&archives&&childAdmissions)result.result.state=clock?'controlled':'work-and-cleanup-verified';
  if(result.reportPath){
    const temporary=`${result.reportPath}.${randomUUID()}.tmp`;
    try{await writeFile(temporary,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});await rename(temporary,result.reportPath);}
    catch{result.reportSaveFailure??={code:'REPORT_SAVE_FAILED',message:'Final model owner receipt could not be saved'};await rm(temporary,{force:true}).catch(()=>{});}
  }
  return result;
}


if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(!process.argv[2])throw new Error('Supply the host hour configuration module');
  const abort=new AbortController(),stop=()=>abort.abort();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{
    const configured=(await import(pathToFileURL(resolve(process.argv[2])).href)).default;
    const config=typeof configured==='function'?await configured({signal:abort.signal}):configured;
    const report=await runSubagentsHour(config,abort.signal);
    process.stdout.write(JSON.stringify({mode:report.mode,accepted:false,state:report.result?.state,businessFailure:report.businessFailure?.code??null,cleanupFailure:report.cleanupFailure?.code??null,reportSaveFailure:report.reportSaveFailure?.code??null,reportPath:report.reportPath})+'\n');
    process.exitCode=report.businessFailure||report.cleanupFailure||report.reportSaveFailure?1:0;
  }finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
}
