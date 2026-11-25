import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPeerMeshEventSubscription } from '../src/harnesses/peermesh/event-source.js';

test('real HTTP subscription baselines before readiness and routes stable external, mention and direct message identities without self echoes', async t => {
  let comments = [], posts = [], dms = []; const deliveries = [];
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path.endsWith('/issues/comments')) response.end(JSON.stringify(comments));
    else if (path.endsWith('/posts')) { const rows = path.includes('/dm/') ? dms : posts; response.end(JSON.stringify({ order: rows.map(row => row.id).reverse(), posts: Object.fromEntries(rows.map(row => [row.id, row])) })); }
    else response.end(JSON.stringify({ id: 'dm', type: 'D', name: 'sender__mm-peer' }));
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  posts.push({ id: 'old', message: 'old', user_id: 'other', channel_id: 'channel', create_at: 1 });
  const source = await createPeerMeshEventSubscription({ facilities: {
    endpoints: { gitea: origin, message: origin }, repository: { owner: 'owner', name: 'repo' }, channelId: 'channel',
    peer: { gitea: { username: 'peer-fixed', accountId: '101', token: 'git-secret' }, message: { accountId: 'mm-peer', token: 'mm-secret' } },
  }, mapping: { workerId: 'worker-fixed', botId: 'bot-fixed' }, ingest: row => { deliveries.push(row); return { batchId: row.eventId }; }, pollIntervalMs: 60_000, maxPolls: 4, dmChannelIds: ['dm'] });
  t.after(() => source.stop()); assert.equal(source.ready, true); assert.equal(deliveries.length, 0);
  comments.push({ id: 7, body: 'actual PR comment', user: { id: 102 }, created_at: '2026-01-01' });
  posts.push({ id: 'mention', message: '@peer-fixed follow up', user_id: 'other', channel_id: 'channel', create_at: 2 });
  posts.push({ id: 'wrong', message: '@someone-else work', user_id: 'other', channel_id: 'channel', create_at: 3 });
  posts.push({ id: 'multiple', message: '@someone-else @peer-fixed both', user_id: 'other', channel_id: 'channel', create_at: 4 });
  posts.push({ id: 'self', message: 'peer own result', user_id: 'mm-peer', channel_id: 'channel', create_at: 4 });
  dms.push({ id: 'direct', message: 'targeted DM', user_id: 'other', channel_id: 'dm', create_at: 5 });
  await source.poll(); await source.poll();
  assert.deepEqual(deliveries.map(row => [row.source, row.eventId, row.kind, row.targetWorker]), [
    ['gitea', 'comment:7', 'external', 'worker-fixed'], ['mattermost', 'post:mention', 'mention', 'worker-fixed'],
    ['mattermost', 'post:wrong', 'mention', 'unmapped:someone-else'], ['mattermost', 'post:multiple', 'mention', 'worker-fixed'], ['mattermost', 'post:direct', 'dm', 'worker-fixed'],
  ]);
  assert.equal(JSON.stringify(source.snapshot()).includes('secret'), false);
  await source.stop(); await assert.rejects(source.poll(), { code: 'ROUTER_SOURCE_STOPPED' });
});

test('two trusted subscriptions route a directed repository comment once to its named peer', async t => {
  let comments = []; const delivered = [[], []];
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url.includes('/issues/comments') ? comments : { order: [], posts: {} }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const peers = ['one', 'two'].map(name => ({ gitea: { username: name, accountId: name, token: name }, message: { accountId: name, token: name }, board: { workerId: `worker-${name}` } }));
  const sources = [];
  for (let index = 0; index < 2; index++) {
    sources.push(await createPeerMeshEventSubscription({ facilities: { endpoints: { gitea: origin, message: origin }, repository: { owner: 'owner', name: 'repo' }, channelId: 'channel', peer: peers[index], peers },
      mapping: { workerId: peers[index].board.workerId, botId: `bot-${index}` }, ingest: row => { delivered[index].push(row); return { batchId: row.eventId }; }, pollIntervalMs: 60_000, maxPolls: 3 }));
  }
  t.after(() => Promise.all(sources.map(source => source.stop())));
  comments = [{ id: 1, user: { id: 5 }, body: '@one inspect this PR' }];
  for (const source of sources) { await source.poll(); await source.poll(); }
  assert.equal(delivered[0].length, 1);
  assert.equal(delivered[1].length, 0);
  assert.equal(delivered[0][0].targetWorker, 'worker-one');
});

