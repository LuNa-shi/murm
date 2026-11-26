import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { finalizeRun } from '@murm/core';
import type { CloseReceipt } from '@murm/core';

test('public finalization verifies exported artifacts before releasing owned facilities', async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'murm-public-finalization-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const receipt: CloseReceipt = {
    agents: [], cleanup: 'complete', errors: [], pending: [], outputDir,
    evidence: { recorded: 0, lost: 0, pending: 0 },
  };
  const steps: string[] = [];
  const report = await finalizeRun({
    runtime: { id: 'public-run', async close() { steps.push('close'); return receipt; } },
    outputDir,
    business: { status: 'completed', value: { accepted: true } },
    verifyArtifacts(actual) {
      assert.deepEqual(actual, receipt);
      steps.push('verify');
    },
    ownedFacilities: [{ id: 'owned-gateway', close() { steps.push('release'); } }],
  });
  assert.deepEqual(steps, ['close', 'verify', 'release']);
  assert.deepEqual(report.business, { status: 'completed', value: { accepted: true } });
  assert.deepEqual(report.coreClose, { status: 'complete', receipt });
  assert.deepEqual(report.artifactVerification, { status: 'passed' });
  assert.deepEqual(report.facilities, [{ id: 'owned-gateway', status: 'complete' }]);
  assert.equal(report.reportSaveFailure, null);
  assert.ok(report.reportPath);
  const { reportPath, ...saved } = report;
  assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), saved);
});

test('concurrent finalization cannot repeat release of the same Runtime facilities', async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'murm-public-finalization-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const closed = Promise.withResolvers<CloseReceipt>();
  let closeCalls = 0;
  let facilityCalls = 0;
  const options = {
    runtime: { id: 'public-concurrent', close() { closeCalls++; return closed.promise; } },
    outputDir,
    business: { status: 'completed', value: true } as const,
    ownedFacilities: [{ id: 'owned-gateway', close() { facilityCalls++; } }],
    cleanupTimeoutMs: 50,
  };

  const first = finalizeRun(options);
  const duplicate = assert.rejects(finalizeRun(options), { code: 'CONFLICT' });
  closed.resolve({ agents: [], cleanup: 'complete', errors: [], pending: [], outputDir,
    evidence: { recorded: 0, lost: 0, pending: 0 } });
  await duplicate;
  await first;
  assert.equal(closeCalls, 1);
  assert.equal(facilityCalls, 1);
});

test('a required export failure, business failure and report save failure keep separate receipts', async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'murm-public-finalization-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const runtimeId = 'public-pending';
  await writeFile(join(outputDir, runtimeId), 'block report directory');
  const pending = { kind: 'agent', id: 'producer', action: 'collect-artifacts', sandboxId: 'original-sandbox' } as const;
  const report = await finalizeRun({
    runtime: { id: runtimeId, async close() {
      return { agents: [], cleanup: 'pending', errors: [], pending: [pending], outputDir,
        evidence: { recorded: 0, lost: 0, pending: 0 } };
    } },
    outputDir,
    business: { status: 'failed', error: { code: 'HANDOFF_FAILED', message: 'Consumer had no message' } },
    verifyArtifacts() { throw Object.assign(new Error('Required output missing'), { code: 'MISSING_ARTIFACT' }); },
    ownedFacilities: [{ id: 'owned-gateway', close() { assert.fail('must retain facility pending Core cleanup'); } }],
  });
  assert.equal(report.business.status, 'failed');
  assert.equal(report.business.error.code, 'HANDOFF_FAILED');
  assert.equal(report.coreClose.status, 'pending');
  assert.deepEqual(report.coreClose.receipt.pending, [pending]);
  assert.equal(report.artifactVerification.status, 'failed');
  assert.equal(report.artifactVerification.error.code, 'ARTIFACT_VERIFICATION_FAILED');
  assert.equal(report.facilities[0].error.code, 'CORE_CLOSE_PENDING');
  assert.equal(report.reportSaveFailure?.code, 'REPORT_SAVE_FAILED');
  assert.equal(report.reportPath, undefined);
});

test('a host timeout reports unknown and a late Core receipt cannot release facilities or rewrite the report', async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'murm-public-finalization-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const closed = Promise.withResolvers<CloseReceipt>();
  const report = await finalizeRun({
    runtime: { id: 'public-late-close', close: () => closed.promise },
    outputDir,
    business: { status: 'cancelled', error: { code: 'HOST_ABORT', message: 'Cancelled' } },
    verifyArtifacts() { assert.fail('artifact verification requires a close receipt'); },
    ownedFacilities: [{ id: 'owned-gateway', close() { assert.fail('late close cannot trigger facility release'); } }],
    cleanupTimeoutMs: 5,
  });
  assert.equal(report.coreClose.status, 'unknown');
  assert.equal(report.coreClose.error.code, 'CLEANUP_WAIT_TIMEOUT');
  assert.equal(report.artifactVerification.status, 'pending');
  assert.equal(report.facilities[0].status, 'pending');
  assert.ok(report.reportPath);
  const saved = await readFile(report.reportPath, 'utf8');
  closed.resolve({ agents: [], cleanup: 'complete', errors: [], pending: [], outputDir,
    evidence: { recorded: 0, lost: 0, pending: 0 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await readFile(report.reportPath, 'utf8'), saved);
});
