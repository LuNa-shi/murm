import { randomUUID } from 'node:crypto';
import { BOT_CONTINUATION_MESSAGE, buildBotContinuationMessage } from '../../agent/bot-contract.js';
import { SwarmEnvError } from '../../errors.js';
import { stableStringify } from '../../protocol/envelope.js';
import { createFlatBotCoordinator } from './bot-coordinator.js';
import { executionEnvelope } from './prepare-inputs.js';

export const FLAT_DISCOVERY_MESSAGE='Read public Tasks and take suitable work. Continue in this Session after take.';

const info=error=>({code:error?.code??'FLAT_CONTROLLER_FAILED',message:error?.message??'Flat controller failed'});
const deny=message=>{throw new SwarmEnvError('NOT_ALLOWED',message);};

/** One serialized source for discovery, continuation and directed user input.
 * Core owns resources; this controller owns only flat policy and domain cleanup. */
export function createFlatController({runtime,taskService,missionId,capacity=2,profile='researcher',deadlineAt,
  selectionMs=60_000,hardBudgetMs=300_000,heartbeatMs=10_000,stallMs=120_000,continuationLimit=20,discoveryLimit=20,
  stopTimeoutMs=30_000,discoveryPrompt=FLAT_DISCOVERY_MESSAGE,
  continuationPrompt=BOT_CONTINUATION_MESSAGE,
  afterStopped=async()=>{} }) {
  if(!runtime?.id || !taskService || typeof missionId!=='string' || !missionId || !Number.isSafeInteger(capacity) || capacity<1 ||
    ![deadlineAt,selectionMs,hardBudgetMs,heartbeatMs,stallMs,stopTimeoutMs].every(Number.isFinite) || deadlineAt<=Date.now() ||
    ![selectionMs,hardBudgetMs,heartbeatMs,stallMs,stopTimeoutMs].every(x=>x>0) || heartbeatMs>10000 ||
    ![continuationLimit,discoveryLimit].every(x=>Number.isSafeInteger(x)&&x>=1) || typeof afterStopped!=='function') throw new TypeError('Flat controller requires finite ordered work budgets and trusted Runtime/domain stores');
  const coordinator=createFlatBotCoordinator({runtime,taskService,missionId});
  const bots=new Map(),feedbackRequests=new Map(),events=new Map();
  const inputs=[],decisions=[],failures=[];
  let chain=Promise.resolve(),timer,deadlineTimer,started=false,closing=false,completion=null,generation=0;
  const complete=Promise.withResolvers();
  const remaining=()=>Math.max(0,deadlineAt-Date.now());
  const snapshot=()=>structuredClone({runtimeId:runtime.id,missionId,closing,completion,bots:[...bots.values()],inputs,decisions,failures});
  const record=(reason,row,extra={})=>{
    const owner=row&&taskService.getBot(row.botId),execution=owner?.execution_id&&taskService.getExecution(owner.execution_id);
    decisions.push({reason,at:Date.now(),remainingMs:remaining(),...(row?{botId:row.botId}:{}),
      ...(owner?{ownerState:owner.state,selectionDeadline:owner.selection_deadline,hardDeadline:owner.hard_deadline}:{}),
      ...(execution?{taskId:execution.task_id,taskState:taskService.getTask(execution.task_id)?.state,executionId:execution.execution_id,executionState:execution.state,fence:execution.fencing_version,executionDeadline:execution.execution_deadline,leaseExpiresAt:execution.lease_expires_at}:{}),
      ...(row?{stallRemainingMs:Math.max(0,stallMs-(Date.now()-row.lastActivityAt)),continuations:row.continuations,continuationLimit,discoveries:row.discoveries,discoveryLimit}:{}),...extra});
  };
  const enqueue=work=>{
    const result=chain.then(work);
    chain=result.catch(error=>{failures.push(info(error));});
    return result;
  };
  const missionTasks=()=>taskService.listTasks({missionId,states:['OPEN','RUNNING','BLOCKED','DONE','CANCELED'],availableOnly:false,scanAll:true,limit:100});
  function finish(reason,extra={}) {
    if(completion) return;
    completion=reason; closing=true; clearInterval(timer); clearTimeout(deadlineTimer); unsubscribe();
    record(reason,null,extra); complete.resolve(snapshot());
  }
  function current(row) {
    const owner=taskService.getBot(row.botId);
    return {owner,execution:owner?.execution_id?taskService.getExecution(owner.execution_id):null};
  }
  function expired(owner,execution) {
    const at=Date.now();
    return at>=Date.parse(owner?.hard_deadline) || (owner?.state==='UNBOUND'&&at>=Date.parse(owner.selection_deadline)) || (execution&&at>=Date.parse(execution.execution_deadline));
  }
  async function applyStop(row,receipt) {
    row.lastStop=receipt;
    const {owner,execution}=current(row);
    if(receipt.execution!=='stopped') {record('execution-unknown-retains-owner',row);return;}
    if(execution) {
      await afterStopped(execution.execution_id,{closedConfirmed:true});
      const fresh=taskService.getExecution(execution.execution_id);
      if(fresh.finish && fresh.state==='CLOSING') taskService.finalizeExecutionFinish(fresh.execution_id,{fencingVersion:fresh.fencing_version});
      else if(['CREATED','RUNNING'].includes(fresh.state)) taskService.dispatch('stop_execution',{terminal_state:'FAILED',terminal_reason:row.stopReason??'flat-ended'},executionEnvelope(fresh,`flat:stop:${row.botId}`));
    }
    if(receipt.cleanup==='complete' && owner && taskService.getBot(row.botId).state!=='CLOSED') taskService.finalizeBotClose(row.botId);
    row.released=receipt.cleanup==='complete';
    record(row.released?'slot-released':'cleanup-pending-retains-slot',row);
  }
  async function stop(row,reason) {
    if(!row.stopReason) {record(reason,row);row.stopReason=reason;}
    try {
      taskService.requestBotStop(row.botId,reason,{terminalState:'FAILED'});
      await applyStop(row,await runtime.stop(row.botId,{timeoutMs:stopTimeoutMs}));
    } catch(error) {row.cleanupError=info(error);record('stop-error-retains-slot',row);}
  }
  async function submit(row,text,{source,requestId,mode='followUp',taskId,executionId,fence}={}) {
    const input={botId:row.botId,source,requestId,mode,taskId:taskId??null,executionId:executionId??null,fence:fence??null,status:'not_submitted'};
    inputs.push(input);
    if(closing || remaining()<=0 || row.uncertain || row.stopReason) {input.reason='controller-closed-or-input-unknown';return input;}
    const live=await runtime.get(row.botId);
    if(closing || remaining()<=0 || !['idle','running'].includes(live.status)) {input.reason='bot-unavailable';return input;}
    if(taskId) {
      const {owner,execution}=current(row);
      if(owner?.state!=='ACTIVE' || execution?.state!=='RUNNING' || execution.execution_id!==executionId || execution.task_id!==taskId || execution.fencing_version!==fence || execution.owner_ref!==row.botId || taskService.getTask(taskId)?.state!=='RUNNING' || Date.now()>=Math.min(Date.parse(owner.hard_deadline),Date.parse(execution.execution_deadline),Date.parse(execution.lease_expires_at))) {
        Object.assign(input,{taskState:taskService.getTask(taskId)?.state??null,executionState:execution?.state??null,ownerState:owner?.state??null});
        input.reason='task-binding-changed';record('input-not-delivered',row,{source,requestId,reason:input.reason});return input;
      }
    }
    try {
      const receipt=await runtime.send(row.botId,text,{requestId,mode});
      Object.assign(input,{status:receipt.status,receipt});
      row.lastActivityAt=Date.now();
      if(receipt.status==='unknown') {row.uncertain=true;record('input-unknown-no-resend',row,{source,requestId});}
    } catch(error) {
      input.status='rejected';input.error=info(error);
      if(!['NOT_ALLOWED','INVALID_CONTRACT','CONFLICT','NOT_FOUND'].includes(error.code)) {input.status='unknown';row.uncertain=true;}
      record('input-failed',row,{source,requestId,status:input.status});
    }
    return input;
  }
  async function refill() {
    if(closing || remaining()<=0 || taskService.isMissionStopped(missionId)) return;
    // Refresh durable dependency state even when no notification reaches this
    // controller. TaskService preserves terminal/owned and nondependency blocks.
    for(const task of missionTasks()) {
      if(closing || remaining()<=0 || taskService.isMissionStopped(missionId)) return;
      if(!['OPEN','BLOCKED'].includes(task.state)) continue;
      try {taskService.reconcileTask(task.task_id);}
      catch(error) {failures.push(info(error));record('task-repair-failed',null,{taskId:task.task_id});}
    }
    const tasks=missionTasks();
    if(tasks.length && tasks.every(task=>['DONE','CANCELED'].includes(task.state))) {finish('all-tasks-terminal',{tasks:tasks.map(task=>({taskId:task.task_id,state:task.state}))});return;}
    for(let index=0;index<capacity;index++) {
      if([...bots.values()].some(row=>row.slot===index && !row.released)) continue;
      const serial=++generation,now=Date.now(),hard=Math.min(deadlineAt,now+hardBudgetMs),selection=Math.min(hard,now+selectionMs);
      if(closing || selection<=now) return;
      const legacySlotId=`flat:slot:${index}`,requestId=`flat:spawn:${serial}`;
      const bot=await coordinator.spawn({legacySlotId,requestId,profile,writable:false,selectionDeadline:new Date(selection).toISOString(),hardDeadline:new Date(hard).toISOString()});
      const row={botId:bot.id,legacySlotId,slot:index,generation:serial,continuations:0,discoveries:1,lastActivityAt:Date.now(),released:false};
      bots.set(bot.id,row);record('spawn-readonly-discovery',row);
      if(closing) await stop(row,'controller-closing');
      else await submit(row,discoveryPrompt,{source:'discovery',requestId:`flat:discovery:${serial}:1`});
    }
  }
  async function reconcile() {
    if(closing) return;
    if(remaining()<=0) {finish('mission-deadline');return;}
    if(taskService.isMissionStopped(missionId)) {finish('mission-stopped');return;}
    for(const row of bots.values()) {
      if(row.released) continue;
      const {owner,execution}=current(row),at=Date.now();
      if(owner?.state==='CLOSING' || execution?.state==='CLOSING' || row.stopReason) {await stop(row,row.stopReason??'task-finish');continue;}
      if(expired(owner,execution)) {await stop(row,'domain-deadline');continue;}
      if(at-row.lastActivityAt>=stallMs) {await stop(row,'stall-budget');continue;}
      if(owner?.state==='ACTIVE' && execution?.state==='RUNNING') {
        try {taskService.dispatch('heartbeat',{},executionEnvelope(execution,`flat:heartbeat:${randomUUID()}`));}
        catch(error) {row.failure=info(error);await stop(row,'lease-failed');}
      }
    }
    await refill();
  }
  async function event(event) {
    const row=bots.get(event.botId);if(!row || closing) return;
    if(event.type==='exit'||(event.type==='error'&&event.fatal)) {record('fatal-or-exit',row);await stop(row,'worker-failed');await refill();return;}
    const binding=current(row);
    if(expired(binding.owner,binding.execution)) {await stop(row,'domain-deadline');await refill();return;}
    if(row.uncertain) {record('input-unknown-awaits-reconciliation',row);return;}
    row.lastActivityAt=Date.now();
    if(event.type==='settled') {
      const {owner,execution}=current(row);
      if(owner?.state==='CLOSING'||execution?.state==='CLOSING') {await stop(row,'task-finish');await refill();return;}
      if(event.outcome!=='completed') {record('failed-turn-is-not-task-completion',row,{outcome:event.outcome});await stop(row,`turn-${event.outcome}`);await refill();return;}
      if(owner?.state==='ACTIVE'&&execution?.state==='RUNNING') {
        if(row.continuations>=continuationLimit) {await stop(row,'continuation-budget');await refill();return;}
        row.continuations++;record('unfinished-execution',row,{continuation:row.continuations});
        await submit(row,buildBotContinuationMessage(execution,{ordinary:continuationPrompt}),{source:'continuation',requestId:`flat:continue:${row.generation}:${row.continuations}`,taskId:execution.task_id,executionId:execution.execution_id,fence:execution.fencing_version});
      } else if(owner?.state==='UNBOUND') {
        if(row.discoveries>=discoveryLimit) {await stop(row,'discovery-budget');await refill();return;}
        row.discoveries++;record('selection-still-open',row);
        await submit(row,discoveryPrompt,{source:'discovery',requestId:`flat:discovery:${row.generation}:${row.discoveries}`});
      } else {await stop(row,'domain-binding-ended');await refill();}
    }
  }
  const unsubscribe=runtime.onEvent(value=>{
    if(closing || !Number.isSafeInteger(value.seq) || value.seq<=(events.get(value.botId)??0)) return;
    events.set(value.botId,value.seq);
    void enqueue(()=>event(value)).catch(()=>{});
  });
  return Object.freeze({
    start(){return enqueue(async()=>{if(started) return snapshot();started=true;deadlineTimer=setTimeout(()=>finish('mission-deadline'),Math.max(1,remaining()));await refill();if(!closing) timer=setInterval(()=>{void enqueue(reconcile).catch(()=>{});},heartbeatMs);return snapshot();});},
    tick:()=>enqueue(reconcile),
    notify(){if(!closing) void enqueue(reconcile).catch(()=>{});},
    feedback({taskId,input,requestId,mode='steer'}) {
      if(typeof taskId!=='string'||typeof input!=='string'||!input || typeof requestId!=='string'||!requestId||!['steer','followUp'].includes(mode)) throw new TypeError('Directed flat feedback requires Task, text, stable request and mode');
      const fingerprint=stableStringify({taskId,input,mode});
      const previous=feedbackRequests.get(requestId);
      if(previous) {if(previous.fingerprint!==fingerprint) throw new SwarmEnvError('CONFLICT','Feedback request changed');return previous.work;}
      const selectedTask=taskService.getTask(taskId);
      const selectedExecution=selectedTask?.mission_id===missionId?taskService.listExecutions(taskId).find(row=>row.state==='RUNNING'):null;
      const selected=selectedExecution?{botId:selectedExecution.owner_ref,executionId:selectedExecution.execution_id,fence:selectedExecution.fencing_version}:null;
      const work=enqueue(async()=>{
        const task=taskService.getTask(taskId);
        const execution=selected&&taskService.getExecution(selected.executionId);
        const row=selected&&bots.get(selected.botId);
        if(closing || task?.state!=='RUNNING' || !row || execution?.state!=='RUNNING' || execution.owner_ref!==selected.botId || execution.fencing_version!==selected.fence) {
          const result={source:'user',requestId,mode,taskId,status:'not_submitted',reason:'task-not-running',taskState:task?.state??null};inputs.push(result);return structuredClone(result);
        }
        return structuredClone(await submit(row,input,{source:'user',requestId,mode,taskId,executionId:execution.execution_id,fence:execution.fencing_version}));
      });feedbackRequests.set(requestId,{fingerprint,work});return work;
    },
    flush:()=>chain,
    snapshot,
    wait:()=>complete.promise,
    halt(reason='host-stop'){finish(reason);},
    async close({timeoutMs=stopTimeoutMs}={}) {
      finish(completion??'host-stop');
      let timeout;
      const jobs=chain.then(()=>Promise.allSettled([...bots.values()].filter(row=>!row.released).map(row=>stop(row,'controller-close'))));
      try {await Promise.race([jobs,new Promise(resolve=>{timeout=setTimeout(resolve,timeoutMs);})]);}
      finally{clearTimeout(timeout);}
      return snapshot();
    },
    async reconcileClose(receipt) {
      for(const stopped of receipt?.bots??[]) {
        const row=bots.get(stopped.botId);
        if(!row) continue;
        const owner=taskService.getBot(row.botId);
        if(owner && !['CLOSING','CLOSED'].includes(owner.state)) taskService.requestBotStop(row.botId,row.stopReason??'controller-close',{terminalState:'FAILED'});
        await applyStop(row,stopped);
      }
      return snapshot();
    },
  });
}
