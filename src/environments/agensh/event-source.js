import { httpClient } from './http.js';
const fail = code => Object.assign(new Error(code), { code });
const e = encodeURIComponent;

/** Trusted bounded polling adapter. Credentials and upstream rows stay on host. */
export async function createAgenshEventSubscription({ facilities, mapping, ingest, signal,
  pollIntervalMs = 1000, maxPolls = 120, dmChannelIds = [], onFailure = () => {} }) {
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000 || !Number.isSafeInteger(maxPolls) || maxPolls < 1 || maxPolls > 1000 ||
      !Array.isArray(dmChannelIds) || dmChannelIds.length > 4 || new Set(dmChannelIds).size !== dmChannelIds.length || dmChannelIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))) throw new TypeError('Event subscription needs bounded polling and explicit direct channels');
  const abort = new AbortController(); const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  const git = httpClient(facilities.endpoints.gitea, `token ${facilities.peer.gitea.token}`);
  const mm = httpClient(facilities.endpoints.message, `Bearer ${facilities.peer.message.token}`);
  const repo = `/api/v1/repos/${e(facilities.repository.owner)}/${e(facilities.repository.name)}`;
  const members = facilities.peers ?? [facilities.peer];
  if (!Array.isArray(members) || members.length < 1 || members.length > 8 || new Set(members.map(peer => peer.gitea.username)).size !== members.length) throw new TypeError('Event subscription needs distinct trusted peers');
  const targets = text => {
    const mentions = [...text.matchAll(/@([a-zA-Z0-9_.-]+)/g)].map(match => match[1]);
    const named = members.filter(peer => mentions.includes(peer.gitea.username));
    return { mentions, addressed: !mentions.length || named.some(peer => peer.board?.workerId === mapping.workerId) };
  };
  const seen = new Set(); const records = []; let polls = 0, closed = false, timer, inFlight, failure;
  const check = () => { if (closed || combined.aborted) throw fail('ROUTER_SOURCE_STOPPED'); };
  async function read() {
    check();
    const comments = await git('GET', `${repo}/issues/comments?limit=50&page=1`, undefined, { signal: combined }); check();
    if (!Array.isArray(comments) || comments.length >= 50) throw fail('ROUTER_SOURCE_PAGE_LIMIT');
    const result = comments.map(row => {
      if (!Number.isSafeInteger(row.id) || typeof row.body !== 'string' || !Number.isSafeInteger(row.user?.id)) throw fail('ROUTER_SOURCE_INVALID');
      return { ignored: members.length > 1 && !targets(row.body).addressed, source: 'gitea', eventId: `comment:${row.id}`, targetWorker: mapping.workerId, kind: 'external', text: row.body, self: String(row.user.id) === facilities.peer.gitea.accountId };
    });
    for (const channel of [facilities.channelId, ...dmChannelIds]) {
      check();
      const data = await mm('GET', `/api/v4/channels/${e(channel)}/posts?page=0&per_page=50`, undefined, { signal: combined }); check();
      if (!Array.isArray(data?.order) || !data.posts || data.order.length >= 50) throw fail('ROUTER_SOURCE_PAGE_LIMIT');
      const posts = data.order.map(id => data.posts[id]).sort((a, b) => a.create_at - b.create_at || String(a.id).localeCompare(String(b.id)));
      for (const row of posts) {
        if (typeof row?.id !== 'string' || !row.id || typeof row.message !== 'string' || row.channel_id !== channel || typeof row.user_id !== 'string' || !Number.isSafeInteger(row.create_at)) throw fail('ROUTER_SOURCE_INVALID');
        const mentions = [...row.message.matchAll(/@([a-zA-Z0-9_.-]+)/g)].map(match => match[1]);
        const mention = mentions.includes(facilities.peer.gitea.username) ? facilities.peer.gitea.username : mentions[0]; const direct = dmChannelIds.includes(channel);
        result.push({ ignored: members.length > 1 && !direct && !targets(row.message).addressed, source: 'mattermost', eventId: `post:${row.id}`, targetWorker: !direct && mention && mention !== facilities.peer.gitea.username ? `unmapped:${mention}` : mapping.workerId,
          kind: direct ? 'dm' : mention ? 'mention' : 'peer-message', text: row.message, self: row.user_id === facilities.peer.message.accountId || Boolean(row.type) });
      }
    }
    return result;
  }
  function schedule() {
    if (!closed && !combined.aborted && polls < maxPolls) timer = setTimeout(() => { void poll().catch(() => {}); }, pollIntervalMs);
  }
  async function poll() {
    check(); if (inFlight) return inFlight;
    if (polls >= maxPolls) throw fail('ROUTER_SOURCE_POLL_LIMIT');
    clearTimeout(timer); polls++;
    inFlight = (async () => {
      try {
        for (const row of await read()) {
          const id = `${row.source}:${row.eventId}`; if (seen.has(id)) continue;
          if (seen.size >= 1024) throw fail('ROUTER_SOURCE_EVENT_LIMIT');
          if (!row.self && !row.ignored && row.text) {
            const { self, ignored, ...event } = row; const batch = ingest(event);
            records.push({ source: event.source, eventId: event.eventId, targetWorker: event.targetWorker, kind: event.kind, batchId: batch.batchId });
          }
          seen.add(id);
        }
      } catch (error) {
        if (!closed && !combined.aborted) { failure = { code: ['ROUTER_SOURCE_PAGE_LIMIT', 'ROUTER_SOURCE_INVALID', 'ROUTER_SOURCE_EVENT_LIMIT'].includes(error.code) ? error.code : 'ROUTER_SOURCE_FAILED' }; closed = true; abort.abort(); onFailure(failure); }
        throw error;
      } finally { inFlight = undefined; schedule(); }
    })();
    return inFlight;
  }
  try {
    for (const channel of dmChannelIds) {
      check(); const row = await mm('GET', `/api/v4/channels/${e(channel)}`, undefined, { signal: combined });
      if (row?.type !== 'D' || !row.name?.split('__').includes(facilities.peer.message.accountId)) throw fail('ROUTER_SOURCE_DM_SCOPE');
    }
    for (const row of await read()) seen.add(`${row.source}:${row.eventId}`);
    check(); schedule();
  } catch (error) { closed = true; abort.abort(); throw fail(error.code === 'ROUTER_SOURCE_DM_SCOPE' ? error.code : 'ROUTER_SOURCE_NOT_READY'); }
  return Object.freeze({ ready: true, poll,
    async stop() { closed = true; clearTimeout(timer); abort.abort(); await inFlight?.catch(() => {}); },
    snapshot: () => ({ ready: true, closed, polls, maxPolls, pollIntervalMs, exhausted: polls >= maxPolls, baselineAndSeen: seen.size, records: structuredClone(records), failure }),
  });
}
