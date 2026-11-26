import { randomUUID } from 'node:crypto';
import { buildBotContinuationMessage, buildBotNotification } from '../../agent/bot-contract.js';
import { SwarmEnvError } from '../../errors.js';
import { stableStringify } from '../../protocol/envelope.js';
import { createFlatBotCoordinator } from './bot-coordinator.js';
import { executionEnvelope } from './prepare-inputs.js';

export const FLAT_AUTONOMOUS_DISCOVERY_MESSAGE = `During discovery, inspect the public Workspace, Tasks, and Materials. Your private project is read-only until you take a Task.

Run swarm task list --states '["ready","running"]'. Read relevant Task contracts with swarm task view. If the pool is empty, propose a first concrete piece of work. If a Task already covers the Mission-wide deliverable, find a distinct, checkable contribution to it. Refresh the list before creating or taking a Task. If another Bot wins a take, check the list again.

You may propose multiple Tasks during discovery and during your Execution. Use a separate swarm task create call for each concrete gap and deliverable. See swarm task create --help. Other Bots can take your proposals. Take one suitable available Task with swarm task take. After it succeeds, remain in this Session with your one Execution and do detailed work there. If you discover a blocker another Bot can resolve, propose that work and continue the parts of your Task you can advance.`;

export function buildFlatAutonomousDiscoveryMessage({ mission, bot, runDeadline, discoveryContext, discoveryWorkflow }: any) {
  return `Mission: ${mission.mission_id}
Goal: ${mission.goal}
Acceptance: ${JSON.stringify(mission.acceptance_conditions)}
Bot: ${bot.bot_id}
Selection deadline: ${bot.selection_deadline}
Bot hard deadline: ${bot.hard_deadline}
Mission deadline: ${runDeadline}${discoveryContext ? `\n\n${discoveryContext}` : ''}

${FLAT_AUTONOMOUS_DISCOVERY_MESSAGE}

${discoveryWorkflow ?? FLAT_TASK_FINISH_GUIDANCE}`;
}

export const FLAT_TASK_FINISH_GUIDANCE = 'When your responsibility ends, report the actual outcome with swarm task finish and end this Bot. Stop work when the Mission is accepted or stopped.';

export const FLAT_DISCOVERY_MESSAGE='Read public Tasks and take suitable work. Continue in this Session after take.';

const info=(error: any)=>({code:error?.code??'FLAT_CONTROLLER_FAILED',message:error?.message??'Flat controller failed'});
const deny=(message: any)=>{throw new SwarmEnvError('NOT_ALLOWED',message);};

/** One serialized source for discovery, continuation and directed user input.
 * Core owns resources; this controller owns only flat policy and domain cleanup. */
