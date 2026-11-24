import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';

const failureCode = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'HOST_COMMAND_FAILED';
const fail = code => Object.assign(new Error(code), { code });

// Keep at most one bounded unfinished line before readline performs UTF-8 decoding.
function boundedLines(oversized) {
  let fragments = [], bytes = 0, discarding = false, skipLf = false;
  const reset = () => { fragments = []; bytes = 0; };
  return new Transform({
    transform(chunk, encoding, callback) {
      let start = 0;
      if (skipLf && chunk[0] === 10) start = 1;
      skipLf = false;
      while (start < chunk.length) {
        const cr = chunk.indexOf(13, start), lf = chunk.indexOf(10, start);
        const end = cr < 0 ? lf : lf < 0 ? cr : Math.min(cr, lf);
        const part = chunk.subarray(start, end < 0 ? chunk.length : end);
        if (!discarding) {
          if (bytes + part.length > 65536) { reset(); discarding = true; oversized(); }
          else { fragments.push(Buffer.from(part)); bytes += part.length; }
        }
        if (end < 0) break;
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
    flush(callback) {
      if (!discarding && bytes) this.push(Buffer.concat(fragments, bytes));
      reset(); callback();
    },
  });
}

/** Ordinary commands are serial; stop seals admission even during an active command. */
export async function runForegroundCommands(host, { input = process.stdin, output = process.stdout } = {}) {
  const status = await host.status();
  if (host.signal.aborted) return { reason: 'host-stop' };
  const framed = boundedLines(() => {
    if (!sealed && !host.signal.aborted) reportError(undefined, fail('HOST_COMMAND_INVALID'));
  });
  const lines = createInterface({ input: framed, crlfDelay: Infinity });
  const write = value => {
    pendingWrites++;
    try { output.write(`${JSON.stringify(value)}\n`, error => {
      pendingWrites--;
      if (error) outputFailed();
      else if (finishReason) settle();
    }); } catch { pendingWrites--; outputFailed(); }
  };
  const done = Promise.withResolvers();
  const queue = [];
  let sealed = false, ended = false, active = false, queuedBytes = 0, streamFailure, pendingWrites = 0, finishReason;
  const settle = () => { if (!pendingWrites && !streamFailure) done.resolve({ reason: finishReason }); };
  const finish = reason => { sealed = true; queue.length = 0; queuedBytes = 0; finishReason = reason; lines.close(); input.pause(); settle(); };
  const abort = () => finish('host-stop');
  const streamFailed = code => {
    streamFailure ??= fail(code);
    sealed = true; queue.length = 0; queuedBytes = 0;
    lines.close(); input.pause(); done.reject(streamFailure);
  };
  const inputFailed = () => streamFailed('HOST_INPUT_FAILED');
  const outputFailed = () => streamFailed('HOST_OUTPUT_FAILED');
  const reportError = (command, error) => write({ type: 'error', ...(typeof command?.id === 'string' && command.id.length <= 128 ? { id: command.id } : {}), code: failureCode(error) });
  async function pump() {
    if (active || sealed) return;
    active = true;
    try {
      while (!sealed && queue.length) {
        const { command, bytes } = queue.shift(); queuedBytes -= bytes;
        try {
          let result;
          if (command.operation === 'status') result = await host.status();
          else {
            if (typeof host[command.operation] !== 'function') throw fail('HOST_OPERATION_UNAVAILABLE');
            result = await host[command.operation](command.input ?? {});
          }
          if (!sealed && !host.signal.aborted) write({ type: 'reply', id: command.id, result });
        } catch (error) { if (!sealed && !host.signal.aborted) reportError(command, error); }
      }
    } finally { active = false; if (ended && !sealed) finish('input-ended'); }
  }
  const admit = line => {
    if (sealed || host.signal.aborted) return;
    let command;
    try {
      const bytes = Buffer.byteLength(line);
      if (bytes > 65536) throw fail('HOST_COMMAND_INVALID');
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
    } catch (error) { if (!sealed && !host.signal.aborted) reportError(command, error); }
  };
  output.on('error', outputFailed);
  input.on('error', inputFailed);
  framed.on('error', inputFailed);
  lines.on('error', inputFailed);
  lines.on('line', admit);
  lines.on('close', () => { ended = true; if (!active && !sealed) finish('input-ended'); });
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
