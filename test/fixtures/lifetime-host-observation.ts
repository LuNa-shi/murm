import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { openSandboxAgentKey, openSandboxRuntimeKey } from '../../src/core/sandbox/opensandbox-metadata.js';

const fail = code => Object.assign(new Error(code), { code });
const duration = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
function expiry(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return NaN;
  const parsed = Date.parse(value), day = Date.parse(value.slice(0, 10));
  return Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === value.slice(0, 10) ? parsed : NaN;
}
async function evidence(directory, runtimeId, agentIds, signal) {
  if (await realpath(directory) !== directory) throw fail('LIFETIME_EVIDENCE_PATH');
  const info = await stat(directory);
  if (info.uid !== process.getuid() || (info.mode & 0o077)) throw fail('LIFETIME_EVIDENCE_PATH');
  while (true) {
    signal.throwIfAborted();
    const handle = await open(join(directory, 'evidence.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW);
    let text;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 8 * 1024 ** 2) throw fail('LIFETIME_EVIDENCE_INVALID');
      const bytes = Buffer.alloc(8 * 1024 ** 2 + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead === bytes.length) throw fail('LIFETIME_EVIDENCE_INVALID');
      text = bytes.subarray(0, bytesRead).toString('utf8');
    } finally { await handle.close(); }
    if (!text.endsWith('\n')) { await delay(10, undefined, { signal }); continue; }
    let rows;
    try { rows = text.trim().split('\n').map(JSON.parse); } catch { throw fail('LIFETIME_EVIDENCE_INVALID'); }
    if (rows.length > 16384 || rows.some((row, i) => row.runtimeId !== runtimeId || row.seq !== i + 1)) throw fail('LIFETIME_EVIDENCE_INVALID');
    const selected = agentIds.map(agentId => rows.filter(row => row.type === 'spawn' && row.agentId === agentId));
    if (selected.some(rows => !rows.some(row => row.state === 'ready'))) { await delay(10, undefined, { signal }); continue; }
    return selected.map(rows => {
      if (rows.map(row => row.state).join(',') !== 'registered,allocation-dispatched,allocation-observed,ready') throw fail('LIFETIME_EVIDENCE_INVALID');
      const [registered, dispatched, observed, ready] = rows;
      if (!registered.requestId || typeof registered.source !== 'string' || !registered.source || rows.some(row => row.requestId !== registered.requestId) || observed.observation !== 'create-response' ||
          typeof observed.sandboxId !== 'string' || !observed.sandboxId || ready.sandboxId !== observed.sandboxId ||
          !Number.isSafeInteger(dispatched.timeoutSeconds) || dispatched.timeoutSeconds < 60) throw fail('LIFETIME_EVIDENCE_INVALID');
      return { agentId: registered.agentId, requestId: registered.requestId, source: registered.source,
        sandboxId: observed.sandboxId, requestedSeconds: dispatched.timeoutSeconds, allocationSeq: observed.seq, readySeq: ready.seq };
    });
  }
}

