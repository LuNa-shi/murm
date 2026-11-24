import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { ServiceRegistry, createInProcessAdapter } from '@swarmenv/core/services';

const error = (code: any, message: any) => Object.assign(new Error(message), { code });
const hash = (value: any) => createHash('sha256').update(value).digest('hex');
const string = (maxLength: any) => ({ type: 'string', minLength: 1, maxLength });
const object = (properties: any) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const address = string(80);
const references: any = { type: 'array', items: address, uniqueItems: true, maxItems: 16 };
const rank = object({ textOccurrences: { type: 'integer', minimum: 1 }, incomingReferences: { type: 'integer', minimum: 0 } });
const searchResult = object({ results: { type: 'array', maxItems: 8, items: object({ address, summary: string(240), rank }) }, limit: { type: 'integer', minimum: 1, maximum: 8 } });
const record = object({ address, author: string(128), version: { const: 1 }, content: string(8192), references });
const capability = (operation: any, input_schema: any, output_schema: any) => ({ name: operation, operation, description: `${operation} immutable run content`,
  side_effect: operation === 'publish' ? 'write' : 'read', idempotent: true, help: { when: 'Share, discover and adopt peer contributions' },
  input_schema, output_schema, errors: ['CONFLICT', 'NOT_FOUND', 'NOT_ALLOWED', 'INVALID_CONTRACT'].map((code: any) => ({ code, retryable: false })) });

