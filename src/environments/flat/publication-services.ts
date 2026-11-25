import { createHash } from 'node:crypto';
import { decodeFileSeed } from '../../../scripts/core-file-seed.js';
import { flatCoordinationPermissions } from './coordination-permissions.js';
import { createWorkspaceMergeService } from './workspace-merge.js';
import { MISSION_WORKSPACE_READS } from './public-workspace-reads.js';
import { prepareWorkspaceCheckSource } from './workspace-check-source.js';
import { agentCheckResult } from '../../judge/check-result.js';
import { ExecutionWorkspace, WorkspaceRequestMismatchError } from '../../runtime/execution-workspace.js';
import { SwarmEnvError } from '../../errors.js';
import { makeEnvelope, stableStringify } from '../../protocol/envelope.js';
import { inputFingerprint, executionEnvelope } from './prepare-inputs.js';
import { listTools } from '../../sdk/service-catalog.js';

const fail = (code: any, message: any) => { throw new SwarmEnvError(code, message); };
const publicationRequestId = (runtimeId: any, botId: any, requestId: any) =>
  `flat:publication:${inputFingerprint([runtimeId,botId,requestId])}`;
const text: any = { type:'string', minLength:1, maxLength:4000 };
const ids: any = { type:'array', items:text, maxItems:100, uniqueItems:true };
const object = (properties: any, required: any=[]) => ({type:'object', properties, required, additionalProperties:false});
const capability = (name: any, operation: any, input_schema: any, side_effect: any='write') => ({name, operation, input_schema,
  output_schema:{type:'object'}, side_effect, idempotent:true, description:`Flat ${name} with trusted Task provenance`,
  help:{when:'Use the current Bot Task binding; reuse the same request ID after an unknown response'}, errors:[]});
// Preserve the published domain input contracts while Core supplies trusted identity.
const catalogSchemas: any = new Map(listTools().map((tool: any) => [tool.operation, tool.parameters]));
const catalogCapability = (name: any, operation: any, sideEffect: any='write') => capability(name, operation, catalogSchemas.get(operation), sideEffect);
const coreFileSeed = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([path, data]) => [path, { encoding: 'base64', data }]));
const liveWorkspaceOperations: any = new Set(['workspace_save','workspace_apply','workspace_status','workspace_current_diff']);
const definitions: any = {
  workspace:[
    catalogCapability('merge','workspace_merge'),
    capability('save','workspace_save',object({resolved:{type:'boolean'},material_ids:ids})),
    capability('apply','workspace_apply',object({from:text},['from'])),
    capability('status','workspace_status',object({}),'read'),
    capability('diff','workspace_current_diff',object({}),'read'),
    capability('view','workspace_public_view',object({}),'read'),
    capability('read','workspace_public_read',object({path:text,revision:text,max_bytes:{type:'integer',minimum:1,maximum:1000000}},['path']),'read'),
    capability('files','workspace_public_files',object({path:text,revision:text,limit:{type:'integer',minimum:1,maximum:100},cursor:text}),'read'),
  ],
  context:[
    catalogCapability('publish','context_publish_material'),
    catalogCapability('dispute','material_dispute'),
    catalogCapability('supersede','material_supersede'),
    catalogCapability('unsupersede','material_unsupersede'),
    catalogCapability('view','context_get_material','read'),
    catalogCapability('list','read_materials','read'),
    capability('consume','consume_materials',object({material_ids:ids,action:{enum:['route','task','workspace','integration']},impact:text},['material_ids','action','impact'])),
  ],
  judge:[
    catalogCapability('check','workspace_check'),
    {...catalogCapability('result','get_check_result','read'),output_schema:{type:['object','null']}},
  ],
  task:[
    catalogCapability('feedback','task_feedback'),
    catalogCapability('link','task_link_material'),
    catalogCapability('finish','task_finish'),
  ],
};

