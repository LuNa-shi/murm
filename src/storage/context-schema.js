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
  -- Collaboration role is orthogonal to the evidence kind.  Older rows are
  -- migrated to experience, which is the least prescriptive role.
  role TEXT NOT NULL DEFAULT 'experience' CHECK (role IN ('input', 'response', 'handoff', 'experience')),
  mission_id TEXT,
  scope TEXT NOT NULL,
  evidence_state TEXT NOT NULL CHECK (evidence_state IN ('proposed', 'observed', 'checked', 'accepted', 'rejected', 'stale')),
  content_ref TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  source_task TEXT,
  source_execution TEXT,
  producer_bot_id TEXT,
  provenance_json TEXT NOT NULL,
  supersedes TEXT REFERENCES materials(material_id),
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS materials_kind_scope ON materials(kind, scope);
CREATE INDEX IF NOT EXISTS materials_source ON materials(source_task, source_execution);

CREATE TABLE IF NOT EXISTS material_relations (
  relation_id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES materials(material_id),
  replacement_material_id TEXT REFERENCES materials(material_id),
  relation_kind TEXT NOT NULL CHECK (relation_kind IN ('dispute', 'supersede')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  reason TEXT,
  actor_ref TEXT NOT NULL,
  source_task TEXT,
  source_execution TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(material_id, replacement_material_id, relation_kind, version)
);

CREATE INDEX IF NOT EXISTS material_relations_active
  ON material_relations(material_id, relation_kind, active, created_at);

CREATE TABLE IF NOT EXISTS material_consumptions (
  operation_id TEXT NOT NULL,
  material_id TEXT NOT NULL REFERENCES materials(material_id),
  reader_task TEXT NOT NULL,
  reader_execution TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('route', 'task', 'workspace', 'integration')),
  action_ref TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, material_id)
);

CREATE INDEX IF NOT EXISTS material_consumptions_reader
  ON material_consumptions(reader_task, reader_execution, action);
CREATE INDEX IF NOT EXISTS material_consumptions_material
  ON material_consumptions(material_id, action);

`;
