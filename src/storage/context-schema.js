export const CONTEXT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS materials (
  material_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('assumption', 'fact', 'conjecture', 'experience', 'failure', 'artifact', 'steer', 'check_result')),
  scope TEXT NOT NULL,
  evidence_state TEXT NOT NULL CHECK (evidence_state IN ('proposed', 'observed', 'checked', 'accepted', 'rejected', 'stale')),
  content_ref TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  source_task TEXT,
  source_execution TEXT,
  provenance_json TEXT NOT NULL,
  supersedes TEXT REFERENCES materials(material_id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS materials_kind_scope ON materials(kind, scope);
CREATE INDEX IF NOT EXISTS materials_source ON materials(source_task, source_execution);

CREATE TABLE IF NOT EXISTS initial_contexts (
  execution_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  spec_version INTEGER NOT NULL,
  spec_hash TEXT NOT NULL,
  input_snapshot_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  freeze_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS initial_context_keys (
  request_key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  execution_id TEXT NOT NULL REFERENCES initial_contexts(execution_id),
  created_at TEXT NOT NULL
);
`;
