import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { stableStringify } from '../../protocol/envelope.js';
import { boundedLines, MAX_COMMAND_BYTES } from './foreground-commands.js';
import { failureCode, type HarnessJson, type ProjectHost } from './project-harness.js';
import { projectError, resolveHarnessInput } from './project-input.js';

type Operation = 'run' | 'status' | 'input' | 'stop';
type Request = { id: string; operation: Operation; input?: HarnessJson };
type Reply = { type: 'reply'; id: string; runId?: string; result: unknown } |
  { type: 'error'; id?: string; runId?: string; code: string };
type Receipt = { id: string; fingerprint: string; reply?: Reply; waiting: number };
type QueuedInput = { receipt: Receipt; input: HarnessJson; bytes: number };
type Writer = (record: unknown) => Promise<void>;

const operations: ReadonlySet<string> = new Set(['run', 'status', 'input', 'stop']);
const inputQueueLimit = 64;
const inputBytesLimit = 262_144;

function validateRequest(request: unknown): asserts request is Request {
  const value = request as Partial<Request> | null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.id !== 'string' || !value.id || value.id.length > 128 ||
      typeof value.operation !== 'string' || !operations.has(value.operation) ||
      Object.keys(value).some(key => !['id', 'operation', 'input'].includes(key))) {
    throw projectError('INVALID_REQUEST', 'Expected a request id and supported operation');
  }
  if ((value.operation === 'stop' || value.operation === 'status') && value.input !== undefined) {
    throw projectError('INVALID_REQUEST', 'This operation takes no input');
  }
}

export async function runProjectRpc(host: ProjectHost, input: Readable, write: Writer, launchDirectory: string) {
  const done = Promise.withResolvers<number>();
  const receipts = new Map<string, Receipt>();
  const queue: QueuedInput[] = [];
  let bytesQueued = 0;
  let active: Receipt | undefined;
  let closed = false;
  const location = () => {
    const { runId } = host.status();
    return runId === null ? {} : { runId };
  };
  const errorRecord = (code: string, id?: string) => ({ type: 'error' as const, ...(id ? { id } : {}), ...location(), code });
  const respond = (receipt: Receipt, reply: Reply) => {
    if (receipt.reply) return;
    receipt.reply = reply;
    for (let index = 0; index < receipt.waiting; index++) void write(reply);
  };
  const reply = (receipt: Receipt, result: unknown) =>
    respond(receipt, { type: 'reply', id: receipt.id, ...location(), result: structuredClone(result) });
  const reject = (receipt: Receipt, code: string) => respond(receipt, errorRecord(code, receipt.id));
  const dropQueued = () => {
    for (const { receipt } of queue.splice(0)) reject(receipt, 'RUN_STOPPING');
    bytesQueued = 0;
  };

  async function pump() {
    if (active || host.signal.aborted || closed) return;
    while (queue.length && !closed && !host.signal.aborted) {
      const { receipt, input, bytes } = queue.shift()!;
      active = receipt;
      bytesQueued -= bytes;
      try {
        reply(receipt, await host.input(input, receipt.id));
      } catch (error) {
        const code = failureCode(error, 'HARNESS_INPUT_FAILED');
        reject(receipt, host.signal.aborted && ['ABORT_ERR', 'RUN_STOPPING', 'HARNESS_INPUT_FAILED'].includes(code)
          ? 'OPERATION_UNKNOWN' : code);
      } finally {
        active = undefined;
      }
    }
  }

  function stopTransport() {
    queueMicrotask(dropQueued);
    if (!host.completion) setImmediate(() => done.resolve(0));
  }

  function onLine(line: string) {
    if (closed) return;
    let requestId: string | undefined;
    try {
      if (Buffer.byteLength(line) > MAX_COMMAND_BYTES) throw projectError('INVALID_REQUEST', 'Request line is too large');
      const request = JSON.parse(line, (_key, value) => {
        if (typeof value === 'number' && !Number.isFinite(value)) throw projectError('INVALID_REQUEST', 'Non-finite JSON number');
        return value;
      });
      if (typeof request?.id === 'string' && request.id && request.id.length <= 128) requestId = request.id;
      validateRequest(request);
      const identity = [request.operation, Object.hasOwn(request, 'input'), request.input ?? null];
      const fingerprint = createHash('sha256').update(stableStringify(identity)).digest('hex');
      const previous = receipts.get(request.id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) void write(errorRecord('REQUEST_ID_CONFLICT', request.id));
        else if (previous.reply) void write(previous.reply);
        else if (previous.waiting < inputQueueLimit) previous.waiting++;
        else void write(errorRecord('REQUEST_LIMIT', request.id));
        return;
      }
      const bytes = Buffer.byteLength(line);
      if (request.operation === 'input' && !host.signal.aborted &&
          (queue.length >= inputQueueLimit || bytesQueued + bytes > inputBytesLimit)) {
        void write(errorRecord('REQUEST_LIMIT', request.id));
        return;
      }
      const receipt: Receipt = { id: request.id, fingerprint, waiting: 1 };
      receipts.set(request.id, receipt);
      try {
        switch (request.operation) {
          case 'run': {
            const { accepted, completion } = host.start(resolveHarnessInput(request.input, launchDirectory));
            reply(receipt, accepted);
            void completion.then(async ({ result, code }) => {
              closed = true;
              dropQueued();
              if (active) reject(active, 'OPERATION_UNKNOWN');
              await write({ type: 'result', runId: result.runId, result });
              done.resolve(code);
            }, done.reject);
            break;
          }
          case 'status':
            reply(receipt, host.status());
            break;
          case 'stop':
            reply(receipt, host.stop('requested'));
            break;
          case 'input':
            if (host.signal.aborted) reject(receipt, 'RUN_STOPPING');
            else {
              queue.push({ receipt, input: request.input ?? null, bytes });
              bytesQueued += bytes;
              void pump();
            }
            break;
        }
      } catch (error) {
        reject(receipt, failureCode(error, 'INVALID_REQUEST'));
      }
    } catch (error) {
      void write(errorRecord(failureCode(error, 'INVALID_REQUEST'), requestId));
    }
  }

  const framed = boundedLines(() => void write(errorRecord('INVALID_REQUEST')));
  const lines = createInterface({ input: framed, crlfDelay: Infinity });
  const ended = () => host.stop('input-ended');
  const failed = () => host.stop('input-failed');
  lines.on('line', onLine);
  lines.on('close', ended);
  lines.on('error', failed);
  input.on('error', failed);
  framed.on('error', failed);
  host.signal.addEventListener('abort', stopTransport, { once: true });
  try {
    // Queue ready before consuming input even if the peer already wrote a request.
    void write({ type: 'ready', version: 'v1', harness: host.harness, status: host.status() });
    if (host.signal.aborted) stopTransport();
    input.pipe(framed);
    return await done.promise;
  } finally {
    closed = true;
    host.signal.removeEventListener('abort', stopTransport);
    lines.off('close', ended);
    lines.close();
    input.unpipe(framed);
    input.pause();
    framed.destroy();
    lines.off('error', failed);
    input.off('error', failed);
    framed.off('error', failed);
  }
}
