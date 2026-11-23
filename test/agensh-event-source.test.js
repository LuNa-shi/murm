import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createAgenshEventSubscription } from '../src/environments/agensh/event-source.js';

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
  const source = await createAgenshEventSubscription({ facilities: {
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
