import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { transport } from './fixtures/core-agent-service-backend.js';
import { createPeerMeshEventSubscription } from '../src/harnesses/peermesh/event-source.js';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return { url: new URL('./fixtures/peermesh-team-backend.js', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
const { createPeerMeshTeam } = await import('../src/harnesses/peermesh/team.js'); hooks.deregister();

async function setup(t, extra = {}) {
  transport.reset(); transport.collectable = true;
  const outputDir = await mkdtemp(join(tmpdir(), 'agensh-team-')); let harness;
  t.after(async () => { await harness?.close({ timeoutMs: 1000 }); await rm(outputDir, { recursive: true, force: true }); });
  const peers = (extra.peerKeys ?? ['a', 'b']).map(key => ({ key, branch: `branch-${key}`, gitea: { username: key, binding: `git-${key}`, accountId: key, token: `git-private-${key}` },
    message: { binding: `mm-${key}`, accountId: key, token: `mm-private-${key}` }, board: { binding: `board-${key}`, workerId: `worker-${key}` } }));
  let facilityClosed = false; const ready = [];
  harness = await createPeerMeshTeam({ runId: 'team', image: 'fixture', outputDir, backend: {},
    prepare: async ({ resources }) => { resources.own({ kind: 'facility', id: 'shared', close() { facilityClosed = true; } }); return { runId: 'team', repository: { owner: 'owner', name: 'repo' }, repositoryUrl: 'http://172.17.0.1:3000/owner/repo.git', channelId: 'channel', boardId: 'board', issueNumber: 1,
      endpoints: { gitea: 'http://172.17.0.1:3000', message: 'http://127.0.0.1:3001', board: 'http://127.0.0.1:3002' }, peers }; },
    router: { workTimeoutMs: 3000, turnTimeoutMs: 1000, readContext: async () => 'shared board', subscribe: async ({ mapping }) => { ready.push(mapping); return { ready: true, stop: async () => {} }; } }, ...extra });
  return { harness, ready, facilityClosed: () => facilityClosed };
}

function settle(inputId, output) {
  const submission = transport.submissions.get(inputId);
  transport.spawns.get(submission.agentId).onEvent({ type: 'settled', outcome: 'completed', output });
}

test('two Agent identities share one Core and retain their original router through event follow-up', async t => {
  const f = await setup(t); assert.equal(f.ready.length, 2); assert.equal(transport.spawns.size, 2);
  const snapshot = f.harness.snapshot(); assert.equal(snapshot.peers.length, 2);
  const starts = [...transport.spawns.values()]; assert.equal(new Set(starts.map(row => row.profile.env.WORK_BRANCH)).size, 2);
  assert.notEqual(starts[0].options.secretEnv.GITEA_TOKEN, starts[1].options.secretEnv.GITEA_TOKEN);
  assert.equal(new Set(starts.map(row => row.runtimeId)).size, 1);
  transport.next = id => settle(id, 'first');
  const first = f.harness.kickoff('a', 'initial a'); assert.equal((await f.harness.wait('a', first.batchId)).state, 'completed');
  transport.next = id => settle(id, 'second');
  const second = f.harness.kickoff('b', 'initial b'); assert.equal((await f.harness.wait('b', second.batchId)).state, 'completed');
  transport.next = id => settle(id, 'adopted');
  const event = { source: 'mattermost', kind: 'mention', eventId: 'actual-message', targetWorker: 'worker-a', text: '@a inspect b result' };
  const followup = f.harness.ingest('a', event); assert.equal((await f.harness.wait('a', followup.batchId)).settled.output, 'adopted');
  assert.equal(f.harness.ingest('a', event).batchId, followup.batchId); assert.equal(transport.submissions.size, 3);
  assert.equal(f.harness.snapshot().peers[1].router.batches.length, 1);
  assert.equal((await f.harness.close()).cleanup, 'complete'); assert.equal(f.facilityClosed(), true);
  assert.ok([...transport.submissions.values()].every(row => row.mode === 'followUp'));
  assert.equal(f.harness.runInput, undefined);
});

test('a peer unknown admission fences the entire team without releasing its shared dependencies on unknown execution', async t => {
  const f = await setup(t);
  transport.next = id => { transport.submissions.get(id).receipt = { status: 'unknown' }; };
  const first = f.harness.kickoff('a', 'unknown');
  assert.equal((await f.harness.wait('a', first.batchId)).state, 'uncertain');
  assert.throws(() => f.harness.kickoff('b', 'later'), { code: 'UNKNOWN_RECIPIENT' });
  assert.equal(transport.submissions.size, 1);
  transport.onStop = () => { throw Object.assign(new Error('fixed unknown'), { code: 'STOP_UNKNOWN' }); };
  assert.equal((await f.harness.close({ timeoutMs: 100 })).cleanup, 'pending'); assert.equal(f.facilityClosed(), false);
  transport.onStop = undefined; assert.equal((await f.harness.close()).cleanup, 'complete');
});

test('eight mapped peers are ready before kickoff and real HTTP events reach only the last peer once', async t => {
  const peerKeys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const requests = [], ready = [];
  let comments = [{ id: 1, user: { id: 99 }, body: '@h old baseline comment' }], posts = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    requests.push({ path, authorization: request.headers.authorization });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(path.endsWith('/issues/comments') ? comments :
      { order: posts.map(row => row.id), posts: Object.fromEntries(posts.map(row => [row.id, row])) }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const f = await setup(t, { peerKeys, router: {
    workTimeoutMs: 5000, turnTimeoutMs: 1000, maxBatches: 4, maxNudges: 0, readContext: async () => 'controlled shared board',
    async subscribe(options) {
      assert.equal(transport.spawns.size, 8);
      assert.equal(transport.submissions.size, 0);
      const source = await createPeerMeshEventSubscription({ ...options, pollIntervalMs: 60_000, maxPolls: 3,
        facilities: { ...options.facilities, endpoints: { ...options.facilities.endpoints, gitea: origin, message: origin } } });
      ready.push(options.mapping);
      return source;
    },
  } });
  const initial = f.harness.snapshot(), starts = [...transport.spawns.values()];
  assert.equal(ready.length, 8); assert.equal(transport.submissions.size, 0);
  assert.equal(new Set(starts.map(row => row.runtimeId)).size, 1);
  assert.equal(new Set(starts.map(row => row.profile.env.WORK_BRANCH)).size, 8);
  assert.equal(new Set(starts.map(row => row.options.secretEnv.GITEA_TOKEN)).size, 8);
  assert.deepEqual(initial.peers.map(peer => peer.key), peerKeys);
  for (const [index, peer] of initial.peers.entries()) {
    assert.equal(peer.router.ready, true); assert.equal(peer.subscription.ready, true);
    assert.deepEqual(ready[index], { agentId: peer.agentId, workerId: `worker-${peer.key}` });
    const identity = initial.identities[index];
    assert.equal(identity.agentId, peer.agentId);
    assert.equal(identity.gitea.binding, `git-${peer.key}`);
    assert.equal(identity.gitea.accountId, peer.key);
    assert.equal(identity.message.binding, `mm-${peer.key}`);
    assert.equal(identity.message.accountId, peer.key);
    assert.equal(identity.board.binding, `board-${peer.key}`);
    assert.equal(identity.board.workerId, `worker-${peer.key}`);
    assert.deepEqual(starts[index].options.bindings, { gitea: `git-${peer.key}`, message: `mm-${peer.key}`, 'peermesh-context': `board-${peer.key}` });
    transport.next = id => settle(id, 'kickoff complete');
    const kickoff = f.harness.kickoff(peer.key, `Initial work for ${peer.key}`);
    assert.equal((await f.harness.wait(peer.key, kickoff.batchId)).state, 'completed');
  }

  comments.push({ id: 8, user: { id: 99 }, body: '@h inspect this repository comment' });
  posts.push({ id: 'late-peer', user_id: 'external', channel_id: 'channel', create_at: 2, message: '@h inspect this peer message' });
  const complete = id => { settle(id, 'targeted follow-up complete'); transport.next = complete; };
  transport.next = complete;
  await f.harness.poll();
  const routed = f.harness.snapshot().peers.at(-1).subscription.records;
  assert.deepEqual(routed.map(row => [row.source, row.eventId, row.targetWorker]), [
    ['gitea', 'comment:8', 'worker-h'], ['mattermost', 'post:late-peer', 'worker-h'],
  ]);
  for (const row of routed) assert.equal((await f.harness.wait('h', row.batchId)).state, 'completed');
  await f.harness.poll(); transport.next = undefined;
  const after = f.harness.snapshot();
  assert.equal(transport.submissions.size, 10);
  const submissions = [...transport.submissions.values()];
  assert.ok(submissions.every(row => row.mode === 'followUp'));
  assert.deepEqual(after.peers.map(peer => submissions.filter(row => row.agentId === peer.agentId).length), [1, 1, 1, 1, 1, 1, 1, 3]);
  assert.deepEqual(after.peers.map(peer => peer.router.batches.length), [1, 1, 1, 1, 1, 1, 1, 3]);
  assert.deepEqual(after.peers.map(peer => peer.subscription.records.length), [0, 0, 0, 0, 0, 0, 0, 2]);
  assert.ok(after.peers.every(peer => peer.subscription.polls === 2 && peer.subscription.maxPolls === 3 &&
    peer.subscription.pollIntervalMs === 60_000 && !peer.subscription.exhausted));
  for (const key of peerKeys) {
    assert.equal(requests.filter(row => row.authorization === `token git-private-${key}`).length, 3);
    assert.equal(requests.filter(row => row.authorization === `Bearer mm-private-${key}`).length, 3);
  }
  const bridgeUrl = transport.url;
  const closed = await f.harness.close();
  assert.equal(closed.cleanup, 'complete'); assert.equal(closed.agents.length, 8);
  assert.ok(closed.agents.every(agent => agent.execution === 'stopped' && agent.cleanup === 'complete'));
  assert.equal(f.facilityClosed(), true);
  assert.ok(f.harness.snapshot().peers.every(peer => peer.subscription.closed));
  await assert.rejects(f.harness.poll(), { code: 'ROUTER_SOURCE_STOPPED' });
  await assert.rejects(fetch(`${bridgeUrl}/health`, { signal: AbortSignal.timeout(500) }));
});

test('project close bounds a held steer and keeps facilities for a later close retry', async t => {
  const head = 'b'.repeat(40);
  const server = createServer((request, response) => {
    if (request.url.endsWith('/branches/main')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ name: 'main', commit: { id: head } }));
    } else {
      assert.ok(request.url.endsWith(`/archive/${head}.tar.gz`));
      response.end('project archive');
    }
  });
  const address = Object.values(networkInterfaces()).flat().find(item => item?.family === 'IPv4' && !item.internal)?.address;
  assert.ok(address, 'project network requires one non-loopback IPv4 interface');
  server.listen(0, address); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://${address}:${server.address().port}`;
  let facilityClosed = false;
  const held = Promise.withResolvers();
  t.after(() => held.resolve());
  const f = await setup(t, {
    project: { title: 'project', body: 'run the project', durationMs: 10_000 },
    gitea: { adminToken: 'git-host' },
    router: { turnTimeoutMs: 5000, readContext: async () => 'board', subscribe: async () => ({ ready: true, stop: async () => {} }) },
    prepare: async ({ resources }) => {
      resources.own({ kind: 'facility', id: 'project', close() { facilityClosed = true; } });
      const peers = ['a', 'b'].map(key => ({ key, gitea: { username: key, binding: `git-${key}`, accountId: key, token: `git-token-${key}` },
        message: { binding: `mm-${key}`, accountId: key, token: `mm-token-${key}` }, board: { binding: `board-${key}`, workerId: `worker-${key}` } }));
      return { project: true, runId: 'team', repository: { owner: 'owner', name: 'repo' }, repositoryUrl: origin + '/owner/repo.git',
        channelId: 'channel', boardId: 'board', issueNumber: 1, endpoints: { gitea: origin, message: origin, board: origin }, peers };
    },
  });
  for (let step = 0; step < 100 && transport.submissions.size < 2; step++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(transport.submissions.size, 2);
  for (const { input } of transport.submissions.values()) {
    assert.equal(JSON.parse(input.slice(input.indexOf('\n') + 1)).text, 'run the project');
  }
  await new Promise(resolve => setImmediate(resolve));
  const sending = Promise.withResolvers();
  transport.next = () => { sending.resolve(); return held.promise; };
  const dm = f.harness.ingest('a', { source: 'mattermost', kind: 'dm', eventId: 'dm', targetWorker: 'worker-a', text: 'held notice' });
  await sending.promise;
  const pending = await f.harness.close({ timeoutMs: 300 });
  assert.equal(pending.cleanup, 'pending');
  assert.equal(pending.routerCleanup, 'pending');
  assert.equal(facilityClosed, false);
  assert.equal(f.harness.snapshot().peers[0].router.batches.find(row => row.batchId === dm.batchId).state, 'steering');
  held.resolve();
  assert.equal((await f.harness.close({ timeoutMs: 2000 })).cleanup, 'complete');
  assert.equal(facilityClosed, true);
});
