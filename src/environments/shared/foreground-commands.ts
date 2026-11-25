import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';

const failureCode = (error: any) => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'HOST_COMMAND_FAILED';
const fail = (code: any) => Object.assign(new Error(code), { code });
const MAX_COMMAND_BYTES = 65536;

// Keep at most one bounded unfinished line before readline performs UTF-8 decoding.
function boundedLines(oversized: any) {
  let fragments: any[] = [], bytes = 0, discarding = false, skipLf = false;
  const reset = () => { fragments = []; bytes = 0; };
  return new Transform({
    transform(chunk: any, encoding: any, callback: any) {
      let start = 0;
      if (skipLf && chunk[0] === 10) start = 1;
      skipLf = false;
      while (start < chunk.length) {
        let end = start;
        while (end < chunk.length && chunk[end] !== 13 && chunk[end] !== 10) end++;
        const part = chunk.subarray(start, end);
        if (!discarding) {
          if (bytes + part.length > MAX_COMMAND_BYTES) { reset(); discarding = true; oversized(); }
          else { fragments.push(Buffer.from(part)); bytes += part.length; }
        }
        if (end === chunk.length) break;
        if (!discarding) { this.push(Buffer.concat(fragments, bytes)); this.push('\n'); }
        reset(); discarding = false;
        start = end + 1;
        if (chunk[end] === 13) {
          if (chunk[start] === 10) start++;
          else if (start === chunk.length) skipLf = true;
        }
      }
      callback();
    },
    flush(callback: any) {
      if (!discarding && bytes) this.push(Buffer.concat(fragments, bytes));
      reset(); callback();
    },
  });
}

/** Ordinary commands are serial; stop seals admission even during an active command. */
export async function runForegroundCommands(host: any, { input = process.stdin, output = process.stdout, keepOpenOnEof = false }: any = {}) {
  const status = await host.status();
  if (host.signal.aborted) return { reason: 'host-stop' };
  const framed = boundedLines(() => {
    if (!sealed && !host.signal.aborted) reportError(undefined, fail('HOST_COMMAND_INVALID'));
  });
  const lines = createInterface({ input: framed, crlfDelay: Infinity });
  const write = (value: any) => {
    pendingWrites++;
    try { output.write(`${JSON.stringify(value)}\n`, (error: any) => {
      pendingWrites--;
      if (error) outputFailed();
      else if (finishReason) settle();
    }); } catch { pendingWrites--; outputFailed(); }
  };
  const done = Promise.withResolvers();
  const queue: any[] = [];
  let sealed = false, ended = false, active = false, queuedBytes = 0, streamFailure: any, pendingWrites = 0, finishReason: any;
  const settle = () => { if (!pendingWrites && !streamFailure) done.resolve({ reason: finishReason }); };
  const finish = (reason: any) => { sealed = true; queue.length = 0; queuedBytes = 0; finishReason = reason; lines.close(); input.pause(); settle(); };
  const abort = () => finish('host-stop');
  const streamFailed = (code: any) => {
    streamFailure ??= fail(code);
    sealed = true; queue.length = 0; queuedBytes = 0;
    lines.close(); input.pause(); done.reject(streamFailure);
  };
  const inputFailed = () => streamFailed('HOST_INPUT_FAILED');
  const outputFailed = () => streamFailed('HOST_OUTPUT_FAILED');
  const reportError = (command: any, error: any) => write({ type: 'error', ...(typeof command?.id === 'string' && command.id.length <= 128 ? { id: command.id } : {}), code: failureCode(error) });
  async function pump() {
    if (active || sealed) return;
    active = true;
    try {
      while (!sealed && queue.length) {
        const { command, bytes } = queue.shift(); queuedBytes -= bytes;
        try {
          let result: any;
          if (command.operation === 'status') result = await host.status();
          else {
            if (typeof host[command.operation] !== 'function') throw fail('HOST_OPERATION_UNAVAILABLE');
            result = await host[command.operation](command.input ?? {});
          }
          if (!sealed && !host.signal.aborted) write({ type: 'reply', id: command.id, result });
        } catch (error: any) { if (!sealed && !host.signal.aborted) reportError(command, error); }
      }
    } finally { active = false; if (ended && !sealed && !keepOpenOnEof) finish('input-ended'); }
  }
  const admit = (line: any) => {
    if (sealed || host.signal.aborted) return;
    let command: any;
    try {
      const bytes = Buffer.byteLength(line);
      if (bytes > MAX_COMMAND_BYTES) throw fail('HOST_COMMAND_INVALID');
      command = JSON.parse(line);
      if (!command || typeof command !== 'object' || Array.isArray(command) ||
          typeof command.id !== 'string' || !command.id || command.id.length > 128 ||
          !['status', 'kickoff', 'input', 'wait', 'stop'].includes(command.operation)) throw fail('HOST_COMMAND_INVALID');
      if (command.operation === 'stop') {
        // Seal first, then acknowledge synchronously before abort can complete the host.
        sealed = true; queue.length = 0; queuedBytes = 0;
        const result = host.stop();
        write({ type: 'reply', id: command.id, result });
        finish('host-stop');
        return;
      }
      if (queue.length >= 64 || queuedBytes + bytes > 262144) throw fail('HOST_COMMAND_LIMIT');
      queue.push({ command, bytes }); queuedBytes += bytes;
      void pump().catch(done.reject);
    } catch (error: any) { if (!sealed && !host.signal.aborted) reportError(command, error); }
  };
  output.on('error', outputFailed);
  input.on('error', inputFailed);
  framed.on('error', inputFailed);
  lines.on('error', inputFailed);
  lines.on('line', admit);
  lines.on('close', () => { ended = true; if (!active && !sealed && !keepOpenOnEof) finish('input-ended'); });
  host.signal.addEventListener('abort', abort, { once: true });
  input.pipe(framed);
  try {
    if (host.signal.aborted) abort();
    else write({ type: 'ready', status });
    return await done.promise;
  } finally {
    sealed = true; host.signal.removeEventListener('abort', abort);
    lines.removeListener('line', admit); lines.close();
    input.unpipe(framed); framed.destroy();
    output.removeListener('error', outputFailed);
    input.removeListener('error', inputFailed); framed.removeListener('error', inputFailed); lines.removeListener('error', inputFailed);
    // A rejected interaction must reach the enclosing host before it stops.
    if (!streamFailure) host.stop();
  }
}
