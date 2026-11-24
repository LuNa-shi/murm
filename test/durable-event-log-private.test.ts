import assert from 'node:assert/strict';
import { link as createLink, lstat, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DurableEventLog } from '../src/observability/durable-event-log.js';

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
