import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Tiktoken } from 'js-tiktoken/lite';
import encoder from 'js-tiktoken/ranks/o200k_base';
import { createInProcessAdapter, type JsonValue, type ServiceCaller, type ServiceCapability, type ServiceManifest, type ServiceRegistry } from '@murm/core/services';
import { stableStringify } from '../../protocol/envelope.js';

export type SharingMode = 'shared' | 'private' | 'none';

type Publication = { sub_task: string; artifact: string; rationale: string; refs: string[] };
type Message = Publication & { address: string; incoming_refs: string[] };
type StoredMessage = {
  ordinal: number; address: string; scope: string; author: string; sub_task: string;
  artifact: string; rationale: string; weight: number; created_at: string; sha256: string;
};
type RequestRow = { fingerprint: string; response: string | null; error_code: string | null; error_message: string | null };

const maxRead = 8;
const maxRefs = 32;
const maxContentTokens = 1024;
export const referenceHelp = 'Give a non-empty rationale. Cite only visible contributions and task resources you actually use. For every address in refs, start a separate rationale line with the address and a space, followed by what it contributed.';
const operations = {
  search: {
    description: 'Find contributions visible to you by lemma, subgoal, or blocker. Returns matching contributions in full.',
    help: 'Provide a query with 1–64 distinct terms and a result limit.\nExample command\n  swarm substrate search --query "SUBGOAL_KEYWORDS" --limit 8',
  },
  visit: {
    description: 'Read contributions at known content addresses.',
    help: 'Use exact content addresses returned by search or publish.\nExample command\n  swarm substrate visit --input visit.json',
  },
  publish: {
    description: 'Publish reusable intermediate work in this run.',
    help: `Give sub_task and artifact as non-empty text with at most ${maxContentTokens} tokens combined. ${referenceHelp} Use refs: [] when you used no references.\nExample command\n  swarm substrate publish --input contribution.json`,
  },
};
const tokenize = (value: string) => value.normalize('NFC').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const count = (maximum: number) => ({ type: 'integer', minimum: 1, maximum });
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const addresses = (maxItems: number, minItems = 0) => ({ type: 'array', items: text(200), uniqueItems: true, minItems, maxItems });
const publication = { sub_task: text(8192), artifact: text(8192), rationale: text(8192), refs: addresses(maxRefs) };
const message = object({ address: text(200), ...publication, incoming_refs: addresses(maxRead) });
const results = object({ results: { type: 'array', maxItems: maxRead, items: message } });
const errors = ['CONFLICT', 'NOT_ALLOWED', 'NOT_FOUND', 'INVALID_CONTRACT', 'OPERATION_LIMIT'].map(code => ({ code, retryable: false }));
let tokenizer: Tiktoken | undefined;

class Rejection extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function capability(operation: keyof typeof operations, input_schema: Record<string, unknown>, output_schema: Record<string, unknown>): ServiceCapability {
  return {
    name: operation, operation, description: operations[operation].description,
    side_effect: operation === 'publish' ? 'write' : 'read', idempotent: true,
    help: { when: operations[operation].help },
    input_schema, output_schema, errors,
  };
}

export function paperSubstrateManifest(mode: Exclude<SharingMode, 'none'>): ServiceManifest {
  return {
    id: 'substrate', title: 'Substrate contributions',
    purpose: mode === 'shared' ? 'Work published by agents in this run.' : 'Your own published work in this run.',
    provider_version: '2', contract_version: '2', endpoint: { transport: 'in-process' },
    capabilities: [
      capability('publish', object(publication), message),
      capability('search', object({ query: text(512), limit: count(maxRead) }), results),
      capability('visit', object({ addresses: addresses(maxRead, 1) }), results),
    ],
  };
}

