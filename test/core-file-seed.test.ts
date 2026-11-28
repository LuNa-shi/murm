import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFileSeed } from '../src/core/files/core-file-seed.js';

test('FileSeed preserves native ordinary file bytes, modes, and a canonical digest', () => {
  const encoded = decodeFileSeed({
    'bin/bytes': { encoding: 'base64', data: 'AP+A', mode: 0o755 },
    'hello.txt': { encoding: 'utf8', data: '\u4f60\u597d\n' },
  });
  assert.deepEqual(encoded.entries, [
    { path: 'bin/bytes', bytes: Buffer.from([0, 255, 128]), mode: 0o755 },
    { path: 'hello.txt', bytes: Buffer.from('\u4f60\u597d\n'), mode: 0o644 },
  ]);
  assert.equal(decodeFileSeed({
    'hello.txt': { encoding: 'base64', data: Buffer.from('\u4f60\u597d\n').toString('base64'), mode: 0o644 },
    'bin/bytes': { encoding: 'base64', data: 'AP+A', mode: 0o755 },
  }).digest, encoded.digest);
  const file = { encoding: 'utf8', data: 'value' };
  const baseline = decodeFileSeed({ 'item.txt': file }).digest;
  for (const changed of [
    { 'other.txt': file },
    { 'item.txt': { ...file, data: 'Value' } },
    { 'item.txt': { ...file, mode: 0o755 } },
  ]) assert.notEqual(decodeFileSeed(changed).digest, baseline);
});

test('FileSeed rejects noncanonical names, structure collisions, and unsupported file entries', () => {
  const regular = { encoding: 'utf8', data: 'value' };
  for (const path of ['', '/absolute', '../escape', 'a/../escape', './dot', 'a//b', 'a/', 'a\\b', 'a\0b', 'C:/absolute', '\ud800']) {
    assert.throws(() => decodeFileSeed({ [path]: regular }), { code: 'INVALID_CONTRACT' });
  }
  assert.throws(() => decodeFileSeed({ a: regular, 'a/b': regular }), { code: 'INVALID_CONTRACT' });
  for (const entry of [
    { ...regular, mode: 0o600 },
    { ...regular, link: '/workspace/runtime' },
    { encoding: 'base64', data: 'QQ' },
    { encoding: 'base64', data: 'Q Q==' },
    { encoding: 'utf8', data: '\ud800' },
    { encoding: 'binary', data: 'aaa' },
  ]) assert.throws(() => decodeFileSeed({ file: entry }), { code: 'INVALID_CONTRACT' });
});

test('FileSeed enforces existing per-file and collective byte bounds without truncation', () => {
  const max = 2 * 1024 ** 2;
  const fullFile = { encoding: 'utf8', data: 'x'.repeat(max) };
  assert.equal(decodeFileSeed({ file: fullFile }).entries[0].bytes.length, max);
  assert.throws(() => decodeFileSeed({ file: { ...fullFile, data: fullFile.data + 'x' } }), { code: 'INVALID_CONTRACT' });
  const large = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [String(index), fullFile]));
  assert.throws(() => decodeFileSeed(large), { code: 'INVALID_CONTRACT' });
});
