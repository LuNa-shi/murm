import { createRuntime } from '../../core/index.js';
import { ServiceRegistry } from '../../core/services.js';
import { SwarmEnvError } from '../../errors.js';
import { runWithReport } from '../shared/run-report.js';
import { createFlatTaskService, flatResearcherProfile } from './task-service.js';
import { createFlatPublicationServices } from './publication-services.js';
import { createFlatController } from './controller.js';
import { createFlatModelAccessPolicy } from './model-access-policy.js';

/** Trusted host entry point. Domain stores remain caller-owned and readable.
 * The live snapshot dependency currently has no supported public Core binding;
 * callers must not substitute a legacy Runtime or model-supplied file payload. */
export async function runFlatEnvironment({backend,model,image,prompt='Use the flat Services to discover, execute and truthfully finish Mission work.',
  outputDir,taskService,contextService,missionWorkspace,workspaceManager,missionId,workspaceId,deadlineAt,
  capacity=2,snapshotProject,controller:controllerOptions={},handoff:handoffOptions={},drive,
  closeTimeoutMs=30_000,redact=value=>value}) {
  let runtime,controller,discovery,publication;
  const result={};
  return runWithReport({outputDir,closeTimeoutMs,redact,
    async createRuntime() {
      // Do not allocate a partly functional team and claim Workspace publication.
      if(typeof snapshotProject!=='function') throw new SwarmEnvError('SERVICE_NOT_READY','Flat live Workspace publication has no supported trusted Core snapshot binding');
      if(contextService?.taskService!==taskService) throw new SwarmEnvError('INVALID_CONTRACT','Flat Context and Task authority must match');
      if(taskService.contextService && taskService.contextService!==contextService) throw new SwarmEnvError('INVALID_CONTRACT','Flat Task Material authority does not match');
      taskService.contextService=contextService;
      discovery=createFlatTaskService({...handoffOptions,runtime:()=>runtime,taskService,contextService,missionWorkspace,workspaceManager,missionId,workspaceId,missionDeadline:()=>deadlineAt});
      publication=createFlatPublicationServices({runtime:()=>runtime,taskService,contextService,missionWorkspace,missionId,workspaceId,deadline:()=>deadlineAt,snapshotProject,
        onFinish:()=>controller?.notify()});
      const services=new ServiceRegistry();
      services.registerService(publication.composeTask(discovery));
      for(const registration of publication.registrations.filter(row=>row.manifest.id!=='task')) services.registerService(registration);
      const researcher=flatResearcherProfile({prompt,model,image});
      researcher.services=Object.fromEntries([
        ['task',[...discovery.manifest.capabilities,...publication.registrations.find(row=>row.manifest.id==='task').manifest.capabilities].map(row=>row.operation)],
        ...publication.registrations.filter(row=>row.manifest.id!=='task').map(row=>[row.manifest.id,row.manifest.capabilities.map(cap=>cap.operation)]),
      ]);
      runtime=await createRuntime({backend,profiles:{researcher},services,maxBots:capacity,outputDir,
        modelAccessPolicy:createFlatModelAccessPolicy({runtimeId:()=>runtime?.id,taskService,missionId,deadline:()=>deadlineAt,isStopping:()=>controller?.snapshot().closing??false})});
      try {
        controller=createFlatController({...controllerOptions,runtime,taskService,missionId,capacity,deadlineAt,afterStopped:(id,options)=>publication.reconcileWorkspace(id,options)});
      } catch(error) {
        try {
          const receipt=await runtime.close({timeoutMs:closeTimeoutMs});
          error.cleanup=receipt.cleanup;error.reportPath=receipt.reportPath;
        } catch(cleanupError) {error.cleanup='pending';error.details=[{code:cleanupError.code??'CLOSE_FAILED',message:'Runtime cleanup after controller admission failed'}];}
        throw error;
      }
      return {id:runtime.id,async close(options) {
        controller.halt();publication.close();
        await discovery.close({timeoutMs:Math.min(closeTimeoutMs,options.timeoutMs)});
        const receipt=await runtime.close(options);
        await controller.reconcileClose(receipt);
        Object.assign(result,controller.snapshot());
        return receipt;
      }};
    },
    async run() {
      await controller.start();
      if(drive) await drive(controller);
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
