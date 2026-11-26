import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, access, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeLeadWorkerFixture } from './fixtures/lead-worker-scenario-cleanup.js';
import { setTimeout as delay } from 'node:timers/promises';

test('a failed reconciliation drains work and closes its listener while retaining uncertain runtime evidence', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lead-worker-teardown-'));
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const guest = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
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
  await assert.rejects(closeLeadWorkerFixture({ directory, server, guests: [guest], work,
    stopWork: () => controller.abort(), reconcile: async () => { throw original; } }), error => error === original);
  assert.equal(drained, true); assert.equal(server.listening, false); assert.ok(guest.exitCode !== null || guest.signalCode !== null);
  await access(directory);
});

test('stopping an active simulated guest terminates its Bash and sleep descendants', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lead-worker-guest-tree-'));
  const command = `trap '' TERM; sleep 60 >/dev/null 2>&1 & printf '%s %s\\n' "$$" "$!"; exec >/dev/null 2>&1; wait`;
  const program = `const {execFile}=require('node:child_process');const child=execFile('bash',['-c',${JSON.stringify(command)}],{timeout:15000},()=>{});child.stdout.pipe(process.stdout);`;
  const guest = spawn(process.execPath, ['-e', program], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(async () => {
    try { process.kill(-guest.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await rm(directory, { recursive: true, force: true });
  });
  const [bytes] = await once(guest.stdout, 'data');
  const descendants = bytes.toString().trim().split(/\s+/).map(Number);
  assert.equal(descendants.length, 2); assert.ok(descendants.every(pid => Number.isSafeInteger(pid) && pid > 1));
  for (const pid of descendants) {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    assert.equal(Number(fields[2]), guest.pid, 'Only the detached guest process group is owned');
  }
  const live = async pid => {
    // A process can disappear after procfs opens stat but before its read.
    try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return false; throw error; }
  };
  assert.ok((await Promise.all(descendants.map(live))).every(Boolean));
  await closeLeadWorkerFixture({ directory, guests: [guest], work: [], stopWork() {}, async reconcile() {} });
  for (let attempt = 0; attempt < 40 && (await Promise.all(descendants.map(live))).some(Boolean); attempt++) await delay(25);
  assert.deepEqual(await Promise.all(descendants.map(live)), [false, false], 'Node guest exit must not abandon an executing descendant');
});

test('simulated sends drain before final close flushes a resumed writer in the runtime output directory', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lead-worker-late-writer-'));
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
  await closeLeadWorkerFixture({ directory, guests: [], work, stopWork: () => resumed.resolve(),
    async reconcile() {
      assert.equal(drained, true, 'Core close must follow the last simulated send');
      assert.ok(writer, 'Core send continuation must enqueue evidence before final flush');
      await writer;
    } });
  await owner;
  await assert.rejects(access(directory), { code: 'ENOENT' });
});