export function createFlatController({runtime,taskService,missionId,capacity=2,profile='researcher',deadlineAt,activeDeadline=()=>deadlineAt,coordinationPermissions=[],
  selectionMs=60_000,hardBudgetMs=300_000,heartbeatMs=10_000,stallMs=120_000,continuationLimit=20,discoveryLimit=20,
  stopTimeoutMs=30_000,autonomousTasks=false,discoveryPrompt,discoveryContext,discoveryWorkflow,
  continuationPrompt,workspaceSaveAvailable=true,completionPolicy='tasks',deliverNotifications=true,materialNotificationMode='followUp',
  afterStopped=async()=>{}, beforeInitialDispatch, automaticContinuation=true, refillWhenNoReadyTask=true }: any) {
  if ([discoveryContext, discoveryWorkflow].some(value => value !== undefined && typeof value !== 'string')) {
    throw new TypeError('Flat discovery context and workflow must be host-supplied text');
  }
  if(!['tasks','mission'].includes(completionPolicy) || !['steer','followUp'].includes(materialNotificationMode) || typeof deliverNotifications!=='boolean' || typeof autonomousTasks!=='boolean' || !runtime?.id || !taskService || typeof missionId!=='string' || !missionId || !Number.isSafeInteger(capacity) || capacity<1 ||
    ![deadlineAt,selectionMs,hardBudgetMs,heartbeatMs,stallMs,stopTimeoutMs].every(Number.isFinite) || deadlineAt<=Date.now() || typeof activeDeadline!=='function' ||
    ![selectionMs,hardBudgetMs,heartbeatMs,stallMs,stopTimeoutMs].every((x: any)=>x>0) || heartbeatMs>10000 ||
    ![continuationLimit,discoveryLimit].every((x: any)=>Number.isSafeInteger(x)&&x>=1) || typeof afterStopped!=='function' || (beforeInitialDispatch!==undefined && typeof beforeInitialDispatch!=='function') || typeof automaticContinuation!=='boolean' || typeof refillWhenNoReadyTask!=='boolean') throw new TypeError('Flat controller requires finite ordered work budgets and trusted Runtime/domain stores');
  const coordinator=createFlatBotCoordinator({runtime,taskService,missionId,coordinationPermissions});
  const bots: any=new Map(),feedbackRequests: any=new Map(),events: any=new Map();
  const inputs: any[]=[],decisions: any[]=[],failures: any[]=[];
  let admissionController: any;
  function missionStopReason() {
    return completionPolicy === 'mission' && taskService.getAcceptedSubmission(missionId) ? 'mission-accepted' : 'mission-stopped';
  }
  let chain=Promise.resolve(),timer: any,deadlineTimer: any,started=false,closing=false,completion: any=null,generation=0;
  const complete=Promise.withResolvers();
  const workDeadline=()=>Math.min(deadlineAt,activeDeadline());
  const remaining=()=>Math.max(0,workDeadline()-Date.now());
  const snapshot=()=>structuredClone({runtimeId:runtime.id,missionId,closing,completion,bots:[...bots.values()],inputs,decisions,failures});
  const record=(reason: any,row: any,extra: any={})=>{
    const owner=row&&taskService.getBot(row.botId),execution=owner?.execution_id&&taskService.getExecution(owner.execution_id);
    decisions.push({reason,at:Date.now(),remainingMs:remaining(),...(row?{botId:row.botId}:{}),
      ...(owner?{ownerState:owner.state,selectionDeadline:owner.selection_deadline,hardDeadline:owner.hard_deadline}:{}),
      ...(execution?{taskId:execution.task_id,taskState:taskService.getTask(execution.task_id)?.state,executionId:execution.execution_id,executionState:execution.state,fence:execution.fencing_version,executionDeadline:execution.execution_deadline,leaseExpiresAt:execution.lease_expires_at}:{}),
      ...(row?{stallRemainingMs:Math.max(0,stallMs-(Date.now()-row.lastActivityAt)),continuations:row.continuations,continuationLimit,discoveries:row.discoveries,discoveryLimit}:{}),...extra});
  };
  const enqueue=(work: any)=>{
    const result=chain.then(work);
    chain=result.catch((error: any)=>{failures.push(info(error));});
    return result;
  };
  const missionTasks=()=>taskService.listTasks({missionId,states:['OPEN','RUNNING','BLOCKED','DONE','CANCELED'],availableOnly:false,scanAll:true,limit:100});
  function finish(reason: any,extra: any={}) {
    if(completion) return;
    completion=reason; closing=true; admissionController?.abort(); clearInterval(timer); clearTimeout(deadlineTimer); unsubscribe();
    record(reason,null,extra); complete.resolve(snapshot());
  }
  function current(row: any) {
    const owner=taskService.getBot(row.botId);
    return {owner,execution:owner?.execution_id?taskService.getExecution(owner.execution_id):null};
  }
  function expired(owner: any,execution: any) {
    const at=Date.now();
    return at>=Date.parse(owner?.hard_deadline) || (owner?.state==='UNBOUND'&&at>=Date.parse(owner.selection_deadline)) || (execution&&at>=Date.parse(execution.execution_deadline));
  }
  async function applyStop(row: any,receipt: any) {
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
  async function stop(row: any,reason: any) {
    if(!row.stopReason) {record(reason,row);row.stopReason=reason;}
    try {
      taskService.requestBotStop(row.botId,reason,{terminalState:'FAILED'});
      await applyStop(row,await runtime.stop(row.botId,{timeoutMs:stopTimeoutMs}));
    } catch(error: any) {row.cleanupError=info(error);record('stop-error-retains-slot',row);}
  }
  async function submit(row: any,text: any,{source,requestId,mode='followUp',taskId,executionId,fence,notificationId}: any={}) {
    const input: any={botId:row.botId,source,requestId,mode,taskId:taskId??null,executionId:executionId??null,fence:fence??null,status:'not_submitted'};
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
    if (taskService.isMissionStopped(missionId)) {
      input.reason = 'mission-stopped';
      record('input-not-delivered', row, { source, requestId, reason: input.reason });
      finish(missionStopReason());
      return input;
    }
    if (source === 'discovery') {
      const owner = taskService.getBot(row.botId);
      if (owner?.state !== 'UNBOUND' || expired(owner, null)) {
        input.reason = 'selection-ended';
        record('input-not-delivered', row, { source, requestId, reason: input.reason });
        return input;
      }
      text ??= autonomousTasks
        ? buildFlatAutonomousDiscoveryMessage({
            mission: taskService.getMission(missionId), bot: owner, runDeadline: new Date(workDeadline()).toISOString(),
            discoveryContext: row.discoveries === 1 ? discoveryContext : undefined, discoveryWorkflow,
          })
        : FLAT_DISCOVERY_MESSAGE;
    }
    if(notificationId) taskService.recordNotificationAttempt(notificationId);
    try {
      const receipt=await runtime.send(row.botId,text,{requestId,mode});
      Object.assign(input,{status:receipt.status,receipt});
      row.lastActivityAt=Date.now();
      if(receipt.status==='unknown') {row.uncertain=true;record('input-unknown-no-resend',row,{source,requestId});}
    } catch(error: any) {
      input.status='rejected';input.error=info(error);
      if(!['NOT_ALLOWED','INVALID_CONTRACT','CONFLICT','NOT_FOUND'].includes(error.code)) {input.status='unknown';row.uncertain=true;}
      record('input-failed',row,{source,requestId,status:input.status});
    }
    return input;
  }
  async function handoffWarning(row: any) {
    const {owner,execution}=current(row),at=Date.now();
    if(row.handoffWarning?.delivered || owner?.state!=='ACTIVE' || execution?.state!=='RUNNING' || row.stopReason ||
      (!execution.handoff_reminder_sent_at && !(Date.parse(execution.handoff_deadline)<=at))) return;
    // Persist the soft boundary first. Enqueue is independently idempotent, so
    // a failed enqueue is recovered even when the reminder already exists.
    const marked=execution.handoff_reminder_sent_at?execution:taskService.dispatch('record_handoff_reminder',
      {reminded_at:new Date(at).toISOString()},executionEnvelope(execution,`flat:handoff-reminder:${execution.execution_id}`)).execution;
    const notification=row.handoffNotification??=taskService.enqueueNotification({
      deliveryKey:`handoff_warning:${marked.execution_id}:${marked.execution_deadline??marked.handoff_deadline}`,
      missionId,recipientTaskId:marked.task_id,recipientExecutionId:marked.execution_id,type:'handoff_warning',
      payload:{execution_id:marked.execution_id,deadline:marked.execution_deadline??null},
    });
    const receipt=taskService.listUnprocessedNotifications(marked.task_id,marked.execution_id)
      .find((value: any)=>value.notification_id===notification.notification_id);
    if(!receipt || receipt.recipient_delivery?.delivered_at) {
      if(row.handoffWarning) row.handoffWarning.delivered=true;
      return;
    }
    // Preserve exact text and request identity across admission/receipt errors.
    // Never reissue an unknown or definitively rejected input automatically.
    const delivery=row.handoffWarning??={notificationId:notification.notification_id,
      fence:marked.fencing_version,text:buildBotNotification(notification,{at,workspaceSaveAvailable}),requestId:`flat:handoff-warning:${marked.execution_id}:${notification.notification_id}`};
    if(!delivery.input || delivery.input.status==='not_submitted') {
      delivery.input=await submit(row,delivery.text,{source:'handoff-warning',requestId:delivery.requestId,
        taskId:marked.task_id,executionId:marked.execution_id,fence:delivery.fence,notificationId:notification.notification_id});
    }
    if(['accepted','queued'].includes(delivery.input.status)) {
      taskService.markNotificationDelivered(notification.notification_id,marked.execution_id);
      delivery.delivered=true;
    }
  }
  async function ordinaryNotifications(row: any) {
    const {owner,execution}=current(row);
    if(!deliverNotifications || row.uncertain || row.stopReason || owner?.state!=='ACTIVE' || execution?.state!=='RUNNING') return;
    row.notifications ??= {};
    try {
      for(const notification of taskService.listUnprocessedNotifications(execution.task_id,execution.execution_id)) {
        if(notification.notification_type==='handoff_warning' || notification.recipient_delivery?.delivered_at) continue;
        const delivery=row.notifications[notification.notification_id] ??= {
          requestId:`flat:notification:${execution.execution_id}:${notification.notification_id}`,
          text:buildBotNotification(notification,{workspaceSaveAvailable}), fence:execution.fencing_version,
          mode:notification.notification_type==='material_available'?materialNotificationMode:'followUp',
        };
        if(!delivery.input || delivery.input.status==='not_submitted') {
          delivery.input=await submit(row,delivery.text,{source:'notification',requestId:delivery.requestId,mode:delivery.mode,
            taskId:execution.task_id,executionId:execution.execution_id,fence:delivery.fence,notificationId:notification.notification_id});
        }
        const currentBinding=current(row);
        if(['accepted','queued'].includes(delivery.input.status) && currentBinding.owner?.state==='ACTIVE' && currentBinding.execution?.state==='RUNNING' && currentBinding.execution.execution_id===execution.execution_id && currentBinding.execution.fencing_version===delivery.fence) taskService.markNotificationDelivered(notification.notification_id,execution.execution_id);
        if(row.uncertain || row.stopReason || closing) return;
      }
    } catch {
      if(!row.notificationPendingRecorded) {
        row.notificationPendingRecorded=true;
        record('notification-pending',row,{code:'NOTIFICATION_PENDING'});
      }
    }
  }
  function canRefill() {
    if (closing || remaining() <= 0) return false;
    if (!taskService.isMissionStopped(missionId)) return true;
    finish(missionStopReason());
    return false;
  }
  async function refill() {
    if (!canRefill()) return;
    // Refresh durable dependency state even when no notification reaches this
    // controller. TaskService preserves terminal/owned and nondependency blocks.
    for(const task of missionTasks()) {
      if (!canRefill()) return;
      if(!['OPEN','BLOCKED'].includes(task.state)) continue;
      try {taskService.reconcileTask(task.task_id);}
      catch(error: any) {failures.push(info(error));record('task-repair-failed',null,{taskId:task.task_id});}
    }
    const tasks=missionTasks();
    if(completionPolicy==='tasks' && tasks.length && tasks.every((task: any)=>['DONE','CANCELED'].includes(task.state))) {finish('all-tasks-terminal',{tasks:tasks.map((task: any)=>({taskId:task.task_id,state:task.state}))});return;}
    const ready=tasks.filter((task: any)=>task.state==='OPEN').length;
    const awaitingDiscovery: any[]=[]; let spawned=0;
    for(let index=0;index<capacity;index++) {
      if([...bots.values()].some((row: any)=>row.slot===index && !row.released)) continue;
      if (!canRefill()) return;
      if(!refillWhenNoReadyTask && spawned>=ready) {record('refill-awaits-ready-task',null);break;}
      const serial=++generation,now=Date.now(),hard=Math.min(workDeadline(),now+hardBudgetMs),selection=Math.min(hard,now+selectionMs);
      if(selection<=now) return;
      const legacySlotId=`flat:slot:${index}`,requestId=`flat:spawn:${serial}`;
      const bot=await coordinator.spawn({legacySlotId,requestId,profile,writable:false,selectionDeadline:new Date(selection).toISOString(),hardDeadline:new Date(hard).toISOString()});
      const row: any={botId:bot.id,legacySlotId,slot:index,generation:serial,continuations:0,discoveries:1,lastActivityAt:Date.now(),released:false};
      bots.set(bot.id,row);spawned++;record('spawn-readonly-discovery',row);
      if(closing) await stop(row,'controller-closing');
      else if(beforeInitialDispatch) awaitingDiscovery.push(row);
      else await submit(row,discoveryPrompt,{source:'discovery',requestId:`flat:discovery:${serial}:1`});
    }
    if(awaitingDiscovery.length && !closing) {
      const gate: any=new AbortController(); admissionController=gate;
      let deadline: any,aborted: any;
      record('host-admission-start',null,{botIds:[...bots.values()].filter((row: any)=>!row.released).map((row: any)=>row.botId)});
      try {
        const cancelled=new Promise<any>((_: any,reject: any)=>{
          aborted=()=>reject(new SwarmEnvError('NOT_ALLOWED','Flat host admission was cancelled'));
          gate.signal.addEventListener('abort',aborted,{once:true});
          deadline=setTimeout(()=>gate.abort(),Math.max(1,remaining()));
        });
        await Promise.race([Promise.resolve().then(()=>{
          gate.signal.throwIfAborted();
          return beforeInitialDispatch({runtime,botIds:[...bots.values()].filter((row: any)=>!row.released).map((row: any)=>row.botId),signal:gate.signal});
        }),cancelled]);
        if(closing || remaining()<=0 || gate.signal.aborted) deny('Flat host admission expired');
        record('host-admission-complete',null);
        for(const row of awaitingDiscovery) await submit(row,discoveryPrompt,{source:'discovery',requestId:`flat:discovery:${row.generation}:1`});
      } catch(error: any) {finish('host-admission-failed');throw error;}
      finally {clearTimeout(deadline);gate.signal.removeEventListener('abort',aborted);if(admissionController===gate)admissionController=undefined;gate.abort();}
    }
  }
  async function reconcile() {
    if(closing) return;
    if(remaining()<=0) {finish('mission-deadline');return;}
    if(taskService.isMissionStopped(missionId)) {finish(missionStopReason());return;}
    for(const row of bots.values()) {
      if(row.released) continue;
      const {owner,execution}=current(row),at=Date.now();
      if(owner?.state==='CLOSING' || execution?.state==='CLOSING' || row.stopReason) {await stop(row,row.stopReason??'task-finish');continue;}
      if(expired(owner,execution)) {await stop(row,'domain-deadline');continue;}
      if(at-row.lastActivityAt>=stallMs) {await stop(row,'stall-budget');continue;}
      if(owner?.state==='ACTIVE' && execution?.state==='RUNNING') {
        try {
          taskService.dispatch('heartbeat',{},executionEnvelope(execution,`flat:heartbeat:${randomUUID()}`));
        }
        catch(error: any) {row.failure=info(error);await stop(row,'lease-failed');continue;}
        try {await handoffWarning(row);}
        catch {
          if(!row.handoffWarningPendingRecorded) {
            row.handoffWarningPendingRecorded=true;
            record('handoff-warning-pending',row,{code:'HANDOFF_WARNING_PENDING'});
          }
        }
        await ordinaryNotifications(row);
      }
    }
    await refill();
  }
  async function event(event: any) {
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
        await ordinaryNotifications(row);
        if(row.uncertain || closing) return;
        if(!automaticContinuation) {record('awaiting-host-followup',row);return;}
        if(row.continuations>=continuationLimit) {await stop(row,'continuation-budget');await refill();return;}
        row.continuations++;record('unfinished-execution',row,{continuation:row.continuations});
        await submit(row,buildBotContinuationMessage(execution,{ordinary:continuationPrompt,workspaceSaveAvailable}),{source:'continuation',requestId:`flat:continue:${row.generation}:${row.continuations}`,taskId:execution.task_id,executionId:execution.execution_id,fence:execution.fencing_version});
      } else if(owner?.state==='UNBOUND') {
        if(row.discoveries>=discoveryLimit) {await stop(row,'discovery-budget');await refill();return;}
        row.discoveries++;record('selection-still-open',row);
        await submit(row,discoveryPrompt,{source:'discovery',requestId:`flat:discovery:${row.generation}:${row.discoveries}`});
      } else {await stop(row,'domain-binding-ended');await refill();}
    }
  }
  const unsubscribe=runtime.onEvent((value: any)=>{
    if(closing || !Number.isSafeInteger(value.seq) || value.seq<=(events.get(value.botId)??0)) return;
    events.set(value.botId,value.seq);
    void enqueue(()=>event(value)).catch(()=>{});
  });
  return Object.freeze({
    start(){return enqueue(async()=>{if(started) return snapshot();started=true;deadlineTimer=setTimeout(()=>finish('mission-deadline'),Math.max(1,remaining()));await refill();if(!closing) timer=setInterval(()=>{void enqueue(reconcile).catch(()=>{});},heartbeatMs);return snapshot();});},
    tick:()=>enqueue(reconcile),
    notify(){if(!closing) void enqueue(reconcile).catch(()=>{});},
    feedback({taskId,input,requestId,mode='steer'}: any) {
      if(typeof taskId!=='string'||typeof input!=='string'||!input || typeof requestId!=='string'||!requestId||!['steer','followUp'].includes(mode)) throw new TypeError('Directed flat feedback requires Task, text, stable request and mode');
      const fingerprint=stableStringify({taskId,input,mode});
      const previous=feedbackRequests.get(requestId);
      if(previous) {if(previous.fingerprint!==fingerprint) throw new SwarmEnvError('CONFLICT','Feedback request changed');return previous.work;}
      const selectedTask=taskService.getTask(taskId);
      const selectedExecution=selectedTask?.mission_id===missionId?taskService.listExecutions(taskId).find((row: any)=>row.state==='RUNNING'):null;
      const selected=selectedExecution?{botId:selectedExecution.owner_ref,executionId:selectedExecution.execution_id,fence:selectedExecution.fencing_version}:null;
      const work=enqueue(async()=>{
        const task=taskService.getTask(taskId);
        const execution=selected&&taskService.getExecution(selected.executionId);
        const row=selected&&bots.get(selected.botId);
        if(closing || task?.state!=='RUNNING' || !row || execution?.state!=='RUNNING' || execution.owner_ref!==selected.botId || execution.fencing_version!==selected.fence) {
          const result: any={source:'user',requestId,mode,taskId,status:'not_submitted',reason:'task-not-running',taskState:task?.state??null};inputs.push(result);return structuredClone(result);
        }
        return structuredClone(await submit(row,input,{source:'user',requestId,mode,taskId,executionId:execution.execution_id,fence:execution.fencing_version}));
      });feedbackRequests.set(requestId,{fingerprint,work});return work;
    },
    flush:()=>chain,
    snapshot,
    wait:()=>complete.promise,
    halt(reason: any='host-stop'){finish(reason);},
    async close({timeoutMs=stopTimeoutMs}: any={}) {
      finish(completion??'host-stop');
      let timeout: any;
      const jobs=chain.then(()=>Promise.allSettled([...bots.values()].filter((row: any)=>!row.released).map((row: any)=>stop(row,'controller-close'))));
      try {await Promise.race([jobs,new Promise<any>((resolve: any)=>{timeout=setTimeout(resolve,timeoutMs);})]);}
      finally{clearTimeout(timeout);}
      return snapshot();
    },
    async reconcileClose(receipt: any) {
      const reconciliationFailures: any[]=[];
      for(const stopped of receipt?.bots??[]) {
        const row=bots.get(stopped.botId);
        if(!row) continue;
        try {
          const owner=taskService.getBot(row.botId);
          if(owner && !['CLOSING','CLOSED'].includes(owner.state)) taskService.requestBotStop(row.botId,row.stopReason??'controller-close',{terminalState:'FAILED'});
          await applyStop(row,stopped);
        } catch(error: any) {
          row.cleanupError=info(error);
          reconciliationFailures.push({botId:row.botId,...row.cleanupError});
          record('close-reconciliation-failed',row);
        }
      }
      if(reconciliationFailures.length) {
        const error: any=new SwarmEnvError('FLAT_CLOSE_RECONCILIATION_FAILED','Flat domain cleanup remains incomplete');
        error.details=reconciliationFailures;
        throw error;
      }
      return snapshot();
    },
  });
}