function rank(rows: StoredMessage[], query: string) {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || terms.length > 64) throw new Rejection('INVALID_CONTRACT', 'Search requires 1–64 distinct terms');
  const documents = rows.map(row => {
    const words = tokenize(`${row.sub_task}\n${row.artifact}\n${row.rationale}`);
    const frequencies = new Map<string, number>();
    for (const word of words) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
    return { row, length: words.length, frequencies };
  });
  const averageLength = documents.reduce((sum, doc) => sum + doc.length, 0) / documents.length;
  const weights = terms.map(term => {
    const df = documents.filter(doc => doc.frequencies.has(term)).length;
    return Math.log1p((documents.length - df + 0.5) / (df + 0.5));
  });
  const scores = documents.map(({ row, frequencies, length }) => {
    const bm25 = terms.reduce((sum, term, index) => {
      const tf = frequencies.get(term) ?? 0;
      if (!tf) return sum;
      return sum + weights[index] * (tf * 2.5) / (tf + 1.5 * (0.25 + 0.75 * length / averageLength));
    }, 0);
    return { row, bm25 };
  }).filter(score => score.bm25 > 0);
  const max = scores.reduce((value, score) => Math.max(value, score.bm25), 0);
  return scores.map(({ row, bm25 }) => ({ row, bm25, normalized: bm25 / max, score: bm25 / max + row.weight }))
    .sort((a, b) => b.score - a.score || a.row.ordinal - b.row.ordinal);
}

export function validateRationale(rationale: string, refs: string[]) {
  if (!rationale.isWellFormed() || !rationale.trim()) throw new Rejection('INVALID_CONTRACT', 'Provide a non-empty rationale');
  const lines = rationale.split('\n');
  for (const ref of refs) {
    if (!lines.some(line => line.startsWith(`${ref} `) && /[\p{L}\p{N}]/u.test(line.slice(ref.length + 1)))) {
      throw new Rejection('INVALID_CONTRACT', `Explain the contribution on a rationale line beginning with ${ref} followed by a space`);
    }
  }
}

interface SubstrateOptions {
  databasePath: string;
  runId: string;
  mode: Exclude<SharingMode, 'none'>;
  services: ServiceRegistry;
  authorize(caller: ServiceCaller): void;
  countOperation?(agentId: string, operation: string, requestId: string): void;
  resourceExists(agentId: string, address: string): boolean;
}

