import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';

const SENSITIVE_KEY = /(?:^|_)(?:authorization|content|credential|formal_source|password|private_key|proof|raw_transcript|secret|stderr|stdout|task_instructions|token|api_key)(?:$|_)/i;
const MAX_AGENT_STRING_LENGTH = 4_000;
const MAX_AGENT_ARRAY_LENGTH = 100;

const OBSERVATION_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS experiments (
  experiment_id TEXT PRIMARY KEY,
  root_task_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('CREATED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'FINISHED')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS observation_events (
  event_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
  sequence INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  core_id TEXT,
  session_id TEXT,
  task_id TEXT,
  execution_id TEXT,
  correlation_id TEXT,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'operator', 'agent')),
  payload_json TEXT NOT NULL,
  agent_payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (experiment_id, sequence)
);

CREATE INDEX IF NOT EXISTS observation_events_experiment_sequence
  ON observation_events(experiment_id, sequence);
CREATE INDEX IF NOT EXISTS observation_events_execution_sequence
  ON observation_events(execution_id, sequence);
CREATE INDEX IF NOT EXISTS observation_events_kind_sequence
  ON observation_events(kind, sequence);
`;

function now() {
  return new Date().toISOString();
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function parse(value) {
  return value === null || value === undefined ? null : JSON.parse(value);
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} is required`);
  return value;
}

function validateLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new TypeError('limit must be an integer between 1 and 1000');
  }
}

function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function redactForAgent(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return { redacted: true, sha256: sha256(value) };
  if (typeof value === 'string') {
    return value.length <= MAX_AGENT_STRING_LENGTH
      ? value
      : `${value.slice(0, MAX_AGENT_STRING_LENGTH)}\n[agent payload truncated]`;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_AGENT_ARRAY_LENGTH).map((item) => redactForAgent(item));
    if (value.length > MAX_AGENT_ARRAY_LENGTH) items.push(`[${value.length - MAX_AGENT_ARRAY_LENGTH} array items truncated]`);
    return items;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactForAgent(child, childKey)]));
}

function rowToEvent(row, view = 'operator') {
  if (!row) return null;
  return {
    event_id: row.event_id,
    experiment_id: row.experiment_id,
    sequence: row.sequence,
    occurred_at: row.occurred_at,
    source: row.source,
    kind: row.kind,
    core_id: row.core_id,
    session_id: row.session_id,
    task_id: row.task_id,
    execution_id: row.execution_id,
    correlation_id: row.correlation_id,
    visibility: row.visibility,
    payload: parse(view === 'agent' ? row.agent_payload_json : row.payload_json),
    payload_hash: row.payload_hash,
  };
}

