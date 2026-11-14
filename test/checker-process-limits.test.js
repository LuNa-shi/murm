import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CHECKER_RESOURCE_PROFILE, createCheckerProcessLimits, verifyCheckerProcessLimits } from '../src/judge/checker-process-limits.js';

test('checker limits use a fixed bounded and isolated transient service profile', () => {
  const limits = createCheckerProcessLimits({ runtimeMs: 100 });
  const args = limits.argsFor('/bin/true', []);
  assert.ok(args.includes('--property=RuntimeMaxSec=1100ms'));
  assert.ok(args.includes('--property=MemoryMax=4294967296'));
  assert.ok(args.includes('--property=TasksMax=64'));
  assert.ok(args.includes('--property=CPUQuota=200%'));
  assert.ok(args.includes('--expand-environment=no'));
  assert.throws(() => createCheckerProcessLimits({ runtimeMs: Infinity }), TypeError);
  assert.throws(() => limits.argsFor('true', []), TypeError);
});

test('real user transient unit enforces memory, swap, PID and CPU bounds and kills descendants', {
  skip: process.env.SWARMENV_TEST_SYSTEMD_CHECKER !== '1',
}, async t => {
  assert.equal(await verifyCheckerProcessLimits(), CHECKER_RESOURCE_PROFILE);
  const limits = createCheckerProcessLimits({ runtimeMs: 10_000 });
  const child = spawn(limits.command, limits.argsFor('/bin/sh', ['-c',
    'sleep 30 & read -r group </proc/self/cgroup; printf "%s\\n" "${group#0::}"; wait',
  ]), { env: limits.environment, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  let clientClosed = false;
  const closed = once(child, 'close').then(() => { clientClosed = true; });
  t.after(() => limits.stop({ clientSettled: () => clientClosed }));
  const [chunk] = await once(child.stdout, 'data');
  const path = `/sys/fs/cgroup${chunk.toString().trim()}`;
  const read = async name => (await readFile(`${path}/${name}`, 'utf8')).trim();
  assert.equal(await read('memory.max'), String(CHECKER_RESOURCE_PROFILE.memory_bytes));
  assert.equal(await read('memory.swap.max'), '0');
  assert.equal(await read('pids.max'), String(CHECKER_RESOURCE_PROFILE.max_tasks));
  const [cpuQuota, period] = (await read('cpu.max')).split(' ').map(Number);
  assert.equal(cpuQuota / period, CHECKER_RESOURCE_PROFILE.cpu_percent / 100);
  assert.ok((await read('cgroup.procs')).split('\n').length >= 2);
  await Promise.all([limits.waitForEmpty({ clientSettled: () => clientClosed }), closed]);
  const state = execFileSync('/usr/bin/systemctl', ['--user', 'show', limits.unit, '-p', 'ActiveState', '--value'],
    { env: limits.environment, encoding: 'utf8' }).trim();
  assert.ok(['inactive', 'failed'].includes(state));
  try { assert.match(await read('cgroup.events'), /^populated 0$/m); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
});

test('a bounded pending stop neither releases ownership nor prevents later confirmation', {
  skip: process.env.SWARMENV_TEST_SYSTEMD_CHECKER !== '1',
}, async () => {
  const limits = createCheckerProcessLimits({ runtimeMs: 2_000 });
  let clientClosed = false;
  let confirmed = false;
  let pending;
  const pendingObserved = new Promise(resolve => { pending = resolve; });
  const cleanup = limits.waitForEmpty({ clientSettled: () => clientClosed, onPending: pending })
    .then(() => { confirmed = true; });
  const error = await pendingObserved;
  assert.equal(error.code, 'CHECKER_CLEANUP_PENDING');
  assert.equal(error.unit, limits.unit);
  assert.equal(confirmed, false);
  clientClosed = true;
  await cleanup;
  assert.equal(confirmed, true);
});
