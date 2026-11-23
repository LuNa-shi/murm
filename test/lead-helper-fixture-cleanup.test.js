import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, access, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeLeadHelperFixture } from './fixtures/lead-helper-scenario-cleanup.js';

test('a failed reconciliation drains work and closes its listener while retaining uncertain runtime evidence', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lead-helper-teardown-'));
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const guest = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  await once(guest, 'spawn');
  const controller = new AbortController(); let drained = false;
  // Keep the regression itself bounded even when testing broken teardown.
  t.after(async () => {
    controller.abort(); guest.kill();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });
  const work = new Set([new Promise(resolve => controller.signal.addEventListener('abort', () => {
    setTimeout(() => { drained = true; resolve(); }, 20);
  }, { once: true }))]);
  const original = new Error('controlled close failure');
  await assert.rejects(closeLeadHelperFixture({ directory, server, guests: [guest], work,
    stopWork: () => controller.abort(), reconcile: async () => { throw original; } }), error => error === original);
  assert.equal(drained, true); assert.equal(server.listening, false); assert.ok(guest.exitCode !== null || guest.signalCode !== null);
  await access(directory);
});

test('simulated sends drain before final close flushes a resumed writer in the runtime output directory', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lead-helper-late-writer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const resumed = Promise.withResolvers(); let drained = false; let writer;
  const callback = resumed.promise.then(() => { drained = true; });
  // Mirror backend.send -> Core.send: evidence persistence is started by an
  // owner resumed after the tracked transport callback has already returned.
  const owner = (async () => {
    await (async () => { await callback; })();
    writer = (async () => {
      const output = join(directory, '00000000-0000-4000-8000-000000000001');
      await mkdir(output); await writeFile(join(output, 'evidence.jsonl'), '{}\n');
    })();
  })();
  const work = new Set([callback]);
  await closeLeadHelperFixture({ directory, guests: [], work, stopWork: () => resumed.resolve(),
    async reconcile() {
      assert.equal(drained, true, 'Core close must follow the last simulated send');
      assert.ok(writer, 'Core send continuation must enqueue evidence before final flush');
      await writer;
    } });
  await owner;
  await assert.rejects(access(directory), { code: 'ENOENT' });
});
