import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { leadWorkerRoles, matchesTeam } from '../harness/team.js';

const error = (code: any) => Object.assign(new Error(code), { code });
const text: any = { type: 'string', minLength: 1, maxLength: 4096 };
const id: any = { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,128}$' };
const revision: any = { type: 'integer', minimum: 0 };
const path: any = { type: 'string', pattern: '^[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*\\.[A-Za-z0-9]+$', maxLength: 256 };
const object = (properties: any, required: any = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const assignees = { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: id };
const feedback = { type: 'array', uniqueItems: true, maxItems: 16, items: { type: 'integer', minimum: 1 } };
const task: any = { subtask_id: id, expected_revision: revision };
const proof = object({ commit: { type: 'string', pattern: '^[a-f0-9]{40}$' }, path, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, bytes: { type: 'integer', minimum: 0, maximum: 1048576 } });
const schemas: any = {
  read: object({}), list_subtasks: object({ state: { enum: ['ready', 'claimed', 'landed', 'complete'] } }, []),
  announce: object({ text, feedback_ids: feedback, user_input_id: id }, ['text', 'feedback_ids']),
  assign: object({ helper_id: id, text }), create_subtask: object({ id, title: text, path }),
  claim: object(task), update_subtask: object({ ...task, text }),
  note: object({ text, subtask_id: id }, ['text']),
  landed: object({ ...task, direction_id: { type: 'integer', minimum: 1 }, delivery: proof }),
  complete: object({ ...task, direction_id: { type: 'integer', minimum: 1 }, delivery: proof }),
};
export const boardPermissions = Object.freeze({ lead: ['read', 'list_subtasks', 'announce', 'assign', 'create_subtask', 'update_subtask', 'note'], helper: ['read', 'list_subtasks', 'create_subtask', 'claim', 'update_subtask', 'note', 'landed', 'complete'] });
const canonical = (value: any): any => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map((item: any) => JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(value).sort().map((key: any) => [key, JSON.parse(canonical(value[key]))])) : value);

export const dynamicBoardPermissions = Object.freeze({
  lead: [...boardPermissions.lead, 'submit'],
  helper: boardPermissions.helper.filter(operation => operation !== 'create_subtask'),
});

export const projectBoardPermissions = Object.freeze({ ...boardPermissions, lead: [...boardPermissions.lead, 'submit'] });

const dynamicSchemas = { ...schemas,
  create_subtask: object({ id, title: text, path, assignee_ids: assignees }),
  submit: object({ delivery: proof, feedback_ids: feedback }),
};

