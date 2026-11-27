import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createInProcessAdapter, type JsonValue, type ServiceCaller, type ServiceCapability, type ServiceRegistry, type ServiceManifest, type ServiceRequest } from '@luna-shi/murm';
import { stableStringify } from '../../src/protocol/envelope.js';
import { referenceHelp, validateRationale } from '../../src/harnesses/substrate/paper-substrate.js';
import { fatePins, sha256, type FateVerdict } from './fate-checker.js';

const maxChecks = 10;
export const maxFateOperationsPerPeer = 100;
const checkTimeoutMs = 900_000;
const string = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const proof = string(131_072);
const errors = ['NOT_ALLOWED', 'NOT_FOUND', 'CONFLICT', 'INVALID_CONTRACT', 'CHECK_LIMIT', 'OPERATION_LIMIT']
  .map(code => ({ code, retryable: false }));
const descriptions: Record<string, string> = {
  search_mathlib: 'Search the fixed Mathlib source for existing Lean declarations.',
  check_lean: `Check a proof term against the original theorem. You have up to ${maxChecks} trial checks.`,
  submit: 'Record or replace your submitted proof. Set finish=true when you are ready to end your work. Your final submission is graded independently.',
};
const verifiedSubmitDescription = 'Save drafts with finish=false. To finish, first get status passed from check_lean for the exact proof, then submit it with finish=true. Final scoring is independent.';
const proofCheckRequired = 'PROOF_CHECK_REQUIRED';

const operationHelp: Record<string, string> = {
  search_mathlib: 'Use a lemma name, a specific query, or a known mathlib: address.\nExample command\n  swarm fate search_mathlib --query "LEMMA_NAME"',
  check_lean: 'Supply a Lean proof term, usually beginning with by.\nExample command\n  swarm fate check_lean --input proof.json',
  submit: `Supply a Lean proof term, usually beginning with by. ${referenceHelp} Use refs: [] when you used no references.\nExample command\n  swarm fate submit --input submission.json`,
};

export type MathlibMatch = { name: string; type: string | null; module: string | null; source: string | null };
type Resource = MathlibMatch & { address: string };
type Submission = { proof: string; rationale: string; refs: string[]; finish: boolean };
export type FateCandidate = Submission & { agentId: string; requestId: string; sha256: string; submittedAt: string };

