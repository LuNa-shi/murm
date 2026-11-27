import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkFileSpace, fileTreeFrames, receiveFileTree } from '../scripts/file-tree-stream.js';
import { DEFAULT_FILE_POLICY } from '../src/core/file-policy.js';

test('bounded tree transfers verify fragments and discard incomplete or invalid uploads', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'murm-file-tree-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const { initial: budget, workerSpoolBytes: maxSpoolBytes } = DEFAULT_FILE_POLICY;
  const controller = new AbortController();
  const options = { parent, budget, maxSpoolBytes, signal: controller.signal, label: 'Test staging' };
  const files = { 'dir/data': { encoding: 'utf8' as const, mode: 0o755 as const, data: 'x'.repeat(128 * 1024 + 45) } };
  const frames = await Array.fromAsync(fileTreeFrames(files, budget, { request: 'transfer' }, options.signal));
  assert.ok(frames.every(frame => frame.length < 128 * 1024));
  async function* split(rows: Buffer[]) {
    for (const frame of rows) {
      yield frame.subarray(0, 7);
      yield frame.subarray(7);
    }
  }
  const receipt = await receiveFileTree(split(frames), options);
  assert.deepEqual(receipt.meta, { request: 'transfer' });
  assert.equal(Buffer.from(receipt.files['dir/data'].data, 'base64').toString(), files['dir/data'].data);
  assert.equal(receipt.files['dir/data'].mode, 0o755);
  await receipt.dispose();
  await assert.rejects(receiveFileTree(split(frames.slice(0, -1)), options), { code: 'INVALID_CONTRACT' });
  const badDigest = Buffer.from(JSON.stringify({ type: 'fileEnd', sha256: '0'.repeat(64) }) + '\n');
  await assert.rejects(receiveFileTree(split([...frames.slice(0, -2), badDigest, frames.at(-1)!]), options), { code: 'INVALID_CONTRACT' });
  async function* cancel() {
    yield frames[0];
    yield frames[1];
    controller.abort();
    yield frames[2];
  }
  await assert.rejects(receiveFileTree(cancel(), options), { name: 'AbortError' });
  await assert.rejects(checkFileSpace(parent, Number.MAX_SAFE_INTEGER, 1, 'Controller staging'), { code: 'FILE_SPACE_INSUFFICIENT' });
  assert.deepEqual(await readdir(parent), []);
});