function rowToExperiment(row) {
  if (!row) return null;
  return {
    experiment_id: row.experiment_id,
    root_task_id: row.root_task_id,
    status: row.status,
    started_at: row.started_at,
    ended_at: row.ended_at,
    metadata: parse(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Durable observation facts and bounded query projections for one or more
 * Experiments. Domain Services remain authoritative for Task and Execution
 * state; this store only records facts and supports monitoring queries.
 */
export class ObservationStore {
  constructor(database = ':memory:') {
    this.db = database instanceof DatabaseSync ? database : new DatabaseSync(database);
    this.db.exec(OBSERVATION_SCHEMA_SQL);
    this.events = new EventEmitter();
  }

  close() {
    this.db.close();
  }

  registerExperiment({ experimentId, rootTaskId = null, status = 'CREATED', startedAt = now(), metadata = {} }) {
    requireString(experimentId, 'experiment_id');
    if (rootTaskId !== null) requireString(rootTaskId, 'root_task_id');
    const createdAt = now();
    const existing = this.getExperiment(experimentId);
    if (existing) {
      if (existing.root_task_id !== null && existing.root_task_id !== rootTaskId && rootTaskId !== null) {
        throw new Error(`experiment already has another root_task_id: ${experimentId}`);
      }
      if (existing.root_task_id === null && rootTaskId !== null) {
        this.db.prepare('UPDATE experiments SET root_task_id = ?, updated_at = ? WHERE experiment_id = ?').run(rootTaskId, now(), experimentId);
      }
      if (existing.status !== status) {
        this.db.prepare('UPDATE experiments SET status = ?, updated_at = ? WHERE experiment_id = ?').run(status, now(), experimentId);
      }
      return this.getExperiment(experimentId);
    }
    this.db.prepare(`INSERT INTO experiments (
      experiment_id, root_task_id, status, started_at, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      experimentId, rootTaskId, status, startedAt, json(metadata), createdAt, createdAt,
    );
    return this.getExperiment(experimentId);
  }

  finishExperiment(experimentId, { status = 'FINISHED', endedAt = now() } = {}) {
    requireString(experimentId, 'experiment_id');
    const result = this.db.prepare('UPDATE experiments SET status = ?, ended_at = ?, updated_at = ? WHERE experiment_id = ?')
      .run(status, endedAt, now(), experimentId);
    if (result.changes === 0) throw new Error(`unknown experiment: ${experimentId}`);
    return this.getExperiment(experimentId);
  }

  getExperiment(experimentId) {
    requireString(experimentId, 'experiment_id');
    return rowToExperiment(this.db.prepare('SELECT * FROM experiments WHERE experiment_id = ?').get(experimentId));
  }

  listExperiments({ status = null, limit = 100 } = {}) {
    validateLimit(limit);
    const rows = status === null
      ? this.db.prepare('SELECT * FROM experiments ORDER BY started_at DESC, experiment_id DESC LIMIT ?').all(limit)
      : this.db.prepare('SELECT * FROM experiments WHERE status = ? ORDER BY started_at DESC, experiment_id DESC LIMIT ?').all(status, limit);
    return rows.map(rowToExperiment);
  }

  append({
    experimentId,
    source,
    kind,
    coreId = null,
    sessionId = null,
    taskId = null,
    executionId = null,
    correlationId = null,
    visibility = 'operator',
    occurredAt = now(),
    eventId = randomUUID(),
    sequence = null,
    payload = {},
    agentPayload = undefined,
  }) {
    requireString(experimentId, 'experiment_id');
    requireString(source, 'source');
    requireString(kind, 'kind');
    requireString(eventId, 'event_id');
    if (!['private', 'operator', 'agent'].includes(visibility)) throw new TypeError(`unsupported observation visibility: ${visibility}`);
    if (!this.getExperiment(experimentId)) throw new Error(`unknown experiment: ${experimentId}`);

    // The store may share the Task/Context database. Service loggers run
    // immediately after a Service transaction commits, and an explicit
    // observation can also be emitted while a caller owns a transaction. A
    // single insert keeps this operation composable with both cases.
    const nextSequence = sequence ?? this.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM observation_events WHERE experiment_id = ?').get(experimentId).next_sequence;
    const createdAt = now();
    const safeAgentPayload = agentPayload === undefined ? redactForAgent(payload) : redactForAgent(agentPayload);
    const payloadHash = sha256(payload);
    this.db.prepare(`INSERT INTO observation_events (
      event_id, experiment_id, sequence, occurred_at, source, kind, core_id,
      session_id, task_id, execution_id, correlation_id, visibility,
      payload_json, agent_payload_json, payload_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      eventId, experimentId, nextSequence, occurredAt, source, kind, coreId,
      sessionId, taskId, executionId, correlationId, visibility, json(payload),
      json(safeAgentPayload), payloadHash, createdAt,
    );
    const record = rowToEvent(this.db.prepare('SELECT * FROM observation_events WHERE event_id = ?').get(eventId));
    this.events.emit('event', record);
    this.events.emit(`experiment:${experimentId}`, record);
    return record;
  }

  subscribe(experimentId, listener) {
    requireString(experimentId, 'experiment_id');
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const eventName = `experiment:${experimentId}`;
    this.events.on(eventName, listener);
    return () => this.events.off(eventName, listener);
  }

  getEvent(eventId, { view = 'operator' } = {}) {
    requireString(eventId, 'event_id');
    if (!['operator', 'agent'].includes(view)) throw new TypeError(`unsupported observation view: ${view}`);
    return rowToEvent(this.db.prepare('SELECT * FROM observation_events WHERE event_id = ?').get(eventId), view);
  }

  listEvents({
    experimentId,
    afterSequence = 0,
    executionId = null,
    taskId = null,
    coreId = null,
    sessionId = null,
    source = null,
    kinds = null,
    view = 'operator',
    limit = 100,
  } = {}) {
    requireString(experimentId, 'experiment_id');
    validateLimit(limit);
    if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new TypeError('after_sequence must be a non-negative integer');
    if (!['operator', 'agent'].includes(view)) throw new TypeError(`unsupported observation view: ${view}`);
    if (kinds !== null && (!Array.isArray(kinds) || kinds.some((kind) => typeof kind !== 'string' || kind.length === 0))) {
      throw new TypeError('kinds must be an array of non-empty strings');
    }
    const conditions = ['experiment_id = ?', 'sequence > ?'];
    const params = [experimentId, afterSequence];
    for (const [column, value] of [['execution_id', executionId], ['task_id', taskId], ['core_id', coreId], ['session_id', sessionId], ['source', source]]) {
      if (value !== null) {
        requireString(value, column);
        conditions.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (kinds?.length) {
      conditions.push(`kind IN (${kinds.map(() => '?').join(', ')})`);
      params.push(...kinds);
    }
    params.push(limit + 1);
    const rows = this.db.prepare(`SELECT * FROM observation_events WHERE ${conditions.join(' AND ')} ORDER BY sequence ASC LIMIT ?`).all(...params);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map((row) => rowToEvent(row, view));
    return {
      events: page,
      next_cursor: hasMore ? page.at(-1).sequence : null,
      has_more: hasMore,
    };
  }

  countEvents(experimentId, { kind = null } = {}) {
    requireString(experimentId, 'experiment_id');
    const row = kind === null
      ? this.db.prepare('SELECT COUNT(*) AS count FROM observation_events WHERE experiment_id = ?').get(experimentId)
      : this.db.prepare('SELECT COUNT(*) AS count FROM observation_events WHERE experiment_id = ? AND kind = ?').get(experimentId, kind);
    return row.count;
  }

  #transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

export { OBSERVATION_SCHEMA_SQL, redactForAgent };
