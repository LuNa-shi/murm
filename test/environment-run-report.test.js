import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'environment-report-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('host report preserves business and cleanup failures independently and saves their trusted identities', async t => {
  const { runWithReport } = await import('../src/environments/shared/run-report.js');
  const outputDir = await directory(t);
  const business = Object.assign(new Error('Original business failure'), { code: 'MODEL_ERROR', runtimeId: 'runtime-one', botId: 'bot-one', requestId: 'input-one', inputId: 'actual-input', details: [{ code: 'UPSTREAM_REJECTED' }], privateToken: 'omit-this-field' });
  const report = await runWithReport({ outputDir, closeTimeoutMs: 100,
    createRuntime: async () => ({ id: 'runtime-one', close: async () => { throw Object.assign(new Error('Cleanup also failed'), { code: 'CLOSE_FAILED' }); } }),
    run: async () => { throw business; } });
  assert.equal(report.businessFailure.message, 'Original business failure');
  assert.equal(report.businessFailure.requestId, 'input-one'); assert.equal(report.businessFailure.inputId, 'actual-input');
  assert.deepEqual(report.businessFailure.details, [{ code: 'UPSTREAM_REJECTED' }]);
  assert.equal(report.cleanupFailure.code, 'CLOSE_FAILED'); assert.equal(report.cleanup, null); assert.equal(report.reportSaveFailure, null);
  assert.equal(JSON.stringify(report).includes('omit-this-field'), false);
  const saved = JSON.parse(await readFile(report.reportPath, 'utf8'));
  assert.deepEqual(saved.businessFailure, report.businessFailure); assert.deepEqual(saved.cleanupFailure, report.cleanupFailure);
});

test('factory failure retains pending cleanup identity without invoking business work or hiding its report path', async t => {
  const { runWithReport } = await import('../src/environments/shared/run-report.js');
  const outputDir = await directory(t); let ran = false;
  const error = Object.assign(new Error('Factory allocation uncertain'), { code: 'OPERATION_UNKNOWN', runtimeId: 'factory-run', cleanup: 'pending', reportPath: '/controlled/core-report.json', details: [{ code: 'MODEL_CLOSE_FAILED' }] });
  const report = await runWithReport({ outputDir, createRuntime: async () => { throw error; }, run: async () => { ran = true; } });
  assert.equal(ran, false); assert.equal(report.runtimeId, 'factory-run');
  assert.equal(report.businessFailure.reportPath, '/controlled/core-report.json');
  assert.equal(report.cleanupFailure.code, 'FACTORY_CLEANUP_PENDING'); assert.equal(report.cleanup, null);
  assert.ok(report.reportPath.endsWith('/factory-run/environment-report.json'));
});

test('report saving failure remains separate from prior business and cleanup failures and returns no false saved path', async t => {
  const { runWithReport } = await import('../src/environments/shared/run-report.js');
  const outputDir = await directory(t);
  await writeFile(join(outputDir, 'blocked-run'), 'controlled blocker');
  const report = await runWithReport({ outputDir, createRuntime: async () => ({ id: 'blocked-run', close: async () => ({ cleanup: 'pending', bots: [{ botId: 'b', execution: 'unknown', cleanup: 'pending' }], pending: [{ sandboxId: 'actual-sandbox' }] }) }),
    run: async () => { throw Object.assign(new Error('Original failure'), { code: 'ORIGINAL' }); } });
  assert.equal(report.businessFailure.code, 'ORIGINAL'); assert.equal(report.cleanupFailure.code, 'CLEANUP_PENDING');
  assert.equal(report.cleanup.pending[0].sandboxId, 'actual-sandbox');
  assert.equal(report.reportSaveFailure.code, 'REPORT_SAVE_FAILED'); assert.equal(report.reportPath, undefined);
});