function failure(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function operation(name: string, input_schema: Record<string, unknown>, output_schema: Record<string, unknown>, timeout_ms?: number): ServiceCapability {
  return {
    name, operation: name, description: descriptions[name], input_schema, output_schema,
    side_effect: name === 'submit' ? 'write' : 'read', idempotent: true, help: { when: operationHelp[name] },
    errors, ...(timeout_ms ? { timeout_ms } : {}),
  };
}

export function fateServiceManifest(verifiedCompletion = false): ServiceManifest {
  const nullable = { anyOf: [{ type: 'string' }, { type: 'null' }] };
  const verdict = {
    ...object({ status: string(32), code: string(80), diagnostic: string(4096), elapsedMs: { type: 'integer', minimum: 0 } }),
    required: ['status', 'code', 'elapsedMs'],
  };
  return {
    id: 'fate', title: 'FATE task tools',
    purpose: `Mathlib lookup, Lean checking, and proof submission. Task and collaboration services share a limit of ${maxFateOperationsPerPeer} operations per agent.`,
    provider_version: '1', contract_version: '2', endpoint: { transport: 'in-process' },
    capabilities: [
      operation('search_mathlib', object({ query: string(512) }), object({
        results: { type: 'array', maxItems: 10, items: object({ name: string(512), type: nullable, module: nullable, source: nullable, address: string(200) }) },
      })),
      operation('check_lean', object({ proof }), verdict, checkTimeoutMs + 1_000),
      { ...operation('submit', object({
        proof, rationale: string(8192), refs: { type: 'array', items: string(200), maxItems: 32, uniqueItems: true }, finish: { type: 'boolean' },
      }), object({ sha256: string(64), submitted_at: string(40), finish: { type: 'boolean' } })),
      ...(verifiedCompletion ? {
        description: verifiedSubmitDescription, errors: [...errors, { code: proofCheckRequired, retryable: false }],
      } : {}) },
    ],
  };
}

interface TaskOptions {
  path: string;
  services: ServiceRegistry;
  authorize(caller: ServiceCaller): void;
  countOperation(agentId: string, operation: string, requestId: string): void;
  remainingMs(): number;
  signal: AbortSignal;
  problemAddress: string;
  shareMathlibResources?: boolean;
  verifiedCompletion?: boolean;
  search(query: string, signal: AbortSignal): Promise<MathlibMatch[]>;
  check(proof: string, options: { signal: AbortSignal; timeoutMs: number }): Promise<FateVerdict>;
  validateReferences(agentId: string, rationale: string, refs: string[]): void;
  onFinish(agentId: string): void;
}

export function createFateTaskService(options: TaskOptions) {
  const db = new DatabaseSync(options.path);
  let closed = false;
  const checks = new Map<string, number>();
  const checking = new Map<string, Set<Promise<JsonValue>>>();
  const passedProofs = new Map<string, Set<string>>();
  const declaredFinished = new Set<string>();
  const requests = new Map<string, { fingerprint: string; result: Promise<JsonValue> }>();
  const resourceScopes = new Map<string, Map<string, Resource>>();
  const operations: { agentId: string; operation: string; requestId: string; startedAt: string; outcome: string; elapsedMs?: number }[] = [];
  const pending = new Set<Promise<JsonValue>>();

  const resourceScope = (agentId: string) => options.shareMathlibResources ? '' : agentId;
  const resourceExists = (agentId: string, address: string) =>
    address === options.problemAddress || resourceScopes.get(resourceScope(agentId))?.has(address) === true;

  async function run(request: ServiceRequest): Promise<JsonValue> {
    const { caller: { agentId }, capability: { operation: name }, envelope: { operation_id: requestId }, input } = request;
    options.countOperation(agentId, name, requestId);
    const signal = AbortSignal.any([request.signal, options.signal]);
    signal.throwIfAborted();
    if (name === 'search_mathlib') {
      const { query } = input as { query: string };
      if (!query.trim() || !query.isWellFormed()) throw failure('INVALID_CONTRACT', 'Provide a search query');
      const scopeId = resourceScope(agentId);
      const scope = resourceScopes.get(scopeId) ?? new Map<string, Resource>();
      if (query.startsWith('mathlib:')) {
        const entry = scope.get(query.trim());
        return { results: entry ? [entry] : [] };
      }
      const raw = await options.search(query, signal);
      signal.throwIfAborted();
      request.assertAuthorized();
      options.authorize(request.caller);
      const entries = raw.slice(0, 10).map(row => ({ ...row, address: `mathlib:${sha256(stableStringify([fatePins.mathlibRevision, row.name, row.source]))}` }));
      const current = resourceScopes.get(scopeId) ?? scope;
      for (const entry of entries) current.set(entry.address, entry);
      resourceScopes.set(scopeId, current);
      return { results: entries };
    }
    if (name === 'check_lean') {
      const count = checks.get(agentId) ?? 0;
      if (count >= maxChecks) throw failure('CHECK_LIMIT', 'This peer used all ten working Lean checks');
      const timeoutMs = Math.min(checkTimeoutMs, options.remainingMs());
      if (timeoutMs < 1) throw failure('NOT_ALLOWED', 'The work period ended');
      checks.set(agentId, count + 1);
      const { proof } = input as { proof: string };
      const verdict = await options.check(proof, { timeoutMs, signal });
      if (options.verifiedCompletion && verdict.status === 'passed') {
        signal.throwIfAborted();
        request.assertAuthorized();
        options.authorize(request.caller);
        const passed = passedProofs.get(agentId) ?? new Set<string>();
        passed.add(sha256(proof));
        passedProofs.set(agentId, passed);
      }
      return verdict;
    }

    const submission = input as Submission;
    if (!submission.proof.trim() || !submission.proof.isWellFormed() || Buffer.byteLength(submission.proof) > 131_072) {
      throw failure('INVALID_CONTRACT', 'Submit a bounded, nonempty Lean proof term');
    }
    validateRationale(submission.rationale, submission.refs);
    options.validateReferences(agentId, submission.rationale, submission.refs);
    request.assertAuthorized();
    options.authorize(request.caller);
    const digest = sha256(submission.proof);
    if (options.verifiedCompletion && submission.finish && !passedProofs.get(agentId)?.has(digest)) {
      throw failure(proofCheckRequired, 'Continue working. Get status passed from check_lean for this exact proof before finishing.');
    }
    const candidate: FateCandidate = {
      ...submission, agentId, requestId, sha256: digest, submittedAt: new Date().toISOString(),
    };
    db.prepare(`INSERT INTO fate_candidates VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET candidate=excluded.candidate`)
      .run(agentId, JSON.stringify(candidate));
    if (submission.finish) {
      declaredFinished.add(agentId);
      options.onFinish(agentId);
    }
    return { sha256: candidate.sha256, submitted_at: candidate.submittedAt, finish: candidate.finish };
  }

  try {
    chmodSync(options.path, 0o600);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE fate_candidates (agent_id TEXT PRIMARY KEY, candidate TEXT NOT NULL);');
    options.services.registerService({
      manifest: fateServiceManifest(options.verifiedCompletion),
      adapter: createInProcessAdapter({ invoke(request) {
        const { caller, envelope, capability, input } = request;
        if (closed) throw failure('NOT_ALLOWED', 'Task Service is closed');
        options.authorize(caller);
        request.assertAuthorized();
        const key = stableStringify([caller.agentId, envelope.operation_id]);
        const fingerprint = sha256(stableStringify({ name: capability.operation, input }));
        const prior = requests.get(key);
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw failure('CONFLICT', 'Task request was reused with a different operation or input');
          return prior.result;
        }
        if (declaredFinished.has(caller.agentId)) throw failure('NOT_ALLOWED', 'The peer has finished');
        const evidence: typeof operations[number] = { agentId: caller.agentId, operation: capability.operation,
          requestId: envelope.operation_id, startedAt: new Date().toISOString(), outcome: 'pending' };
        operations.push(evidence);
        const result = run(request).then(value => {
          const verdict = capability.operation === 'check_lean' ? value as FateVerdict : null;
          evidence.outcome = verdict?.status ?? 'succeeded';
          if (verdict) evidence.elapsedMs = verdict.elapsedMs;
          return value;
        }, cause => {
          evidence.outcome = typeof cause?.code === 'string' ? cause.code : 'SERVICE_FAILED';
          throw cause;
        });
        requests.set(key, { fingerprint, result });
        pending.add(result);
        void result.then(() => pending.delete(result), () => pending.delete(result));
        if (capability.operation === 'check_lean') {
          const agentChecks = checking.get(caller.agentId) ?? new Set<Promise<JsonValue>>();
          checking.set(caller.agentId, agentChecks);
          agentChecks.add(result);
          const settled = () => {
            agentChecks.delete(result);
            if (!agentChecks.size) checking.delete(caller.agentId);
          };
          void result.then(settled, settled);
        }
        return result;
      } }),
    });
    return Object.freeze({
      resourceExists,
      completionStatus(agentId: string) {
        return {
          remainingChecks: maxChecks - (checks.get(agentId) ?? 0),
          hasPassingProof: Boolean(passedProofs.get(agentId)?.size),
          checkPending: Boolean(checking.get(agentId)?.size),
        };
      },
      settleChecks: (agentId: string) => Promise.allSettled([...(checking.get(agentId) ?? [])]),
      snapshot() {
        const candidates = db.prepare('SELECT candidate FROM fate_candidates ORDER BY agent_id').all()
          .map(row => JSON.parse(String(row.candidate)) as FateCandidate);
        return { candidates, operations, checks: Object.fromEntries(checks),
          resources: Object.fromEntries([...resourceScopes].map(([agentId, scope]) => [agentId, [...scope.values()]])) };
      },
      settle: () => Promise.allSettled([...pending]),
      close() { if (!closed) { closed = true; db.close(); } },
    });
  } catch (error) {
    db.close();
    throw error;
  }
}
