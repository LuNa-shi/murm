import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AllocationRecord, AllocationResource, AllocationRun } from '../../src/core/allocation-ledger.js';

/** Read a consistent terminal snapshot without acquiring the Run's writer lock. */
export function checkLedger(directory: string, runtimeId: string, expectedAllocations: number) {
  const database = new DatabaseSync(join(directory, 'allocations.sqlite'), { readOnly: true });
  try {
    database.exec('PRAGMA busy_timeout = 0; BEGIN');
    const read = <T>(sql: string) => database.prepare(sql).all().map(row => JSON.parse(String(row.body)) as T);
    const [run] = read<AllocationRun>('SELECT body FROM allocation_run WHERE id = 1');
    assert.ok(run?.schemaVersion === 1 && run.runtimeId === runtimeId, 'The terminal ledger must identify the original Run');
    const records = read<AllocationRecord>('SELECT body FROM allocations');
    const resources = read<AllocationResource>('SELECT body FROM allocation_resources');
    const byResourceKey = new Map<string, AllocationResource[]>();
    const sandboxIds = new Set<string>();
    for (const resource of resources) {
      const rows = byResourceKey.get(resource.resourceKey) ?? [];
      rows.push(resource);
      byResourceKey.set(resource.resourceKey, rows);
      sandboxIds.add(resource.sandboxId);
    }
    const allocationKeys = new Set(records.map(record => record.resourceKey));
    const ownedResources = resources.every(resource => allocationKeys.has(resource.resourceKey));
    const complete = run.state === 'closed' && ownedResources && records.length === expectedAllocations && records.every(record => {
      const rows = byResourceKey.get(record.resourceKey) ?? [];
      return record.runtimeId === runtimeId && record.state === 'deleted' &&
        rows.some(resource => resource.sandboxId === record.sandboxId) &&
        rows.every(resource => resource.stopConfirmed && resource.managementAbsent && resource.stopEvidence && resource.deletionEvidence);
    });
    return { complete, runState: run.state, allocations: records.length, unconfirmedResources: resources.filter(row => !row.stopConfirmed || !row.managementAbsent).length,
      sandboxIds: [...sandboxIds] };
  } finally { database.close(); }
}
