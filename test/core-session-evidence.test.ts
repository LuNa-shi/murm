import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionEvidence } from './fixtures/core-session-evidence.js';

const filename = '2026-11-23T10-20-30-001Z_12345678-1234-1234-1234-123456789abc.jsonl';
test('native Session evidence observes only a persisted filename and preserves stable identity', async () => {
  const execute = async (command, args, options) => {
    assert.equal(command, 'docker');
    assert.deepEqual(args, ['exec', 'physical-container', 'find', '/workspace/runtime/pi-session',
      '-type', 'f', '-name', '*.jsonl', '-printf', '%f\n']);
    assert.equal(options.timeout, 5000);
    return { stdout: filename + '\n' };
  };
  const expected = { sessionId: '12345678-1234-1234-1234-123456789abc', sessionFile: filename };
  assert.deepEqual(await sessionEvidence('physical-container', execute), expected);
  assert.deepEqual(await sessionEvidence('physical-container', execute), expected);
});

test('missing, ambiguous or malformed Session filename evidence cannot pass', async () => {
  for (const stdout of ['', `${filename}\n${filename}\n`, 'unexpected.jsonl\n']) {
    await assert.rejects(sessionEvidence('physical-container', async () => ({ stdout })));
  }
});

test('Codex native Session evidence identifies the persisted rollout without reading its contents', async () => {
  const valid = 'rollout-2026-11-25T20-01-02-019abcde-1234-5678-9abc-123456789abc.jsonl';
  const observed = await sessionEvidence('codex-container', async (_command, args) => {
    assert.equal(args[3], '/workspace/runtime/codex-home/sessions');
    return { stdout: valid + '\n' };
  }, 'codex');
  assert.deepEqual(observed, { sessionId: '019abcde-1234-5678-9abc-123456789abc', sessionFile: valid });
  await assert.rejects(sessionEvidence('codex-container', async () => ({ stdout: valid + '\n' + valid }), 'codex'));
});
