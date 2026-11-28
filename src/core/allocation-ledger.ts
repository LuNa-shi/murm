import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type AllocationState = 'intent' | 'dispatched' | 'created' | 'starting' | 'ready' | 'unknown' | 'stopping' | 'exporting' | 'retained' | 'deleting' | 'deleted' | 'rejected';
export type AllocationRunState = 'open' | 'closing' | 'closed';

export interface AllocationIntent {
  agentId: string;
  resourceKey: string;
  requestId: string;
  caller?: string;
  parameterFingerprint: string;
  providerId: string;
  connectionFingerprint: string;
  executionGeneration: number;
  profile: string;
  executor: string;
  image: string;
  timeoutSeconds: number;
  publicState?: Record<string, unknown>;
  privateState?: Record<string, unknown>;
}

export interface AllocationRecord extends AllocationIntent {
  runtimeId: string;
  controllerEpoch: number;
  state: AllocationState;
  createdAt: string;
  updatedAt: string;
  sandboxId?: string;
  expiresAt?: string | null;
  workerInstanceId?: string;
  streamEpoch?: string;
  afterSequence: number;
  historyGap?: { expectedSequence: number; receivedSequence: number };
  retention?: { reason: string; deadline: string; owner: string };
  renewal?: { requestedExpiresAt: string; confirmedExpiresAt?: string | null; error?: string };
  retry?: { attempts: number; nextAt: string; error: string };
  archive?: unknown;
  artifacts?: unknown;
  stopConfirmed: boolean;
  managementAbsent: boolean;
  terminalEvidence?: string;
}

export interface AllocationResource {
  resourceKey: string;
  sandboxId: string;
  observedAt: string;
  stopConfirmed: boolean;
  managementAbsent: boolean;
  stopEvidence?: string;
  deletionEvidence?: string;
}

export interface AllocationInput {
  resourceKey: string;
  caller: string;
  requestId: string;
  parameterFingerprint: string;
  inputId: string;
  parameters: unknown;
  state: 'reserved' | 'dispatched' | 'unknown' | 'accepted' | 'rejected';
  receipt?: unknown;
}

export interface AllocationRun {
  schemaVersion: 1;
  runtimeId: string;
  configFingerprint: string;
  maxAgents: number;
  hostIdentity: string;
  controllerEpoch: number;
  state: AllocationRunState;
  createdAt: string;
  updatedAt: string;
  publicState: Record<string, unknown>;
  privateState: Record<string, unknown>;
}

export interface AllocationLedgerOptions {
  directory: string;
  runtimeId: string;
  configFingerprint: string;
  maxAgents: number;
  /** A stable identity from a trusted deployment may replace the same-boot OS identity. */
  hostIdentity?: string;
}

function fault(code: string, message: string) {
  return Object.assign(new Error(message), { code, allocationLedger: true });
}

function required(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 4096) throw fault('INVALID_CONTRACT', `Allocation ledger requires ${name}`);
}

function integer(value: unknown, name: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw fault('INVALID_CONTRACT', `Allocation ledger requires a valid ${name}`);
}

function timestamp(value: string, name: string) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw fault('INVALID_CONTRACT', `Allocation ledger requires a valid ${name}`);
  return new Date(value).toISOString();
}

function encode(value: unknown): string {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); }
  catch { throw fault('INVALID_CONTRACT', 'Allocation ledger data must be JSON serializable'); }
  if (encoded === undefined) throw fault('INVALID_CONTRACT', 'Allocation ledger data must be JSON serializable');
  return encoded;
}

function decode<T>(row: unknown): T | undefined {
  return row ? JSON.parse((row as { body: string }).body) as T : undefined;
}

function currentHostIdentity() {
  // The Runtime Pod gets its node name from Kubernetes' downward API. A
  // recreated Pod can differ in hostname while retaining the same node boot.
  const node = process.env.MURM_RUNTIME_NODE_NAME;
  const identities = [node ? 'kubernetes' : 'host', node || hostname()];
  try { identities.push(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()); }
  catch { throw fault('NOT_ALLOWED', 'Durable Runtime requires the Linux kernel boot identity'); }
  if (!node) {
    try { identities.push(readFileSync('/etc/machine-id', 'utf8').trim()); } catch { /* hostname and boot ID still identify the owner */ }
  }
  return createHash('sha256').update(identities.join('\n')).digest('hex');
}