test('cancelling a subscription during ingestion prevents dispatch of remaining rows in that poll', async t => {
  let comments = [];
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url.includes('/issues/comments') ? comments : { order: [], posts: {} }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cancel = new AbortController();
  const delivered = [];
  const failures = [];
  const source = await createPeerMeshEventSubscription({
    facilities: {
      endpoints: { gitea: origin, message: origin }, repository: { owner: 'owner', name: 'repo' }, channelId: 'channel',
      peer: { gitea: { username: 'peer-fixed', accountId: '101', token: 'git-token' }, message: { accountId: 'mm-peer', token: 'mm-token' } },
    },
    mapping: { workerId: 'worker-fixed', botId: 'bot-fixed' },
    signal: cancel.signal,
    pollIntervalMs: 60_000,
    onFailure: failure => failures.push(failure),
    ingest(event) {
      delivered.push(event.eventId);
      cancel.abort();
      return { batchId: `batch:${event.eventId}` };
    },
  });
  t.after(() => source.stop());
  comments = [
    { id: 1, body: 'first row', user: { id: 102 } },
    { id: 2, body: 'remaining row', user: { id: 102 } },
  ];

  await assert.rejects(source.poll(), { code: 'ROUTER_SOURCE_STOPPED' });
  await source.stop();
  assert.deepEqual(delivered, ['comment:1']);
  assert.deepEqual(source.snapshot().records.map(record => record.eventId), delivered);
  assert.deepEqual(failures, []);
});

test('polling collects all new pages and advances a Mattermost cursor without duplicate inputs', async t => {
  const comments = [], posts = [], trace = [], delivered = [], failures = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    trace.push(url);
    const page = Number(url.searchParams.get('page'));
    response.setHeader('content-type', 'application/json');
    if (url.pathname.endsWith('/comments')) return response.end(JSON.stringify(comments.slice((page - 1) * 50, page * 50)));
    const newestFirst = posts.slice().reverse();
    const before = url.searchParams.get('before');
    const start = before ? newestFirst.findIndex(row => row.id === before) + 1 : 0;
    const rows = newestFirst.slice(start, start + 50);
    response.end(JSON.stringify({ order: rows.map(row => row.id), posts: Object.fromEntries(rows.map(row => [row.id, row])) }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const source = await createPeerMeshEventSubscription({
    facilities: { endpoints: { gitea: origin, message: origin }, repository: { owner: 'owner', name: 'repo' }, channelId: 'channel',
      peer: { gitea: { username: 'worker', accountId: '101', token: 'git-token' }, message: { accountId: 'worker', token: 'mm-token' } } },
    mapping: { workerId: 'worker', botId: 'bot' }, pollIntervalMs: 60_000, maxPolls: 2, onFailure: failure => failures.push(failure),
    ingest: event => { delivered.push(event); return { batchId: event.eventId }; },
  });
  t.after(() => source.stop());
  for (let index = 1; index <= 55; index++) {
    comments.push({ id: index, user: { id: 200 }, body: 'comment', updated_at: '2026-11-24T00:00:00.000Z' });
    posts.push({ id: String(index), user_id: 'author', channel_id: 'channel', create_at: index, message: 'post' });
  }
  await source.poll();
  await source.poll();
  assert.equal(delivered.length, 110);
  assert.equal(new Set(delivered.map(event => event.eventId)).size, 110);
  assert.equal(delivered.at(-1).origin.senderId, 'author');
  assert.equal(delivered.at(-1).eventId, 'post:55');
  assert.ok(trace.some(url => url.searchParams.has('before')));
  assert.ok(trace.some(url => url.searchParams.has('since')));
  assert.deepEqual(failures, [{ code: 'ROUTER_SOURCE_POLL_LIMIT' }]);
  assert.equal(source.snapshot().closed, true);
  assert.equal(source.snapshot().exhausted, true);
  await assert.rejects(source.poll(), { code: 'ROUTER_SOURCE_STOPPED' });
});
