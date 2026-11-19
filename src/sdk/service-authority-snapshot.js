import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { stableStringify } from '../protocol/envelope.js';

const capture = action => {
  try { return { value: action() }; }
  catch (error) { return { error: { code: error.code ?? ERROR_CODES.NOT_ALLOWED, message: error.message } }; }
};

/** Built only in the Task coordinator; never accepted from an Agent payload. */
export function captureServiceAuthority(tasks, envelope = null, { missionId = null, taskIds = [], provenance = true, workspace = false } = {}) {
  const bot = envelope ? tasks.getBot(envelope.actor_ref) : null;
  const scope = envelope ? capture(() => tasks.materialScope(envelope)) : null;
  missionId = scope?.value?.mission_id ?? missionId;
  const selectedTasks = [...new Set([envelope?.task_id, ...taskIds].filter(Boolean))];
  const taskMap = Object.fromEntries(selectedTasks.map(id => {
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
    .all(missionId).map(row => [row.execution_id, { task_id: row.task_id, owner_ref: row.owner_ref, mission_id: missionId }])) : {};
  return { envelope, bot, tasks: taskMap, executions, origins,
    links: Object.fromEntries(selectedTasks.map(id => [id, tasks.listTaskMaterialIds(id)])), scope,
    write_scope: envelope ? capture(() => tasks.materialScope(envelope, { write: true })) : null,
    mission_open: envelope ? capture(() => { const value = tasks.materialScope(envelope); tasks.assertMissionResearchOpen(value.mission_id); return value.mission_id; }) : null,
    correction_scope: envelope ? capture(() => tasks.assertMissionCoordination(envelope, 'unsupersede')) : null,
  };
}

export class ServiceAuthoritySnapshot {
  constructor(snapshot) { this.snapshot = snapshot; }
  getBot(id) { return this.snapshot.bot?.bot_id === id ? this.snapshot.bot : null; }
  getTask(id) { return this.snapshot.tasks[id] ?? null; }
  getExecution(id) { return this.snapshot.executions[id] ?? null; }
  listTaskMaterialIds(id) { return this.snapshot.links[id] ?? []; }
  hasTaskMaterial(taskId, materialId) { return this.listTaskMaterialIds(taskId).includes(materialId); }
  materialOriginMission(taskId, executionId, actorRef = null) {
    const origin = this.snapshot.origins?.[executionId];
    return origin?.task_id === taskId && (!actorRef || origin.owner_ref === actorRef) ? origin.mission_id : null;
  }
  #scope(envelope, key) {
    if (stableStringify(envelope) !== stableStringify(this.snapshot.envelope)) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Service authority is bound to one exact request envelope');
    }
    const result = this.snapshot[key];
    if (!result || result.error) throw new SwarmEnvError(result?.error?.code ?? ERROR_CODES.NOT_ALLOWED,
      result?.error?.message ?? 'Service authority does not authorize this request');
    const bot = this.snapshot.bot;
    const execution = this.getExecution(envelope.execution_id);
    const deadlines = bot ? [bot.hard_deadline, bot.state === 'UNBOUND' ? bot.selection_deadline : null,
      execution?.execution_deadline, execution?.lease_expires_at].filter(Boolean) : [];
    if (deadlines.some(value => !Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now())) {
      throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Service authority deadline elapsed before commit');
    }
    return result.value;
  }
  materialScope(envelope, { write = false } = {}) { return this.#scope(envelope, write ? 'write_scope' : 'scope'); }
  assertMissionCoordination(envelope, operation) {
    if (operation !== 'unsupersede') throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, 'Unsupported service coordination grant');
    return this.#scope(envelope, 'correction_scope');
  }
  assertMissionResearchOpen(missionId) {
    const open = this.snapshot.mission_open;
    if (!open || open.error || open.value !== missionId) throw new SwarmEnvError(ERROR_CODES.NOT_ALLOWED, open?.error?.message ?? 'Mission no longer admits research');
  }
  withServiceLifecycleWrite(commit) { return commit(); }
  // Dependency notifications are derived from the durable command receipt by
  // the coordinator; a peer must never synchronously call back into Task.
  notifyDependencyEvent() {}
}
