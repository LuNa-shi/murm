import assert from 'node:assert/strict';
import { link as createLink, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DurableEventLog } from '../src/observability/durable-event-log.js';
import { beginPrivateAudit, PRIVATE_AUDIT_RETENTION_MS, prunePrivateAudit } from '../src/observability/private-audit-retention.js';

test('private audit prunes only expired closed or dead-owner managed runs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarm-private-audit-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const activePath = join(root, 'nested', 'active');
  const closedPath = join(root, 'closed');
  const deadPath = join(root, 'dead');
  const legacy = join(root, 'legacy');
  await mkdir(legacy);
  await symlink(legacy, join(root, 'link'));
  await beginPrivateAudit({ root, directory: activePath });
  const closed = await beginPrivateAudit({ root, directory: closedPath });
  await beginPrivateAudit({ root, directory: deadPath });
  const markerPath = join(deadPath, '.swarmenv-private-audit-v1.json');
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  marker.owner.start = '0';
  await writeFile(markerPath, JSON.stringify(marker));
  await assert.rejects(beginPrivateAudit({ root, directory: activePath }), { code: 'EEXIST' });
  for (const path of ['.hidden', '.hidden/run', 'nested/.hidden']) {
    await assert.rejects(beginPrivateAudit({ root, directory: join(root, path) }), /visible to the retention sweep/);
  }
  await assert.rejects(beginPrivateAudit({ root, directory: join(root, 'link', 'new') }), /Unsafe private audit/);
  assert.equal((await lstat(activePath)).mode & 0o777, 0o700);
  await closed.close();
  await closed.close();
  assert.deepEqual(await prunePrivateAudit({ root }), { removed: 0 });
  assert.deepEqual(await prunePrivateAudit({ root, now: Date.now() + PRIVATE_AUDIT_RETENTION_MS + 1_000 }), { removed: 2 });
  for (const path of [closedPath, deadPath]) await assert.rejects(lstat(path), { code: 'ENOENT' });
  for (const path of [activePath, legacy, join(root, 'link')]) await lstat(path);
});

test('raw audit writes mode 0600 and rejects symbolic or hard-linked targets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarm-audit-file-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const target = join(root, 'audit');
  const link = join(root, 'link');
  new DurableEventLog(target, { raw: true }).append({ content: 'private content' });
  assert.equal((await lstat(target)).mode & 0o777, 0o600);
  await symlink(target, link);
  assert.throws(() => new DurableEventLog(link, { raw: true }).append({ content: 'override' }), { code: 'ELOOP' });
  const hardLink = join(root, 'hardlink');
  await createLink(target, hardLink);
  assert.throws(() => new DurableEventLog(hardLink, { raw: true }).append({ content: 'override' }), /Unsafe private audit log/);
  assert.equal(JSON.parse(await readFile(target, 'utf8')).content, 'private content');
});
