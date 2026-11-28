import type { Readable } from 'node:stream';

type LineHandlers = {
  line(value: string): void;
  invalid(): void;
  end(): void;
  error(error: Error): void;
};

export function readRpcLines(stream: Readable, maxBytes: number, handlers: LineHandlers) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const line = Buffer.allocUnsafe(maxBytes);
  let length = 0;
  let discarding = false;
  let attached = true;
  function data(value: Buffer | string) {
    const chunk = typeof value === 'string' ? Buffer.from(value) : value;
    for (let start = 0; attached && start < chunk.length;) {
      const lf = chunk.indexOf(10, start);
      const end = lf === -1 ? chunk.length : lf;
      const bytes = end - start;
      if (!discarding) {
        if (length + bytes > maxBytes) {
          discarding = true;
          handlers.invalid();
        } else {
          chunk.copy(line, length, start, end);
          length += bytes;
        }
      }
      if (lf === -1) return;
      if (!discarding) {
        let decoded: string | undefined;
        try { decoded = decoder.decode(line.subarray(0, length)); }
        catch { handlers.invalid(); }
        if (decoded !== undefined) handlers.line(decoded);
      }
      length = 0;
      discarding = false;
      start = lf + 1;
    }
  }
  function end() {
    if (length && !discarding) handlers.invalid();
    handlers.end();
  }
  stream.on('data', data);
  stream.once('end', end);
  stream.on('error', handlers.error);
  return () => {
    attached = false;
    stream.off('data', data);
    stream.off('end', end);
    stream.off('error', handlers.error);
  };
}