// Host acceptance preparation, not a Agent Service or an endurance verdict. The
// trusted caller supplies its live Runtime and private output root. Date and
// expiresAt must use the provider's common clock; uncertaintyMs is the host's
// explicit calibrated clock error bound, plus one second for HTTP Date precision.
// No request duration is converted to an expiry, and no resources are created.
export async function admitLifetime({ runtime, outputDir, agentIds, workMs, cleanupMs, recoveryMs, marginMs,
  observationTimeoutMs = 10000, maxObservationAgeMs = 5000, provider, signal }) {
  if (!runtime?.id || typeof runtime.get !== 'function' || typeof outputDir !== 'string' ||
      !Array.isArray(agentIds) || agentIds.length < 4 || agentIds.length > 8 || new Set(agentIds).size !== agentIds.length || agentIds.some(id => typeof id !== 'string' || !id) ||
      ![workMs, cleanupMs, recoveryMs, marginMs, observationTimeoutMs, maxObservationAgeMs].every(duration) || observationTimeoutMs > 60000 || maxObservationAgeMs > 60000 ||
      (signal !== undefined && !(signal instanceof AbortSignal)) ||
      !Number.isSafeInteger(provider?.uncertaintyMs) || provider.uncertaintyMs < 0 || provider.uncertaintyMs > 60000) throw fail('LIFETIME_CONFIG_INVALID');
  let base;
  try { base = new URL(provider.baseUrl); } catch { throw fail('LIFETIME_CONFIG_INVALID'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw fail('LIFETIME_CONFIG_INVALID');
  const local = new AbortController();
  const combined = AbortSignal.any([local.signal, AbortSignal.timeout(observationTimeoutMs), ...(signal ? [signal] : [])]);
  const bounded = work => new Promise((resolve, reject) => {
    const abort = () => reject(fail('LIFETIME_OBSERVATION_ABORTED'));
    combined.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => combined.removeEventListener('abort', abort));
    if (combined.aborted) abort();
  });
  const check = async () => {
    combined.throwIfAborted();
    for (const id of agentIds) if (!['idle', 'running'].includes((await bounded(runtime.get(id))).status)) throw fail('LIFETIME_AGENT_UNAVAILABLE');
    combined.throwIfAborted();
  };
  try {
    await check();
    const members = await bounded(evidence(join(resolve(outputDir), runtime.id), runtime.id, agentIds, combined));
    if (new Set(members.map(row => row.sandboxId)).size !== members.length) throw fail('LIFETIME_RESOURCE_MISMATCH');
    const resources = await Promise.all(members.map(async member => {
      const sentAtMs = performance.now();
      const response = await fetch(`${base.href.replace(/\/$/, '')}/sandboxes/${encodeURIComponent(member.sandboxId)}`, {
        headers: provider.headers, redirect: 'error', signal: combined,
      });
      let bytes = 0; const chunks = [];
      try {
        if (!response.ok) throw fail('LIFETIME_PROVIDER_FAILED');
        for await (const chunk of response.body) {
          bytes += chunk.length; if (bytes > 65536) throw fail('LIFETIME_PROVIDER_INVALID'); chunks.push(chunk);
        }
      } finally { await response.body?.cancel().catch(() => {}); }
      const receivedAtMs = performance.now();
      let resource; try { resource = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('LIFETIME_PROVIDER_INVALID'); }
      if (resource.id !== member.sandboxId || resource.status?.state !== 'Running' || resource.metadata?.runtime_key !== openSandboxRuntimeKey(runtime.id) ||
          resource.metadata?.agent_key !== openSandboxAgentKey(member.agentId) || resource.metadata?.resource_key !== openSandboxAgentKey(member.agentId)) throw fail('LIFETIME_RESOURCE_MISMATCH');
      const date = response.headers.get('date'); const providerNowMs = Date.parse(date);
      if (!date || !Number.isFinite(providerNowMs) || new Date(providerNowMs).toUTCString() !== date ||
          Math.abs(Date.now() - providerNowMs) > provider.uncertaintyMs + 1000 || (response.headers.get('age') ?? '0') !== '0') throw fail('LIFETIME_CLOCK_UNVERIFIED');
      const expiresAt = expiry(resource.expiresAt);
      if (!Number.isFinite(expiresAt)) throw fail('LIFETIME_EXPIRY_UNKNOWN');
      return { ...member, sentAtMs, receivedAtMs, providerNowMs, uncertaintyMs: provider.uncertaintyMs + 1000, expiresAt: new Date(expiresAt).toISOString(),
        expiresAtMs: sentAtMs + expiresAt - providerNowMs - provider.uncertaintyMs - 1000 };
    }));
    await check();
    const observedAtMs = performance.now();
    if (resources.some(row => observedAtMs - row.receivedAtMs > maxObservationAgeMs)) throw fail('LIFETIME_OBSERVATION_STALE');
    const workDeadlineAtMs = observedAtMs + workMs;
    const stopAtMs = Math.min(...resources.map(row => row.expiresAtMs - cleanupMs - recoveryMs - marginMs));
    if (workDeadlineAtMs > stopAtMs) throw fail('LIFETIME_TOO_SHORT');
    return { runtimeId: runtime.id, clockId: randomUUID(), observedAtMs, workDeadlineAtMs, stopAtMs, resources };
  } catch (error) {
    if (combined.aborted) throw fail('LIFETIME_OBSERVATION_ABORTED');
    if (typeof error?.code === 'string' && error.code.startsWith('LIFETIME_')) throw error;
    throw fail('LIFETIME_OBSERVATION_FAILED');
  } finally { local.abort(); }
}
