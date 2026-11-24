import { createHash } from 'node:crypto';
import { createProgrammingContract } from './programming.js';
const invalid = () => Object.assign(new Error('FLAT_PROGRAM_PROOF_INVALID'), { code: 'FLAT_PROGRAM_PROOF_INVALID' });
const hash = value => createHash('sha256').update(value).digest('hex');

/** Trusted host task/verifier port. Model source remains in required private
 * exports; public proof is a real Material plus current-owner checked revision. */
export function createFlatProgrammingWorkload({ programming }) {
  if (!programming) throw invalid();
  const program = createProgrammingContract(programming);
  const seen = new Set(), revisions = new Set();
  return Object.freeze({
    input({ peer, phase, proofKey, candidate, adopted }) {
      if (!Number.isSafeInteger(peer) || peer < 0 || peer > 4 || !Number.isSafeInteger(phase) || phase < 0 || phase > 3 ||
          typeof proofKey !== 'string' || !proofKey || !/^\d+\.\d+$/.test(candidate?.revision ?? '')) throw invalid();
      return `FLAT_PROGRAM_GROUP peer=${peer} phase=${phase}. Keep your actual current Task and Execution. Complete this programming task and independently inspect the host candidate ${candidate.revision}. ${adopted ? 'Merge all fixed Task revisions listed below in order, each with a fresh stable request ID, and remember the last returned checked main_revision.' : `Merge --from ${candidate.revision} with a fresh stable request ID, obtain trusted whole-tree PASS and remember main_revision.`} If MAIN_MOVED, inspect current state and retry the merge with a new request ID; do not fabricate success. Publish exactly one Material whose content is JSON with exactly proofKey:${proofKey}, peer:${peer}, phase:${phase}, revision:the returned fixed main_revision, programming:the requested result${adopted ? ', adopted:{materialId,sourceSha256,answersSha256} copied from the original programming proof' : ''}. Link it to your Task with role experience. Do not finish the Task in this group. Keep executable source and stdout files for required export and wait for the next explicit host followUp.${adopted ? ` The original contributor has actually stopped. First merge each of your Task’s fixed public candidate revisions ${candidate.stages.map(stage=>stage.revision).join(', ')} in order, each with its own stable request ID, so the final whole-tree check covers your complete Task contract. Read Material ${adopted.materialId} and public revision ${adopted.revision} through their normal CLI routes, preserve the original, Use material consume with action task and a truthful impact to record the actual source consumption. Copy only its original materialId and programming sourceSha256/answersSha256 into adopted; these hashes are not supplied by the host.` : ''}${program.prompt(peer, phase + 1)}`;
    },
    verifyRejected({owned,rejected}) {
      for(const row of rejected) {
        if(row.code!=='FLAT_PROGRAM_MATERIAL_MISSING'||typeof row.taskId!=='string'||typeof row.proofKey!=='string')throw invalid();
        const found=owned.context.readMaterials({producer_task_id:row.taskId}).some(material=>{
          try {const value=typeof material.content==='string'?JSON.parse(material.content):material.content;return value?.proofKey===row.proofKey;}catch{return false;}
        });
        if(found)throw invalid();
      }
    },
    async verify({ owned, botId, peer, phase, proofKey, adopted }) {
      const bot = owned.tasks.getBot(botId), execution = bot?.execution_id && owned.tasks.getExecution(bot.execution_id);
      if(bot?.state!=='ACTIVE'||!execution||execution.owner_ref!==botId||execution.state!=='RUNNING')throw invalid();
      const matches=owned.context.readMaterials({producer_task_id:execution?.task_id}).filter(material=>{
        try {const value=typeof material.content==='string'?JSON.parse(material.content):material.content;return value?.proofKey===proofKey;}catch{return false;}
      });
      if(matches.length===0)throw Object.assign(new Error('FLAT_PROGRAM_MATERIAL_MISSING'),{code:'FLAT_PROGRAM_MATERIAL_MISSING',executionId:execution.execution_id,proofKey});
      if(matches.length!==1)throw invalid();
      const materialId=matches[0].material_id;
      if(seen.has(materialId))throw invalid();
      const material = owned.context.getMaterial(materialId, { verifyIntegrity: true });
      if (!execution || execution.owner_ref !== botId || execution.state !== 'RUNNING' ||
          material?.mission_id !== owned.missionId || material.producer_task_id !== execution.task_id ||
          material.producer_execution_id !== execution.execution_id || material.producer_bot_id !== botId) throw invalid();
      let value; try { value = typeof material.content === 'string' ? JSON.parse(material.content) : material.content; } catch { throw invalid(); }
      const keys = adopted ? 'adopted,peer,phase,programming,proofKey,revision' : 'peer,phase,programming,proofKey,revision';
      if (!value || Object.keys(value).sort().join() !== keys || value.peer !== peer || value.phase !== phase || value.proofKey !== proofKey ||
          !/^\d+\.\d+$/.test(value.revision ?? '') || adopted && (value.adopted?.materialId !== adopted.materialId || Object.keys(value.adopted).sort().join() !== 'answersSha256,materialId,sourceSha256')) throw invalid();
      if (revisions.has(`${botId}:${value.revision}`)) throw invalid();
      const metadata = owned.workspace.readDeliveryRevision({ workspaceId: owned.workspaceId, missionId: owned.missionId, revision: value.revision });
      const source = metadata?.source, proof = metadata?.check;
      const task = owned.tasks.getTask(execution.task_id), required = task.completion_contract.workspace_delivery;
      const candidate=owned.candidates.find(row=>row.taskId===task.task_id);
      const phasePaths=adopted?required.paths:candidate?.stages.slice(0,phase+1).flatMap(stage=>stage.paths);
      if(!phasePaths || metadata?.parents?.[1]!==candidate.stages[phase].revision)throw invalid();
      if (source?.operation !== 'merge' || source.mission_id !== owned.missionId || source.task_id !== execution.task_id ||
          source.execution_id !== execution.execution_id || source.bot_id !== botId || source.fencing_version !== execution.fencing_version ||
          metadata.conflicts?.length || proof?.verdict !== 'PASS' || proof.checked_tree !== metadata.git_tree ||
          proof.policy?.task?.spec_version !== task.spec_version ||
          Object.entries(required.check).some(([key, expected]) => proof.checker?.[key] !== expected) ||
          phasePaths.some(path => !Object.hasOwn(metadata.files, path)) ||
          proof.check_mode === 'lean-module' || proof.check_mode === 'lean-project' && phasePaths.some(path => !proof.checked_paths?.includes(path))) throw invalid();
      if (adopted) {
        const sourceBot = owned.tasks.getBot(adopted.botId);
        const retired = owned.controller.snapshot().bots.find(row => row.botId === adopted.botId);
        const original = owned.context.getMaterial(adopted.materialId, { verifyIntegrity: true });
        let originalValue; try { originalValue=typeof original?.content === 'string' ? JSON.parse(original.content) : original?.content; } catch { throw invalid(); }
        const consumptions=owned.context.listMaterialConsumptions({reader_task:execution.task_id,action:'task'});
        if (value.adopted.sourceSha256 !== originalValue?.programming?.sourceSha256 ||
            value.adopted.answersSha256 !== originalValue?.programming?.answersSha256 ||
            !consumptions.some(row=>row.material_id===adopted.materialId && row.reader_execution===execution.execution_id && row.content_hash===original.content_hash) || sourceBot?.state !== 'CLOSED' || !retired?.released || retired.lastStop?.execution !== 'stopped' ||
            original?.content_hash !== adopted.materialHash) throw invalid();
      }
      await program.verify(peer, phase + 1, value);
      seen.add(materialId); revisions.add(`${botId}:${value.revision}`);
      return { reference: materialId, sha256: hash(JSON.stringify(material)), revision: value.revision,
        executionId: execution.execution_id, materialHash: material.content_hash,
        programming: structuredClone(value.programming), ...(adopted ? { adopted: structuredClone(value.adopted) } : {}) };
    },
  });
}
