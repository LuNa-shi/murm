import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { makeEnvelope, stableStringify } from '../protocol/envelope.js';
import { assertNewExecutionWork } from '../task/execution-budget.js';
import { MissionSubmissionStore } from './mission-submission.js';

/** Assemble the Mission submission boundary for one in-process project. */
export function createMissionCoordination({
  taskService, contextService, workspace, workspaceId, missionId, checker, manualReview, deadline,
  isStopping = () => false, onAccepted = () => undefined, maxInfrastructureRetries = 0, maxFinalChecks, maxConcurrentFinalChecks,
}) {
  if (typeof deadline !== 'function' && !Number.isFinite(deadline)) throw new TypeError('Mission coordination requires a finite run deadline');
  if (!taskService?.db || !contextService || contextService.taskService !== taskService) {
    throw new SwarmEnvError(ERROR_CODES.SERVICE_NOT_READY, 'Mission submission requires local Task lifecycle authority for Context');
  }
  const getDeadline = typeof deadline === 'function' ? deadline : () => deadline;
  const running = () => !isStopping() && Date.now() < getDeadline();
  const acceptance = () => taskService.getMission(missionId)?.acceptance_conditions;
  const authorize = input => {
    if (input.missionId !== missionId || input.workspaceId !== workspaceId || !running()) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Mission submission requires the current running Mission and Workspace');
    }
    const execution = input.executionId ? taskService.getExecution(input.executionId) : null;
    if (input.executionId) {
      if (!execution || !Number.isSafeInteger(input.fencingVersion) || execution.fencing_version !== input.fencingVersion) {
        throw new SwarmEnvError(ERROR_CODES.FENCED, 'Mission submission requires the original Execution fence');
      }
    } else if (input.fencingVersion != null) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Unbound submission cannot carry an Execution fence');
    }
    const envelope = makeEnvelope({
      operationId: input.requestId, actorRef: input.actorRef, taskId: input.taskId,
      executionId: input.executionId, fencingVersion: input.fencingVersion,
      specVersion: execution?.spec_version, stateVersion: execution?.state_version,
    });
    const scope = taskService.assertMissionCoordination(envelope, 'mission_submit');
    if (scope.mission_id !== missionId) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Mission submission permission belongs to another Mission');
    }
    if (execution) assertNewExecutionWork(execution);
    return { acceptance: acceptance(), envelope, deadline: getDeadline() };
  };
  const snapshotMaterials = input => {
    const { envelope } = authorize(input);
    return input.materialIds.map(materialId => {
      const view = contextService.dispatch('context_get_material', { material_id: materialId }, envelope);
      const material = view.material;
      if (!material || material.mission_id !== missionId) {
        throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Submission Material must be readable in the Mission');
      }
      return {
        material_id: material.material_id, content_hash: material.content_hash, version: material.version,
        relation_version: material.relation_version, disputed: view.disputed,
        active_successor_ids: view.active_successors.map(relation => relation.replacement_material_id),
      };
    });
  };
  const validateMaterials = ({ missionId: requestedMission, materials }) => requestedMission === missionId &&
    materials.every(ref => {
      const material = contextService.getMaterial(ref.material_id, { verifyIntegrity: true });
      if (!material || material.mission_id !== missionId || material.version !== ref.version ||
          material.content_hash !== ref.content_hash) return false;
      const relations = contextService.listMaterialRelations({ mission_id: missionId, material_id: ref.material_id });
      const successors = relations.filter(row => row.material_id === ref.material_id && row.relation_kind === 'supersede').map(row => row.replacement_material_id).sort();
      const disputed = relations.some(row => row.material_id === ref.material_id && row.relation_kind === 'dispute');
      if (material.relation_version !== ref.relation_version || disputed !== ref.disputed ||
          stableStringify(successors) !== stableStringify([...ref.active_successor_ids].sort())) return false;
      if (!material.producer_task_id && !material.producer_execution_id) return true;
      return taskService.materialOriginMission(material.producer_task_id, material.producer_execution_id, material.producer_bot_id) === missionId;
    });
  const validateCompletion = submission => running() && submission.mission_id === missionId &&
    submission.workspace_id === workspaceId && stableStringify(acceptance()) === stableStringify(submission.acceptance);

  return new MissionSubmissionStore({
    database: taskService.db, workspace, authorize, snapshotMaterials, validateMaterials, validateCompletion, checker, manualReview,
    timeoutMs: checker?.timeoutMs ?? manualReview?.timeoutMs ?? 120_000, onAccepted, maxInfrastructureRetries, maxFinalChecks, maxConcurrentFinalChecks,
  });
}
