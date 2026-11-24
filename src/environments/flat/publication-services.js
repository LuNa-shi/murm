import { createWorkspaceMergeService } from './workspace-merge.js';
import { MISSION_WORKSPACE_READS } from './public-workspace-reads.js';
import { prepareWorkspaceCheckSource } from './workspace-check-source.js';
import { agentCheckResult } from '../../judge/check-result.js';
import { ExecutionWorkspace } from '../../runtime/execution-workspace.js';
import { SwarmEnvError } from '../../errors.js';
import { makeEnvelope, stableStringify } from '../../protocol/envelope.js';
import { inputFingerprint, executionEnvelope } from './prepare-inputs.js';
import { listTools } from '../../sdk/service-catalog.js';

const fail = (code, message) => { throw new SwarmEnvError(code, message); };
const text = { type:'string', minLength:1, maxLength:4000 };
const ids = { type:'array', items:text, maxItems:100, uniqueItems:true };
const object = (properties, required=[]) => ({type:'object', properties, required, additionalProperties:false});
const capability = (name, operation, input_schema, side_effect='write') => ({name, operation, input_schema,
  output_schema:{type:'object'}, side_effect, idempotent:true, description:`Flat ${name} with trusted Task provenance`,
  help:{when:'Use the current Bot Task binding; reuse the same request ID after an unknown response'}, errors:[]});
// Preserve the published domain input contracts while Core supplies trusted identity.
const catalogSchemas = new Map(listTools().map(tool => [tool.operation, tool.parameters]));
const catalogCapability = (name, operation, sideEffect='write') => capability(name, operation, catalogSchemas.get(operation), sideEffect);
const definitions = {
  workspace:[
    catalogCapability('merge','workspace_merge'),
    capability('save','workspace_save',object({resolved:{type:'boolean'},material_ids:ids})),
    capability('status','workspace_status',object({}),'read'),
    capability('diff','workspace_current_diff',object({}),'read'),
    capability('view','workspace_public_view',object({}),'read'),
    capability('read','workspace_public_read',object({path:text,revision:text,max_bytes:{type:'integer',minimum:1,maximum:1000000}},['path']),'read'),
    capability('files','workspace_public_files',object({path:text,revision:text,limit:{type:'integer',minimum:1,maximum:100},cursor:text}),'read'),
  ],
  context:[
    catalogCapability('publish','context_publish_material'),
    catalogCapability('view','context_get_material','read'),
    catalogCapability('list','read_materials','read'),
    capability('consume','consume_materials',object({material_ids:ids,action:{enum:['route','task','workspace','integration']},impact:text},['material_ids','action','impact'])),
  ],
  judge:[
    catalogCapability('check','workspace_check'),
    {...catalogCapability('result','get_check_result','read'),output_schema:{type:['object','null']}},
  ],
  task:[
    catalogCapability('link','task_link_material'),
    catalogCapability('finish','task_finish'),
  ],
};

