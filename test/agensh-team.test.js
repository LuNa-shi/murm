import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { transport } from './fixtures/core-bot-service-backend.js';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return { url: new URL('./fixtures/agensh-team-backend.js', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
const { createAgenshTeam } = await import('../src/environments/agensh/team.js'); hooks.deregister();

async function setup(t, extra = {}) {
  transport.reset(); transport.collectable = true;
  const outputDir = await mkdtemp(join(tmpdir(), 'agensh-team-')); let environment;
  t.after(async () => { await environment?.close({ timeoutMs: 1000 }); await rm(outputDir, { recursive: true, force: true }); });
  const peers = ['a', 'b'].map(key => ({ key, branch: `branch-${key}`, gitea: { username: key, binding: `git-${key}`, accountId: key, token: `git-private-${key}` },
    message: { binding: `mm-${key}`, accountId: key, token: `mm-private-${key}` }, board: { binding: `board-${key}`, workerId: `worker-${key}` } }));
  let facilityClosed = false; const ready = [];
  environment = await createAgenshTeam({ runId: 'team', image: 'fixture', outputDir, backend: {},
    prepare: async ({ resources }) => { resources.own({ kind: 'facility', id: 'shared', close() { facilityClosed = true; } }); return { runId: 'team', repository: { owner: 'owner', name: 'repo' }, repositoryUrl: 'http://172.17.0.1:3000/owner/repo.git', channelId: 'channel', boardId: 'board', issueNumber: 1,
      endpoints: { gitea: 'http://172.17.0.1:3000', message: 'http://127.0.0.1:3001', board: 'http://127.0.0.1:3002' }, peers }; },
    router: { workTimeoutMs: 3000, turnTimeoutMs: 1000, readContext: async () => 'shared board', subscribe: async ({ mapping }) => { ready.push(mapping); return { ready: true, stop: async () => {} }; } }, ...extra });
  return { environment, ready, facilityClosed: () => facilityClosed };
}

function settle(inputId, output) {
  const submission = transport.submissions.get(inputId);
  transport.spawns.get(submission.botId).onEvent({ type: 'settled', outcome: 'completed', output });
}

test('two Bot identities share one Core and retain their original router through event follow-up', async t => {
  const f = await setup(t); assert.equal(f.ready.length, 2); assert.equal(transport.spawns.size, 2);
  const snapshot = f.environment.snapshot(); assert.equal(snapshot.peers.length, 2);
  const starts = [...transport.spawns.values()]; assert.equal(new Set(starts.map(row => row.profile.env.WORK_BRANCH)).size, 2);
  assert.notEqual(starts[0].options.secretEnv.GITEA_TOKEN, starts[1].options.secretEnv.GITEA_TOKEN);
  assert.equal(new Set(starts.map(row => row.runtimeId)).size, 1);
  transport.next = id => settle(id, 'first');
  const first = f.environment.kickoff('a', 'initial a'); assert.equal((await f.environment.wait('a', first.batchId)).state, 'completed');
  transport.next = id => settle(id, 'second');
  const second = f.environment.kickoff('b', 'initial b'); assert.equal((await f.environment.wait('b', second.batchId)).state, 'completed');
  transport.next = id => settle(id, 'adopted');
  const event = { source: 'mattermost', kind: 'mention', eventId: 'actual-message', targetWorker: 'worker-a', text: '@a inspect b result' };
  const followup = f.environment.ingest('a', event); assert.equal((await f.environment.wait('a', followup.batchId)).settled.output, 'adopted');
  assert.equal(f.environment.ingest('a', event).batchId, followup.batchId); assert.equal(transport.submissions.size, 3);
  assert.equal(f.environment.snapshot().peers[1].router.batches.length, 1);
  assert.equal((await f.environment.close()).cleanup, 'complete'); assert.equal(f.facilityClosed(), true);
  assert.ok([...transport.submissions.values()].every(row => row.mode === 'followUp'));
  assert.equal(f.environment.runInput, undefined);
});

test('a peer unknown admission fences the entire team without releasing its shared dependencies on unknown execution', async t => {
  const f = await setup(t);
  transport.next = id => { transport.submissions.get(id).receipt = { status: 'unknown' }; };
  const first = f.environment.kickoff('a', 'unknown');
  assert.equal((await f.environment.wait('a', first.batchId)).state, 'uncertain');
  assert.throws(() => f.environment.kickoff('b', 'later'), { code: 'UNKNOWN_RECIPIENT' });
  assert.equal(transport.submissions.size, 1);
  transport.onStop = () => { throw Object.assign(new Error('fixed unknown'), { code: 'STOP_UNKNOWN' }); };
  assert.equal((await f.environment.close({ timeoutMs: 100 })).cleanup, 'pending'); assert.equal(f.facilityClosed(), false);
  transport.onStop = undefined; assert.equal((await f.environment.close()).cleanup, 'complete');
});