test('a hung close has a finite host wait and preserves the business result for explicit later reconciliation', { timeout: 1000 }, async t => {
  const { runWithReport } = await import('../src/environments/shared/run-report.js');
  const outputDir = await directory(t);
  let closeCalls = 0;
  const report = await runWithReport({ outputDir, closeTimeoutMs: 10, createRuntime: async () => ({ id: 'hung-close', close({ timeoutMs }) { closeCalls++; assert.equal(timeoutMs, 10); return new Promise(() => {}); } }), run: async () => ({ accepted: false }) });
  assert.deepEqual(report.result, { accepted: false }); assert.equal(report.businessFailure, null);
  assert.equal(report.closeTimeoutMs, 10);
  assert.equal(report.cleanupFailure.code, 'CLOSE_WAIT_TIMEOUT'); assert.equal(closeCalls, 1); assert.equal(report.cleanup, null);
});

test('a hung post-close reconciliation preserves the physical receipt within the original host wait', { timeout: 1000 }, async t => {
  const { runWithReport } = await import('../src/environments/shared/run-report.js');
  const outputDir = await directory(t);
  const receipt = { cleanup: 'complete', bots: [{ botId: 'closed-bot', execution: 'stopped', cleanup: 'complete' }] };
  const report = await runWithReport({ outputDir, closeTimeoutMs: 10,
    createRuntime: async () => ({ id: 'reconciling-run', close: async () => receipt }),
    run: async () => ({ accepted: false }),
    afterClose: actual => { assert.deepEqual(actual, receipt); return new Promise(() => {}); },
  });
  assert.deepEqual(report.result, { accepted: false });
  assert.deepEqual(report.cleanup, receipt);
  assert.equal(report.cleanupFailure.code, 'CLOSE_WAIT_TIMEOUT');
  const saved = JSON.parse(await readFile(report.reportPath, 'utf8'));
  assert.deepEqual(saved.cleanup, receipt);
  assert.equal(saved.cleanupFailure.code, 'CLOSE_WAIT_TIMEOUT');
});

test('a close receipt arriving after the host timeout cannot start domain reconciliation or alter the report', { timeout: 1000 }, async t => {
  const { runWithReport } = await import('../src/environments/shared/run-report.js');
  const outputDir = await directory(t);
  const closed = Promise.withResolvers();
  let reconciliations = 0;
  const report = await runWithReport({ outputDir, closeTimeoutMs: 10,
    createRuntime: async () => ({ id: 'late-close', close: () => closed.promise }),
    run: async () => ({ completed: false }),
    afterClose: () => { reconciliations++; },
  });
  const saved = await readFile(report.reportPath, 'utf8');
  closed.resolve({ cleanup: 'complete', bots: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reconciliations, 0);
  assert.equal(report.cleanup, null);
  assert.equal(report.cleanupFailure.code, 'CLOSE_WAIT_TIMEOUT');
  assert.equal(await readFile(report.reportPath, 'utf8'), saved);
});

test('post-close work finishing after its timeout cannot mutate the saved or returned result projection', { timeout: 1000 }, async t => {
  const { runWithReport } = await import('../src/environments/shared/run-report.js');
  const outputDir = await directory(t);
  const reconciled = Promise.withResolvers();
  const result = { finalization: 'pending' };
  const report = await runWithReport({ outputDir, closeTimeoutMs: 10,
    createRuntime: async () => ({ id: 'late-reconciliation', close: async () => ({ cleanup: 'complete', bots: [] }) }),
    run: async () => result,
    afterClose: async () => { await reconciled.promise; result.finalization = 'late'; },
    redact: value => { queueMicrotask(() => reconciled.resolve()); return value; },
  });
  const saved = await readFile(report.reportPath, 'utf8');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.finalization, 'late');
  assert.deepEqual(report.result, { finalization: 'pending' });
  assert.deepEqual(JSON.parse(saved).result, { finalization: 'pending' });
  assert.equal(report.cleanup.cleanup, 'complete');
  assert.equal(report.cleanupFailure.code, 'CLOSE_WAIT_TIMEOUT');
  assert.equal(await readFile(report.reportPath, 'utf8'), saved);
});