function protectedDatabase(directory: string, create = true) {
  try { return prepareDatabaseFile(directory, create); }
  catch (error) {
    if ((error as { allocationLedger?: boolean }).allocationLedger) throw error;
    throw fault('LEDGER_UNAVAILABLE', 'Allocation ledger protected storage is unavailable');
  }
}

function prepareDatabaseFile(directory: string, create: boolean) {
  const root = resolve(directory);
  if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || realpathSync(root) !== root || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw fault('NOT_ALLOWED', 'Allocation ledger directory must be private, owned, and free of symbolic links');
  }
  const path = join(root, 'allocations.sqlite');
  let descriptor: number;
  try { descriptor = create ? openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600) : openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  }
  try {
    const file = fstatSync(descriptor);
    if (!file.isFile() || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0 || file.nlink !== 1) {
      throw fault('NOT_ALLOWED', 'Allocation ledger database must be a private owned regular file');
    }
  } finally { closeSync(descriptor); }
  return path;
}

const transitions: Record<AllocationState, readonly AllocationState[]> = {
  intent: ['dispatched', 'rejected'],
  dispatched: ['created', 'unknown', 'stopping', 'rejected'],
  created: ['starting', 'ready', 'unknown', 'stopping'],
  starting: ['ready', 'unknown', 'stopping'],
  ready: ['unknown', 'stopping'],
  unknown: ['created', 'ready', 'stopping', 'exporting', 'retained', 'deleting'],
  stopping: ['unknown', 'exporting', 'retained', 'deleting'],
  exporting: ['unknown', 'retained', 'deleting'],
  retained: ['unknown', 'exporting', 'deleting'],
  deleting: ['unknown', 'retained'],
  deleted: [],
  rejected: [],
};

