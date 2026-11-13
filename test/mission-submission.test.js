import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MissionSubmissionStore } from '../src/runtime/mission-submission.js';

test('Mission submissions snapshot inputs, enforce one active freeze, and isolate late results', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swarmenv-submit-'));
  const store = new MissionSubmissionStore({ file: join(dir, 'submissions.json') });
  const pending = await store.submit({ missionId: 'm1', workspaceId: 'w1', mainRevision: '0.2', materialIds: ['mat-1'], checker: 'lean', environment: 'lean:1', actorRef: 'operator:test', requestId: 'sub-1' });
  assert.equal(pending.state, 'pending');
  await assert.rejects(() => store.submit({ missionId: 'm1', workspaceId: 'w1', mainRevision: '0.3', actorRef: 'operator:test', requestId: 'sub-2' }), { code: 'CONFLICT' });
  const failed = await store.finish({ missionId: 'm1', submissionId: 'sub-1', verdict: 'fail', result: { reason: 'checker' } });
  assert.equal(failed.state, 'failed');
  const next = await store.submit({ missionId: 'm1', workspaceId: 'w1', mainRevision: '0.3', actorRef: 'operator:test', requestId: 'sub-2' });
  assert.equal(next.main_revision, '0.3');
  assert.equal((await store.get({ missionId: 'm1', submissionId: 'sub-1' })).main_revision, '0.2');
});
