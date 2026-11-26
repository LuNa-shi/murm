import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { httpClient } from './http.js';
import { setTimeout as delay } from 'node:timers/promises';

const e = encodeURIComponent;
const fail = (code: any) => Object.assign(new Error(code), { code });
/** Trusted host merge authority. Every attempted write has an immutable receipt. */
export function createPeerMeshDelivery({ facilities, adminToken, maxReadinessReads = 10, readinessIntervalMs = 100 }: any) {
  if (!facilities?.peers || typeof adminToken !== 'string' || !adminToken) throw new TypeError('Delivery requires scoped facilities and host credential');
  if (!Number.isSafeInteger(maxReadinessReads) || maxReadinessReads < 1 || maxReadinessReads > 20 ||
      !Number.isSafeInteger(readinessIntervalMs) || readinessIntervalMs < 1 || readinessIntervalMs > 1000) throw new TypeError('Delivery requires bounded read-only readiness checks');
  const request = httpClient(facilities.endpoints.gitea, `token ${adminToken}`);
  const scope = `/api/v1/repos/${e(facilities.repository.owner)}/${e(facilities.repository.name)}`;
  const attempts = new Set<any>();
  const requests = new Map<string, any>();
  let finalPin: { commit: string; stable: boolean } | undefined;
  let finalization: Promise<{ commit: string; stable: boolean; archive: string; sha256: string; bytes: number }> | undefined;
  let accepting = true;
  async function readMain(signal?: AbortSignal) {
    const branch = await request('GET', `${scope}/branches/main`, undefined, { signal });
    if (branch?.name !== 'main' || typeof branch.commit?.id !== 'string' || !/^[a-f0-9]{40}$/.test(branch.commit.id)) throw fail('DELIVERY_INVALID');
    return branch.commit.id as string;
  }
  async function readback(row: any, signal?: AbortSignal) {
    row.phase = 'readback';
    try {
      const pr = await request('GET', `${scope}/pulls/${row.number}`, undefined, { signal });
      const mergeShaValid = typeof pr?.merge_commit_sha === 'string' && /^[a-f0-9]{40}$/.test(pr.merge_commit_sha);
      const merged = pr?.merged === true;
      const headMatches = pr?.head?.sha === row.headSha;
      row.observation = { merged, headMatches, mergeShaValid };
      if (facilities.project && merged && mergeShaValid) {
        const commit = await request('GET', `${scope}/git/commits/${pr.merge_commit_sha}`, undefined, { signal });
        row.observation.mergeIncludesHead = commit?.sha === pr.merge_commit_sha && commit.parents?.[1]?.sha === row.headSha;
      }
      if (merged && mergeShaValid) row.mergeSha = pr.merge_commit_sha;
    } catch (error: any) {
      row.state = 'unknown';
      row.failure ??= { phase: row.phase, code: error.code, ...(error.status === undefined ? {} : { status: error.status }) };
      throw fail('DELIVERY_MERGE_UNKNOWN');
    }
    const verifiedHead = facilities.project ? row.observation.mergeIncludesHead === true : row.observation.headMatches;
    if (!row.observation.merged || !row.observation.mergeShaValid || !verifiedHead) {
      row.state = 'unknown';
      row.failure ??= { phase: row.phase, code: 'DELIVERY_INVALID_OBSERVATION' };
      throw fail('DELIVERY_MERGE_UNKNOWN');
    }
    row.state = 'merged';
    row.phase = 'verified';
    row.verifiedAt = new Date().toISOString();
    return { peerKey: row.peerKey, number: row.number, headSha: row.headSha, mergeSha: row.mergeSha };
  }
  function reconcile(row: any, signal?: AbortSignal) {
    if (!row.reconciling) {
      row.reconciling = readback(row, signal).finally(() => { delete row.reconciling; });
      row.work = row.reconciling;
    }
    return row.reconciling;
  }
  async function saveArchive(directory: string, commit: string, signal: AbortSignal) {
    const destination = join(directory, `main-${commit}.tar.gz`);
    const temporary = join(directory, `.main-${randomUUID()}.tmp`);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      const response = await fetch(new URL(`${scope}/archive/${commit}.tar.gz`, facilities.endpoints.gitea), {
        signal, redirect: 'error', headers: { authorization: `token ${adminToken}` },
      });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw fail('DELIVERY_EXPORT_FAILED'); }
      const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        if (bytes > 64 * 1024 ** 2) return done(fail('DELIVERY_EXPORT_FAILED'));
        hash.update(chunk);
        done(null, chunk);
      } });
      await pipeline(response.body, meter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
      if (!bytes) throw fail('DELIVERY_EXPORT_FAILED');
      await rename(temporary, destination);
      return { archive: destination, sha256: hash.digest('hex'), bytes };
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
      throw fail('DELIVERY_EXPORT_FAILED');
    }
  }
  return Object.freeze({
    snapshot: () => [...attempts].map(({ work, finished, reconciling, ...row }) => structuredClone(row)),
    stop() { accepting = false; },
    finalize(directory: string, signal: AbortSignal) {
      accepting = false;
      if (!finalization) finalization = (async () => {
        await Promise.allSettled([...attempts].map(row => row.work));
        await Promise.allSettled([...attempts].filter(row => row.state === 'unknown').map(row => reconcile(row, signal)));
        const stable = ![...attempts].some(row => row.state === 'unknown');
        if (!finalPin?.stable) finalPin = { commit: await readMain(signal), stable };
        try {
          return { ...finalPin, ...await saveArchive(directory, finalPin.commit, signal) };
        } catch (error: any) {
          throw Object.assign(error, { pin: finalPin });
        }
      })().finally(() => { finalization = undefined; });
      return finalization;
    },
    async merge({ peerKey, number, headSha, requestId, signal }: any) {
      const peer = facilities.peers.find((peer: any) => peer.key === peerKey);
      if (!peer || !Number.isSafeInteger(number) || number < 1 || typeof headSha !== 'string' || !/^[a-f0-9]{40}$/.test(headSha)) throw fail('DELIVERY_INVALID');
      if (!accepting) throw fail('DELIVERY_STOPPING');
      const key = JSON.stringify([peerKey, requestId ?? [number, headSha]]);
      const previous = requests.get(key);
      if (previous) {
        if (previous.number !== number || previous.headSha !== headSha) throw fail('DELIVERY_CONFLICT');
        return previous.state === 'unknown' && previous.finished ? reconcile(previous, signal) : previous.work;
      }
      if (requests.size >= 4096) throw fail('DELIVERY_CONFLICT');
      const active = [...attempts].find(row => row.number === number && row.state !== 'rejected');
      if (active) {
        if (active.peerKey !== peerKey || active.headSha !== headSha) throw fail('DELIVERY_CONFLICT');
        requests.set(key, active);
        return active.state === 'unknown' && active.finished ? reconcile(active, signal) : active.work;
      }
      if (attempts.size >= 512) throw fail('DELIVERY_CONFLICT');
      const row: any = { peerKey, number, headSha, ...(requestId ? { requestId } : {}), state: 'checking', phase: 'preflight',
        readinessReads: 0, requestedAt: new Date().toISOString() };
      attempts.add(row);
      requests.set(key, row);
      row.work = (async () => {
        async function confirmReady() {
          while (row.readinessReads < maxReadinessReads) {
            row.readinessReads++;
            const pr = await request('GET', `${scope}/pulls/${number}`, undefined, { signal });
            const allowedHead = facilities.project
              ? typeof pr?.head?.ref === 'string' && pr.head.ref.length > 0 && pr.head.ref !== 'main' &&
                pr.head.repo?.full_name === `${facilities.repository.owner}/${facilities.repository.name}`
              : pr?.head?.ref === peer.branch;
            if (!allowedHead || pr?.head?.sha !== headSha || pr.base?.ref !== 'main' ||
                String(pr.user?.id) !== peer.gitea.accountId || pr.merged) throw fail('DELIVERY_INVALID');
            if (pr.mergeable === true) return;
            if (row.readinessReads < maxReadinessReads) await delay(readinessIntervalMs, undefined, { signal });
          }
          throw fail('DELIVERY_NOT_READY');
        }
        for (let submission = 0; submission < 2; submission++) {
          row.state = 'checking';
          row.phase = 'preflight';
          await confirmReady();
          if (!accepting) throw fail('DELIVERY_STOPPING');
          row.state = 'submitted';
          row.phase = 'submit';
          try {
            await request('POST', `${scope}/pulls/${number}/merge`, { Do: 'merge', head_commit_id: headSha }, {
              signal, recognizedRejection: { status: 405, message: 'Please try again later', code: 'GITEA_MERGE_RECHECKING' },
            });
            row.acknowledgement = 'confirmed';
            break;
          } catch (error: any) {
            row.failure = { phase: row.phase, code: error.code, ...(error.status === undefined ? {} : { status: error.status }) };
            if (error.code === 'GITEA_MERGE_RECHECKING' && submission === 0 && row.readinessReads < maxReadinessReads) {
              row.recheckRejection = row.failure;
              delete row.failure;
              row.acknowledgement = 'rejected';
              row.state = 'checking';
              await delay(Math.max(150, readinessIntervalMs), undefined, { signal });
              continue;
            }
            if ([401, 403, 404, 405, 409, 422].includes(error.status)) {
              row.state = 'rejected';
              row.acknowledgement = 'rejected';
              throw fail('DELIVERY_NOT_READY');
            }
            row.state = 'unknown';
            row.acknowledgement = 'unknown';
            break;
          }
        }
        return readback(row, signal);
      })().catch((error: any) => { if (row.state === 'checking') { row.state = 'rejected'; row.failure = { phase: row.phase, code: error.code ?? 'DELIVERY_PREFLIGHT_FAILED', ...(error.status === undefined ? {} : { status: error.status }) }; } throw error; }).finally(() => { row.finished = true; });
      return row.work;
    },
    async readMainFile(path: any, { signal, maxBytes = 1024 ** 2 }: any = {}) {
      if (typeof path !== 'string' || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.[A-Za-z0-9]+$/.test(path) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 ** 2) throw fail('DELIVERY_INVALID');
      const commit = await readMain(signal);
      const value = await request('GET', `${scope}/contents/${path.split('/').map(e).join('/')}?ref=${commit}`, undefined, { signal });
      if (value?.type !== 'file' || value.encoding !== 'base64' || value.path !== path || typeof value.content !== 'string' || value.content.length > Math.ceil(maxBytes / 3) * 4 + 4096) throw fail('DELIVERY_INVALID');
      const data = Buffer.from(value.content.replace(/\s/g, ''), 'base64');
      if (data.length !== value.size || data.length > maxBytes) throw fail('DELIVERY_INVALID');
      return { commit, path, data };
    },
  });
}
