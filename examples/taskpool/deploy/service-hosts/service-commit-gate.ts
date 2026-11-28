import { SERVICE_COMMIT_SCHEMA_SQL } from '../../persistence/service-peer-schema.js';
import { createHash, randomUUID } from 'node:crypto';
import { stableStringify } from '../../persistence/envelope.js';
import { ERROR_CODES, MurmError } from '../../errors.js';

export function ensureServiceCommitSchema(db: any) {
  db.exec(SERVICE_COMMIT_SCHEMA_SQL);
}

export function assertServiceCommitSettled(db: any) {
  // The table is created before a peer can issue a write.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'service_commit_gate'").get()) return;
  const pending = db.prepare('SELECT gate_id FROM service_commit_gate WHERE singleton = 1').get();
  if (pending) throw new MurmError(ERROR_CODES.SERVICE_NOT_READY,
    'An independent service commit must be reconciled before lifecycle changes',
    { gate_id: pending.gate_id }, { retryable: true });
}

/** Task-owned durable exclusion for one exact Context commit / Judge launch.
 * No expiry unlocks this gate: an HTTP timeout does not cancel a peer write.
 */
export class ServiceCommitGate {
  declare taskService: any;
  declare db: any;

  constructor(taskService: any) {
    this.taskService = taskService;
    this.db = taskService.db;
    ensureServiceCommitSchema(this.db);
  }

  pending() {
    const row = this.db.prepare('SELECT * FROM service_commit_gate WHERE singleton = 1').get();
    return row ? { gate_id: row.gate_id, digest: row.digest, command: JSON.parse(row.command_json), created_at: row.created_at } : null;
  }

  acquire(command: any) {
    return this.taskService.withServiceLifecycleWrite(() => {
      const resolved = typeof command === 'function' ? command() : command;
      if (!['context', 'judge'].includes(resolved?.service)) throw new TypeError('A service commit must target Context or Judge');
      const encoded = stableStringify(resolved);
      const gate_id = randomUUID();
      const digest = createHash('sha256').update(encoded).digest('hex');
      this.db.prepare('INSERT INTO service_commit_gate VALUES (1, ?, ?, ?, ?)')
        .run(gate_id, digest, encoded, new Date().toISOString());
      return this.pending();
    });
  }

  deliverEvents() {
    for (const row of this.db.prepare('SELECT * FROM service_commit_events WHERE delivered = 0 ORDER BY rowid').all()) {
      for (const [index, event] of JSON.parse(row.events_json).entries()) this.taskService.notifyDependencyEvent({
        ...event, event_id: `${row.gate_id}:${index}`,
      });
      this.db.prepare('UPDATE service_commit_events SET delivered = 1 WHERE gate_id = ?').run(row.gate_id);
    }
  }

  settle(admission: any, receipt: any) {
    if (receipt?.terminal !== true) throw new MurmError(ERROR_CODES.SERVICE_NOT_READY,
      'A service commit requires a durable terminal receipt', undefined, { retryable: true });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pending = this.pending();
      if (!pending || pending.gate_id !== admission.gate_id || pending.digest !== admission.digest) {
        throw new MurmError(ERROR_CODES.CONFLICT, 'Service commit receipt does not match the pending command');
      }
      if (receipt.events?.length) this.db.prepare('INSERT OR IGNORE INTO service_commit_events (gate_id, events_json) VALUES (?, ?)')
        .run(receipt.events[0].event_id ?? pending.gate_id, JSON.stringify(receipt.events));
      this.db.prepare('DELETE FROM service_commit_gate WHERE singleton = 1').run();
      this.db.exec('COMMIT');
    } catch (error: any) { this.db.exec('ROLLBACK'); throw error; }
  }
}
