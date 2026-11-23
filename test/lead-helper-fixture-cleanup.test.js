import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeLeadHelperFixture } from './fixtures/lead-helper-scenario-cleanup.js';

test('a failed reconciliation still drains owned work, stops guests, closes its listener and removes its temp directory', { timeout: 5000 }, async t => {
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
  await assert.rejects(access(directory), { code: 'ENOENT' });
});
