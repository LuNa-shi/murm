import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const error = code => Object.assign(new Error(code), { code });
const text = { type: 'string', minLength: 1, maxLength: 4096 };
const id = { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,128}$' };
const revision = { type: 'integer', minimum: 0 };
const path = { type: 'string', pattern: '^[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*\\.[A-Za-z0-9]+$', maxLength: 256 };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const task = { subtask_id: id, expected_revision: revision };
const proof = object({ commit: { type: 'string', pattern: '^[a-f0-9]{40}$' }, path, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, bytes: { type: 'integer', minimum: 0, maximum: 1048576 } });
const schemas = {
  read: object({}), list_subtasks: object({ state: { enum: ['ready', 'claimed', 'landed', 'complete'] } }, []),
  announce: object({ text, feedback_ids: { type: 'array', uniqueItems: true, maxItems: 16, items: { type: 'integer', minimum: 1 } }, user_input_id: id }, ['text', 'feedback_ids']),
  assign: object({ helper_id: id, text }), create_subtask: object({ id, title: text, path }),
  claim: object(task), update_subtask: object({ ...task, text }),
  note: object({ text, subtask_id: id }, ['text']),
  landed: object({ ...task, direction_id: { type: 'integer', minimum: 1 }, delivery: proof }),
  complete: object({ ...task, direction_id: { type: 'integer', minimum: 1 }, delivery: proof }),
};
export const boardPermissions = Object.freeze({ lead: ['read', 'list_subtasks', 'announce', 'assign', 'create_subtask', 'update_subtask', 'note'], helper: ['read', 'list_subtasks', 'create_subtask', 'claim', 'update_subtask', 'note', 'landed', 'complete'] });
const canonical = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);

