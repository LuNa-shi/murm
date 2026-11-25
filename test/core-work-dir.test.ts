import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CoreWorkDir } from '../scripts/core-work-dir.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'core-files-worker-'));
  const path = join(root, 'work');
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o555);
  t.after(async () => { await chmod(path, 0o700); await rm(root, { recursive: true, force: true }); });
  return { root, path, worker: new CoreWorkDir({ path, uid: process.getuid(), gid: process.getgid(), assertOpen() {} }) };
}

test('trusted Worker prepares ordinary bytes before a same-version grant and preserves executable mode', async t => {
  const { path, worker } = await fixture(t);
  const seed = { version: 1, files: { 'bin/sample': { encoding: 'base64', data: 'AP+A', mode: 0o755 } } };
  const [first, repeat] = await Promise.all([worker.prepare(seed), worker.prepare(seed)]);
  assert.equal(repeat, first);
  assert.deepEqual(await readFile(join(path, 'bin/sample')), Buffer.from([0, 255, 128]));
  assert.equal((await lstat(path)).mode & 0o777, 0o555);
  assert.equal((await lstat(join(path, 'bin/sample'))).mode & 0o777, 0o755);
  await assert.rejects(worker.prepare({ ...seed, version: 2 }), { code: 'CONFLICT' });
  await assert.rejects(worker.grant({ ...first, version: 2 }), { code: 'CONFLICT' });
  const writable = await worker.grant(first);
  assert.deepEqual(writable, { ...first, writable: true });
  assert.deepEqual(await worker.grant(first), writable);
  assert.equal((await lstat(path)).mode & 0o777, 0o755);
  assert.equal((await lstat(join(path, 'bin/sample'))).mode & 0o777, 0o755);
});

test('trusted Worker denies a prepared ancestor symlink before granting or changing an outside sentinel', async t => {
  const { root, path, worker } = await fixture(t);
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'file'), 'fixed', { mode: 0o644 });
  const receipt = await worker.prepare({ version: 1, files: { 'child/file': { encoding: 'utf8', data: 'fixed' } } });
  await chmod(path, 0o700);
  await rm(join(path, 'child'), { recursive: true });
  await symlink(outside, join(path, 'child'));
  await chmod(path, 0o555);
  await assert.rejects(worker.grant(receipt), { code: 'CONFLICT' });
  assert.equal(await readFile(join(outside, 'file'), 'utf8'), 'fixed');
  assert.equal((await lstat(path)).mode & 0o777, 0o555);
});

test('trusted snapshot returns fixed binary bytes and never recaptures an existing request', async t => {
  const { path, worker } = await fixture(t);
  await worker.initialize({ writable: true });
  await writeFile(join(path, 'result'), Buffer.from([0, 255, 128]));
  const options = { requestId: 'capture', paths: ['result'], includeGit: false, maxBytes: 1024, required: true };
  const first = await worker.snapshot(options);
  assert.equal(first.files.result.data, 'AP+A');
  await writeFile(join(path, 'result'), 'changed');
  assert.deepEqual(await worker.snapshot(options), first);
  await assert.rejects(worker.snapshot({ ...options, paths: ['other'] }), { code: 'CONFLICT' });
  const second = await worker.snapshot({ ...options, requestId: 'second' });
  assert.equal(second.version, first.version + 1);
  assert.equal(Buffer.from(second.files.result.data, 'base64').toString(), 'changed');
  await symlink('/etc/passwd', join(path, 'escape'));
  await assert.rejects(worker.snapshot({ ...options, requestId: 'escape', paths: ['escape'] }), { code: 'INVALID_CONTRACT' });
});

test('live installation checks current bytes and retains exact tree until host confirmation', {
  skip: process.getuid() !== 0 && 'Trusted live installation requires root worker permissions',
}, async t => {
  const { path } = await fixture(t);
  const worker = new CoreWorkDir({ path, uid: 1000, gid: 1000, assertOpen() {} });
  const original = { 'proof.lean': { encoding: 'utf8', data: 'original' }, 'obsolete': { encoding: 'utf8', data: 'remove' } };
  await worker.initialize({ files: original, writable: true });
  const before = await worker.snapshot({ requestId: 'before', paths: ['.'], includeGit: false, maxBytes: 4096, required: true });
  const inode = (await lstat(path)).ino;
  const files = { 'proof.lean': { encoding: 'utf8', data: 'integrated', mode: 0o755 }, 'binary': { encoding: 'base64', data: 'AP+A' } };
  const input = { requestId: 'install', version: 2, expectedDigest: before.digest, files };
  await writeFile(join(path, 'proof.lean'), 'unsaved');
  await assert.rejects(worker.install(input, []), { code: 'WORKSPACE_BUSY' });
  await writeFile(join(path, 'proof.lean'), 'original');
  const installed = await worker.install(input, []);
  assert.equal(installed.phase, 'installed'); assert.equal(worker.installPending, true);
  assert.equal((await lstat(path)).ino, inode);
  assert.equal(await readFile(join(path, 'proof.lean'), 'utf8'), 'integrated');
  assert.equal((await lstat(join(path, 'proof.lean'))).mode & 0o777, 0o755);
  assert.deepEqual(await readFile(join(path, 'binary')), Buffer.from([0, 255, 128]));
  await assert.rejects(readFile(join(path, 'obsolete')), { code: 'ENOENT' });
  assert.deepEqual(await worker.install(input, []), installed);
  await assert.rejects(worker.install({ ...input, files: original }, []), { code: 'CONFLICT' });
  await assert.rejects(worker.confirm({ ...installed, digest: before.digest }), { code: 'CONFLICT' });
  const committed = await worker.confirm(installed);
  assert.equal(committed.phase, 'committed'); assert.equal(worker.installPending, false);
  await writeFile(join(path, 'proof.lean'), 'continued');
  assert.equal((await worker.install(input, [])).phase, 'committed');
  assert.equal(await readFile(join(path, 'proof.lean'), 'utf8'), 'continued');
});
