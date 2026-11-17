export const SERVICE_COMMIT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS service_commit_gate (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  gate_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL,
  command_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS service_commit_events (
  gate_id TEXT PRIMARY KEY, events_json TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
);`;

export const CONTEXT_PEER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS context_peer_receipts (
  gate_id TEXT PRIMARY KEY, digest TEXT NOT NULL, receipt_json TEXT NOT NULL
);`;

export const JUDGE_PEER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS judge_peer_phases (
  gate_id TEXT PRIMARY KEY, digest TEXT NOT NULL, generation TEXT NOT NULL,
  call_id TEXT NOT NULL, phase TEXT NOT NULL, receipt_json TEXT
);`;
