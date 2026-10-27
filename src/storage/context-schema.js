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

CREATE TABLE IF NOT EXISTS material_consumptions (
  operation_id TEXT NOT NULL,
  material_id TEXT NOT NULL REFERENCES materials(material_id),
  reader_task TEXT NOT NULL,
  reader_execution TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('route', 'task', 'candidate', 'integration')),
  action_ref TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, material_id)
);

CREATE INDEX IF NOT EXISTS material_consumptions_reader
  ON material_consumptions(reader_task, reader_execution, action);
CREATE INDEX IF NOT EXISTS material_consumptions_material
  ON material_consumptions(material_id, action);

`;