/** Environment-owned persistent content; no Task/Execution or private directory access. */
export function createSubstrateService({ databasePath, runId, poolSize = 3 }: any) {
  if (typeof databasePath !== 'string' || !databasePath || typeof runId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) throw new TypeError('Substrate requires a database path and bounded run ID');
  if (!Number.isSafeInteger(poolSize) || poolSize < 3 || poolSize > 8) throw new TypeError('scaleMAS pool size must be an integer from three to eight');
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const db: any = new DatabaseSync(databasePath); chmodSync(databasePath, 0o600);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS substrate_runs (run_id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS substrate_contents (address TEXT PRIMARY KEY, run_id TEXT NOT NULL, author TEXT NOT NULL, content TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS substrate_references (source TEXT NOT NULL REFERENCES substrate_contents(address), target TEXT NOT NULL REFERENCES substrate_contents(address), PRIMARY KEY(source,target));
    CREATE TABLE IF NOT EXISTS substrate_requests (run_id TEXT NOT NULL, author TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, address TEXT REFERENCES substrate_contents(address), error_code TEXT, PRIMARY KEY(run_id,author,request_id));
    CREATE TABLE IF NOT EXISTS substrate_reads (ordinal INTEGER PRIMARY KEY, run_id TEXT NOT NULL, author TEXT NOT NULL, operation TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL);`);
  let runtimeId: any; let closed = false;
  const peers: any = new Set(), retired: any = new Set();
  const read = (value: any) => {
    const row = db.prepare('SELECT * FROM substrate_contents WHERE run_id=? AND address=?').get(runId, value);
    if (!row) throw error('NOT_FOUND', 'Content is not visible in this run');
    return { address: row.address, author: row.author, version: 1, content: row.content,
      references: db.prepare('SELECT target FROM substrate_references WHERE source=? ORDER BY target').all(row.address).map((item: any) => item.target) };
  };
  const adapter = createInProcessAdapter({ async invoke({ capability, input, caller, envelope, signal }: any) {
    if (closed || !runtimeId || caller?.runtimeId !== runtimeId || caller.profile !== 'peer' || (!peers.has(caller.botId) || retired.has(caller.botId))) throw error('NOT_ALLOWED', 'Substrate caller is outside this run');
    signal?.throwIfAborted();
    const operation = capability.operation;
    if (operation === 'search') {
      const tokens = typeof input?.query === 'string' ? [...new Set(input.query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])] : [];
      if (!input || Object.keys(input).some((key: any) => !['query', 'limit'].includes(key)) || typeof input.query !== 'string' || input.query.length > 512 || !tokens.length || tokens.length > 16 ||
          !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 8) throw error('INVALID_CONTRACT', 'Search requires text and a limit between one and eight');
      const results = db.prepare('SELECT address,content FROM substrate_contents WHERE run_id=?').all(runId).map((row: any) => {
        const words = row.content.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
        const textOccurrences = words.reduce((total: any, word: any) => total + Number(tokens.includes(word)), 0);
        const incomingReferences = db.prepare('SELECT COUNT(*) AS count FROM substrate_references WHERE target=?').get(row.address).count;
        return { address: row.address, summary: row.content.slice(0, 240), rank: { textOccurrences, incomingReferences } };
      }).filter((row: any) => row.rank.textOccurrences > 0).sort((left: any, right: any) => right.rank.textOccurrences - left.rank.textOccurrences ||
        right.rank.incomingReferences - left.rank.incomingReferences || (left.address < right.address ? -1 : left.address > right.address ? 1 : 0)).slice(0, input.limit);
      db.prepare('INSERT INTO substrate_reads(run_id,author,operation,input,result) VALUES(?,?,?,?,?)').run(runId, caller.botId, operation, JSON.stringify(input), JSON.stringify(results));
      return { results, limit: input.limit };
    }
    if (operation === 'visit') {
      if (!input || Object.keys(input).length !== 1 || typeof input.address !== 'string') throw error('INVALID_CONTRACT', 'Visit requires one address');
      const result = read(input.address);
      db.prepare('INSERT INTO substrate_reads(run_id,author,operation,input,result) VALUES(?,?,?,?,?)').run(runId, caller.botId, operation, JSON.stringify(input), JSON.stringify([result.address]));
      return result;
    }
    if (operation !== 'publish' || !input || Object.keys(input).some((key: any) => !['content', 'references'].includes(key)) ||
        typeof input.content !== 'string' || !input.content.isWellFormed() || !input.content.trim() || Buffer.byteLength(input.content) > 8192 || !Array.isArray(input.references ?? []) ||
        (input.references ?? []).length > 16 || new Set(input.references ?? []).size !== (input.references ?? []).length ||
        (input.references ?? []).some((value: any) => typeof value !== 'string' || value.length > 80) ||
        typeof envelope?.operation_id !== 'string' || !envelope.operation_id || envelope.operation_id.length > 512) throw error('INVALID_CONTRACT', 'Publish requires bounded content, references and a stable request ID');
    const refs = [...(input.references ?? [])].sort();
    const fingerprint = hash(JSON.stringify({ content: input.content, references: refs }));
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = db.prepare('SELECT * FROM substrate_requests WHERE run_id=? AND author=? AND request_id=?').get(runId, caller.botId, envelope.operation_id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw error('CONFLICT', 'Publication request was reused with different content');
        if (previous.error_code) throw error(previous.error_code, 'Publication references were not visible');
        const result = read(previous.address); db.exec('COMMIT'); return result;
      }
      refs.forEach(read);
      const value = `content:${hash(JSON.stringify([runId, caller.botId, envelope.operation_id, fingerprint]))}`;
      db.prepare('INSERT INTO substrate_contents VALUES(?,?,?,?)').run(value, runId, caller.botId, input.content);
      const insert = db.prepare('INSERT INTO substrate_references VALUES(?,?)'); refs.forEach((target: any) => insert.run(value, target));
      db.prepare('INSERT INTO substrate_requests VALUES(?,?,?,?,?,?)').run(runId, caller.botId, envelope.operation_id, fingerprint, value, null);
      db.exec('COMMIT'); return read(value);
    } catch (cause: any) {
      db.exec('ROLLBACK');
      if (cause.code === 'NOT_FOUND') db.prepare('INSERT OR IGNORE INTO substrate_requests VALUES(?,?,?,?,?,?)').run(runId, caller.botId, envelope.operation_id, fingerprint, null, 'NOT_FOUND');
      throw cause;
    }
  } });
  const manifest: any = { id: 'substrate', title: 'Persistent peer content', purpose: 'Publish immutable contributions and citations within one run',
    provider_version: '1', contract_version: '2', endpoint: { transport: 'in-process' }, capabilities: [
      capability('publish', { ...object({ content: string(8192), references }), required: ['content'] }, record),
      capability('visit', object({ address }), record),
      capability('search', object({ query: string(512), limit: { type: 'integer', minimum: 1, maximum: 8 } }), searchResult),
    ] };
  const services: any = new ServiceRegistry(); services.registerService({ manifest, adapter });
  return Object.freeze({ services, manifest, adapter,
    bindRuntime(id: any) {
      if (closed || runtimeId || typeof id !== 'string' || !id) throw error('NOT_ALLOWED', 'Substrate Runtime is already bound or invalid');
      const previous = db.prepare('SELECT runtime_id FROM substrate_runs WHERE run_id=?').get(runId);
      if (previous && previous.runtime_id !== id) throw error('CONFLICT', 'Run ID belongs to another Runtime');
      db.prepare('INSERT OR IGNORE INTO substrate_runs VALUES(?,?)').run(runId, id); runtimeId = id;
    },
    bindPeer(id: any) {
      if (closed || !runtimeId || typeof id !== 'string' || !id || peers.has(id) || peers.size >= poolSize) {
        throw error('NOT_ALLOWED', 'Substrate requires distinct trusted peers within the configured pool');
      }
      peers.add(id);
    },
    retirePeer(id: any) { if (!peers.has(id)) throw error('NOT_ALLOWED', 'Unknown peer'); retired.add(id); },
    snapshot() { return { runId, runtimeId, contents: db.prepare('SELECT address FROM substrate_contents WHERE run_id=? ORDER BY address').all(runId).map((row: any) => read(row.address)),
      reads: db.prepare('SELECT author,operation,input,result FROM substrate_reads WHERE run_id=? ORDER BY ordinal').all(runId).map((row: any) => ({ ...row, input: JSON.parse(row.input), result: JSON.parse(row.result) })) }; },
    close() { if (!closed) { closed = true; db.close(); } },
  });
}
