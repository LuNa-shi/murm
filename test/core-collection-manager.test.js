import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenSandboxManager } from '../src/runtime/opensandbox-manager.js';

const spec = { paths: ['.'], includeGit: false, maxBytes: 1024, required: true };
async function fixture() {
  let stopped = false;
  let deletions = 0;
  let records = [{ type: 'end', totalBytes: 0, fileCount: 0, directoryCount: 0 }];
  const manager = createOpenSandboxManager({ lifecycleBaseUrl: 'http://sandbox.test/v1', image: 'fixture',
    fetchImpl: async (url, options) => {
      const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/sandboxes')) return json({ id: 'sandbox-collect' });
      if (url.includes('/endpoints/44772')) return json({ url: 'http://execd.test' });
      if (url.includes('/endpoints/44100')) return json({ url: 'http://worker.test' });
      if (url.endsWith('/health')) return json({ ok: true });
      if (url.endsWith('/start')) return json({ result: { contract: { version: 'swarmenv-core-v1', resources: [] }, project_files: { version: 0, writable: false } } });
      if (url.endsWith('/stop')) return json({ result: { stopped } });
      if (url.endsWith('/core/files/collect') || url.endsWith('/core/session/archive')) {
        assert.match(options.headers.authorization, /^Bearer /);
        return new Response(records.map(record => JSON.stringify(record)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
      }
      if (options.method === 'DELETE') { deletions++; return new Response(null, { status: 204 }); }
      if (url.endsWith('/sandboxes/sandbox-collect')) return new Response(null, { status: 404 });
      throw new Error('Unexpected fixture request');
    } });
  await manager.ensureExecution({ executionId: 'bot', botId: 'bot', cleanupOnFailure: false });
  await manager.startAgent({ executionId: 'bot', command: 'pi', args: [], writable: false, resources: [] });
  return { manager, setStopped: () => { stopped = true; }, deletions: () => deletions, setRecords: input => { records = input; } };
}
const consume = async stream => { const rows = []; for await (const row of stream) rows.push(row); return rows; };

test('Core export retains its authenticated Worker after confirmed stop and rejects deletion while stop is unknown', async () => {
  const f = await fixture();
  await assert.rejects(consume(f.manager.collectCoreFiles('bot', spec)), { code: 'NOT_ALLOWED' });
  await assert.rejects(f.manager.stopAgent('bot', 'SIGTERM', { preserveWorker: true }));
  await assert.rejects(f.manager.stopExecution('bot'));
  assert.equal(f.deletions(), 0);
  assert.equal(f.manager.coreResource('bot').executionStopped, false);
  f.setStopped();
  assert.equal(await f.manager.stopAgent('bot', 'SIGTERM', { preserveWorker: true }), true);
  assert.deepEqual(await consume(f.manager.collectCoreFiles('bot', spec)), [{ type: 'end', totalBytes: 0, fileCount: 0, directoryCount: 0 }]);
  assert.equal(f.manager.coreResource('bot').sandboxId, 'sandbox-collect');
  assert.equal(f.manager.coreResource('bot').executionStopped, true);
  await f.manager.stopExecution('bot');
  assert.equal(f.deletions(), 1);
  assert.equal(f.manager.coreResource('bot').creation, 'absent');
});

test('collection transport rejects truncated, oversized or failed streams and preserves the stopped resource for retry', async () => {
  const f = await fixture();
  f.setStopped();
  await f.manager.stopAgent('bot', 'SIGTERM', { preserveWorker: true });
  f.setRecords([{ type: 'file', path: 'unfinished', bytes: 1, mode: 0o644 }]);
  await assert.rejects(consume(f.manager.collectCoreFiles('bot', spec)), /complete receipt/);
  f.setRecords([{ type: 'chunk', data: 'A'.repeat(128 * 1024) }]);
  await assert.rejects(consume(f.manager.collectCoreFiles('bot', spec)), /line limit/);
  f.setRecords([{ type: 'error', code: 'INVALID_CONTRACT', message: 'Collection exceeds maxBytes' }]);
  await assert.rejects(consume(f.manager.collectCoreFiles('bot', spec)), { code: 'INVALID_CONTRACT' });
  assert.equal(f.manager.coreResource('bot').creation, 'created');
  assert.equal(f.manager.coreResource('bot').executionStopped, true);
  f.setRecords([{ type: 'end', totalBytes: 0, fileCount: 0, directoryCount: 0 }]);
  assert.equal((await consume(f.manager.collectCoreFiles('bot', spec))).length, 1);
  await assert.rejects(consume(f.manager.collectCoreFiles('bot', { ...spec, maxBytes: 2048 })), { code: 'CONFLICT' });
});


test('native Session transport has independent fixed scope and survives a retried stopped-resource export', async () => {
  const f = await fixture();
  await assert.rejects(consume(f.manager.collectCoreSession('bot')), { code: 'NOT_ALLOWED' });
  f.setStopped();
  await f.manager.stopAgent('bot', 'SIGTERM', { preserveWorker: true });
  await consume(f.manager.collectCoreFiles('bot', spec));
  f.setRecords([{ type: 'file', path: 'native.jsonl', bytes: 1, mode: 0o600 }]);
  await assert.rejects(consume(f.manager.collectCoreSession('bot')), /complete receipt/);
  assert.equal(f.manager.coreResource('bot').creation, 'created');
  f.setRecords([{ type: 'end', totalBytes: 0, fileCount: 0, directoryCount: 0 }]);
  assert.equal((await consume(f.manager.collectCoreSession('bot'))).length, 1);
  await f.manager.stopExecution('bot');
});
