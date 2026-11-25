import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { open, mkdir, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const maxInputBytes = 2 * 1024 ** 2;
const maxArchiveBytes = 9 * 1024 ** 2;
const positiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0;

interface RunWindowOptions {
  directory: string;
  upstreamUrl: string;
  upstreamHeaders?: HeadersInit;
  durationMs?: number;
  maxRequests?: number | null;
  maxConcurrent?: number;
  maxOutputTokens?: number | null;
  now?: () => number;
}

interface Attempt {
  number: number;
  elapsedMs: number;
  requestedOutputTokens?: number;
  upstreamStatus?: number;
  transport?: 'upstream_rejected' | 'stream_ended' | 'aborted' | 'failed';
  finishedElapsedMs?: number;
}

interface Checkpoint {
  sourceRevision: string;
  sha256: string;
  path: string;
  observedElapsedMs: number;
  persistedElapsedMs: number;
}

export async function createRunWindow({
  directory, upstreamUrl, upstreamHeaders = {}, durationMs = 1_800_000,
  maxRequests = 240, maxConcurrent = 3, maxOutputTokens = 4096, now = () => performance.now(),
}: RunWindowOptions) {
  if (![durationMs, maxConcurrent].every(positiveInteger) || durationMs > 2_147_483_647 ||
      (maxRequests !== null && !positiveInteger(maxRequests)) ||
      (maxOutputTokens !== null && (!positiveInteger(maxOutputTokens) || maxOutputTokens < 16))) {
    throw new Error('Invalid benchmark run bounds');
  }
  const target = new URL(upstreamUrl);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password ||
      target.search || target.hash || !target.pathname.endsWith('/v1/responses')) {
    throw new Error('Invalid Responses upstream');
  }
  const headers = new Headers(upstreamHeaders);
  headers.set('accept', 'text/event-stream');
  headers.set('content-type', 'application/json');
  const authorization = 'Bearer ' + randomBytes(32).toString('base64url');
  const active = new Set<AbortController>();
  const lifetime = new AbortController();
  const attempts: Attempt[] = [];
  const checkpoints: Checkpoint[] = [];
  let startTick: number | undefined;
  let startedAt: string | undefined;
  let closedElapsedMs: number | null | undefined;
  let stopReason: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closePromise: Promise<void> | undefined;
  let latestCheckpoint: Checkpoint | undefined;

  function seal(reason: string, tick = now()) {
    if (closedElapsedMs !== undefined) return;
    const expired = startTick !== undefined && tick >= startTick + durationMs;
    stopReason = expired ? 'deadline' : reason;
    closedElapsedMs = startTick === undefined ? null : expired ? durationMs : tick - startTick;
    clearTimeout(timer);
    for (const controller of active) controller.abort();
    lifetime.abort(Object.assign(new Error('Run window sealed'), { code: stopReason }));
  }

  function admits(tick: number) {
    if (startTick !== undefined && tick >= startTick + durationMs) seal('deadline', tick);
    return startTick !== undefined && closedElapsedMs === undefined;
  }

  function stopWhenDue() {
    const tick = now();
    if (admits(tick)) timer = setTimeout(stopWhenDue, Math.max(1, startTick + durationMs - tick));
  }

  function reply(response: ServerResponse, status: number, code: string) {
    if (response.destroyed) return;
    if (response.headersSent) return response.destroy();
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code } }));
  }

  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') return reply(response, 404, 'path');
    if (request.headers.authorization !== authorization) return reply(response, 401, 'credential');
    if (!admits(now())) return reply(response, 403, 'window_closed');
    let body;
    try {
      let total = 0;
      const chunks = [];
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        total += chunk.length;
        if (total > maxInputBytes) {
          response.setHeader('connection', 'close');
          return reply(response, 413, 'input_limit');
        }
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return reply(response, 400, 'invalid_json');
    }
    if (body?.model !== 'k3' || body.stream !== true || body.store !== false ||
        Object.hasOwn(body, 'max_completion_tokens') ||
        (body.max_output_tokens !== undefined && (!positiveInteger(body.max_output_tokens) || body.max_output_tokens < 16))) {
      return reply(response, 400, 'invalid_request');
    }
    const requested = maxOutputTokens === null ? body.max_output_tokens
      : Math.min(body.max_output_tokens ?? maxOutputTokens, maxOutputTokens);
    const payload = JSON.stringify(requested === undefined ? body : { ...body, max_output_tokens: requested });
    const tick = now();
    if (!admits(tick)) return reply(response, 403, 'window_closed');
    if (request.aborted || response.destroyed) return;
    if (maxRequests !== null && attempts.length >= maxRequests) return reply(response, 429, 'request_limit');
    if (active.size >= maxConcurrent) return reply(response, 429, 'concurrent_limit');
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    const attempt: Attempt = { number: attempts.length + 1, elapsedMs: tick - startTick, requestedOutputTokens: requested };
    attempts.push(attempt);
    active.add(controller);
    response.once('close', disconnect);
    try {
      const result = await fetch(target, { method: 'POST', redirect: 'error', headers, signal: controller.signal, body: payload });
      attempt.upstreamStatus = result.status;
      if (!admits(now())) {
        await result.body?.cancel().catch(() => {});
        throw new Error('Window reached deadline');
      }
      if (!result.ok || !result.body || !/^text\/event-stream(?:;|$)/i.test(result.headers.get('content-type') ?? '')) {
        attempt.transport = 'upstream_rejected';
        await result.body?.cancel();
        return reply(response, result.status === 429 ? 429 : 502, 'upstream_rejected');
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      await pipeline(Readable.fromWeb(result.body), async function* (source) {
        for await (const chunk of source) {
          if (!admits(now())) throw new Error('Window reached deadline');
          yield chunk;
        }
      }, response, { signal: controller.signal });
      attempt.transport = 'stream_ended';
    } catch {
      attempt.transport = controller.signal.aborted ? 'aborted' : 'failed';
      reply(response, 502, 'transport_interrupted');
    } finally {
      attempt.finishedElapsedMs = now() - startTick;
      response.off('close', disconnect);
      active.delete(controller);
    }
  });
  server.requestTimeout = 20_000;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    signal: lifetime.signal,
    remainingMs() {
      const tick = now();
      return admits(tick) ? Math.max(0, startTick + durationMs - tick) : 0;
    },
    upstream: Object.freeze({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`,
      headers: Object.freeze({ authorization }),
    }),
    start() {
      if (startTick !== undefined || closedElapsedMs !== undefined) throw new Error('Window cannot be reopened');
      startedAt = new Date().toISOString();
      startTick = now();
      stopWhenDue();
      return startedAt;
    },
    async checkpoint({ archive, sourceRevision }: { archive: Buffer; sourceRevision: string }) {
      if (!Buffer.isBuffer(archive) || !archive.length || archive.length > maxArchiveBytes ||
          typeof sourceRevision !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(sourceRevision)) {
        throw new Error('Invalid checkpoint inputs');
      }
      const observedTick = now();
      if (!admits(observedTick)) throw new Error('Window closed before checkpoint');
      const bytes = Buffer.from(archive);
      const digest = createHash('sha256').update(bytes).digest('hex');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, `${digest}-${randomBytes(8).toString('hex')}.tar.gz`);
      const fd = await open(path, 'wx', 0o400);
      try {
        try {
          await fd.writeFile(bytes);
          await fd.sync();
        } finally {
          await fd.close();
        }
        const persistedTick = now();
        if (!admits(persistedTick)) throw new Error('Window closed before checkpoint persisted');
        const record = Object.freeze({ sourceRevision, sha256: digest, path,
          observedElapsedMs: observedTick - startTick, persistedElapsedMs: persistedTick - startTick });
        checkpoints.push(record);
        if (!latestCheckpoint || record.observedElapsedMs >= latestCheckpoint.observedElapsedMs) latestCheckpoint = record;
        return record;
      } catch (error) {
        await unlink(path);
        throw error;
      }
    },
    receipt() {
      admits(now());
      return structuredClone({ startedAt, durationMs, maxRequests, maxConcurrent, maxOutputTokens, stopReason,
        closedElapsedMs: closedElapsedMs ?? null,
        attempts, checkpoints, latestCheckpoint });
    },
    seal: (reason: string) => seal(reason),
    close() {
      seal('shutdown');
      closePromise ??= new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      return closePromise;
    },
  };
}
