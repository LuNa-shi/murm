import { httpClient } from './http.js';

const e = encodeURIComponent;
const fail = code => Object.assign(new Error(code), { code });
/** Trusted host merge authority. Every attempted write has an immutable receipt. */
export function createAgenshDelivery({ facilities, adminToken }) {
  if (!facilities?.peers || typeof adminToken !== 'string' || !adminToken) throw new TypeError('Delivery requires scoped facilities and host credential');
  const request = httpClient(facilities.endpoints.gitea, `token ${adminToken}`);
  const scope = `/api/v1/repos/${e(facilities.repository.owner)}/${e(facilities.repository.name)}`;
  const records = new Map();
  return Object.freeze({
    snapshot: () => [...records.values()].map(({ work, ...row }) => structuredClone(row)),
    async merge({ peerKey, number, headSha, signal }) {
      const peer = facilities.peers.find(peer => peer.key === peerKey);
      if (!peer || !Number.isSafeInteger(number) || number < 1 || !/^[a-f0-9]{40}$/.test(headSha)) throw fail('DELIVERY_INVALID');
      const key = `${peerKey}:${number}`; const previous = records.get(key);
      if (previous) {
        if (previous.headSha !== headSha) throw fail('DELIVERY_CONFLICT');
        return previous.work;
      }
      if (records.size >= 16 || [...records.values()].some(row => row.peerKey === peerKey && row.state !== 'rejected')) throw fail('DELIVERY_CONFLICT');
      const row = { peerKey, number, headSha, state: 'checking' };
      records.set(key, row);
      row.work = (async () => {
        const pr = await request('GET', `${scope}/pulls/${number}`, undefined, { signal });
        if (pr?.head?.sha !== headSha || pr.head.ref !== peer.branch || pr.base?.ref !== 'main' || String(pr.user?.id) !== peer.gitea.accountId || pr.merged) throw fail('DELIVERY_INVALID');
        row.state = 'submitted';
        try { await request('POST', `${scope}/pulls/${number}/merge`, { Do: 'merge', head_commit_id: headSha }, { signal }); }
        catch { row.state = 'unknown'; throw fail('DELIVERY_MERGE_UNKNOWN'); }
        let merged;
        try { merged = await request('GET', `${scope}/pulls/${number}`, undefined, { signal }); }
        catch { row.state = 'unknown'; throw fail('DELIVERY_MERGE_UNKNOWN'); }
        if (!merged?.merged || merged.head?.sha !== headSha || !/^[a-f0-9]{40}$/.test(merged.merge_commit_sha ?? '')) { row.state = 'unknown'; throw fail('DELIVERY_MERGE_UNKNOWN'); }
        row.state = 'merged'; row.mergeSha = merged.merge_commit_sha;
        return { peerKey, number, headSha, mergeSha: row.mergeSha };
      })().catch(error => { if (row.state === 'checking') row.state = 'rejected'; throw error; });
      return row.work;
    },
    async readMainFile(path, { signal, maxBytes = 1024 ** 2 } = {}) {
      if (typeof path !== 'string' || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.[A-Za-z0-9]+$/.test(path) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 ** 2) throw fail('DELIVERY_INVALID');
      const branch = await request('GET', `${scope}/branches/main`, undefined, { signal });
      if (branch?.name !== 'main' || typeof branch.commit?.id !== 'string' || !/^[a-f0-9]{40}$/.test(branch.commit.id)) throw fail('DELIVERY_INVALID');
      const commit = branch.commit.id;
      const value = await request('GET', `${scope}/contents/${path.split('/').map(e).join('/')}?ref=${commit}`, undefined, { signal });
      if (value?.type !== 'file' || value.encoding !== 'base64' || value.path !== path || typeof value.content !== 'string' || value.content.length > Math.ceil(maxBytes / 3) * 4 + 4096) throw fail('DELIVERY_INVALID');
      const data = Buffer.from(value.content.replace(/\s/g, ''), 'base64');
      if (data.length !== value.size || data.length > maxBytes) throw fail('DELIVERY_INVALID');
      return { commit, path, data };
    },
  });
}