/** Host composition only. Task policy and durable publication remain outside Core. */
export function createFlatPublicationServices({ runtime, taskService, contextService, missionId, missionWorkspace, workspaceId,
  profile='researcher', deadline, coordinationPermissions=[], onFinish=()=>{}, snapshotProject, workspaceCapture, judgeService = null, workspaceProjectCheck = false, workspaceMergeChecker = null }: any) {
  if (!runtime || !taskService || !contextService || !missionWorkspace || typeof missionId!=='string' || !missionId ||
      typeof workspaceId!=='string' || !workspaceId || typeof deadline!=='function' || typeof onFinish!=='function') fail('INVALID_CONTRACT','Flat publication requires trusted Runtime, stores and finite Mission budget');
  if (typeof workspaceProjectCheck!=='boolean') fail('INVALID_CONTRACT','Flat Judge project mode must be boolean');
  if (judgeService && (judgeService.taskService !== taskService || typeof judgeService.dispatch !== 'function')) fail('INVALID_CONTRACT','Flat Judge and Task authority must match');
  if (workspaceCapture !== undefined && workspaceCapture !== 'core') fail('INVALID_CONTRACT', 'Flat workspaceCapture must select core');
  if (workspaceCapture === 'core' && snapshotProject !== undefined) fail('INVALID_CONTRACT', 'Choose one trusted Flat capture binding');
  const captureAvailable = workspaceCapture === 'core' || typeof snapshotProject === 'function';
  const permissions=flatCoordinationPermissions(coordinationPermissions);
  const getRuntime=()=>typeof runtime==='function'?runtime():runtime;
  const requests: any=new Map();
  const judgeCalls: any=new Map();
  const mergeCalls: any=new Map();
  const judgeStatus=()=>({cleanup:judgeCalls.size?'pending':'complete',pending:[...new Map([...judgeCalls.values()].map(({id,work,providerStarted,providerCompleted,...receipt}: any)=>[id,structuredClone(receipt)])).values()]});
  let closing=false;
  function binding(caller: any, {write=true,allowUnboundRevocation=false,feedbackId}: any={}) {
    const core=getRuntime();
    if (closing || caller?.runtimeId!==core?.id || caller.profile!==profile || typeof caller.botId!=='string') fail('NOT_ALLOWED','Flat publication caller is outside this Runtime');
    const bot=taskService.getBot(caller.botId);
    if (!bot || bot.mission_id!==missionId || bot.sandbox_id || bot.core_id===core.id || !['UNBOUND','ACTIVE'].includes(bot.state) || (write && bot.state!=='ACTIVE' && !(allowUnboundRevocation && bot.state==='UNBOUND'))) fail('NOT_ALLOWED','Flat publication requires its actual current Bot owner');
    const until=deadline();
    if (!Number.isFinite(until) || Date.now()>=until) fail('NOT_ALLOWED','Flat Mission budget elapsed');
    taskService.assertMissionResearchOpen(missionId); taskService.assertBotDeadline(bot.bot_id);
    if (write && bot.state === 'UNBOUND') {
      // This is the original narrow domain exception; recheck it before replay.
      taskService.assertMissionCoordination(makeEnvelope({actorRef:bot.bot_id}), 'unsupersede');
    }
    const execution=bot.execution_id ? taskService.getExecution(bot.execution_id):null;
    if (execution && (execution.owner_ref!==bot.bot_id || execution.state!=='RUNNING' || Date.now()>=Date.parse(execution.lease_expires_at) || taskService.getTask(execution.task_id)?.spec_version!==execution.spec_version)) fail('NOT_ALLOWED','Flat Execution ownership or lease changed');
    if(feedbackId!==undefined) {
      const notification=execution&&taskService.listNotifications({missionId,recipientTaskId:execution.task_id})
        .find((row: any)=>row.notification_id===feedbackId);
      if(!notification) fail('NOT_ALLOWED','Feedback notification is outside the current Task');
      if(notification.recipient_execution_id && notification.recipient_execution_id!==execution.execution_id) {
        const addressed=taskService.getExecution(notification.recipient_execution_id);
        if(addressed && ['CREATED','RUNNING'].includes(addressed.state)) fail('NOT_ALLOWED','Feedback belongs to another active Execution');
      }
    }
    return {core,bot,execution};
  }
  function installReceipt(input: any, execution: any, receipt: any) {
    if (receipt) {
      const files = coreFileSeed(input.files);
      if (receipt.botId !== execution.owner_ref || receipt.requestId !== input.request_id ||
          receipt.digest !== decodeFileSeed(files).digest || !['installed', 'committed'].includes(receipt.phase)) {
        fail('INVALID_CONTRACT', 'Core install receipt differs from the fixed apply tree');
      }
    }
    return { request_id: input.request_id, execution_id: execution.execution_id, binding_version: execution.fencing_version,
      phase: receipt?.phase ?? 'not_found', content_hash: input.content_hash,
      fingerprint: inputFingerprint({ expected_content_hash: input.expected_content_hash, content_hash: input.content_hash }) };
  }
  const applyRecovery = new Map<string, { attempts: number; timer?: ReturnType<typeof setTimeout> }>();
  function recoverApply(executionId: string, kind?: string) {
    if (kind !== 'apply' || closing || applyRecovery.has(executionId)) return;
    const record = { attempts: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    applyRecovery.set(executionId, record);
    const retry = async () => {
      if (closing) { applyRecovery.delete(executionId); return; }
      try {
        await workspace.reconcile(executionId);
        applyRecovery.delete(executionId);
      } catch {
        record.attempts++;
        if (record.attempts < 11 && Date.now() + 1000 < deadline() && !closing) {
          record.timer = setTimeout(() => void retry(), 1000);
          record.timer.unref();
          return;
        }
        try {
          const execution = taskService.getExecution(executionId);
          taskService.requestBotStop(execution.owner_ref, 'workspace-apply-reconciliation-failed', { terminalState: 'FAILED' });
          const stopped = await getRuntime().stop(execution.owner_ref, { timeoutMs: 30000 });
          if (stopped.execution === 'stopped') await workspace.reconcile(executionId, { closedConfirmed: true });
        } catch { /* Controller close retains unconfirmed ownership and cleanup. */ }
        applyRecovery.delete(executionId);
      }
    };
    record.timer = setTimeout(() => void retry(), 1000);
    record.timer.unref();
  }
  const workspace: any = new ExecutionWorkspace({taskService,contextService,workspace:missionWorkspace,
    sandboxManager:{
      async queryBotProjectInstall(input: any) {
        const execution = taskService.getExecution(input.executionId);
        const receipt = await getRuntime().files.installStatus(execution.owner_ref, { requestId: input.request_id });
        return installReceipt(input, execution, receipt);
      },
      async installBotProject(input: any) {
        const execution = taskService.getExecution(input.executionId);
        const core = getRuntime();
        const expected = await core.files.snapshot(execution.owner_ref, { requestId: input.snapshot_request_id, paths: ['.'], includeGit: false, maxBytes: 16 * 1024 * 1024 });
        const files = coreFileSeed(input.files);
        const receipt = await core.files.install(execution.owner_ref, { requestId: input.request_id, expected, files });
        return installReceipt(input, execution, receipt);
      },
      async confirmBotProjectInstall(input: any) {
        const execution = taskService.getExecution(input.executionId);
        return installReceipt(input, execution, await getRuntime().files.confirm(execution.owner_ref, { requestId: input.request_id }));
      },
      recoverSnapshot: workspaceCapture === 'core', async snapshotBotProject({executionId,requestId}: any) {
      const execution=taskService.getExecution(executionId);
      if (workspaceCapture === 'core') {
        const core = getRuntime();
        if (typeof core?.files?.snapshot !== 'function') fail('SERVICE_NOT_READY', 'Core file snapshot capability is unavailable');
        const snapshot = await core.files.snapshot(execution.owner_ref, { requestId, paths: ['.'], includeGit: false, maxBytes: 16 * 1024 * 1024 });
        if (snapshot.botId !== execution.owner_ref || snapshot.requestId !== requestId || !Number.isSafeInteger(snapshot.version) || snapshot.version < 1) fail('INVALID_CONTRACT', 'Core snapshot receipt has a different identity');
        const decoded = decodeFileSeed(snapshot.files);
        if (decoded.digest !== snapshot.digest) fail('INVALID_CONTRACT', 'Core snapshot bytes differ from its digest');
        const digest = (bytes: any) => createHash('sha256').update(bytes).digest('hex');
        const files = Object.fromEntries(decoded.entries.map(({ path, bytes }) => [path, bytes.toString('base64')]));
        const manifest = Object.fromEntries(decoded.entries.map(({ path, bytes }) => [path, { bytes: bytes.length, content_hash: digest(bytes) }]));
        return { execution_id: executionId, binding_version: execution.fencing_version, state: 'ACTIVE', files, manifest, content_hash: digest(stableStringify(manifest)) };
      }
      if(typeof snapshotProject!=='function') fail('SERVICE_NOT_READY','No supported trusted live Core snapshot binding is configured');
      return snapshotProject({botId:execution.owner_ref,executionId,fencingVersion:execution.fencing_version,requestId});
    }},
    guard: assertWorkspace, onPending: recoverApply,
  });
  function assertWorkspace(identity: any,{receiptOnly=false}: any={}) {
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
  const merge: any = workspaceMergeChecker ? createWorkspaceMergeService({ taskService, workspace: missionWorkspace, workspaceId,
    assertExecutionWorkspace: assertWorkspace, checker: workspaceMergeChecker }) : null;
  const mergeStatus=()=>({cleanup:mergeCalls.size || merge?.status().cleanup==='pending'?'pending':'complete',
    pending_checks:merge?.status().pending_checks??0,
    pending:[...mergeCalls.values()].map((row: any)=>({...row}))});

  taskService.setWorkspaceDeliveryReader(({missionId:requestedMission,workspaceId:requestedWorkspace,revision}: any)=>
    requestedMission===missionId && requestedWorkspace===workspaceId ? missionWorkspace.readDeliveryRevision({missionId,workspaceId,revision}):null);
  async function workspaceOperation(operation: any,input: any,current: any,id: any,signal: any,assertAuthorized: any) {
    if (['workspace_public_view', 'workspace_public_read', 'workspace_public_files'].includes(operation)) {
      const metadata = await missionWorkspace.get({ workspaceId, signal });
      if (metadata.mission_id !== missionId) fail('NOT_ALLOWED', 'Flat Workspace belongs to another Mission');
      if (operation === 'workspace_public_view') return metadata;
      return (MISSION_WORKSPACE_READS as Record<string, any>)[operation](missionWorkspace, { ...input, workspace_id: workspaceId }, signal);
    }
    if(!current.execution) fail('NOT_ALLOWED','Private Workspace operation requires an active Execution');
    if(operation==='workspace_merge') {
      if(!merge) fail('SERVICE_NOT_READY','Flat checked merge is not configured');
      return merge.merge(input,{actorRef:current.bot.bot_id,taskId:current.execution.task_id,executionId:current.execution.execution_id,
        fencingVersion:current.execution.fencing_version,requestId:id,signal,assertAuthorized});
    }
    if(!captureAvailable) fail('SERVICE_NOT_READY','No supported trusted live Core snapshot binding is configured');
    return workspace.dispatch(({workspace_save:'save',workspace_apply:'apply',workspace_status:'status',workspace_current_diff:'diff'} as Record<string, string>)[operation],input,
      {actorRef:current.bot.bot_id,taskId:current.execution.task_id,executionId:current.execution.execution_id,fencingVersion:current.execution.fencing_version,requestId:id,signal,assertAuthorized});
  }
  async function judgeOperation(operation: any,input: any,current: any,id: any,caller: any,signal: any,assertAuthorized: any,call: any) {
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
    const lookupByKey=operation==='get_check_result' && input.request_key && !input.check_result_id;
    let payload=input;
    if(operation==='workspace_check') {
      if(!execution) fail('NOT_ALLOWED','Judge checks require an active Execution');
      const source: any=await prepareWorkspaceCheckSource(input,{workspace:missionWorkspace,workspaceId,projectCheck:workspaceProjectCheck,guard});
      payload={source,request_key:input.request_key??id,
        ...(!source.check_mode ? {source_attestation:{task_id:execution.task_id,execution_id:execution.execution_id,path:source.path,
          revision:source.revision,workspace_revision:source.workspace_revision,workspace_id:source.workspace_id,content_hash:source.content_hash}}:{})};
    } else if(lookupByKey) {
      payload={...input,request_key:publicationRequestId(caller.runtimeId,caller.botId,input.request_key)};
    }
    const latest=await guard();
    const envelope=latest.execution?{...executionEnvelope(latest.execution,id),actor_ref:caller.botId}:makeEnvelope({actorRef:caller.botId,operationId:id});
    if(call) call.providerStarted=true;
    let result=await judgeService.dispatch(operation,payload,envelope,{assertAuthorized:assertCurrent});
    if(lookupByKey && result===null) {
      // Explicit Judge keys are stored as supplied. Only fall back on a confirmed miss.
      await guard();
      result=await judgeService.dispatch(operation,input,envelope,{assertAuthorized:assertCurrent});
    }
    if(call) call.providerCompleted=true;
    await guard();
    if(result) {
      const task=taskService.getTask(result.target_task_id);
      if(!task || task.mission_id!==missionId) fail('NOT_ALLOWED','Judge result is outside the Bot Mission');
    }
    return agentCheckResult(result);
  }
  async function invoke(service: any,{capability:cap,input,caller,envelope,signal,assertAuthorized}: any) {
    const operation=cap.operation;
    const guardedReplay=service==='judge'||operation==='workspace_merge'||operation==='task_feedback'||['material_dispute','material_supersede','material_unsupersede'].includes(operation);
    if (!definitions[service]?.some((row: any)=>row.operation===operation)) fail('INVALID_CONTRACT','Unknown flat publication operation');
    if (!input || typeof input!=='object' || Array.isArray(input) || ['actor_ref','owner_ref','bot_id','execution_id','fencing_version','spec_version','state_version'].some((key: any)=>Object.hasOwn(input,key))) fail('INVALID_CONTRACT','Flat publication cannot supply trusted identity');
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
    const access: any={write:!read,allowUnboundRevocation:service==='context' && operation==='material_unsupersede' && permissions.includes('unsupersede'),...(operation==='task_feedback'?{feedbackId:input.notification_id}:{})};
    const original=binding(caller,access);
    const live=await core.get(caller.botId);
    if (!['idle','running'].includes(live.status) || live.profile!==profile) fail('NOT_ALLOWED','Core Bot is unavailable');
    signal?.throwIfAborted();
    const current=binding(caller,access);
    if (current.execution?.execution_id!==original.execution?.execution_id || current.execution?.fencing_version!==original.execution?.fencing_version) fail('FENCED','Flat binding changed during admission');
    const reauthorize=(expected: any)=>{
      assertAuthorized?.();signal?.throwIfAborted();
      const latest=binding(caller,access);
      if(latest.execution?.execution_id!==expected.executionId || latest.execution?.fencing_version!==expected.fencingVersion) fail('FENCED','Flat publication replay binding changed');
    };
    const joined=requests.get(key);
    if (joined) {
      if(joined.fingerprint!==fingerprint) fail('CONFLICT','Flat publication request has different parameters');
      if(joined.work && !guardedReplay) return structuredClone(await joined.work);
      if(guardedReplay && joined.work && (operation==='workspace_merge'||joined.pending)) {
        reauthorize(joined);
        const result=await joined.work;
        reauthorize(joined);
        return structuredClone(result);
      }
    }
    const id=publicationRequestId(core.id,caller.botId,envelope.operation_id);
    const call: any=service==='judge'?{id,requestId:envelope.operation_id,operation,botId:caller.botId,executionId:current.execution?.execution_id??null}:null;
    const work=Promise.resolve().then(()=>{
      signal?.throwIfAborted();
      const latest=binding(caller,access);
      if(latest.execution?.execution_id!==current.execution?.execution_id || latest.execution?.fencing_version!==current.execution?.fencing_version) fail('FENCED','Flat binding changed before publication');
      const domainEnvelope=latest.execution ? {...executionEnvelope(latest.execution,id),actor_ref:caller.botId}:makeEnvelope({actorRef:caller.botId,operationId:id});
      const result=service==='judge'?judgeOperation(operation,input,latest,id,caller,signal,assertAuthorized,call):service==='workspace'?workspaceOperation(operation,input,latest,id,signal,assertAuthorized):service==='context'?contextService.dispatch(operation,input,domainEnvelope):taskService.dispatch(operation,input,domainEnvelope);
      if(operation==='task_finish') onFinish({botId:caller.botId,executionId:latest.execution.execution_id,requestId:envelope.operation_id});
      return result;
    });
    const request: any={fingerprint,work,pending:true,executionId:current.execution?.execution_id,fencingVersion:current.execution?.fencing_version};
    requests.set(key,request);
    if(operation==='workspace_merge') {
      mergeCalls.set(work,{requestId:envelope.operation_id,botId:caller.botId,executionId:current.execution.execution_id});
      void work.then(()=>mergeCalls.delete(work),()=>mergeCalls.delete(work));
    }
    if(service==='judge') {
      call.work=work;
      judgeCalls.set(work,call);
      void work.then(()=>{judgeCalls.delete(work);},(error: any)=>{
        // An infrastructure timeout may leave the caller-owned provider unresolved.
        if(call.providerStarted && !call.providerCompleted && !['NOT_ALLOWED','FENCED','INVALID_CONTRACT','CONFLICT','CHECKER_BUSY'].includes(error.code)) {
          call.error={code:error.code??'JUDGE_OUTCOME_UNKNOWN',message:'Judge operation has no confirmed completion receipt'};
        } else judgeCalls.delete(work);
      });
    }
    void work.then(()=>{request.pending=false;},(error: any)=>{
      request.pending=false;
      if(request.work===work) request.work=null;
      // A fresh adapter can learn a different durable Workspace fingerprint
      // only by dispatching. Its rejected candidate must not shadow that
      // original request when the caller retries the correct operation.
      if(service==='workspace' && liveWorkspaceOperations.has(operation) &&
          error instanceof WorkspaceRequestMismatchError && requests.get(key)===request) requests.delete(key);
    });
    const result=await work;
    // Durable Git replay can return before its publication guard. A fresh or
    // re-entered call must recheck authority after that asynchronous lookup,
    // exactly as a joined request does. Preserve original operation failures.
    if(operation==='workspace_merge') reauthorize(request);
    return structuredClone(result);
  }
  const checkerBudgets = {
    // Judge can wait for admission and run both a preflight and a source check.
    workspace_check: (judgeService?.missionBudget?.queueWaitMs ?? 0) + 2 * (judgeService?.processTimeoutMs ?? 0),
    workspace_merge: workspaceMergeChecker?.timeoutMs ?? 0,
  };
  const registrations=Object.entries((definitions as Record<string, any>)).filter(([id]: any)=>id!=='judge'||judgeService).map(([id,capabilities]: any)=>({
    manifest:{id,title:`Flat ${id}`,purpose:'Publish and read durable flat results with actual Task ownership',provider_version:'1',contract_version:'2',endpoint:{transport:'in-process'},capabilities:capabilities.filter(({operation}: any)=>
      (operation!=='workspace_merge'||merge) && (operation!=='workspace_apply'||workspaceCapture==='core') && (!liveWorkspaceOperations.has(operation)||captureAvailable))
      .map((cap: any) => {
        const budget = checkerBudgets[cap.operation as keyof typeof checkerBudgets];
        return Number.isFinite(budget) && budget > 0
          ? { ...cap, timeout_ms: Math.min(86_400_000, Math.max(30_000, Math.ceil(budget) + 5_000)) }
          : cap;
      })},
    adapter:{invoke:(request: any)=>invoke(id,request)},
  }));
  return {registrations, reconcileWorkspace:(executionId: any,options: any)=>workspace.reconcile(executionId,options), close(){closing=true;for(const row of applyRecovery.values()) clearTimeout(row.timer);applyRecovery.clear();if(merge) void merge.close({timeoutMs:0});return judgeStatus();}, judgeStatus, mergeStatus,
    async waitForMerges({timeoutMs}: any={}) {
      if(!Number.isFinite(timeoutMs)||timeoutMs<=0) fail('INVALID_CONTRACT','Merge close wait must be positive and finite');
      let timer: any;
      try {await Promise.race([Promise.allSettled([...mergeCalls.keys(), ...(merge?[merge.waitForSettled()]:[])]),new Promise<any>((resolve: any)=>{timer=setTimeout(resolve,timeoutMs);})]);}
      finally {clearTimeout(timer);}
      return mergeStatus();
    },
    async waitForJudges({timeoutMs}: any={}) {
      if(!Number.isFinite(timeoutMs)||timeoutMs<=0) fail('INVALID_CONTRACT','Judge close wait must be positive and finite');
      if(!judgeCalls.size) return judgeStatus();
      let timer: any;
      try {await Promise.race([Promise.allSettled([...judgeCalls.values()].map((call: any)=>call.work)),new Promise<any>((resolve: any)=>{timer=setTimeout(resolve,timeoutMs);})]);}
      finally {clearTimeout(timer);}
      return judgeStatus();
    },
    composeTask(discovery: any) {
      const contribution: any=registrations.find((row: any)=>row.manifest.id==='task');
      return {manifest:{...discovery.manifest,capabilities:[...discovery.manifest.capabilities,...contribution.manifest.capabilities]},
        adapter:{invoke:(request: any)=>definitions.task.some((row: any)=>row.operation===request.capability.operation)?contribution.adapter.invoke(request):discovery.adapter.invoke(request)}};
    },
  };
}
