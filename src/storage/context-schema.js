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
  mission_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  producer_task_id TEXT,
  producer_execution_id TEXT,
  producer_bot_id TEXT,
  provenance_json TEXT NOT NULL,
  supersedes TEXT REFERENCES materials(material_id),
  title TEXT,
  summary TEXT,
  media_type TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS materials_producer ON materials(producer_task_id, producer_execution_id);
CREATE INDEX IF NOT EXISTS materials_mission_scan ON materials(mission_id);

CREATE TABLE IF NOT EXISTS material_attachments (
  material_id TEXT NOT NULL REFERENCES materials(material_id),
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY (material_id, name)
);

CREATE TABLE IF NOT EXISTS material_relations (
  relation_id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES materials(material_id),
  replacement_material_id TEXT REFERENCES materials(material_id),
  relation_kind TEXT NOT NULL CHECK (relation_kind IN ('dispute', 'supersede')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  reason TEXT,
  claim TEXT,
  actor_ref TEXT NOT NULL,
  producer_task_id TEXT,
  producer_execution_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(material_id, replacement_material_id, relation_kind, version)
);

CREATE INDEX IF NOT EXISTS material_relations_active
  ON material_relations(material_id, relation_kind, active, created_at);
CREATE INDEX IF NOT EXISTS material_relations_outgoing_scan
  ON material_relations(material_id, relation_kind, active);
CREATE INDEX IF NOT EXISTS material_relations_incoming_scan
  ON material_relations(replacement_material_id, relation_kind, active);

-- Relation revision belongs to the old Material, including after revocation.
CREATE TABLE IF NOT EXISTS material_relation_heads (
  material_id TEXT PRIMARY KEY REFERENCES materials(material_id),
  version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS material_relation_events (
  event_id TEXT PRIMARY KEY,
  relation_id TEXT NOT NULL REFERENCES material_relations(relation_id),
  material_id TEXT NOT NULL REFERENCES materials(material_id),
  action TEXT NOT NULL CHECK (action IN ('created', 'revoked')),
  operation_id TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  producer_task_id TEXT,
  producer_execution_id TEXT,
  reason TEXT NOT NULL,
  relation_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS material_relation_events_material
  ON material_relation_events(material_id, relation_version, created_at);

CREATE TABLE IF NOT EXISTS material_consumptions (
  operation_id TEXT NOT NULL,
  material_id TEXT NOT NULL REFERENCES materials(material_id),
  reader_task TEXT NOT NULL,
  reader_execution TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('route', 'task', 'workspace', 'integration')),
  action_ref TEXT,
  material_version INTEGER,
  content_hash TEXT,
  impact TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, material_id)
);

CREATE INDEX IF NOT EXISTS material_consumptions_reader
  ON material_consumptions(reader_task, reader_execution, action);
CREATE INDEX IF NOT EXISTS material_consumptions_material
  ON material_consumptions(material_id, action);
CREATE INDEX IF NOT EXISTS material_consumptions_material_scan
  ON material_consumptions(material_id);

`;
