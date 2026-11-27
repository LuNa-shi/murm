import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CoreWorkDir } from '../scripts/core-work-dir.js';

async function fixture(t, uid = process.getuid()) {
  const root = await mkdtemp(join(tmpdir(), 'core-files-worker-'));
  const path = join(root, 'work');
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o555);
  t.after(async () => { await chmod(path, 0o700); await rm(root, { recursive: true, force: true }); });
  return { root, path, worker: new CoreWorkDir({ path, uid, gid: uid, assertOpen() {} }) };
}

test('trusted startup accepts ordinary binary bytes and preserves executable mode', async t => {
  const { path, worker } = await fixture(t);
  await chmod(path, 0o755);
  const files = { 'bin/sample': { encoding: 'base64', data: 'AP+A', mode: 0o755 } };
  assert.equal((await worker.initialize({ files, writable: false })).writable, false);
  assert.deepEqual(await readFile(join(path, 'bin/sample')), Buffer.from([0, 255, 128]));
  assert.equal((await lstat(join(path, 'bin/sample'))).mode & 0o777, 0o755);
});

test('trusted snapshot returns fixed binary bytes and never recaptures an existing request', async t => {
  const { path, worker } = await fixture(t);
  await worker.initialize({ writable: true });
  await writeFile(join(path, 'result'), Buffer.from([0, 255, 128]));
  const options = { requestId: 'capture', paths: ['result'], maxBytes: 1024 };
  const first = await worker.snapshot(options);
  assert.equal(first.files.result.data, 'AP+A');
  assert.match(first.digest, /^partial:sha256:/);
  await writeFile(join(path, 'result'), 'changed');
  assert.deepEqual(await worker.snapshot(options), first);
  await assert.rejects(worker.snapshot({ ...options, paths: ['other'] }), { code: 'CONFLICT' });
  const second = await worker.snapshot({ ...options, requestId: 'second' });
  assert.equal(second.version, first.version + 1);
  assert.equal(Buffer.from(second.files.result.data, 'base64').toString(), 'changed');
});

test('trusted full capture excludes nested Git metadata and rejects unsupported links', async t => {
  const { root, path, worker } = await fixture(t);
  await worker.initialize({ writable: true });
  await mkdir(join(path, 'nested/.git'), { recursive: true });
  await writeFile(join(path, 'nested/.git/config'), 'protected');
  await writeFile(join(path, 'nested/ordinary'), 'included');
  const before = await worker.snapshot({ requestId: 'whole', paths: ['.'] });
  assert.deepEqual(Object.keys(before.files), ['nested/ordinary']);
  assert.match(before.digest, /^complete:sha256:/);
  await assert.rejects(worker.snapshot({ requestId: 'git', paths: ['nested/.git/config'] }), { code: 'INVALID_CONTRACT' });
  await writeFile(join(root, 'outside'), 'unchanged');
  await symlink(join(root, 'outside'), join(path, 'symbolic'));
  await assert.rejects(worker.snapshot({ requestId: 'symlink', paths: ['.'] }), { code: 'INVALID_CONTRACT' });
  await rm(join(path, 'symbolic'));
  await link(join(root, 'outside'), join(path, 'hardlink'));
  await assert.rejects(worker.snapshot({ requestId: 'hardlink', paths: ['.'] }), { code: 'INVALID_CONTRACT' });
  assert.equal(await readFile(join(root, 'outside'), 'utf8'), 'unchanged');
});

test('live replacement verifies the preimage and retains the same receipt after subsequent writes', {
  skip: process.getuid() !== 0 && 'Trusted live replacement requires root Worker permissions',
}, async t => {
  const { path, worker } = await fixture(t, 1000);
  const original = { 'proof.lean': { encoding: 'utf8', data: 'original' }, 'obsolete': { encoding: 'utf8', data: 'remove' } };
  await worker.initialize({ files: original, writable: false });
  const before = await worker.snapshot({ requestId: 'before', paths: ['.'], maxBytes: 4096 });
  const inode = (await lstat(path)).ino;
  const files = { 'proof.lean': { encoding: 'utf8', data: 'integrated', mode: 0o755 }, 'binary': { encoding: 'base64', data: 'AP+A' } };
  const input = { requestId: 'replace', expectedDigest: before.digest, files, writable: true };
  await writeFile(join(path, 'proof.lean'), 'unsaved');
  await assert.rejects(worker.replace({ ...input, requestId: 'stale' }, []), { code: 'CONFLICT' });
  assert.equal(await readFile(join(path, 'proof.lean'), 'utf8'), 'unsaved');
  await writeFile(join(path, 'proof.lean'), 'original');
  const installed = await worker.replace(input, []);
  assert.equal(installed.status, 'completed'); assert.equal(installed.writable, true);
  assert.equal(worker.installPending, false);
  assert.equal((await lstat(path)).ino, inode);
  assert.equal(await readFile(join(path, 'proof.lean'), 'utf8'), 'integrated');
  assert.equal((await lstat(join(path, 'proof.lean'))).mode & 0o777, 0o755);
  assert.deepEqual(await readFile(join(path, 'binary')), Buffer.from([0, 255, 128]));
  await assert.rejects(readFile(join(path, 'obsolete')), { code: 'ENOENT' });
  await assert.rejects(worker.replace({ ...input, files: original }, []), { code: 'CONFLICT' });
  await writeFile(join(path, 'proof.lean'), 'continued');
  assert.deepEqual(await worker.replace(input, []), installed);
  assert.equal(await readFile(join(path, 'proof.lean'), 'utf8'), 'continued');
});
