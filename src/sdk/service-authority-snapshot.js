import { ERROR_CODES, SwarmEnvError } from '../errors.js';
import { stableStringify } from '../protocol/envelope.js';

const capture = action => {
  try { return { value: action() }; }
  catch (error) { return { error: { code: error.code ?? ERROR_CODES.NOT_ALLOWED, message: error.message } }; }
};

/** Built only in the Task coordinator; never accepted from an Agent payload. */
export function captureServiceAuthority(tasks, envelope = null) {
  // Do not call decorated Task getters here: their Material projections call
  // Context again. This snapshot reads only the coordinator's own domain rows.
  const taskRows = tasks.db.prepare(`SELECT t.task_id, m.mission_id, t.state, t.spec_version
    FROM tasks t JOIN modern_task_records m ON m.task_id = t.task_id`).all();
  const taskMap = Object.fromEntries(taskRows.map(task => [task.task_id, { ...task }]));
  const executions = Object.fromEntries(taskRows.flatMap(({ task_id }) => tasks.listExecutions(task_id)
    .map(e => [e.execution_id, { execution_id: e.execution_id, task_id: e.task_id, owner_ref: e.owner_ref,
      state: e.state, spec_version: e.spec_version, state_version: e.state_version, fencing_version: e.fencing_version,
      lease_expires_at: e.lease_expires_at, execution_deadline: e.execution_deadline,
      handoff_deadline: e.handoff_deadline, handoff_reminder_sent_at: e.handoff_reminder_sent_at,
      workspace_input: e.workspace_input }])));
  const bot = envelope ? tasks.getBot(envelope.actor_ref) : null;
  return { envelope, bot, tasks: taskMap, executions,
    links: Object.fromEntries(taskRows.map(({ task_id }) => [task_id, tasks.listTaskMaterialIds(task_id)])),
    scope: envelope ? capture(() => tasks.materialScope(envelope)) : null,
    write_scope: envelope ? capture(() => tasks.materialScope(envelope, { write: true })) : null,
    mission_open: envelope ? capture(() => { const scope = tasks.materialScope(envelope); tasks.assertMissionResearchOpen(scope.mission_id); return scope.mission_id; }) : null,
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
    const e = this.getExecution(executionId);
    return e?.task_id === taskId && (!actorRef || e.owner_ref === actorRef) ? this.getTask(taskId)?.mission_id ?? null : null;
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
