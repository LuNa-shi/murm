import { httpClient } from './http.js';
const fail = (code: any) => Object.assign(new Error(code), { code });
const e = encodeURIComponent;

/** Trusted bounded polling adapter. Credentials and upstream rows stay on host. */
export async function createAgenshEventSubscription({ facilities, mapping, ingest, signal,
  pollIntervalMs = 1000, maxPolls, dmChannelIds = [], onFailure = () => {} }: any) {
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000 || (maxPolls !== undefined && (!Number.isSafeInteger(maxPolls) || maxPolls < 1 || maxPolls > 100_000)) ||
      !Array.isArray(dmChannelIds) || dmChannelIds.length > 8 || new Set(dmChannelIds).size !== dmChannelIds.length || dmChannelIds.some((id: any) => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))) throw new TypeError('Event subscription needs bounded polling and explicit direct channels');
  const abort: any = new AbortController(); const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  const git = httpClient(facilities.endpoints.gitea, `token ${facilities.peer.gitea.token}`);
  const mm = httpClient(facilities.endpoints.message, `Bearer ${facilities.peer.message.token}`);
  const repo = `/api/v1/repos/${e(facilities.repository.owner)}/${e(facilities.repository.name)}`;
  const members = facilities.peers ?? [facilities.peer];
  if (!Array.isArray(members) || members.length < 1 || members.length > 8 || new Set(members.map((peer: any) => peer.gitea.username)).size !== members.length) throw new TypeError('Event subscription needs distinct trusted peers');
  const targets = (text: any) => {
    const mentions = [...text.matchAll(/@([a-zA-Z0-9_.-]+)/g)].map((match: any) => match[1]);
    const named = members.filter((peer: any) => mentions.includes(peer.gitea.username));
    return { mentions, addressed: !mentions.length || named.some((peer: any) => peer.board?.workerId === mapping.workerId) };
  };
  const pageSize = 50;
  const pageLimit = 32;
  let commentCursor = 0;
  const channelCursors = new Map<string, string>();
  const directAccounts = new Map<string, string>(Object.entries(facilities.directChannels?.[facilities.peer.key] ?? {})
    .map(([key, channel]) => [channel as string, members.find((peer: any) => peer.key === key)?.message.accountId]));
  const seen: any = new Set(); const records: any[] = []; let polls = 0, closed = false, timer: any, inFlight: any, failure: any;
  const check = () => { if (closed || combined.aborted) throw fail('ROUTER_SOURCE_STOPPED'); };
  async function read() {
    check();
    const comments: any[] = [];
    let nextCommentCursor = commentCursor;
    const since = commentCursor ? `&since=${e(new Date(commentCursor - 2000).toISOString())}` : '';
    for (let page = 1; ; page++) {
      const rows = await git('GET', `${repo}/issues/comments?limit=${pageSize}&page=${page}${since}`, undefined, { signal: combined });
      check();
      if (!Array.isArray(rows) || rows.length > pageSize) throw fail('ROUTER_SOURCE_INVALID');
      comments.push(...rows);
      if (rows.length < pageSize) break;
      if (page === pageLimit) throw fail('ROUTER_SOURCE_PAGE_LIMIT');
    }
    const result = comments.map(row => {
      if (!Number.isSafeInteger(row?.id) || typeof row.body !== 'string' || !Number.isSafeInteger(row.user?.id)) throw fail('ROUTER_SOURCE_INVALID');
      const updated = Date.parse(row.updated_at ?? row.created_at);
      if (Number.isFinite(updated)) nextCommentCursor = Math.max(nextCommentCursor, updated);
      return { ignored: members.length > 1 && !targets(row.body).addressed, source: 'gitea', eventId: `comment:${row.id}`,
        targetWorker: mapping.workerId, kind: 'external', text: row.body, self: String(row.user.id) === facilities.peer.gitea.accountId,
        origin: { senderId: String(row.user.id), ...(typeof row.issue_url === 'string' ? { object: row.issue_url } : {}),
          ...(Number.isFinite(updated) ? { timestamp: updated } : {}) } };
    });
    for (const channel of [facilities.channelId, ...dmChannelIds]) {
      const posts: any[] = [];
      const anchor = channelCursors.get(channel);
      let before: string | undefined;
      let tip: string | undefined;
      for (let page = 1; ; page++) {
        check();
        const data = await mm('GET', `/api/v4/channels/${e(channel)}/posts?page=0&per_page=${pageSize}${before ? `&before=${e(before)}` : ''}`, undefined, { signal: combined });
        check();
        if (!Array.isArray(data?.order) || !data.posts || data.order.length > pageSize ||
            data.order.some((id: any) => typeof id !== 'string' || !id || !Object.hasOwn(data.posts, id))) throw fail('ROUTER_SOURCE_INVALID');
        tip ??= data.order[0];
        const known = anchor ? data.order.indexOf(anchor) : -1;
        const relevant = known < 0 ? data.order : data.order.slice(0, known);
        posts.push(...relevant.map((id: string) => data.posts[id]));
        if (known >= 0 || data.order.length < pageSize) break;
        if (page === pageLimit || before === data.order.at(-1)) throw fail('ROUTER_SOURCE_PAGE_LIMIT');
        before = data.order.at(-1);
      }
      posts.sort((a, b) => a?.create_at - b?.create_at || String(a?.id).localeCompare(String(b?.id)));
      for (const row of posts) {
        if (typeof row?.id !== 'string' || !row.id || typeof row.message !== 'string' || row.channel_id !== channel || typeof row.user_id !== 'string' || !Number.isSafeInteger(row.create_at)) throw fail('ROUTER_SOURCE_INVALID');
        const mentions = [...row.message.matchAll(/@([a-zA-Z0-9_.-]+)/g)].map((match: any) => match[1]);
        const mention = mentions.includes(facilities.peer.gitea.username) ? facilities.peer.gitea.username : mentions[0];
        const direct = dmChannelIds.includes(channel);
        const other = directAccounts.get(channel);
        if (other && ![other, facilities.peer.message.accountId].includes(row.user_id) && !row.type) throw fail('ROUTER_SOURCE_DM_SCOPE');
        result.push({ ignored: members.length > 1 && !direct && !targets(row.message).addressed, source: 'mattermost', eventId: `post:${row.id}`,
          targetWorker: !direct && mention && mention !== facilities.peer.gitea.username ? `unmapped:${mention}` : mapping.workerId,
          kind: direct ? 'dm' : mention ? 'mention' : 'peer-message', text: row.message, self: row.user_id === facilities.peer.message.accountId || Boolean(row.type),
          origin: { senderId: row.user_id, object: channel, timestamp: row.create_at } });
      }
      if (tip) channelCursors.set(channel, tip);
    }
    commentCursor = nextCommentCursor;
    return result;
  }
  function schedule() {
    if (!closed && !combined.aborted && (maxPolls === undefined || polls < maxPolls)) timer = setTimeout(() => { void poll().catch(() => {}); }, pollIntervalMs);
  }
  async function poll() {
    check(); if (inFlight) return inFlight;
    if (maxPolls !== undefined && polls >= maxPolls) throw fail('ROUTER_SOURCE_POLL_LIMIT');
    clearTimeout(timer); polls++;
    inFlight = (async () => {
      try {
        for (const row of await read()) {
          check();
          const id = `${row.source}:${row.eventId}`; if (seen.has(id)) continue;
          if (seen.size >= 8192) throw fail('ROUTER_SOURCE_EVENT_LIMIT');
          if (!row.self && !row.ignored && row.text) {
            const { self, ignored, ...event } = row; const batch = ingest(event);
            records.push({ source: event.source, eventId: event.eventId, targetWorker: event.targetWorker, kind: event.kind, origin: event.origin, receivedAt: new Date().toISOString(), batchId: batch.batchId });
          }
          seen.add(id);
        }
      } catch (error: any) {
        if (!closed && !combined.aborted) { failure = { code: ['ROUTER_SOURCE_PAGE_LIMIT', 'ROUTER_SOURCE_INVALID', 'ROUTER_SOURCE_EVENT_LIMIT', 'ROUTER_SOURCE_DM_SCOPE'].includes(error.code) ? error.code : 'ROUTER_SOURCE_FAILED' }; closed = true; abort.abort(); onFailure(failure); }
        throw error;
      } finally { inFlight = undefined; schedule(); }
    })();
    return inFlight;
  }
  try {
    for (const channel of dmChannelIds) {
      check(); const row = await mm('GET', `/api/v4/channels/${e(channel)}`, undefined, { signal: combined });
      if (row?.type !== 'D' || !row.name?.split('__').includes(facilities.peer.message.accountId) ||
        (directAccounts.has(channel) && !row.name.split('__').includes(directAccounts.get(channel)))) throw fail('ROUTER_SOURCE_DM_SCOPE');
    }
    for (const row of await read()) seen.add(`${row.source}:${row.eventId}`);
    check(); schedule();
  } catch (error: any) { closed = true; abort.abort(); throw fail(error.code === 'ROUTER_SOURCE_DM_SCOPE' ? error.code : 'ROUTER_SOURCE_NOT_READY'); }
  return Object.freeze({ ready: true, poll,
    async stop() { closed = true; clearTimeout(timer); abort.abort(); await inFlight?.catch(() => {}); },
    snapshot: () => ({ ready: true, closed, polls, maxPolls, pollIntervalMs, exhausted: maxPolls !== undefined && polls >= maxPolls, baselineAndSeen: seen.size, records: structuredClone(records), failure }),
  });
}
