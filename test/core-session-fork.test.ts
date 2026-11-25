import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapshotSessionFork, sessionForkText } from '../scripts/core-session-fork.js';

const user = { type: 'message', id: 'user', parentId: null, message: { role: 'user', content: 'Keep the work. token-private' } };
const call = { type: 'message', id: 'call', parentId: 'user', message: { role: 'assistant', content: [
  { type: 'toolCall', id: 'tool-one', name: 'bash', arguments: { command: 'echo token-private' } },
  { type: 'toolCall', id: 'tool-two', name: 'read', arguments: { path: 'file' } },
] } };
const result = (id, parentId, toolCallId) => ({ type: 'message', id, parentId, message: { role: 'toolResult', toolCallId, content: [{ type: 'text', text: 'token-private' }] } });

test('Context Fork captures the last paired tool boundary and redacts parent credentials', () => {
  const first = result('first', 'call', 'tool-one');
  const second = result('second', 'first', 'tool-two');
  const partial = snapshotSessionFork({ entries: [user, call, first], leafId: 'first' }, ['token-private']);
  assert.deepEqual(partial.entries, [{ ...user, message: { ...user.message, content: 'Keep the work. [REDACTED]' } }]);
  const complete = snapshotSessionFork({ entries: [user, call, first, second], leafId: 'second' }, ['token-private']);
  assert.equal(complete.entries.length, 4);
  assert.equal(JSON.stringify(complete).includes('token-private'), false);
  assert.equal(complete.entries[1].message.content[0].type, 'toolCall');
  assert.equal(complete.entries[3].message.toolCallId, 'tool-two');
  const lines = sessionForkText(complete, '/workspace/project').trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].type, 'session');
  assert.equal(lines[0].version, 3);
  assert.equal(lines[0].cwd, '/workspace/project');
  assert.deepEqual(lines.slice(1), complete.entries);
  assert.notEqual(JSON.parse(sessionForkText(complete, '/workspace/project').split('\n')[0]).id, lines[0].id);
});

test('Context Fork rejects corrupt ancestry and unmatched tool results', () => {
  assert.throws(() => snapshotSessionFork({ entries: [user], leafId: 'missing' }), { code: 'INVALID_CONTRACT' });
  assert.throws(() => snapshotSessionFork({ entries: [user, result('orphan', 'user', 'unknown')], leafId: 'orphan' }), { code: 'INVALID_CONTRACT' });
  assert.throws(() => snapshotSessionFork({ entries: [{ ...user, parentId: 'user' }], leafId: 'user' }), { code: 'INVALID_CONTRACT' });
});

test('Context Fork fails closed when a credential occupies structural metadata', () => {
  assert.throws(() => snapshotSessionFork({ entries: [user], leafId: 'user' }, ['user']), { code: 'NOT_ALLOWED' });
});