export const ALLOCATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS allocation_run (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS allocations (
  resource_key TEXT PRIMARY KEY, agent_id TEXT NOT NULL UNIQUE, request_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL, body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS allocation_resources (
  resource_key TEXT NOT NULL REFERENCES allocations(resource_key), sandbox_id TEXT NOT NULL,
  body TEXT NOT NULL, PRIMARY KEY (resource_key, sandbox_id)
);
CREATE TABLE IF NOT EXISTS allocation_inputs (
  request_key TEXT PRIMARY KEY, resource_key TEXT NOT NULL REFERENCES allocations(resource_key), body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS allocation_events (
  resource_key TEXT NOT NULL REFERENCES allocations(resource_key), stream_epoch TEXT NOT NULL,
  sequence INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (resource_key, stream_epoch, sequence)
);
PRAGMA user_version = 1;
`;

/** Private transaction journal. Its SQLite connection owns the run's same-host writer lock. */
export class AllocationLedger {
  readonly path: string;
  readonly controllerEpoch: number;
  readonly recovered: boolean;
  private readonly db: DatabaseSync;
  private failed = false;
  private closed = false;

  static open(options: AllocationLedgerOptions) { return new AllocationLedger(options); }

  static inspect(directory: string): Omit<AllocationRun, 'privateState'> {
    const path = protectedDatabase(directory, false);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 0');
      const run = decode<AllocationRun>(db.prepare('SELECT body FROM allocation_run WHERE id = 1').get());
      if (!run || run.schemaVersion !== 1) throw fault('INVALID_CONTRACT', 'Allocation ledger schema is unsupported');
      const { privateState: _privateState, ...publicRun } = run;
      return publicRun;
    } catch (error) {
      if ((error as { allocationLedger?: boolean }).allocationLedger) throw error;
      throw fault('LEDGER_UNAVAILABLE', 'Allocation ledger cannot be inspected while its writer is active or storage is unavailable');
    } finally { db.close(); }
  }

  private constructor(options: AllocationLedgerOptions) {
    required(options.runtimeId, 'runtimeId');
    required(options.configFingerprint, 'configFingerprint');
    integer(options.maxAgents, 'maxAgents', 1);
    const hostIdentity = options.hostIdentity ?? currentHostIdentity();
    required(hostIdentity, 'hostIdentity');
    this.path = protectedDatabase(options.directory);
    this.db = new DatabaseSync(this.path);
    let recovered = false;
    let epoch = 0;
    try {
      // DELETE + EXCLUSIVE retains the OS file lock between commits. A second
      // writer cannot enter, and SIGKILL releases the lock through the kernel.
      this.db.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA locking_mode = EXCLUSIVE; PRAGMA foreign_keys = ON; BEGIN EXCLUSIVE');
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (version !== 0 && version !== 1) throw fault('INVALID_CONTRACT', 'Allocation ledger schema is unsupported');
      this.db.exec(ALLOCATION_SCHEMA_SQL);
      let run = this.readRun();
      recovered = Boolean(run);
      const now = new Date().toISOString();
      if (run) {
        if (run.schemaVersion !== 1 || !Number.isSafeInteger(run.controllerEpoch) || run.controllerEpoch < 1 ||
            !['open', 'closing', 'closed'].includes(run.state)) throw fault('INVALID_CONTRACT', 'Allocation ledger run header is invalid');
        if (run.runtimeId !== options.runtimeId || run.configFingerprint !== options.configFingerprint || run.maxAgents !== options.maxAgents) {
          throw fault('CONFLICT', 'Allocation ledger identity or configuration differs from the original run');
        }
        if (run.hostIdentity !== hostIdentity) throw fault('NOT_ALLOWED', 'Allocation ledger cross-host takeover requires verified infrastructure fencing');
        if (run.state === 'closed') throw fault('NOT_ALLOWED', 'A closed allocation run cannot resume control');
        run = { ...run, controllerEpoch: run.controllerEpoch + 1, updatedAt: now };
      } else {
        run = { schemaVersion: 1, runtimeId: options.runtimeId, configFingerprint: options.configFingerprint,
          maxAgents: options.maxAgents, hostIdentity, controllerEpoch: 1, state: 'open', createdAt: now, updatedAt: now,
          publicState: {}, privateState: {} };
      }
      epoch = run.controllerEpoch;
      this.db.prepare('INSERT OR REPLACE INTO allocation_run (id, body) VALUES (1, ?)').run(encode(run));
      if (recovered) {
        for (const row of this.db.prepare("SELECT resource_key, body FROM allocations WHERE state IN ('dispatched', 'starting')").all() as { resource_key: string; body: string }[]) {
          const allocation = JSON.parse(row.body) as AllocationRecord;
          allocation.state = 'unknown'; allocation.updatedAt = now;
          this.db.prepare('UPDATE allocations SET state = ?, body = ? WHERE resource_key = ?').run(allocation.state, encode(allocation), row.resource_key);
        }
        for (const row of this.db.prepare('SELECT request_key, body FROM allocation_inputs').all() as { request_key: string; body: string }[]) {
          const input = JSON.parse(row.body) as AllocationInput;
          if (input.state !== 'dispatched') continue;
          input.state = 'unknown';
          this.db.prepare('UPDATE allocation_inputs SET body = ? WHERE request_key = ?').run(encode(input), row.request_key);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* acquisition may have failed before a transaction */ }
      this.db.close();
      if ((error as { allocationLedger?: boolean }).allocationLedger) throw error;
      throw fault('LEDGER_UNAVAILABLE', 'Allocation ledger writer lock or durable storage is unavailable');
    }
    this.controllerEpoch = epoch;
    this.recovered = recovered;
  }

  private readRun() { return decode<AllocationRun>(this.db.prepare('SELECT body FROM allocation_run WHERE id = 1').get()); }

  private assertOpen() {
    if (this.closed || this.failed) throw fault('LEDGER_UNAVAILABLE', 'Allocation ledger is closed or a durable write failed');
  }

  private transaction<T>(operation: () => T): T {
    this.assertOpen();
    try {
      this.db.exec('BEGIN EXCLUSIVE');
      const result = operation();
      this.db.exec('COMMIT');
      return structuredClone(result);
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* storage may be unavailable */ }
      if ((error as { allocationLedger?: boolean }).allocationLedger) throw error;
      this.failed = true;
      throw fault('LEDGER_UNAVAILABLE', 'Allocation ledger durable write failed. New side effects are fenced.');
    }
  }

  private record(resourceKey: string) {
    const row = decode<AllocationRecord>(this.db.prepare('SELECT body FROM allocations WHERE resource_key = ?').get(resourceKey));
    if (!row) throw fault('NOT_FOUND', 'Allocation ledger resource is unknown');
    return row;
  }

  private save(record: AllocationRecord) {
    record.updatedAt = new Date().toISOString();
    this.db.prepare('UPDATE allocations SET state = ?, body = ? WHERE resource_key = ?').run(record.state, encode(record), record.resourceKey);
    return record;
  }

  private move(record: AllocationRecord, state: AllocationState) {
    if (record.state !== state && !transitions[record.state].includes(state)) throw fault('CONFLICT', 'Allocation ledger state transition is not allowed');
    record.state = state;
    return record;
  }

  get healthy() { return !this.closed && !this.failed; }
  get run() { this.assertOpen(); return this.readRun()!; }
  get occupied() { this.assertOpen(); return Number((this.db.prepare("SELECT count(*) AS count FROM allocations WHERE state NOT IN ('deleted', 'rejected')").get() as { count: number }).count); }
  get(resourceKey: string) { this.assertOpen(); return this.record(resourceKey); }
  list(): AllocationRecord[] { this.assertOpen(); return this.db.prepare('SELECT body FROM allocations ORDER BY rowid').all().map(row => decode<AllocationRecord>(row)!); }
  resources(resourceKey: string): AllocationResource[] { this.assertOpen(); return this.db.prepare('SELECT body FROM allocation_resources WHERE resource_key = ? ORDER BY rowid').all(resourceKey).map(row => decode<AllocationResource>(row)!); }
  inputs(resourceKey: string): AllocationInput[] { this.assertOpen(); return this.db.prepare('SELECT body FROM allocation_inputs WHERE resource_key = ? ORDER BY rowid').all(resourceKey).map(row => decode<AllocationInput>(row)!); }

  reserveIntent(input: AllocationIntent) {
    for (const field of ['agentId', 'resourceKey', 'requestId', 'parameterFingerprint', 'providerId', 'connectionFingerprint', 'profile', 'executor', 'image'] as const) required(input[field], field);
    integer(input.executionGeneration, 'executionGeneration', 1);
    integer(input.timeoutSeconds, 'timeoutSeconds', 60);
    const requestKey = encode([input.caller ?? 'host', 'spawn', input.requestId]);
    return this.transaction(() => {
      const existing = decode<AllocationRecord>(this.db.prepare('SELECT body FROM allocations WHERE request_key = ?').get(requestKey));
      if (existing) {
        if (existing.parameterFingerprint !== input.parameterFingerprint) throw fault('CONFLICT', 'Allocation requestId has different parameters');
        return existing;
      }
      const run = this.readRun()!;
      if (run.state !== 'open') throw fault('NOT_ALLOWED', 'Allocation run is closing');
      if (this.occupied >= run.maxAgents) throw fault('CONFLICT', 'Allocation run has no available capacity');
      if (this.db.prepare('SELECT 1 FROM allocations WHERE resource_key = ? OR agent_id = ?').get(input.resourceKey, input.agentId)) throw fault('CONFLICT', 'Allocation identity is already registered');
      const now = new Date().toISOString();
      const record: AllocationRecord = { ...input, caller: input.caller ?? 'host', runtimeId: run.runtimeId,
        controllerEpoch: this.controllerEpoch, state: 'intent', createdAt: now, updatedAt: now, afterSequence: 0,
        stopConfirmed: false, managementAbsent: false };
      this.db.prepare('INSERT INTO allocations (resource_key, agent_id, request_key, state, body) VALUES (?, ?, ?, ?, ?)')
        .run(record.resourceKey, record.agentId, requestKey, record.state, encode(record));
      return record;
    });
  }

  dispatched(resourceKey: string) {
    return this.transaction(() => {
      if (this.readRun()!.state !== 'open') throw fault('NOT_ALLOWED', 'Allocation run is closing');
      const record = this.record(resourceKey);
      if (record.state !== 'intent') throw fault('CONFLICT', 'An allocation create request can only be dispatched once');
      return this.save(this.move(record, 'dispatched'));
    });
  }

  observeResource(resourceKey: string, observation: { sandboxId: string; expiresAt?: string | null }) {
    required(observation.sandboxId, 'sandboxId');
    const expiresAt = observation.expiresAt === undefined || observation.expiresAt === null ? observation.expiresAt : timestamp(observation.expiresAt, 'expiresAt');
    return this.transaction(() => {
      const record = this.record(resourceKey);
      if (record.state === 'intent' || record.state === 'rejected') throw fault('CONFLICT', 'Allocation cannot observe a resource in its current state');
      const duplicate = record.sandboxId !== undefined && record.sandboxId !== observation.sandboxId;
      const resource: AllocationResource = { resourceKey, sandboxId: observation.sandboxId, observedAt: new Date().toISOString(), stopConfirmed: false, managementAbsent: false };
      this.db.prepare('INSERT OR IGNORE INTO allocation_resources (resource_key, sandbox_id, body) VALUES (?, ?, ?)').run(resourceKey, observation.sandboxId, encode(resource));
      record.sandboxId ??= observation.sandboxId;
      if (expiresAt !== undefined) record.expiresAt = expiresAt;
      if (duplicate) { record.state = 'unknown'; record.stopConfirmed = false; record.managementAbsent = false; delete record.terminalEvidence; }
      else if (record.state === 'dispatched' || record.state === 'unknown') record.state = this.readRun()!.state === 'open' ? 'created' : 'stopping';
      return this.save(record);
    });
  }

  observePresence(resourceKey: string, sandboxId: string, expiresAt: string | null) {
    return this.transaction(() => {
      const record = this.record(resourceKey);
      const resource = decode<AllocationResource>(this.db.prepare('SELECT body FROM allocation_resources WHERE resource_key = ? AND sandbox_id = ?').get(resourceKey, sandboxId));
      if (!resource || ['deleted', 'rejected'].includes(record.state)) throw fault('CONFLICT', 'A terminal or unknown resource identity cannot reappear');
      if (resource.managementAbsent) {
        resource.managementAbsent = false;
        delete resource.deletionEvidence;
        record.managementAbsent = false;
        this.db.prepare('UPDATE allocation_resources SET body = ? WHERE resource_key = ? AND sandbox_id = ?').run(encode(resource), resourceKey, sandboxId);
      }
      record.expiresAt = expiresAt;
      return this.save(record);
    });
  }

  starting(resourceKey: string) {
    return this.transaction(() => {
      const record = this.record(resourceKey);
      if (this.readRun()!.state !== 'open' || record.state !== 'created') throw fault('NOT_ALLOWED', 'Allocation Worker startup cannot be dispatched');
      return this.save(this.move(record, 'starting'));
    });
  }

  ready(resourceKey: string, observation: { workerInstanceId: string; streamEpoch: string; privateState?: Record<string, unknown> }) {
    required(observation.workerInstanceId, 'workerInstanceId');
    required(observation.streamEpoch, 'streamEpoch');
    return this.transaction(() => {
      const record = this.record(resourceKey);
      if (this.readRun()!.state !== 'open' || record.stopConfirmed || record.historyGap || this.resources(resourceKey).length !== 1) throw fault('NOT_ALLOWED', 'Allocation cannot resume business control');
      if ((record.workerInstanceId && record.workerInstanceId !== observation.workerInstanceId) || (record.streamEpoch && record.streamEpoch !== observation.streamEpoch)) throw fault('CONFLICT', 'Allocation Worker instance or stream epoch changed');
      this.move(record, 'ready');
      Object.assign(record, observation, { controllerEpoch: this.controllerEpoch, privateState: { ...record.privateState, ...observation.privateState } });
      return this.save(record);
    });
  }

  transition(resourceKey: string, state: Exclude<AllocationState, 'intent' | 'dispatched' | 'created' | 'starting' | 'ready' | 'deleted' | 'rejected'>) {
    return this.transaction(() => this.save(this.move(this.record(resourceKey), state)));
  }

  rejectCreation(resourceKey: string, evidence: string) {
    required(evidence, 'definitive creation rejection evidence');
    return this.transaction(() => {
      const record = this.record(resourceKey);
      if (record.sandboxId) throw fault('CONFLICT', 'A known Sandbox must be confirmed stopped and deleted');
      this.move(record, 'rejected');
      record.terminalEvidence = evidence;
      return this.save(record);
    });
  }

  recordStop(resourceKey: string, sandboxId: string, evidence: string) { return this.confirmResource(resourceKey, sandboxId, 'stop', evidence); }
  recordDeletion(resourceKey: string, sandboxId: string, evidence: string) { return this.confirmResource(resourceKey, sandboxId, 'deletion', evidence); }

  private confirmResource(resourceKey: string, sandboxId: string, kind: 'stop' | 'deletion', evidence: string) {
    required(evidence, `${kind} evidence`);
    return this.transaction(() => {
      const record = this.record(resourceKey);
      const resource = decode<AllocationResource>(this.db.prepare('SELECT body FROM allocation_resources WHERE resource_key = ? AND sandbox_id = ?').get(resourceKey, sandboxId));
      if (!resource) throw fault('NOT_FOUND', 'Allocation resource identity has not been observed');
      if (kind === 'stop') { resource.stopConfirmed = true; resource.stopEvidence = evidence; }
      else { resource.managementAbsent = true; resource.deletionEvidence = evidence; }
      this.db.prepare('UPDATE allocation_resources SET body = ? WHERE resource_key = ? AND sandbox_id = ?').run(encode(resource), resourceKey, sandboxId);
      const resources = this.resources(resourceKey);
      record.stopConfirmed = resources.every(item => item.stopConfirmed);
      record.managementAbsent = resources.every(item => item.managementAbsent);
      if (record.stopConfirmed && record.managementAbsent) {
        record.state = 'deleted';
        record.terminalEvidence = 'execution-stop-and-resource-deletion-confirmed';
      } else if (record.managementAbsent && !record.stopConfirmed) record.state = 'unknown';
      else if (record.stopConfirmed && !['exporting', 'retained', 'deleted'].includes(record.state)) record.state = 'stopping';
      return this.save(record);
    });
  }

  checkpoint(resourceKey: string, patch: { expiresAt?: string | null; publicState?: Record<string, unknown>; privateState?: Record<string, unknown>; archive?: unknown; artifacts?: unknown }) {
    return this.transaction(() => {
      const record = this.record(resourceKey);
      if ('expiresAt' in patch) record.expiresAt = patch.expiresAt;
      if (patch.publicState) record.publicState = { ...record.publicState, ...patch.publicState };
      if (patch.privateState) record.privateState = { ...record.privateState, ...patch.privateState };
      if ('archive' in patch) record.archive = patch.archive;
      if ('artifacts' in patch) record.artifacts = patch.artifacts;
      return this.save(record);
    });
  }

  lease(resourceKey: string, renewal: NonNullable<AllocationRecord['renewal']>) {
    timestamp(renewal.requestedExpiresAt, 'requestedExpiresAt');
    if (renewal.confirmedExpiresAt) timestamp(renewal.confirmedExpiresAt, 'confirmedExpiresAt');
    return this.transaction(() => {
      const record = this.record(resourceKey);
      if (['deleted', 'rejected'].includes(record.state)) throw fault('NOT_ALLOWED', 'A terminal allocation cannot renew');
      record.renewal = renewal;
      if ('confirmedExpiresAt' in renewal) record.expiresAt = renewal.confirmedExpiresAt;
      return this.save(record);
    });
  }

  retain(resourceKey: string, retention: NonNullable<AllocationRecord['retention']>) {
    required(retention.reason, 'retention reason'); required(retention.owner, 'retention owner'); timestamp(retention.deadline, 'retention deadline');
    return this.transaction(() => {
      const record = this.move(this.record(resourceKey), 'retained');
      record.retention = retention;
      return this.save(record);
    });
  }

  retry(resourceKey: string, error: string, nextAt: string) {
    required(error, 'error classification'); timestamp(nextAt, 'next reconciliation time');
    return this.transaction(() => {
      const record = this.record(resourceKey);
      record.retry = { attempts: (record.retry?.attempts ?? 0) + 1, error, nextAt };
      return this.save(record);
    });
  }

  reserveInput(input: Omit<AllocationInput, 'state' | 'receipt'>) {
    for (const field of ['resourceKey', 'caller', 'requestId', 'parameterFingerprint', 'inputId'] as const) required(input[field], field);
    const requestKey = encode([input.caller, input.resourceKey, input.requestId]);
    return this.transaction(() => {
      const existing = decode<AllocationInput>(this.db.prepare('SELECT body FROM allocation_inputs WHERE request_key = ?').get(requestKey));
      if (existing) {
        if (existing.parameterFingerprint !== input.parameterFingerprint) throw fault('CONFLICT', 'Input requestId has different parameters');
        return existing;
      }
      const record = this.record(input.resourceKey);
      if (this.readRun()!.state !== 'open' || record.state !== 'ready' || record.controllerEpoch !== this.controllerEpoch) throw fault('NOT_ALLOWED', 'Allocation input control has not been recovered');
      const entry: AllocationInput = { ...input, state: 'reserved' };
      this.db.prepare('INSERT INTO allocation_inputs (request_key, resource_key, body) VALUES (?, ?, ?)').run(requestKey, input.resourceKey, encode(entry));
      return entry;
    });
  }

  recordInput(resourceKey: string, caller: string, requestId: string, state: AllocationInput['state'], receipt?: unknown) {
    return this.transaction(() => this.writeInput(resourceKey, caller, requestId, state, receipt));
  }

  input(resourceKey: string, caller: string, requestId: string) {
    this.assertOpen();
    return decode<AllocationInput>(this.db.prepare('SELECT body FROM allocation_inputs WHERE request_key = ?')
      .get(encode([caller, resourceKey, requestId])));
  }

  private writeInput(resourceKey: string, caller: string, requestId: string, state: AllocationInput['state'], receipt?: unknown) {
    const key = encode([caller, resourceKey, requestId]);
    const input = decode<AllocationInput>(this.db.prepare('SELECT body FROM allocation_inputs WHERE request_key = ?').get(key));
    if (!input) throw fault('NOT_FOUND', 'Allocation input request is unknown');
    if (['accepted', 'rejected'].includes(input.state) && (input.state !== state || encode(input.receipt ?? null) !== encode(receipt ?? null))) throw fault('CONFLICT', 'A confirmed input receipt cannot be changed');
    if ((state === 'reserved' && input.state !== state) || (state === 'dispatched' && !['reserved', 'dispatched'].includes(input.state))) throw fault('CONFLICT', 'An input cannot return to an undispatched state');
    input.state = state;
    if (receipt !== undefined) input.receipt = receipt;
    this.db.prepare('UPDATE allocation_inputs SET body = ? WHERE request_key = ?').run(encode(input), key);
    return input;
  }

  commitEvents(resourceKey: string, page: { workerInstanceId: string; streamEpoch: string; events: readonly { sequence: number; event: unknown }[];
    nativeExecuting?: boolean; inputs?: readonly { caller: string; requestId: string; state: AllocationInput['state']; receipt?: unknown }[] }) {
    if (page.events.length > 1024 || Buffer.byteLength(encode(page)) > 8 * 1024 ** 2) throw fault('INVALID_CONTRACT', 'Allocation event page exceeds its bounded budget');
    let gap = false;
    const result = this.transaction(() => {
      const record = this.record(resourceKey);
      if (record.workerInstanceId !== page.workerInstanceId || record.streamEpoch !== page.streamEpoch) throw fault('CONFLICT', 'Allocation event identity changed');
      let cursor = record.afterSequence;
      const pendingEvents = new Map<number, string>();
      for (const item of page.events) {
        integer(item.sequence, 'event sequence', 1);
        const saved = this.db.prepare('SELECT body FROM allocation_events WHERE resource_key = ? AND stream_epoch = ? AND sequence = ?').get(resourceKey, page.streamEpoch, item.sequence) as { body: string } | undefined;
        const existing = saved?.body ?? pendingEvents.get(item.sequence);
        const body = encode(item.event);
        if (existing !== undefined) {
          if (existing !== body) throw fault('CONFLICT', 'An event sequence has different content');
          continue;
        }
        if (item.sequence !== cursor + 1) {
          gap = true;
          record.state = 'unknown';
          record.historyGap = { expectedSequence: cursor + 1, receivedSequence: item.sequence };
          return this.save(record);
        }
        pendingEvents.set(item.sequence, body);
        cursor = item.sequence;
      }
      for (const [sequence, body] of pendingEvents) {
        this.db.prepare('INSERT INTO allocation_events (resource_key, stream_epoch, sequence, body) VALUES (?, ?, ?, ?)').run(resourceKey, page.streamEpoch, sequence, body);
      }
      for (const input of page.inputs ?? []) this.writeInput(resourceKey, input.caller, input.requestId, input.state, input.receipt);
      if (page.nativeExecuting !== undefined) record.publicState = { ...record.publicState, nativeExecuting: page.nativeExecuting };
      record.afterSequence = cursor;
      return this.save(record);
    });
    if (gap) throw fault('EVENT_GAP', 'Allocation event history has a gap. New inputs are fenced.');
    return result;
  }

  events(resourceKey: string, afterSequence = 0, limit = 256): { sequence: number; event: unknown }[] {
    this.assertOpen(); integer(afterSequence, 'afterSequence'); integer(limit, 'event page limit', 1);
    if (limit > 1024) throw fault('INVALID_CONTRACT', 'Allocation ledger event pages are limited to 1024 entries');
    const record = this.record(resourceKey);
    return (this.db.prepare('SELECT sequence, body FROM allocation_events WHERE resource_key = ? AND stream_epoch = ? AND sequence > ? ORDER BY sequence LIMIT ?')
      .all(resourceKey, record.streamEpoch ?? '', afterSequence, limit) as { sequence: number; body: string }[]).map(row => ({ sequence: row.sequence, event: JSON.parse(row.body) }));
  }

  putRuntimeState(patch: { publicState?: Record<string, unknown>; privateState?: Record<string, unknown> }) {
    return this.transaction(() => {
      const run = this.readRun()!;
      if (patch.publicState) run.publicState = { ...run.publicState, ...patch.publicState };
      if (patch.privateState) run.privateState = { ...run.privateState, ...patch.privateState };
      run.updatedAt = new Date().toISOString();
      this.db.prepare('UPDATE allocation_run SET body = ? WHERE id = 1').run(encode(run));
      return run;
    });
  }

  beginClose() {
    return this.transaction(() => {
      const run = this.readRun()!;
      if (run.state === 'open') run.state = 'closing';
      run.updatedAt = new Date().toISOString();
      this.db.prepare('UPDATE allocation_run SET body = ? WHERE id = 1').run(encode(run));
      return run;
    });
  }

  completeClose() {
    return this.transaction(() => {
      const run = this.readRun()!;
      if (run.state !== 'closing' || this.occupied !== 0) throw fault('CONFLICT', 'Allocation run still owns resources or has no close intent');
      run.state = 'closed'; run.updatedAt = new Date().toISOString();
      this.db.prepare('UPDATE allocation_run SET body = ? WHERE id = 1').run(encode(run));
      return run;
    });
  }

  /** Closing the connection releases ownership. A pending run remains recoverable. */
  close() {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