/** One bounded durable run. No lease expiry, reassignment or owner reclamation. */
export function createBoard({ path: databasePath, runId, helperCount, verifyDelivery, dynamic = false, project = false, submissionPath }: any) {
  const roles = leadWorkerRoles(helperCount);
  const helperRoles = roles.slice(1);
  const permissions = dynamic ? dynamicBoardPermissions : project ? projectBoardPermissions : boardPermissions;
  const capabilities = dynamic ? dynamicSchemas : project ? { ...schemas, submit: dynamicSchemas.submit } : schemas;
  const listeners = new Set<() => void>();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(runId ?? '') || typeof databasePath !== 'string' || typeof verifyDelivery !== 'function') throw new TypeError('Board requires run, database and delivery verifier');
  const db: any = new DatabaseSync(databasePath); db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS board_state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts (actor TEXT, request TEXT, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(actor,request));');
  const initial: any = { runId, team: null, runtimeId: null, directions: [], assignments: [], subtasks: [], notes: [], reads: [], userInputs: [], history: [], failures: {}, fenced: false, ...(dynamic ? { members: {} } : {}), ...(dynamic || project ? { submitted: null } : {}) };
  db.prepare('INSERT OR IGNORE INTO board_state VALUES (1, ?)').run(JSON.stringify(initial));
  let closed = false; let retained: any; let memoryFenced = false;
  const load = () => closed ? structuredClone(retained) : JSON.parse(db.prepare('SELECT body FROM board_state WHERE id=1').get().body);
  if (load().runId !== runId) { db.close(); throw new TypeError('Board belongs to another run'); }
  function transaction(work: any) {
    if (closed) throw error('BOARD_FENCED');
    db.exec('BEGIN IMMEDIATE');
    try {
      const state = load(); const result = work(state);
      if (state.history.length > 512 || Buffer.byteLength(JSON.stringify(state)) > 2 * 1024 ** 2) throw error('BOARD_LIMIT');
      db.prepare('UPDATE board_state SET body=? WHERE id=1').run(JSON.stringify(state)); db.exec('COMMIT');
      for (const listener of listeners) queueMicrotask(listener);
      return structuredClone(result);
    } catch (failure: any) { db.exec('ROLLBACK'); throw failure; }
  }
  const event = (state: any, type: any, actor: any, input: any) => { const row: any = { seq: state.history.length + 1, type, actor, ...structuredClone(input) }; state.history.push(row); return row; };
  function authorize(state: any, caller: any, operation: any) {
    const member = dynamic ? state.members[caller.agentId] : undefined;
    const profile = dynamic ? member?.profile : state.team && roles.find((name: any) => state.team[name] === caller.agentId);
    const role: 'lead' | 'helper' = (dynamic ? member?.role : profile) === 'lead' ? 'lead' : 'helper';
    if (!profile || dynamic && !member.ready || state.runtimeId !== caller.runtimeId || caller.profile !== profile || caller.binding !== `${runId}:board` || !permissions[role].includes(operation)) throw error('NOT_ALLOWED');
    if ((memoryFenced || state.fenced) && !['read', 'list_subtasks'].includes(operation)) throw error('BOARD_FENCED');
    return role;
  }
  function owned(state: any, caller: any, input: any, role: any) {
    const row = state.subtasks.find((row: any) => row.id === input.subtask_id); if (!row) throw error('NOT_FOUND');
    if (row.owner ? row.owner !== caller.agentId : role !== 'lead') throw error('NOT_ALLOWED');
    if (row.revision !== input.expected_revision) throw error('CONFLICT');
    return row;
  }
  function deliveryGuard(state: any, caller: any, input: any, role: any) {
    const row = owned(state, caller, input, role);
    if (!row.owner || row.state === 'complete' || row.path !== input.delivery.path) throw error('CONFLICT');
    if (state.directions.at(-1)?.seq !== input.direction_id || !state.reads.some((read: any) => read.actor === caller.agentId && read.directionId === input.direction_id)) throw error('DIRECTION_NOT_READ');
    return row;
  }
  const registration: any = { manifest: { id: 'board', title: 'Lead-Worker Board', purpose: 'Durable direction, exclusive ownership and verified delivery', provider_version: 'lead-worker-board-1', contract_version: '2', endpoint: { transport: 'in-process' },
    capabilities: Object.entries(capabilities as Record<string, any>).map(([operation, input_schema]: any) => ({ name: operation, operation, description: `Public Board ${operation}`, help: { when: 'Read direction before claiming or completing work; never reclaim an owner' }, side_effect: ['read', 'list_subtasks'].includes(operation) ? 'read' : 'write', idempotent: true, input_schema,
      output_schema: { type: 'object', additionalProperties: true }, errors: ['NOT_ALLOWED', 'CONFLICT', 'NOT_FOUND', 'BOARD_FENCED', 'BOARD_LIMIT', 'FEEDBACK_NOT_READ', 'DIRECTION_NOT_READ', 'DELIVERY_INVALID'].map((code: any) => ({ code, retryable: false })) })) },
    adapter: { async invoke({ capability, input, envelope, caller, signal, assertAuthorized }: any) {
      const operation = capability.operation; const state = load(); const role = authorize(state, caller, operation);
      if (signal?.aborted) throw error('BOARD_FENCED');
      const fingerprint = canonical({ operation, input });
      const replay = db.prepare('SELECT fingerprint,result FROM receipts WHERE actor=? AND request=?').get(caller.agentId, envelope.operation_id);
      if (replay) { if (replay.fingerprint !== fingerprint) throw error('CONFLICT'); return JSON.parse(replay.result); }
      let delivery: any;
      if (['landed', 'complete', 'submit'].includes(operation)) {
        const subtask = operation === 'submit' ? null : deliveryGuard(state, caller, input, role);
        try { delivery = await verifyDelivery({ actor: caller.agentId, subtask: structuredClone(subtask), delivery: structuredClone(input.delivery), direction: structuredClone(state.directions.at(-1)), requireDirectionText: !dynamic && !project && state.directions.length > 1, signal }); }
        catch { throw error('DELIVERY_INVALID'); }
        if (!delivery || delivery.verified !== true || !Object.entries((input.delivery as Record<string, any>)).every(([key, value]: any) => delivery[key] === value)) throw error('DELIVERY_INVALID');
      }
      return transaction((current: any) => {
        assertAuthorized();
        const currentRole = authorize(current, caller, operation); if (signal?.aborted) throw error('BOARD_FENCED');
        const duplicate = db.prepare('SELECT fingerprint,result FROM receipts WHERE actor=? AND request=?').get(caller.agentId, envelope.operation_id);
        if (duplicate) { if (duplicate.fingerprint !== fingerprint) throw error('CONFLICT'); return JSON.parse(duplicate.result); }
        if (db.prepare('SELECT count(*) AS n FROM receipts').get().n >= 512) throw error('BOARD_LIMIT');
        if (current.history.length >= 500) throw error('BOARD_LIMIT');
        let result: any;
        if (operation === 'read') {
          const read = event(current, 'read', caller.agentId, { directionId: current.directions.at(-1)?.seq ?? null, notesThrough: current.notes.at(-1)?.seq ?? 0 }); current.reads.push(read); result = structuredClone(current);
        } else if (operation === 'list_subtasks') result = { subtasks: current.subtasks.filter((row: any) => !input.state || row.state === input.state) };
        else if (operation === 'announce') {
          if (input.feedback_ids.some((seq: any) => !current.notes.some((note: any) => note.seq === seq && note.actor !== caller.agentId) || !current.reads.some((read: any) => read.actor === caller.agentId && read.notesThrough >= seq))) throw error('FEEDBACK_NOT_READ');
          if (input.user_input_id && !current.userInputs.some((row: any) => row.requestId === input.user_input_id)) throw error('NOT_ALLOWED');
          result = event(current, 'announce', caller.agentId, input); current.directions.push(result);
        } else if (operation === 'assign') {
          if (dynamic ? current.members[input.helper_id]?.role !== 'helper' : !helperRoles.some((name: any) => current.team[name] === input.helper_id)) throw error('NOT_ALLOWED');
          result = event(current, 'assign', caller.agentId, input); current.assignments.push(result);
        } else if (operation === 'create_subtask') {
          if (current.subtasks.length >= 32) throw error('BOARD_LIMIT');
          if (current.subtasks.some((row: any) => row.id === input.id || row.path === input.path)) throw error('CONFLICT');
          if (dynamic && input.assignee_ids.some((id: string) => current.members[id]?.role !== 'helper')) throw error('NOT_ALLOWED');
          result = { ...input, owner: null, state: 'ready', revision: 0, createdBy: caller.agentId }; current.subtasks.push(result); event(current, operation, caller.agentId, { subtaskId: input.id });
        } else if (operation === 'claim') {
          result = current.subtasks.find((row: any) => row.id === input.subtask_id); if (!result) throw error('NOT_FOUND');
          if (dynamic && !result.assignee_ids.includes(caller.agentId)) throw error('NOT_ALLOWED');
          if (result.owner || result.state !== 'ready' || result.revision !== input.expected_revision) throw error('CONFLICT');
          Object.assign(result, { owner: caller.agentId, state: 'claimed', revision: result.revision + 1 }); event(current, operation, caller.agentId, { subtaskId: result.id });
        } else if (operation === 'update_subtask') {
          result = owned(current, caller, input, currentRole); if (result.state === 'complete') throw error('CONFLICT'); result.text = input.text; result.revision++; event(current, operation, caller.agentId, { subtaskId: result.id, text: input.text });
        } else if (operation === 'note') {
          if (input.subtask_id) owned(current, caller, { subtask_id: input.subtask_id, expected_revision: current.subtasks.find((row: any) => row.id === input.subtask_id)?.revision }, currentRole);
          if (current.notes.length >= 64) throw error('BOARD_LIMIT'); result = event(current, operation, caller.agentId, input); current.notes.push(result);
        } else if (operation === 'submit') {
          if (current.submitted || !current.subtasks.length || current.subtasks.some((row: any) => row.state !== 'complete')) throw error('CONFLICT');
          if ((submissionPath ?? (dynamic && !project ? 'orders.mjs' : undefined)) !== undefined &&
              input.delivery.path !== (submissionPath ?? 'orders.mjs')) throw error('DELIVERY_INVALID');
          if (!input.feedback_ids.length || input.feedback_ids.some((seq: number) =>
            !current.notes.some((note: any) => note.seq === seq && note.actor !== caller.agentId) ||
            !current.reads.some((read: any) => read.actor === caller.agentId && read.notesThrough >= seq))) throw error('FEEDBACK_NOT_READ');
          result = event(current, 'submit', caller.agentId, { delivery, feedbackIds: input.feedback_ids });
          current.submitted = result;
        } else {
          result = deliveryGuard(current, caller, input, currentRole); Object.assign(result, { state: operation, revision: result.revision + 1, directionId: input.direction_id, delivery }); event(current, operation, caller.agentId, { subtaskId: result.id, directionId: input.direction_id, delivery });
        }
        const resultBytes = Buffer.byteLength(JSON.stringify(result));
        if (Number(db.prepare('SELECT coalesce(sum(length(result)),0) AS bytes FROM receipts').get().bytes) + resultBytes > 16 * 1024 ** 2) throw error('BOARD_LIMIT');
        db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(caller.agentId, envelope.operation_id, fingerprint, JSON.stringify(result)); return result;
      });
    } } };
  return Object.freeze({
    register(services: any) { services.registerService(registration); },
    bindTeam(runtimeId: any, team: any) {
      transaction((state: any) => {
        if (state.team || typeof runtimeId !== 'string' || !runtimeId || !matchesTeam(roles, team)) throw error('NOT_ALLOWED');
        state.runtimeId = runtimeId;
        state.team = structuredClone(team);
        if (dynamic) for (const role of roles) {
          state.members[team[role]] = { agentId: team[role], profile: role, role: role === 'lead' ? 'lead' : 'helper', ready: true };
        }
      });
    },
    prepareMember({ agentId, profile, requestId, git }: {
      agentId: string; profile: string; requestId: string;
      git?: { accountId: string; username: string; branch: string };
    }) {
      transaction((state: any) => {
        if (!dynamic || !state.team || state.fenced || state.members[agentId] || Object.keys(state.members).length >= roles.length + 1) throw error('NOT_ALLOWED');
        state.members[agentId] = { agentId, profile, requestId, role: 'helper', ready: false, ...(git ? { git: structuredClone(git) } : {}) };
        event(state, 'member_preparing', agentId, { profile, requestId });
      });
    },
    readyMember(agentId: string) {
      transaction((state: any) => {
        if (!dynamic || state.fenced || !state.members[agentId] || state.members[agentId].ready) throw error('NOT_ALLOWED');
        const member = state.members[agentId];
        member.ready = true;
        state.team[member.profile] = agentId;
        event(state, 'member_ready', agentId, { profile: member.profile, requestId: member.requestId });
      });
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    registerUserInput(requestId: any, input: any) { transaction((state: any) => { if (state.fenced || typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId) || typeof input !== 'string' || Buffer.byteLength(input) > 16384 || state.userInputs.length >= 5 || state.userInputs.some((row: any) => row.requestId === requestId)) throw error('NOT_ALLOWED'); state.userInputs.push({ requestId, sha256: createHash('sha256').update(input).digest('hex') }); }); },
    fence({ agentId, code, execution = 'unknown' }: any = {}) { memoryFenced = true; transaction((state: any) => { state.fenced = true; if (agentId) { const failure: any = { code: /^[A-Za-z0-9_:-]{1,80}$/.test(code ?? '') ? code : 'AGENT_FAILED', execution: execution === 'stopped' ? 'stopped' : 'unknown' }; state.failures ??= {}; state.failures[agentId] = failure; for (const row of state.subtasks) if (row.owner === agentId && row.state !== 'complete') row.failure = failure; if (state.history.length < 512) event(state, 'failure', agentId, failure); } }); },
    snapshot: () => load(),
    close() { if (!closed) { retained = load(); db.close(); closed = true; listeners.clear(); } },
  });
}