/** Versioned tables in the Environment-owned SQLite store. Legacy tables retain their own contracts. */
export function createPaperSubstrate({ databasePath, runId, mode, services, authorize, countOperation, resourceExists }: SubstrateOptions) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId) || !['shared', 'private'].includes(mode)) throw new TypeError('Invalid Substrate run or sharing mode');
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databasePath);
  let closed = false;
  let runtimeId: string | undefined;
  try {
    chmodSync(databasePath, 0o600);
    db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS paper_runs (run_id TEXT PRIMARY KEY, mode TEXT NOT NULL, runtime_id TEXT);
      CREATE TABLE IF NOT EXISTS paper_clocks (run_id TEXT NOT NULL, scope TEXT NOT NULL, tick INTEGER NOT NULL, PRIMARY KEY(run_id,scope));
      CREATE TABLE IF NOT EXISTS paper_messages (
        ordinal INTEGER PRIMARY KEY, address TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL, scope TEXT NOT NULL,
        author TEXT NOT NULL, sub_task TEXT NOT NULL, artifact TEXT NOT NULL, rationale TEXT NOT NULL,
        weight REAL NOT NULL, created_at TEXT NOT NULL, sha256 TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS paper_message_scope ON paper_messages (run_id,scope,ordinal);
      CREATE TABLE IF NOT EXISTS paper_refs (
        source TEXT NOT NULL REFERENCES paper_messages(address), target TEXT NOT NULL, ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL, PRIMARY KEY (source,target)
      );
      CREATE INDEX IF NOT EXISTS paper_ref_target ON paper_refs(target,kind);
      CREATE TABLE IF NOT EXISTS paper_requests (
        ordinal INTEGER PRIMARY KEY, run_id TEXT NOT NULL, author TEXT NOT NULL, request_id TEXT NOT NULL, operation TEXT NOT NULL,
        fingerprint TEXT NOT NULL, input TEXT NOT NULL, response TEXT, error_code TEXT, error_message TEXT,
        audit TEXT, tick INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id,author,request_id)
      );`);
    db.prepare('INSERT OR IGNORE INTO paper_runs (run_id,mode) VALUES(?,?)').run(runId, mode);
    if (db.prepare('SELECT mode FROM paper_runs WHERE run_id=?').get(runId)?.mode !== mode) throw new Rejection('CONFLICT', 'The run already uses another sharing mode');

    const scopeFor = (agentId: string) => mode === 'shared' ? '' : agentId;
    const getMessage = db.prepare('SELECT * FROM paper_messages WHERE run_id=? AND scope=? AND address=?');
    const visibleMessages = db.prepare('SELECT * FROM paper_messages WHERE run_id=? AND scope=? ORDER BY ordinal');
    const outgoing = db.prepare('SELECT target FROM paper_refs WHERE source=? ORDER BY ordinal');
    const incoming = db.prepare(`SELECT m.address FROM paper_refs r JOIN paper_messages m ON m.address=r.source
      WHERE r.target=? AND r.kind='message' AND m.run_id=? AND m.scope=? ORDER BY m.ordinal DESC LIMIT 8`);
    const requireMessage = (scope: string, address: string) => {
      const row = getMessage.get(runId, scope, address) as StoredMessage | undefined;
      if (!row) throw new Rejection('NOT_FOUND', `Contribution is not visible: ${address}`);
      return row;
    };
    const references = (agentId: string, rationale: string, refs: string[]) => {
      validateRationale(rationale, refs);
      return refs.map(address => {
        if (getMessage.get(runId, scopeFor(agentId), address)) return { address, kind: 'message' };
        if (resourceExists(agentId, address)) return { address, kind: 'resource' };
        throw new Rejection('NOT_FOUND', `Reference is not visible: ${address}`);
      });
    };
    function projection(row: StoredMessage): Message {
      return {
        address: row.address, sub_task: row.sub_task, artifact: row.artifact, rationale: row.rationale,
        refs: outgoing.all(row.address).map(ref => String(ref.target)),
        incoming_refs: incoming.all(row.address, runId, row.scope).map(ref => String(ref.address)),
      };
    }
    function publish(agentId: string, req: string, input: Publication, now: string) {
      if ([input.sub_task, input.artifact].some(value => !value.isWellFormed() || !value.trim())) {
        throw new Rejection('INVALID_CONTRACT', 'Sub-task and artifact must be well-formed non-empty text');
      }
      tokenizer ??= new Tiktoken(encoder);
      const contentSize = tokenizer.encode(input.sub_task, [], []).length + tokenizer.encode(input.artifact, [], []).length;
      if (contentSize > maxContentTokens) throw new Rejection('INVALID_CONTRACT', 'Sub-task plus artifact exceed 1,024 tokens');
      const refs = references(agentId, input.rationale, input.refs);
      const scope = scopeFor(agentId);
      const sha256 = digest(stableStringify(input));
      const address = `content:${digest(stableStringify([runId, agentId, req, sha256]))}`;
      db.prepare(`INSERT INTO paper_messages(address,run_id,scope,author,sub_task,artifact,rationale,weight,created_at,sha256)
        VALUES(?,?,?,?,?,?,?,0,?,?)`).run(address, runId, scope, agentId, input.sub_task, input.artifact, input.rationale, now, sha256);
      for (const [index, ref] of refs.entries()) {
        db.prepare('INSERT INTO paper_refs VALUES(?,?,?,?)').run(address, ref.address, index, ref.kind);
        if (ref.kind === 'message') db.prepare('UPDATE paper_messages SET weight=weight+0.3*(1-weight) WHERE address=?').run(ref.address);
      }
      return projection(requireMessage(scope, address));
    }
    services.registerService({
      manifest: paperSubstrateManifest(mode),
      adapter: createInProcessAdapter({ invoke(request) {
        const { caller, input, capability, envelope } = request;
        if (closed || !runtimeId || caller.runtimeId !== runtimeId) throw new Rejection('NOT_ALLOWED', 'Caller is outside the bound Runtime');
        authorize(caller);
        request.assertAuthorized();
        const operation = capability.operation;
        const fingerprint = digest(stableStringify({ operation, input }));
        const scope = scopeFor(caller.agentId);
        const now = new Date().toISOString();
        let response: JsonValue = null;
        let rejection: Rejection | null = null;
        db.exec('BEGIN IMMEDIATE');
        try {
          const previous = db.prepare(`SELECT fingerprint,response,error_code,error_message FROM paper_requests
            WHERE run_id=? AND author=? AND request_id=?`).get(runId, caller.agentId, envelope.operation_id) as RequestRow | undefined;
          if (previous) {
            if (previous.fingerprint !== fingerprint) throw new Rejection('CONFLICT', 'Request identity was reused with a different operation or input');
            if (previous.error_code) throw new Rejection(previous.error_code, previous.error_message ?? 'Request rejected');
            const replay = JSON.parse(previous.response ?? 'null') as JsonValue;
            db.exec('COMMIT');
            return replay;
          }
          countOperation?.(caller.agentId, operation, envelope.operation_id);
          const tick = db.prepare(`INSERT INTO paper_clocks VALUES(?,?,1)
            ON CONFLICT(run_id,scope) DO UPDATE SET tick=tick+1 RETURNING tick`).get(runId, scope)!.tick!;
          db.prepare('UPDATE paper_messages SET weight=weight*0.98 WHERE run_id=? AND scope=? AND weight>0').run(runId, scope);
          let audit = null;
          db.exec('SAVEPOINT paper_operation');
          try {
            if (operation === 'publish') response = publish(caller.agentId, envelope.operation_id, input as Publication, now);
            else if (operation === 'visit') {
              const { addresses } = input as { addresses: string[] };
              response = { results: addresses.map(address => projection(requireMessage(scope, address))) };
            } else {
              const { query, limit } = input as { query: string; limit: number };
              const ordered = rank(visibleMessages.all(runId, scope) as StoredMessage[], query).slice(0, limit);
              response = { results: ordered.map(({ row }) => projection(row)) };
              audit = JSON.stringify(ordered.map(({ row, bm25, normalized, score }) =>
                ({ address: row.address, bm25, normalized, score, citation_weight: row.weight })));
            }
          } catch (cause) {
            if (!(cause instanceof Rejection)) throw cause;
            db.exec('ROLLBACK TO paper_operation');
            rejection = cause;
          }
          db.exec('RELEASE paper_operation');
          db.prepare(`INSERT INTO paper_requests(run_id,author,request_id,operation,fingerprint,input,response,error_code,error_message,audit,tick,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId, caller.agentId, envelope.operation_id, operation, fingerprint, JSON.stringify(input),
            rejection ? null : JSON.stringify(response), rejection?.code ?? null, rejection?.message ?? null, audit, tick, now);
          db.exec('COMMIT');
        } catch (cause) {
          db.exec('ROLLBACK');
          throw cause;
        }
        if (rejection) throw rejection;
        return response;
      } }),
    });
    return Object.freeze({
      bindRuntime(id: string) {
        if (closed || runtimeId || typeof id !== 'string' || !id) throw new Rejection('NOT_ALLOWED', 'Runtime identity is already bound or invalid');
        const updated = db.prepare(`UPDATE paper_runs SET runtime_id=? WHERE run_id=? AND (runtime_id IS NULL OR runtime_id=?)`)
          .run(id, runId, id);
        if (!updated.changes) throw new Rejection('CONFLICT', 'Run ID belongs to another Runtime');
        runtimeId = id;
      },
      validateReferences(agentId: string, rationale: string, refs: string[]) { references(agentId, rationale, refs); },
      snapshot() {
        const contents = (db.prepare('SELECT * FROM paper_messages WHERE run_id=? ORDER BY ordinal').all(runId) as StoredMessage[])
          .map(row => ({ ...projection(row), author: row.author, version: 1, sha256: row.sha256, created_at: row.created_at, citation_weight: row.weight }));
        const ticks = db.prepare('SELECT scope,tick FROM paper_clocks WHERE run_id=? ORDER BY scope').all(runId);
        const operations = db.prepare(`SELECT author,request_id,operation,input,response,error_code,error_message,audit,tick,created_at
          FROM paper_requests WHERE run_id=? ORDER BY ordinal`).all(runId).map(row => ({
          ...row, input: JSON.parse(String(row.input)), response: JSON.parse(String(row.response)), audit: JSON.parse(String(row.audit)),
        }));
        return { runId, runtimeId, mode, contents, ticks, operations };
      },
      close() { if (!closed) { closed = true; db.close(); } },
    });
  } catch (error) {
    db.close();
    throw error;
  }
}