/** Host composition only. Task policy and durable publication remain outside Core. */
export function createFlatPublicationServices({ runtime, taskService, contextService, missionId, missionWorkspace, workspaceId,
  profile='researcher', deadline, onFinish=()=>{}, snapshotProject, judgeService = null, workspaceProjectCheck = false, workspaceMergeChecker = null }) {
  if (!runtime || !taskService || !contextService || !missionWorkspace || typeof missionId!=='string' || !missionId ||
      typeof workspaceId!=='string' || !workspaceId || typeof deadline!=='function' || typeof onFinish!=='function') fail('INVALID_CONTRACT','Flat publication requires trusted Runtime, stores and finite Mission budget');
  if (typeof workspaceProjectCheck!=='boolean') fail('INVALID_CONTRACT','Flat Judge project mode must be boolean');
  if (judgeService && (judgeService.taskService !== taskService || typeof judgeService.dispatch !== 'function')) fail('INVALID_CONTRACT','Flat Judge and Task authority must match');
  const getRuntime=()=>typeof runtime==='function'?runtime():runtime;
  const requests=new Map();
  const judgeCalls=new Map();
  const mergeCalls=new Map();
  const judgeStatus=()=>({cleanup:judgeCalls.size?'pending':'complete',pending:[...new Map([...judgeCalls.values()].map(({id,work,providerStarted,providerCompleted,...receipt})=>[id,structuredClone(receipt)])).values()]});
  let closing=false;
  function binding(caller, {write=true}={}) {
    const core=getRuntime();
    if (closing || caller?.runtimeId!==core?.id || caller.profile!==profile || typeof caller.botId!=='string') fail('NOT_ALLOWED','Flat publication caller is outside this Runtime');
    const bot=taskService.getBot(caller.botId);
    if (!bot || bot.mission_id!==missionId || bot.sandbox_id || bot.core_id===core.id || !['UNBOUND','ACTIVE'].includes(bot.state) || (write && bot.state!=='ACTIVE')) fail('NOT_ALLOWED','Flat publication requires its actual current Bot owner');
    const until=deadline();
    if (!Number.isFinite(until) || Date.now()>=until) fail('NOT_ALLOWED','Flat Mission budget elapsed');
    taskService.assertMissionResearchOpen(missionId); taskService.assertBotDeadline(bot.bot_id);
    const execution=bot.execution_id ? taskService.getExecution(bot.execution_id):null;
    if (execution && (execution.owner_ref!==bot.bot_id || execution.state!=='RUNNING' || Date.now()>=Date.parse(execution.lease_expires_at) || taskService.getTask(execution.task_id)?.spec_version!==execution.spec_version)) fail('NOT_ALLOWED','Flat Execution ownership or lease changed');
    return {core,bot,execution};
  }
  const workspace = new ExecutionWorkspace({taskService,contextService,workspace:missionWorkspace,
    sandboxManager:{async snapshotBotProject({executionId}) {
      if(typeof snapshotProject!=='function') fail('SERVICE_NOT_READY','No supported trusted live Core snapshot binding is configured');
      const execution=taskService.getExecution(executionId);
      return snapshotProject({botId:execution.owner_ref,executionId,fencingVersion:execution.fencing_version});
    }},
    guard: assertWorkspace,
  });
  function assertWorkspace(identity,{receiptOnly=false}={}) {
    const execution=taskService.getExecution(identity.executionId), bot=taskService.getBot(identity.actorRef);
    if(!execution || !bot || execution.owner_ref!==identity.actorRef || execution.task_id!==identity.taskId || bot.mission_id!==missionId || execution.workspace_input?.workspace_id!==workspaceId) fail('NOT_ALLOWED','Workspace provenance is outside the current flat binding');
    if(!receiptOnly) {
      identity.assertAuthorized?.();
      if(identity.signal?.aborted) fail('NOT_ALLOWED','Workspace Service call was cancelled');
      const current=binding({runtimeId:getRuntime()?.id,botId:identity.actorRef,profile});
      if(current.execution?.execution_id!==identity.executionId || execution.fencing_version!==identity.fencingVersion) fail('FENCED','Workspace Execution fence changed');
    }
    return execution;
  }
  const merge = workspaceMergeChecker ? createWorkspaceMergeService({ taskService, workspace: missionWorkspace, workspaceId,
    assertExecutionWorkspace: assertWorkspace, checker: workspaceMergeChecker }) : null;
  const mergeStatus=()=>({cleanup:mergeCalls.size || merge?.status().cleanup==='pending'?'pending':'complete',
    pending_checks:merge?.status().pending_checks??0,
    pending:[...mergeCalls.values()].map(row=>({...row}))});

  taskService.setWorkspaceDeliveryReader(({missionId:requestedMission,workspaceId:requestedWorkspace,revision})=>
    requestedMission===missionId && requestedWorkspace===workspaceId ? missionWorkspace.readDeliveryRevision({missionId,workspaceId,revision}):null);
  async function workspaceOperation(operation,input,current,id,signal,assertAuthorized) {
    if (['workspace_public_view', 'workspace_public_read', 'workspace_public_files'].includes(operation)) {
      const metadata = await missionWorkspace.get({ workspaceId, signal });
      if (metadata.mission_id !== missionId) fail('NOT_ALLOWED', 'Flat Workspace belongs to another Mission');
      if (operation === 'workspace_public_view') return metadata;
      return MISSION_WORKSPACE_READS[operation](missionWorkspace, { ...input, workspace_id: workspaceId }, signal);
    }
    if(!current.execution) fail('NOT_ALLOWED','Private Workspace operation requires an active Execution');
    if(operation==='workspace_merge') {
      if(!merge) fail('SERVICE_NOT_READY','Flat checked merge is not configured');
      return merge.merge(input,{actorRef:current.bot.bot_id,taskId:current.execution.task_id,executionId:current.execution.execution_id,
        fencingVersion:current.execution.fencing_version,requestId:id,signal,assertAuthorized});
    }
    if(typeof snapshotProject!=='function') fail('SERVICE_NOT_READY','No supported trusted live Core snapshot binding is configured');
    return workspace.dispatch(({workspace_save:'save',workspace_status:'status',workspace_current_diff:'diff'})[operation],input,
      {actorRef:current.bot.bot_id,taskId:current.execution.task_id,executionId:current.execution.execution_id,fencingVersion:current.execution.fencing_version,requestId:id,signal});
  }
  async function judgeOperation(operation,input,current,id,caller,signal,assertAuthorized,call) {
    const execution=current.execution;
    const assertCurrent=()=>{
      assertAuthorized?.();
      signal?.throwIfAborted();
      const latest=binding(caller,{write:operation==='workspace_check'});
      if(operation==='workspace_check' && (latest.execution?.workspace_input?.workspace_id!==workspaceId || taskService.getTask(latest.execution?.task_id)?.mission_id!==missionId)) fail('NOT_ALLOWED','Judge source is outside the current Flat Workspace binding');
      if(latest.execution?.execution_id!==execution?.execution_id || latest.execution?.fencing_version!==execution?.fencing_version) fail('FENCED','Flat Judge binding changed');
      return latest;
    };
    const guard=async()=>{
      assertCurrent();
      const live=await current.core.get(caller.botId);
      if(!['idle','running'].includes(live.status) || live.profile!==profile) fail('NOT_ALLOWED','Core Bot is unavailable');
      return assertCurrent();
    };
    let payload=input;
    if(operation==='workspace_check') {
      if(!execution) fail('NOT_ALLOWED','Judge checks require an active Execution');
      const source=await prepareWorkspaceCheckSource(input,{workspace:missionWorkspace,workspaceId,projectCheck:workspaceProjectCheck,guard});
      payload={source,request_key:input.request_key??id,
        ...(!source.check_mode ? {source_attestation:{task_id:execution.task_id,execution_id:execution.execution_id,path:source.path,
          revision:source.revision,workspace_revision:source.workspace_revision,workspace_id:source.workspace_id,content_hash:source.content_hash}}:{})};
    }
    const latest=await guard();
    const envelope=latest.execution?{...executionEnvelope(latest.execution,id),actor_ref:caller.botId}:makeEnvelope({actorRef:caller.botId,operationId:id});
    if(call) call.providerStarted=true;
    const result=await judgeService.dispatch(operation,payload,envelope,{assertAuthorized:assertCurrent});
    if(call) call.providerCompleted=true;
    await guard();
    if(result) {
      const task=taskService.getTask(result.target_task_id);
      if(!task || task.mission_id!==missionId) fail('NOT_ALLOWED','Judge result is outside the Bot Mission');
    }
    return agentCheckResult(result);
  }
  async function invoke(service,{capability:cap,input,caller,envelope,signal,assertAuthorized}) {
    const operation=cap.operation;
    const guardedReplay=service==='judge'||operation==='workspace_merge';
    if (!definitions[service]?.some(row=>row.operation===operation)) fail('INVALID_CONTRACT','Unknown flat publication operation');
    if (!input || typeof input!=='object' || Array.isArray(input) || ['actor_ref','owner_ref','bot_id','execution_id','fencing_version','spec_version','state_version'].some(key=>Object.hasOwn(input,key))) fail('INVALID_CONTRACT','Flat publication cannot supply trusted identity');
    if (typeof envelope?.operation_id!=='string' || !envelope.operation_id) fail('INVALID_CONTRACT','Flat publication needs stable request identity');
    const core=getRuntime();
    if (caller?.runtimeId!==core?.id || caller.profile!==profile || typeof caller.botId!=='string') fail('NOT_ALLOWED','Foreign flat caller');
    const key=stableStringify([core.id,caller.botId,envelope.operation_id]);
    const fingerprint=stableStringify({service,operation,input});
    const previous=requests.get(key);
    if (previous) {
      // Judge owns durable replay; its caller must still pass current authority.
      if(previous.fingerprint!==fingerprint) fail('CONFLICT','Flat publication request has different parameters');
      if(previous.work && !guardedReplay) return structuredClone(await previous.work);
    }
    const read=cap.side_effect==='read';
    const original=binding(caller,{write:!read});
    const live=await core.get(caller.botId);
    if (!['idle','running'].includes(live.status) || live.profile!==profile) fail('NOT_ALLOWED','Core Bot is unavailable');
    signal?.throwIfAborted();
    const current=binding(caller,{write:!read});
    if (current.execution?.execution_id!==original.execution?.execution_id || current.execution?.fencing_version!==original.execution?.fencing_version) fail('FENCED','Flat binding changed during admission');
    const joined=requests.get(key);
    if (joined) {
      if(joined.fingerprint!==fingerprint) fail('CONFLICT','Flat publication request has different parameters');
      if(joined.work && !guardedReplay) return structuredClone(await joined.work);
      if(guardedReplay && joined.work && (operation==='workspace_merge'||joined.pending)) {
        const reauthorize=()=>{
          assertAuthorized?.();signal?.throwIfAborted();
          const latest=binding(caller,{write:!read});
          if(latest.execution?.execution_id!==joined.executionId || latest.execution?.fencing_version!==joined.fencingVersion) fail('FENCED','Flat publication replay binding changed');
        };
        reauthorize();
        const result=await joined.work;
        reauthorize();
        return structuredClone(result);
      }
    }
    const id=`flat:publication:${inputFingerprint([core.id,caller.botId,envelope.operation_id])}`;
    const call=service==='judge'?{id,requestId:envelope.operation_id,operation,botId:caller.botId,executionId:current.execution?.execution_id??null}:null;
    const work=Promise.resolve().then(()=>{
      signal?.throwIfAborted();
      const latest=binding(caller,{write:!read});
      if(latest.execution?.execution_id!==current.execution?.execution_id || latest.execution?.fencing_version!==current.execution?.fencing_version) fail('FENCED','Flat binding changed before publication');
      const domainEnvelope=latest.execution ? {...executionEnvelope(latest.execution,id),actor_ref:caller.botId}:makeEnvelope({actorRef:caller.botId,operationId:id});
      const result=service==='judge'?judgeOperation(operation,input,latest,id,caller,signal,assertAuthorized,call):service==='workspace'?workspaceOperation(operation,input,latest,id,signal,assertAuthorized):service==='context'?contextService.dispatch(operation,input,domainEnvelope):taskService.dispatch(operation,input,domainEnvelope);
      if(operation==='task_finish') onFinish({botId:caller.botId,executionId:latest.execution.execution_id,requestId:envelope.operation_id});
      return result;
    });
    const request={fingerprint,work,pending:true,executionId:current.execution?.execution_id,fencingVersion:current.execution?.fencing_version};
    requests.set(key,request);
    if(operation==='workspace_merge') {
      mergeCalls.set(work,{requestId:envelope.operation_id,botId:caller.botId,executionId:current.execution.execution_id});
      void work.then(()=>mergeCalls.delete(work),()=>mergeCalls.delete(work));
    }
    if(service==='judge') {
      call.work=work;
      judgeCalls.set(work,call);
      void work.then(()=>{judgeCalls.delete(work);},error=>{
        // An infrastructure timeout may leave the caller-owned provider unresolved.
        if(call.providerStarted && !call.providerCompleted && !['NOT_ALLOWED','FENCED','INVALID_CONTRACT','CONFLICT','CHECKER_BUSY'].includes(error.code)) {
          call.error={code:error.code??'JUDGE_OUTCOME_UNKNOWN',message:'Judge operation has no confirmed completion receipt'};
        } else judgeCalls.delete(work);
      });
    }
    void work.then(()=>{request.pending=false;},()=>{request.pending=false;if(request.work===work) request.work=null;});
    return structuredClone(await work);
  }
  const registrations=Object.entries(definitions).filter(([id])=>id!=='judge'||judgeService).map(([id,capabilities])=>({
    manifest:{id,title:`Flat ${id}`,purpose:'Publish and read durable flat results with actual Task ownership',provider_version:'1',contract_version:'2',endpoint:{transport:'in-process'},capabilities:capabilities.filter(cap=>cap.operation!=='workspace_merge'||merge)},
    adapter:{invoke:request=>invoke(id,request)},
  }));
  return {registrations, reconcileWorkspace:(executionId,options)=>workspace.reconcile(executionId,options), close(){closing=true;if(merge) void merge.close({timeoutMs:0});return judgeStatus();}, judgeStatus, mergeStatus,
    async waitForMerges({timeoutMs}={}) {
      if(!Number.isFinite(timeoutMs)||timeoutMs<=0) fail('INVALID_CONTRACT','Merge close wait must be positive and finite');
      let timer;
      try {await Promise.race([Promise.allSettled([...mergeCalls.keys(), ...(merge?[merge.waitForSettled()]:[])]),new Promise(resolve=>{timer=setTimeout(resolve,timeoutMs);})]);}
      finally {clearTimeout(timer);}
      return mergeStatus();
    },
    async waitForJudges({timeoutMs}={}) {
      if(!Number.isFinite(timeoutMs)||timeoutMs<=0) fail('INVALID_CONTRACT','Judge close wait must be positive and finite');
      if(!judgeCalls.size) return judgeStatus();
      let timer;
      try {await Promise.race([Promise.allSettled([...judgeCalls.values()].map(call=>call.work)),new Promise(resolve=>{timer=setTimeout(resolve,timeoutMs);})]);}
      finally {clearTimeout(timer);}
      return judgeStatus();
    },
    composeTask(discovery) {
      const contribution=registrations.find(row=>row.manifest.id==='task');
      return {manifest:{...discovery.manifest,capabilities:[...discovery.manifest.capabilities,...contribution.manifest.capabilities]},
        adapter:{invoke:request=>definitions.task.some(row=>row.operation===request.capability.operation)?contribution.adapter.invoke(request):discovery.adapter.invoke(request)}};
    },
  };
}