test('a report-save failure returns a detached snapshot before late domain reconciliation finishes', { timeout: 1000 }, async t => {
  const { runWithReport } = await import('../src/environments/shared/run-report.js');
  const outputDir = await directory(t);
  await writeFile(join(outputDir, 'blocked-late-reconciliation'), 'controlled blocker');
  const reconciled = Promise.withResolvers();
  const result = { finalization: 'pending' };
  const report = await runWithReport({ outputDir, closeTimeoutMs: 10,
    createRuntime: async () => ({ id: 'blocked-late-reconciliation', close: async () => ({ cleanup: 'complete', bots: [] }) }),
    run: async () => result,
    afterClose: async () => { await reconciled.promise; result.finalization = 'late'; },
  });
  assert.deepEqual(report.result, { finalization: 'pending' });
  reconciled.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.finalization, 'late');
  assert.deepEqual(report.result, { finalization: 'pending' });
  assert.equal(report.businessFailure, null);
  assert.equal(report.cleanup.cleanup, 'complete');
  assert.equal(report.cleanupFailure.code, 'CLOSE_WAIT_TIMEOUT');
  assert.equal(report.reportSaveFailure.code, 'REPORT_SAVE_FAILED');
  assert.equal(report.reportSaveFailure.details[0].code, 'EEXIST');
  assert.equal(report.reportPath, undefined);
});

test('save failure also detaches earlier business failure details from late reconciliation', { timeout: 1000 }, async t => {
  const { runWithReport } = await import('../src/environments/shared/run-report.js');
  const outputDir = await directory(t);
  await writeFile(join(outputDir, 'blocked-business-details'), 'controlled blocker');
  const reconciled = Promise.withResolvers();
  const details = [{ finalization: 'pending' }];
  const report = await runWithReport({ outputDir, closeTimeoutMs: 10,
    createRuntime: async () => ({ id: 'blocked-business-details', close: async () => ({ cleanup: 'complete', bots: [] }) }),
    run: async () => { throw Object.assign(new Error('Business failed'), { code: 'ORIGINAL', details }); },
    afterClose: async () => { await reconciled.promise; details[0].finalization = 'late'; },
  });
  reconciled.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(details[0].finalization, 'late');
  assert.deepEqual(report.businessFailure.details, [{ finalization: 'pending' }]);
  assert.equal(report.businessFailure.code, 'ORIGINAL');
  assert.equal(report.cleanup.cleanup, 'complete');
  assert.equal(report.cleanupFailure.code, 'CLOSE_WAIT_TIMEOUT');
  assert.equal(report.reportSaveFailure.code, 'REPORT_SAVE_FAILED');
});

test('initial JSON serialization failure stays a detached report-save failure', async t => {
  const { runWithReport } = await import('../src/environments/shared/run-report.js');
  const outputDir = await directory(t);
  const details = [{ count: 1n }];
  const report = await runWithReport({ outputDir,
    createRuntime: async () => ({ id: 'serialization-failure', close: async () => ({ cleanup: 'pending', bots: [] }) }),
    run: async () => { throw Object.assign(new Error('Business failed'), { code: 'ORIGINAL', details }); },
  });
  details[0].count = 2n;
  assert.equal(report.businessFailure.code, 'ORIGINAL');
  assert.equal(report.businessFailure.details[0].count, 1n);
  assert.equal(report.cleanupFailure.code, 'CLEANUP_PENDING');
  assert.equal(report.reportSaveFailure.code, 'REPORT_SAVE_FAILED');
  assert.match(report.reportSaveFailure.details[0].message, /BigInt/i);
  assert.equal(report.reportPath, undefined);
});

test('successful Runtime reports use separate directories and apply host redaction before save and return', async t => {
  const { runWithReport } = await import('../src/environments/shared/run-report.js');
  const outputDir = await directory(t);
  const run = id => runWithReport({ outputDir,
    createRuntime: async () => ({ id, close: async () => ({ cleanup: 'complete', bots: [{ execution: 'stopped', cleanup: 'complete' }] }) }),
    run: async () => ({ value: 'private-marker', run: id }), redact: value => JSON.parse(JSON.stringify(value).replaceAll('private-marker', '[redacted]')) });
  const first = await run('first-runtime'), second = await run('second-runtime');
  assert.notEqual(first.reportPath, second.reportPath);
  for (const report of [first, second]) {
    assert.equal(report.businessFailure, null); assert.equal(report.cleanupFailure, null); assert.equal(report.reportSaveFailure, null);
    assert.equal(report.result.value, '[redacted]'); assert.equal((await readFile(report.reportPath, 'utf8')).includes('private-marker'), false);
  }
});
