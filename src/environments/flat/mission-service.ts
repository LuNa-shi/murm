import { SwarmEnvError } from '../../errors.js';
import { listTools } from '../../sdk/service-catalog.js';
import { makeEnvelope } from '../../protocol/envelope.js';
import { executionEnvelope, inputFingerprint } from './prepare-inputs.js';
import { flatCoordinationPermissions } from './coordination-permissions.js';

const operations=['mission_get','mission_submit','mission_submission_get'];
const deny=(message: any)=>{throw new SwarmEnvError('NOT_ALLOWED',message);};

/** A caller-owned Mission store/checker exposed through the ordinary Core Bridge. */
export function createFlatMissionService({runtime,taskService,missionWorkspace,missionId,workspaceId,
  missionCoordination,coordinationPermissions=[],profile='researcher',deadline}: any) {
  if(!runtime || !taskService || !missionWorkspace || typeof missionId!=='string' || !missionId ||
    typeof workspaceId!=='string' || !workspaceId || typeof deadline!=='function' ||
    missionCoordination?.db!==taskService.db || missionCoordination?.workspace!==missionWorkspace ||
    typeof missionCoordination?.submit!=='function' || typeof missionCoordination?.describe!=='function') {
    throw new SwarmEnvError('INVALID_CONTRACT','Flat Mission Service requires the caller-owned local Mission coordination store');
  }
  const permissions=flatCoordinationPermissions(coordinationPermissions);
  const getRuntime=()=>typeof runtime==='function'?runtime():runtime;
  let closing=false;
  function binding(caller: any,submit: any) {
    const core=getRuntime(),bot=taskService.getBot(caller?.botId);
    if(closing || caller?.runtimeId!==core?.id || caller.profile!==profile || !bot || bot.mission_id!==missionId ||
      bot.sandbox_id || bot.core_id===core.id || !['UNBOUND','ACTIVE'].includes(bot.state)) deny('Mission caller is outside its current Core binding');
    const until=deadline();
    if(!Number.isFinite(until) || Date.now()>=until) deny('Mission host deadline elapsed');
    taskService.assertBotDeadline(bot.bot_id);
    const execution=bot.execution_id?taskService.getExecution(bot.execution_id):null;
    const envelope=execution?{...executionEnvelope(execution,'flat:mission:admission'),actor_ref:bot.bot_id}:makeEnvelope({actorRef:bot.bot_id});
    if(submit) {
      if(!permissions.includes('mission_submit')) deny('Mission submission is not enabled by this host');
      const scope=taskService.assertMissionCoordination(envelope,'mission_submit');
      if(scope.mission_id!==missionId) deny('Mission coordination belongs to another Mission');
    } else taskService.materialScope(envelope,{write:false});
    return {core,bot,execution};
  }
  const manifest: any={id:'mission',title:'Flat Mission',purpose:'Inspect and explicitly submit fixed public Mission results',provider_version:'1',contract_version:'2',endpoint:{transport:'in-process'},
    capabilities:listTools('task').filter((tool: any)=>operations.includes(tool.operation)).map((tool: any)=>({
      name:tool.operation.slice(8),operation:tool.operation,description:tool.description,side_effect:tool.side_effect?'write':'read',idempotent:true,
      help:{when:'Use the configured Mission and explicit material_ids; only a host-granted coordinator may submit'},errors:[],
      input_schema:{...tool.parameters,required:(tool.parameters.required??[]).filter((field: any)=>field!=='mission_id')},output_schema:{type:tool.side_effect?'object':['object','null']},
    }))};
  return {manifest,adapter:{async invoke({capability,input,caller,envelope,signal,assertAuthorized}: any) {
    const operation=capability.operation,submit=operation==='mission_submit';
    if(!operations.includes(operation) || !input || typeof input!=='object' || Array.isArray(input)) throw new SwarmEnvError('INVALID_CONTRACT','Unsupported Mission request');
    const allowed=submit?['material_ids']:operation==='mission_get'?['mission_id']:['mission_id','submission_id'];
    if(Object.keys(input).some((key: any)=>!allowed.includes(key))) throw new SwarmEnvError('INVALID_CONTRACT','Mission request cannot select caller or checker authority');
    if(input.mission_id!==undefined && input.mission_id!==missionId) deny('Mission read belongs to another Mission');
    if(typeof envelope?.operation_id!=='string' || !envelope.operation_id) throw new SwarmEnvError('INVALID_CONTRACT','Mission request needs stable identity');
    const original=binding(caller,submit);
    function guard(write: any=submit) {
      assertAuthorized?.();signal?.throwIfAborted();
      const current=binding(caller,write);
      if(current.execution?.execution_id!==original.execution?.execution_id || current.execution?.fencing_version!==original.execution?.fencing_version) throw new SwarmEnvError('FENCED','Mission caller binding changed');
      return current;
    }
    const live=await original.core.get(original.bot.bot_id);
    if(!['idle','running'].includes(live.status) || live.profile!==profile) deny('Core Mission caller is unavailable');
    const workspace=await missionWorkspace.get({workspaceId});
    if(workspace.mission_id!==missionId) deny('Mission Workspace belongs to another Mission');
    const current=guard();
    const key=inputFingerprint([original.core.id,original.bot.bot_id,envelope.operation_id]);
    if(operation==='mission_get') return taskService.getMission(missionId);
    let submissionId=input.submission_id??null;
    if(submit) {
      const result=await missionCoordination.submit({missionId,workspaceId,actorRef:current.bot.bot_id,
        taskId:current.execution?.task_id??null,executionId:current.execution?.execution_id??null,fencingVersion:current.execution?.fencing_version??null,
        materialIds:input.material_ids,requestId:`flat:mission:${key}`});
      submissionId=result.submission_id;
    }
    const result=await missionCoordination.describe({missionId,workspaceId,submissionId,
      isStopped:()=>{const until=deadline();return closing || !Number.isFinite(until) || Date.now()>=until || taskService.isMissionStopped(missionId);}});
    // Accepted checks survive submitter closure; returning data still requires
    // the original live caller, while the read permits an accepted Mission.
    guard(false);
    return result;
  }},close(){closing=true;}};
}
