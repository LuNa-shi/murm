import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CHECKER_RESOURCE_PROFILE, createCheckerProcessLimits, verifyCheckerProcessLimits } from '../examples/taskpool/services/judge/checker-process-limits.js';

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

test('operator checker resource overrides are isolated from defaults and validated before dispatch', () => {
  const resources = { memory_bytes: 64 * 1024 ** 3, cpu_percent: 800, max_tasks: 128 };
  const args = createCheckerProcessLimits({ runtimeMs: 100, resources }).argsFor('/bin/true', []);
  assert.ok(args.includes('--property=MemoryMax=68719476736'));
  assert.ok(args.includes('--property=CPUQuota=800%'));
  assert.ok(args.includes('--property=TasksMax=128'));
  assert.equal(CHECKER_RESOURCE_PROFILE.memory_bytes, 4 * 1024 ** 3);
  for (const invalid of [{ memory_bytes: 0 }, { cpu_percent: Infinity }, { max_tasks: -1 }, { swap_bytes: 100 }, []]) {
    assert.throws(() => createCheckerProcessLimits({ runtimeMs: 100, resources: invalid }), TypeError);
  }
});

test('real cgroup enforces the selected operator resource profile', {
  skip: process.env.MURM_TEST_SYSTEMD_CHECKER !== '1',
}, async () => {
  const resources = { memory_bytes: 8 * 1024 ** 3, cpu_percent: 400, max_tasks: 128 };
  const observed = await verifyCheckerProcessLimits(resources);
  for (const [key, value] of Object.entries(resources)) assert.equal(observed[key], value);
  assert.equal(observed.swap_bytes, 0);
  assert.equal(observed.stop_grace_ms, 1000);
});

test('real user transient unit enforces memory, swap, PID and CPU bounds and kills descendants', {
  skip: process.env.MURM_TEST_SYSTEMD_CHECKER !== '1',
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
  skip: process.env.MURM_TEST_SYSTEMD_CHECKER !== '1',
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

test('durable checker ownership reaps the unit and descendants after its client process dies', {
  skip: process.env.MURM_TEST_SYSTEMD_CHECKER !== '1', timeout: 15000,
}, async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { cleanupOwnedCheckers } = await import('../examples/taskpool/services/judge/checker-owner.js');
  const root = await mkdtemp(join(tmpdir(), 'checker-owner-'));
  const ownerFile = join(root, 'owned.ndjson');
  const limits = createCheckerProcessLimits({ runtimeMs: 10000, ownerFile });
  const child = spawn(limits.command, limits.argsFor('/bin/sh', ['-c',
    'sleep 30 & read -r group </proc/self/cgroup; printf "%s\\n" "${group#0::}"; wait',
  ]), { env: limits.environment, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  const closed = once(child, 'close');
  t.after(async () => { await cleanupOwnedCheckers(ownerFile); await rm(root, { recursive: true, force: true }); });
  const [chunk] = await once(child.stdout, 'data');
  const group = `/sys/fs/cgroup${chunk.toString().trim()}`;
  child.kill('SIGKILL');
  assert.equal((await cleanupOwnedCheckers(ownerFile)).settled, 1);
  await closed;
  assert.equal((await cleanupOwnedCheckers(ownerFile)).settled, 0);
  const events = await readFile(`${group}/cgroup.events`, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return 'populated 0'; throw error;
  });
  assert.match(events, /^populated 0$/m);
});

test('recovery fences a delayed dispatch before claiming its absent unit settled', {
  skip: process.env.MURM_TEST_SYSTEMD_CHECKER !== '1', timeout: 15000,
}, async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { cleanupOwnedCheckers } = await import('../examples/taskpool/services/judge/checker-owner.js');
  const root = await mkdtemp(join(tmpdir(), 'checker-late-dispatch-'));
  const ownerFile = join(root, 'owned.ndjson');
  const limits = createCheckerProcessLimits({ runtimeMs: 2000, ownerFile });
  const child = spawn('/bin/sh', ['-c', 'kill -STOP $$; exec "$@"', 'delayed-checker',
    limits.command, ...limits.argsFor('/usr/bin/sleep', ['2'])],
  { detached: true, env: limits.environment, stdio: 'ignore' });
  const closed = once(child, 'close');
  t.after(async () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await closed;
    execFileSync('/usr/bin/systemctl', ['--user', 'stop', limits.unit], { env: limits.environment });
    execFileSync('/usr/bin/systemctl', ['--user', 'unmask', '--runtime', limits.unit], { env: limits.environment });
    await rm(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + 2000;
  while (!(await readFile(`/proc/${child.pid}/stat`, 'utf8')).split(') ')[1].startsWith('T ')) {
    assert.ok(Date.now() < deadline, 'Dispatcher must reach the controlled pause'); await delay(10);
  }
  assert.equal((await cleanupOwnedCheckers(ownerFile)).settled, 1);
  child.kill('SIGCONT');
  assert.equal((await closed)[0], 125);
  const state = execFileSync('/usr/bin/systemctl', ['--user', 'show', limits.unit, '-p', 'ActiveState', '--value'],
    { env: limits.environment, encoding: 'utf8' }).trim();
  assert.equal(state, 'inactive');
  assert.equal((await cleanupOwnedCheckers(ownerFile)).settled, 0);
});
