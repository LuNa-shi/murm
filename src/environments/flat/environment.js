import { flatCoordinationPermissions } from './coordination-permissions.js';
import { createFlatMissionService } from './mission-service.js';
import { createRuntime } from '../../core/index.js';
import { ServiceRegistry } from '../../core/services.js';
import { SwarmEnvError } from '../../errors.js';
import { runWithReport } from '../shared/run-report.js';
import { createFlatTaskService, flatResearcherProfile } from './task-service.js';
import { createFlatPublicationServices } from './publication-services.js';
import { createFlatController } from './controller.js';
import { createFlatModelAccessPolicy } from './model-access-policy.js';

export const FLAT_WITHOUT_WORKSPACE_SAVE_PROMPT = '当前配置支持读取公开 Workspace 和发布 Material。请领取可通过这些能力完成的 Task，按照 Task 的真实完成条件提交结果。运行期间的私有文件只保留在 Bot 工作目录中。';

/** Trusted host entry point. Domain stores remain caller-owned and readable. */
export async function runFlatEnvironment({backend,model,image,prompt='Use the flat Services to discover, execute and truthfully finish Mission work.',
  outputDir,taskService,contextService,missionWorkspace,workspaceManager,missionId,workspaceId,deadlineAt,
  capacity=2,coordinationPermissions=[],missionCoordination=null,snapshotProject,judgeService=null,workspaceProjectCheck=false,workspaceMergeChecker=null,controller:controllerOptions={},handoff:handoffOptions={},drive,
  closeTimeoutMs=30_000,redact=value=>value,signal}) {
  if(signal!==undefined && !(signal instanceof AbortSignal)) throw new TypeError('Flat host signal must be an AbortSignal');
  const permissions=flatCoordinationPermissions(coordinationPermissions);
  const workspaceSaveAvailable=typeof snapshotProject==='function';
  let runtime,controller,discovery,publication,mission,closeDeadline;
  const result={};
  return runWithReport({outputDir,closeTimeoutMs,redact,
    async createRuntime() {
      signal?.throwIfAborted();
      if(snapshotProject!==undefined && !workspaceSaveAvailable) throw new SwarmEnvError('INVALID_CONTRACT','Flat snapshotProject must be a trusted function when supplied');
      if(contextService?.taskService!==taskService) throw new SwarmEnvError('INVALID_CONTRACT','Flat Context and Task authority must match');
      if(taskService.contextService && taskService.contextService!==contextService) throw new SwarmEnvError('INVALID_CONTRACT','Flat Task Material authority does not match');
      const readinessSignal = AbortSignal.any([AbortSignal.timeout(closeTimeoutMs), ...(signal ? [signal] : [])]);
      const workspace = await missionWorkspace.get({ workspaceId, signal: readinessSignal });
      readinessSignal.throwIfAborted();
      if (workspace.mission_id !== missionId) throw new SwarmEnvError('NOT_ALLOWED', 'Flat Workspace belongs to another Mission');
      taskService.contextService=contextService;
      discovery=createFlatTaskService({...handoffOptions,runtime:()=>runtime,taskService,contextService,missionWorkspace,workspaceManager,missionId,workspaceId,missionDeadline:()=>deadlineAt,coordinationPermissions:permissions});
      publication=createFlatPublicationServices({runtime:()=>runtime,taskService,contextService,missionWorkspace,missionId,workspaceId,deadline:()=>deadlineAt,coordinationPermissions:permissions,snapshotProject,judgeService,workspaceProjectCheck,workspaceMergeChecker,
        onFinish:()=>controller?.notify()});
      const services=new ServiceRegistry();
      services.registerService(publication.composeTask(discovery));
      for(const registration of publication.registrations.filter(row=>row.manifest.id!=='task')) services.registerService(registration);
      if(missionCoordination!==null) {
        mission=createFlatMissionService({runtime:()=>runtime,taskService,missionWorkspace,missionId,workspaceId,missionCoordination,
          coordinationPermissions:permissions,deadline:()=>deadlineAt});
        services.registerService(mission);
      }
      const researcherPrompt = workspaceSaveAvailable ? prompt : `${prompt}\n\n${FLAT_WITHOUT_WORKSPACE_SAVE_PROMPT}`;
      const researcher=flatResearcherProfile({prompt:researcherPrompt,model,image,coordinationPermissions:permissions});
      researcher.services=Object.fromEntries([
        ['task',[...discovery.manifest.capabilities,...publication.registrations.find(row=>row.manifest.id==='task').manifest.capabilities].map(row=>row.operation)],
        ...publication.registrations.filter(row=>row.manifest.id!=='task').map(row=>[row.manifest.id,row.manifest.capabilities.map(cap=>cap.operation)]),
        ...(mission?[['mission',mission.manifest.capabilities.filter(cap=>cap.operation!=='mission_submit'||permissions.includes('mission_submit')).map(cap=>cap.operation)]]:[]),
      ]);
      runtime=await createRuntime({backend,profiles:{researcher},services,maxBots:capacity,outputDir,
        modelAccessPolicy:createFlatModelAccessPolicy({runtimeId:()=>runtime?.id,taskService,missionId,deadline:()=>deadlineAt,isStopping:()=>controller?.snapshot().closing??false})});
      try {
        controller=createFlatController({...controllerOptions,runtime,taskService,missionId,capacity,deadlineAt,coordinationPermissions:permissions,
          workspaceSaveAvailable,afterStopped:(id,options)=>publication.reconcileWorkspace(id,options)});
      } catch(error) {
        try {
          const receipt=await runtime.close({timeoutMs:closeTimeoutMs});
          error.cleanup=receipt.cleanup;error.reportPath=receipt.reportPath;
        } catch(cleanupError) {error.cleanup='pending';error.details=[{code:cleanupError.code??'CLOSE_FAILED',message:'Runtime cleanup after controller admission failed'}];}
        throw error;
      }
      const aborted=()=>controller.halt('host-stop');
      signal?.addEventListener('abort',aborted,{once:true});
      if(signal?.aborted) aborted();
      return {id:runtime.id,async close(options) {
        signal?.removeEventListener('abort',aborted);
        controller.halt();
        mission?.close();
        closeDeadline=Date.now()+Math.min(closeTimeoutMs,options.timeoutMs);
        const judgeStatus=publication.close();
        if(judgeService) result.judge=judgeStatus;
        if(workspaceMergeChecker) result.workspaceMerge=publication.mergeStatus();
        await discovery.close({timeoutMs:Math.min(closeTimeoutMs,options.timeoutMs)});
        return runtime.close(options);
      }};
    },
    async afterClose(receipt) {
      try {
        await controller.reconcileClose(receipt);
        if(workspaceMergeChecker) {
          result.workspaceMerge=await publication.waitForMerges({timeoutMs:Math.max(1,closeDeadline-Date.now()-1)});
          if(result.workspaceMerge.cleanup!=='complete') throw new SwarmEnvError('FLAT_MERGE_CLEANUP_PENDING','Flat final-tree merge checker has no confirmed completion receipt',result.workspaceMerge);
        }
        if(judgeService) {
          result.judge=await publication.waitForJudges({timeoutMs:Math.max(1,closeDeadline-Date.now()-1)});
          if(result.judge.cleanup!=='complete') throw new SwarmEnvError('FLAT_JUDGE_CLEANUP_PENDING','Flat Judge operations have no confirmed completion receipt',result.judge);
        }
      }
      finally { Object.assign(result,controller.snapshot()); }
    },
    async run() {
      await controller.start();
      if(drive) await drive(controller,runtime);
      await controller.wait();
      Object.assign(result,controller.snapshot());
      if(result.completion!=='all-tasks-terminal' || result.failures.length) {
        const error=new SwarmEnvError('FLAT_BUSINESS_FAILED','Flat ended without complete successful Task closure',{completion:result.completion});
        error.details=[result];throw error;
      }
      return result;
    },
  });
}
