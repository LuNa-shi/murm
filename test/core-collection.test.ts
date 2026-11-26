import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectCoreWorkDir } from '../scripts/core-collection.js';

const execute = promisify(execFile);
const spec = { paths: ['.'], includeGit: true, maxBytes: 1024 * 1024, required: true };

test('stopped Agent collection preserves empty directories, binary work and unpushed Git history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'core-collection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'empty'));
  await writeFile(join(root, 'committed'), 'committed\n');
  for (const args of [['init', '-q'], ['add', 'committed'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'fixed']]) {
    await execute('git', ['-C', root, ...args]);
  }
  await writeFile(join(root, 'uncommitted'), Buffer.from([0, 255, 42]));
  const result = await inventory(root, spec);
  assert.ok(result.directories.includes('empty'));
  assert.deepEqual(Buffer.from(result.files.find(file => file.path === 'uncommitted').data, 'base64'), Buffer.from([0, 255, 42]));
  const restored = await mkdtemp(join(tmpdir(), 'core-restored-'));
  t.after(() => rm(restored, { recursive: true, force: true }));
  for (const directory of result.directories) await mkdir(join(restored, directory), { recursive: true });
  for (const file of result.files) await writeFile(join(restored, file.path), Buffer.from(file.data, 'base64'), { mode: file.mode });
  assert.equal((await execute('git', ['-C', restored, 'show', 'HEAD:committed'])).stdout, 'committed\n');
  assert.deepEqual(await readFile(join(restored, 'uncommitted')), Buffer.from([0, 255, 42]));
  const plain = await inventory(root, { ...spec, includeGit: false });
  assert.ok(plain.files.every(file => !file.path.startsWith('.git/')));
});

async function inventory(root, policy) {
  const result = { files: [], directories: [] };
  let current;
  for await (const record of collectCoreWorkDir(root, policy)) {
    if (record.type === 'directory') result.directories.push(record.path);
    if (record.type === 'file') { current = { ...record, data: '' }; result.files.push(current); }
    if (record.type === 'chunk') current.data += record.data;
    if (record.type === 'fileEnd') current.sha256 = record.sha256;
    if (record.type === 'end') result.totalBytes = record.totalBytes;
  }
  return result;
}

test('collection explicitly rejects missing paths, byte overruns, escaping links and external Git objects', async t => {
  const { symlink, link } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'core-collection-reject-'));
  const outside = await mkdtemp(join(tmpdir(), 'core-collection-outside-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await writeFile(join(root, 'ordinary'), 'fixed bytes');
  await writeFile(join(outside, 'sentinel'), 'UNCHANGED');
  const plain = { ...spec, includeGit: false };
  await assert.rejects(inventory(root, { ...plain, paths: ['missing'] }), { code: 'INVALID_CONTRACT' });
  await assert.rejects(inventory(root, { ...plain, maxBytes: 1 }), /maxBytes/);
  await symlink(outside, join(root, 'escape'));
  await assert.rejects(inventory(root, { ...plain, paths: ['escape/sentinel'] }), /ancestors/);
  await assert.rejects(inventory(root, plain), /without links/);
  await rm(join(root, 'escape'));
  await link(join(root, 'ordinary'), join(root, 'hardlink'));
  await assert.rejects(inventory(root, plain), /without links/);
  await rm(join(root, 'hardlink'));
  await mkdir(join(root, '.git/objects/info'), { recursive: true });
  await writeFile(join(root, '.git/objects/info/http-alternates'), 'https://external.invalid/store\n');
  await assert.rejects(inventory(root, spec), /external Git/);
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'UNCHANGED');
});

test('collection streams bounded chunks and accepts a policy larger than 64 MiB without allocating it', async t => {
  const { createHash } = await import('node:crypto');
  const root = await mkdtemp(join(tmpdir(), 'core-collection-chunks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(200_000, 255);
  await writeFile(join(root, 'binary'), bytes);
  const chunks = [];
  let end;
  let hash;
  for await (const record of collectCoreWorkDir(root, { ...spec, includeGit: false, maxBytes: 4 * 1024 ** 3 })) {
    if (record.type === 'chunk') { const chunk = Buffer.from(record.data, 'base64'); assert.ok(chunk.length <= 65536); chunks.push(chunk); }
    if (record.type === 'fileEnd') hash = record.sha256;
    if (record.type === 'end') end = record;
  }
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.equal(hash, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(end, { type: 'end', totalBytes: 200_000, fileCount: 1, directoryCount: 0 });
  await assert.rejects(inventory(root, { ...spec, includeGit: false, paths: ['../outside'] }), /relative paths/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(async () => { for await (const record of collectCoreWorkDir(root, { ...spec, includeGit: false }, { signal: controller.signal })) void record; }, { name: 'AbortError' });
});

test('optional Git collection preserves private files before clone and Git history after clone', async t => {
  const root = await mkdtemp(join(tmpdir(), 'core-collection-checkout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'private-work'), 'draft');
  const policy = { ...spec, allowMissingGit: true };
  const before = await inventory(root, policy);
  assert.deepEqual(before.directories, []);
  assert.equal(before.files[0].path, 'private-work');
  await assert.rejects(inventory(root, spec), /missing path/);
  await execute('git', ['init', '-q', root]);
  const after = await inventory(root, policy);
  assert.ok(after.directories.includes('.git'));
  assert.ok(after.files.some(file => file.path === '.git/HEAD'));
});
