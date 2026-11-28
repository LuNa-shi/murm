import { ERROR_CODES, MurmError } from '../../errors.js';
import { stableStringify } from '../../persistence/envelope.js';

const capture = (action: any) => {
  try { return { value: action() }; }
  catch (error: any) { return { error: { code: error.code ?? ERROR_CODES.NOT_ALLOWED, message: error.message } }; }
};

/** Built only in the Task coordinator; never accepted from an Agent payload. */
export function captureServiceAuthority(tasks: any, envelope: any = null, { missionId = null, taskIds = [], provenance = true, workspace = false }: any = {}) {
  const agent = envelope ? tasks.getAgent(envelope.actor_ref) : null;
  const scope = envelope ? capture(() => tasks.materialScope(envelope)) : null;
  missionId = scope?.value?.mission_id ?? missionId;
  const selectedTasks = [...new Set([envelope?.task_id, ...taskIds].filter(Boolean))];
  const taskMap = Object.fromEntries(selectedTasks.map((id: any) => {
    const row = tasks.db.prepare(`SELECT t.task_id, m.mission_id, t.state, t.spec_version
      FROM tasks t JOIN task_records m ON m.task_id = t.task_id WHERE t.task_id = ?`).get(id);
    return [id, row ?? null];
  }));
  const current = envelope?.execution_id ? tasks.getExecution(envelope.execution_id) : null;
  const executions = current ? { [current.execution_id]: {
    execution_id: current.execution_id, task_id: current.task_id, owner_ref: current.owner_ref,
    state: current.state, spec_version: current.spec_version, state_version: current.state_version,
    fencing_version: current.fencing_version, lease_expires_at: current.lease_expires_at,
    execution_deadline: current.execution_deadline, handoff_deadline: current.handoff_deadline,
    handoff_reminder_sent_at: current.handoff_reminder_sent_at,
    ...(workspace ? { workspace_input: current.workspace_input } : {}),
  } } : {};
  // Historical provenance needs immutable identity only, never Workspace trees,
  // contracts or live state. Unrelated Missions are excluded at the owner query.
  const origins = provenance && missionId ? Object.fromEntries(tasks.db.prepare(`
    SELECT e.execution_id, e.task_id, e.owner_ref FROM executions e
    JOIN task_records m ON m.task_id = e.task_id WHERE m.mission_id = ?`)
    .all(missionId).map((row: any) => [row.execution_id, { task_id: row.task_id, owner_ref: row.owner_ref, mission_id: missionId }])) : {};
  return { envelope, agent, tasks: taskMap, executions, origins,
    links: Object.fromEntries(selectedTasks.map((id: any) => [id, tasks.listTaskMaterialIds(id)])), scope,
    write_scope: envelope ? capture(() => tasks.materialScope(envelope, { write: true })) : null,
    mission_open: envelope ? capture(() => { const value = tasks.materialScope(envelope); tasks.assertMissionResearchOpen(value.mission_id); return value.mission_id; }) : null,
    correction_scope: envelope ? capture(() => tasks.assertMissionCoordination(envelope, 'unsupersede')) : null,
  };
}

export class ServiceAuthoritySnapshot {
  declare snapshot: any;

  constructor(snapshot: any) { this.snapshot = snapshot; }
  getAgent(id: any) { return this.snapshot.agent?.agent_id === id ? this.snapshot.agent : null; }
  getTask(id: any) { return this.snapshot.tasks[id] ?? null; }
  getExecution(id: any) { return this.snapshot.executions[id] ?? null; }
  listTaskMaterialIds(id: any) { return this.snapshot.links[id] ?? []; }
  hasTaskMaterial(taskId: any, materialId: any) { return this.listTaskMaterialIds(taskId).includes(materialId); }
  materialOriginMission(taskId: any, executionId: any, actorRef: any = null) {
    const origin = this.snapshot.origins?.[executionId];
    return origin?.task_id === taskId && (!actorRef || origin.owner_ref === actorRef) ? origin.mission_id : null;
  }
  #scope(envelope: any, key: any) {
    if (stableStringify(envelope) !== stableStringify(this.snapshot.envelope)) {
      throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Service authority is bound to one exact request envelope');
    }
    const result = this.snapshot[key];
    if (!result || result.error) throw new MurmError(result?.error?.code ?? ERROR_CODES.NOT_ALLOWED,
      result?.error?.message ?? 'Service authority does not authorize this request');
    const agent = this.snapshot.agent;
    const execution = this.getExecution(envelope.execution_id);
    const deadlines = agent ? [agent.hard_deadline, agent.state === 'UNBOUND' ? agent.selection_deadline : null,
      execution?.execution_deadline, execution?.lease_expires_at].filter(Boolean) : [];
    if (deadlines.some((value: any) => !Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now())) {
      throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Service authority deadline elapsed before commit');
    }
    return result.value;
  }
  materialScope(envelope: any, { write = false }: any = {}) { return this.#scope(envelope, write ? 'write_scope' : 'scope'); }
  assertMissionCoordination(envelope: any, operation: any) {
    if (operation !== 'unsupersede') throw new MurmError(ERROR_CODES.NOT_ALLOWED, 'Unsupported service coordination grant');
    return this.#scope(envelope, 'correction_scope');
  }
  assertMissionResearchOpen(missionId: any) {
    const open = this.snapshot.mission_open;
    if (!open || open.error || open.value !== missionId) throw new MurmError(ERROR_CODES.NOT_ALLOWED, open?.error?.message ?? 'Mission no longer admits research');
  }
  withServiceLifecycleWrite(commit: any) { return commit(); }
  // Dependency notifications are derived from the durable command receipt by
  // the coordinator; a peer must never synchronously call back into Task.
  notifyDependencyEvent() {}
}
