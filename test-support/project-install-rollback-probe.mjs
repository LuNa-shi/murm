// Local network-disabled probe; no model or provider requests.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, opendir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--inside')) {
  const mounts = ['sandbox-project.mjs', 'project-install.mjs', 'project-processes.mjs'].flatMap(file => ['--mount', `type=bind,source=${fileURLToPath(new URL('../scripts/' + file, import.meta.url))},target=/opt/swarmenv/${file},readonly`]);
  const { stdout } = await promisify(execFile)('docker', ['run', '--rm', '--network', 'none', '--cpus', '1', '--memory', '512m', '--pids-limit', '128', '--tmpfs', '/workspace:rw,nosuid,nodev,size=64m', ...mounts,
    '--mount', `type=bind,source=${fileURLToPath(import.meta.url)},target=/opt/swarmenv/install-probe.mjs,readonly`, '--entrypoint', 'node', 'swarmenv/agent:issue122', '/opt/swarmenv/install-probe.mjs', '--inside'], { timeout: 60_000, maxBuffer: 1024 * 1024 });
  process.stdout.write(stdout);
} else {
  const { SandboxProject, PROJECT_DIR } = await import('/opt/swarmenv/sandbox-project.mjs');
  const { canonical } = await import('/opt/swarmenv/project-install.mjs');
  const manifest = files => Object.fromEntries(Object.entries(files).map(([path, content]) => [path, { bytes: Buffer.byteLength(content), content_hash: createHash('sha256').update(content).digest('hex') }]));
  const treeState = async () => {
    const result = {};
    const visit = async path => {
      const absolute = join(PROJECT_DIR, path), info = await lstat(absolute);
      result[path] = { mode: info.mode & 0o7777, uid: info.uid, gid: info.gid, directory: info.isDirectory(), ...(info.isFile() ? { bytes: (await readFile(absolute)).toString('base64') } : {}) };
      if (info.isDirectory()) for await (const entry of await opendir(absolute)) await visit(path ? `${path}/${entry.name}` : entry.name);
    };
    await visit(''); return result;
  };
  for (const direction of ['directory-to-file', 'file-to-directory']) for (const faultPoint of ['after_file_write', 'after_write']) {
    await rm(PROJECT_DIR, { recursive: true, force: true });
    await rm('/workspace/runtime', { recursive: true, force: true });
    await rm('/workspace/.swarm-project-control', { recursive: true, force: true });
    const project = new SandboxProject();
    await project.initialize();
    const original = { ...(direction === 'directory-to-file' ? { 'changed/item': 'old bytes' } : { changed: 'old bytes' }), ['__proto__']: 'original prototype file' };
    for (const [path, bytes] of Object.entries(original)) { await mkdir(dirname(join(PROJECT_DIR, path)), { recursive: true }); await writeFile(join(PROJECT_DIR, path), bytes); }
    if (direction === 'directory-to-file') await mkdir(join(PROJECT_DIR, 'changed/empty/deep'), { recursive: true });
    await mkdir(join(PROJECT_DIR, 'retained/empty'), { recursive: true });
    await project.prepare({ execution_id: 'test', binding_version: 1, manifest: manifest(original) });
    await project.grant({ execution_id: 'test', binding_version: 1 });
    await chmod(join(PROJECT_DIR, 'retained'), 0o751);
    await chmod(join(PROJECT_DIR, 'retained/empty'), 0o705);
    if (direction === 'directory-to-file') await chmod(join(PROJECT_DIR, 'changed/empty/deep'), 0o710);
    await chmod(join(PROJECT_DIR, Object.keys(original)[0]), 0o640);
    await chmod(join(PROJECT_DIR, '__proto__'), 0o751);
    const before = await treeState(), rootInode = (await lstat(PROJECT_DIR)).ino;
    const snapshot = await project.snapshot({ execution_id: 'test', binding_version: 1 });
    const target = { ...(direction === 'directory-to-file' ? { changed: 'new bytes' } : { 'changed/new': 'new bytes' }), ['__proto__']: 'changed prototype file', constructor: 'new constructor file' };
    let injected = false;
    project.installer.fault = point => { if (!injected && point === faultPoint) { injected = true; throw new Error('controlled partial install failure'); } };
    const result = await project.install({ execution_id: 'test', binding_version: 1, request_id: direction + faultPoint,
      expected_content_hash: snapshot.content_hash, content_hash: createHash('sha256').update(canonical(manifest(target))).digest('hex'),
      files: Object.fromEntries(Object.entries(target).map(([path, content]) => [path, Buffer.from(content).toString('base64')])) }, []);
    assert.equal(injected, true);
    assert.equal(result.phase, 'failed');
    assert.deepEqual(await treeState(), before);
    assert.equal((await lstat(PROJECT_DIR)).ino, rootInode);
    assert.equal(project.installPending, false);
  }
  for (const variant of ['large-path-set', 'maximum-bytes']) {
    await rm(PROJECT_DIR, { recursive: true, force: true });
    await rm('/workspace/runtime', { recursive: true, force: true });
    await rm('/workspace/.swarm-project-control', { recursive: true, force: true });
    const project = new SandboxProject();
    await project.initialize();
    const original = variant === 'maximum-bytes'
      ? Object.fromEntries(Array.from({ length: 8 }, (_, i) => [String(i), Buffer.alloc(2 * 1024 * 1024, 65)]))
      : Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`${String(i).padStart(4, '0')}-${'p'.repeat(150)}`, 'old']));
    for (const [path, bytes] of Object.entries(original)) await writeFile(join(PROJECT_DIR, path), bytes);
    await project.prepare({ execution_id: 'limits', binding_version: 1, manifest: manifest(original) });
    await project.grant({ execution_id: 'limits', binding_version: 1 });
    const firstPath = Object.keys(original)[0];
    await chmod(join(PROJECT_DIR, firstPath), 0o751);
    const snapshot = await project.snapshot({ execution_id: 'limits', binding_version: 1 });
    const target = Object.fromEntries(Object.keys(original).map(path => [path, variant === 'maximum-bytes' ? Buffer.alloc(2 * 1024 * 1024, 66) : 'new']));
    const result = await project.install({ execution_id: 'limits', binding_version: 1, request_id: variant,
      expected_content_hash: snapshot.content_hash, content_hash: createHash('sha256').update(canonical(manifest(target))).digest('hex'),
      files: Object.fromEntries(Object.entries(target).map(([path, content]) => [path, Buffer.from(content).toString('base64')])) }, []);
    assert.equal(result.phase, 'installed');
    assert.equal((await lstat(join(PROJECT_DIR, firstPath))).mode & 0o7777, 0o751);
    const confirmation = { execution_id: 'limits', binding_version: 1, request_id: variant, content_hash: result.content_hash };
    project.installer.fault = point => { if (point === 'after_receipt_rename') throw new Error('controlled confirmation directory fsync failure'); };
    await assert.rejects(project.confirmInstall(confirmation), /controlled confirmation/);
    assert.equal(project.installPending, true);
    assert.equal((await project.queryInstall(confirmation)).phase, 'installed');
    assert.equal((await project.installReceipts()).find(receipt => receipt.request_id === variant).phase, 'installed');
    project.installer.fault = null;
    assert.equal((await project.confirmInstall(confirmation)).phase, 'committed');
    assert.equal(project.installPending, false);
    assert.equal((await project.snapshot({ execution_id: 'limits', binding_version: 1 })).content_hash, result.content_hash);
  }
  console.log('PASS: partial/full install failure restores files, empty directory topology, modes and ownership in both file/directory directions without replacing the project root; large path sets and two 16 MiB trees install within a 64 MiB filesystem while retaining existing modes');
}
