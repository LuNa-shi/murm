import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ordersTreeDigest, testOrdersCandidate } from './dynamic-orders.js';

async function load(path: string, limit: number) {
  if (!path || (await stat(path)).size > limit) throw new Error('Missing or oversized verification input');
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function verifyClosedOrders(reportPath: string, bundlePath: string) {
  const [report, candidate] = await Promise.all([load(reportPath, 8 * 1024 ** 2), load(bundlePath, 2 * 1024 ** 2)]);
  const verdict = report.result?.verdict;
  assert.ok(verdict?.ok && verdict.results?.length === 9 && verdict.results.every((row: { ok: boolean }) => row.ok));
  assert.equal(report.businessFailure, null);
  assert.equal(report.cleanupFailure, null);
  assert.equal(report.reportSaveFailure, null);
  assert.equal(report.cleanup?.cleanup, 'complete');
  assert.equal(report.cleanup.agents?.length, 4);
  assert.ok(report.cleanup.agents.every((row: { execution: string; cleanup: string }) => row.execution === 'stopped' && row.cleanup === 'complete'));
  const checking = report.cleanup.harness?.resources?.filter((row: { kind: string }) => row.kind === 'checking-container');
  assert.equal(checking?.length, 1);
  assert.equal(checking[0].state, 'closed');
  assert.deepEqual(report.result.harness.dynamic.deployment.verification, { validInput: true, duplicateAndMalformedInput: true });
  for (const key of ['commit', 'sha256', 'treeSha256', 'image']) assert.equal(candidate[key], verdict[key]);
  assert.match(candidate.commit, /^[a-f0-9]{40}$/);
  assert.equal(candidate.commit, report.result.submitted.delivery.commit);
  assert.equal(candidate.sha256, report.result.submitted.delivery.sha256);
  assert.equal(ordersTreeDigest(candidate.files), candidate.treeSha256);
  assert.equal(createHash('sha256').update(Buffer.from(candidate.files['orders.mjs'], 'base64')).digest('hex'), candidate.sha256);
  const result = await testOrdersCandidate(candidate.files, candidate.image);
  return { ...result, commit: candidate.commit, treeSha256: candidate.treeSha256, historicalCleanup: 'complete' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = await verifyClosedOrders(process.argv[2], process.argv[3]);
    console.log(JSON.stringify(report));
    if (!report.ok) process.exitCode = 1;
  } catch {
    console.error('Orders verification could not confirm the frozen candidate and Run evidence');
    process.exitCode = 1;
  }
}