/** One bounded durable run. No lease expiry, reassignment or owner reclamation. */
export function createBoard({ path: databasePath, runId, verifyDelivery }) {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(runId ?? '') || typeof databasePath !== 'string' || typeof verifyDelivery !== 'function') throw new TypeError('Board requires run, database and delivery verifier');
  const db = new DatabaseSync(databasePath); db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS board_state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts (actor TEXT, request TEXT, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(actor,request));');
  const initial = { runId, team: null, runtimeId: null, directions: [], assignments: [], subtasks: [], notes: [], reads: [], userInputs: [], history: [], failures: {}, fenced: false };
  db.prepare('INSERT OR IGNORE INTO board_state VALUES (1, ?)').run(JSON.stringify(initial));
  let closed = false; let retained;
  const load = () => closed ? structuredClone(retained) : JSON.parse(db.prepare('SELECT body FROM board_state WHERE id=1').get().body);
  if (load().runId !== runId) { db.close(); throw new TypeError('Board belongs to another run'); }
  function transaction(work) {
    if (closed) throw error('BOARD_FENCED');
    db.exec('BEGIN IMMEDIATE');
    try {
      const state = load(); const result = work(state);
      if (state.history.length > 512 || Buffer.byteLength(JSON.stringify(state)) > 2 * 1024 ** 2) throw error('BOARD_LIMIT');
      db.prepare('UPDATE board_state SET body=? WHERE id=1').run(JSON.stringify(state)); db.exec('COMMIT'); return structuredClone(result);
    } catch (failure) { db.exec('ROLLBACK'); throw failure; }
  }
  const event = (state, type, actor, input) => { const row = { seq: state.history.length + 1, type, actor, ...structuredClone(input) }; state.history.push(row); return row; };
  function authorize(state, caller, operation) {
    const role = state.team?.lead === caller.botId ? 'lead' : [state.team?.helper1, state.team?.helper2].includes(caller.botId) ? 'helper' : null;
    if (!role || state.runtimeId !== caller.runtimeId || caller.profile !== (role === 'lead' ? 'lead' : state.team.helper1 === caller.botId ? 'helper1' : 'helper2') || caller.binding !== `${runId}:board` || !boardPermissions[role].includes(operation)) throw error('NOT_ALLOWED');
    if (state.fenced && !['read', 'list_subtasks'].includes(operation)) throw error('BOARD_FENCED');
    return role;
  }
  function owned(state, caller, input, role) {
    const row = state.subtasks.find(row => row.id === input.subtask_id); if (!row) throw error('NOT_FOUND');
    if (row.owner ? row.owner !== caller.botId : role !== 'lead') throw error('NOT_ALLOWED');
    if (row.revision !== input.expected_revision) throw error('CONFLICT');
    return row;
  }
  function deliveryGuard(state, caller, input, role) {
    const row = owned(state, caller, input, role);
    if (!row.owner || row.state === 'complete' || row.path !== input.delivery.path) throw error('CONFLICT');
    if (state.directions.at(-1)?.seq !== input.direction_id || !state.reads.some(read => read.actor === caller.botId && read.directionId === input.direction_id)) throw error('DIRECTION_NOT_READ');
    return row;
  }
  const registration = { manifest: { id: 'board', title: 'Lead-helper Board', purpose: 'Durable direction, exclusive ownership and verified delivery', provider_version: 'lead-helper-board-1', contract_version: '2', endpoint: { transport: 'in-process' },
    capabilities: Object.entries(schemas).map(([operation, input_schema]) => ({ name: operation, operation, description: `Public Board ${operation}`, help: { when: 'Read direction before claiming or completing work; never reclaim an owner' }, side_effect: ['read', 'list_subtasks'].includes(operation) ? 'read' : 'write', idempotent: true, input_schema,
      output_schema: { type: 'object', additionalProperties: true }, errors: ['NOT_ALLOWED', 'CONFLICT', 'NOT_FOUND', 'BOARD_FENCED', 'BOARD_LIMIT', 'FEEDBACK_NOT_READ', 'DIRECTION_NOT_READ', 'DELIVERY_INVALID'].map(code => ({ code, retryable: false })) })) },
    adapter: { async invoke({ capability, input, envelope, caller, signal }) {
      const operation = capability.operation; const state = load(); const role = authorize(state, caller, operation);
      if (signal?.aborted) throw error('BOARD_FENCED');
      const fingerprint = canonical({ operation, input });
      const replay = db.prepare('SELECT fingerprint,result FROM receipts WHERE actor=? AND request=?').get(caller.botId, envelope.operation_id);
      if (replay) { if (replay.fingerprint !== fingerprint) throw error('CONFLICT'); return JSON.parse(replay.result); }
      let delivery;
      if (['landed', 'complete'].includes(operation)) {
        const subtask = deliveryGuard(state, caller, input, role);
        try { delivery = await verifyDelivery({ actor: caller.botId, subtask: structuredClone(subtask), delivery: structuredClone(input.delivery), direction: structuredClone(state.directions.at(-1)), requireDirectionText: state.directions.length > 1, signal }); }
        catch { throw error('DELIVERY_INVALID'); }
        if (!delivery || delivery.verified !== true || !Object.entries(input.delivery).every(([key, value]) => delivery[key] === value)) throw error('DELIVERY_INVALID');
      }
      return transaction(current => {
        const currentRole = authorize(current, caller, operation); if (signal?.aborted) throw error('BOARD_FENCED');
        const duplicate = db.prepare('SELECT fingerprint,result FROM receipts WHERE actor=? AND request=?').get(caller.botId, envelope.operation_id);
        if (duplicate) { if (duplicate.fingerprint !== fingerprint) throw error('CONFLICT'); return JSON.parse(duplicate.result); }
        if (db.prepare('SELECT count(*) AS n FROM receipts').get().n >= 512) throw error('BOARD_LIMIT');
        if (current.history.length >= 500) throw error('BOARD_LIMIT');
        let result;
        if (operation === 'read') {
          const read = event(current, 'read', caller.botId, { directionId: current.directions.at(-1)?.seq ?? null, notesThrough: current.notes.at(-1)?.seq ?? 0 }); current.reads.push(read); result = structuredClone(current);
        } else if (operation === 'list_subtasks') result = { subtasks: current.subtasks.filter(row => !input.state || row.state === input.state) };
        else if (operation === 'announce') {
          if (input.feedback_ids.some(seq => !current.notes.some(note => note.seq === seq && note.actor !== caller.botId) || !current.reads.some(read => read.actor === caller.botId && read.notesThrough >= seq))) throw error('FEEDBACK_NOT_READ');
          if (input.user_input_id && !current.userInputs.some(row => row.requestId === input.user_input_id)) throw error('NOT_ALLOWED');
          result = event(current, 'announce', caller.botId, input); current.directions.push(result);
        } else if (operation === 'assign') {
          if (![current.team.helper1, current.team.helper2].includes(input.helper_id)) throw error('NOT_ALLOWED');
          result = event(current, 'assign', caller.botId, input); current.assignments.push(result);
        } else if (operation === 'create_subtask') {
          if (current.subtasks.length >= 32) throw error('BOARD_LIMIT');
          if (current.subtasks.some(row => row.id === input.id || row.path === input.path)) throw error('CONFLICT');
          result = { ...input, owner: null, state: 'ready', revision: 0, createdBy: caller.botId }; current.subtasks.push(result); event(current, operation, caller.botId, { subtaskId: input.id });
        } else if (operation === 'claim') {
          result = current.subtasks.find(row => row.id === input.subtask_id); if (!result) throw error('NOT_FOUND');
          if (result.owner || result.state !== 'ready' || result.revision !== input.expected_revision) throw error('CONFLICT');
          Object.assign(result, { owner: caller.botId, state: 'claimed', revision: result.revision + 1 }); event(current, operation, caller.botId, { subtaskId: result.id });
        } else if (operation === 'update_subtask') {
          result = owned(current, caller, input, currentRole); if (result.state === 'complete') throw error('CONFLICT'); result.text = input.text; result.revision++; event(current, operation, caller.botId, { subtaskId: result.id, text: input.text });
        } else if (operation === 'note') {
          if (input.subtask_id) owned(current, caller, { subtask_id: input.subtask_id, expected_revision: current.subtasks.find(row => row.id === input.subtask_id)?.revision }, currentRole);
          if (current.notes.length >= 64) throw error('BOARD_LIMIT'); result = event(current, operation, caller.botId, input); current.notes.push(result);
        } else {
          result = deliveryGuard(current, caller, input, currentRole); Object.assign(result, { state: operation, revision: result.revision + 1, directionId: input.direction_id, delivery }); event(current, operation, caller.botId, { subtaskId: result.id, directionId: input.direction_id, delivery });
        }
        const resultBytes = Buffer.byteLength(JSON.stringify(result));
        if (Number(db.prepare('SELECT coalesce(sum(length(result)),0) AS bytes FROM receipts').get().bytes) + resultBytes > 16 * 1024 ** 2) throw error('BOARD_LIMIT');
        db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(caller.botId, envelope.operation_id, fingerprint, JSON.stringify(result)); return result;
      });
    } } };
  return Object.freeze({
    register(services) { services.registerService(registration); },
    bindTeam(runtimeId, team) { transaction(state => { if (state.team || typeof runtimeId !== 'string' || !runtimeId || Object.keys(team).sort().join() !== 'helper1,helper2,lead' || new Set(Object.values(team)).size !== 3 || Object.values(team).some(value => typeof value !== 'string' || !value)) throw error('NOT_ALLOWED'); state.runtimeId = runtimeId; state.team = structuredClone(team); }); },
    registerUserInput(requestId, input) { transaction(state => { if (state.fenced || typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId) || typeof input !== 'string' || Buffer.byteLength(input) > 16384 || state.userInputs.length >= 5 || state.userInputs.some(row => row.requestId === requestId)) throw error('NOT_ALLOWED'); state.userInputs.push({ requestId, sha256: createHash('sha256').update(input).digest('hex') }); }); },
    fence({ botId, code, execution = 'unknown' } = {}) { transaction(state => { state.fenced = true; if (botId) { const failure = { code: /^[A-Za-z0-9_:-]{1,80}$/.test(code ?? '') ? code : 'BOT_FAILED', execution: execution === 'stopped' ? 'stopped' : 'unknown' }; state.failures ??= {}; state.failures[botId] = failure; for (const row of state.subtasks) if (row.owner === botId && row.state !== 'complete') row.failure = failure; if (state.history.length < 512) event(state, 'failure', botId, failure); } }); },
    snapshot: () => load(),
    close() { if (!closed) { retained = load(); db.close(); closed = true; } },
  });
}
