import { createInterface } from 'node:readline';

const failureCode = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'HOST_COMMAND_FAILED';

/** Commands belong to this foreground process and use the active mode handle. */
export async function runForegroundCommands(host, { input = process.stdin, output = process.stdout } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const write = value => output.write(`${JSON.stringify(value)}\n`);
  const abort = () => lines.close();
  host.signal.addEventListener('abort', abort, { once: true });
  if (host.signal.aborted) lines.close();
  try {
    if (host.signal.aborted) return { reason: 'host-stop' };
    write({ type: 'ready', status: host.status() });
    for await (const line of lines) {
      if (host.signal.aborted) break;
      let command;
      try {
        if (Buffer.byteLength(line) > 65536) throw Object.assign(new Error(), { code: 'HOST_COMMAND_INVALID' });
        command = JSON.parse(line);
        if (!command || typeof command !== 'object' || Array.isArray(command) ||
            typeof command.id !== 'string' || !command.id || command.id.length > 128 ||
            !['status', 'kickoff', 'input', 'wait', 'stop'].includes(command.operation)) throw Object.assign(new Error(), { code: 'HOST_COMMAND_INVALID' });
        let result;
        if (command.operation === 'status') result = host.status();
        else if (command.operation === 'stop') result = host.stop();
        else {
          if (typeof host[command.operation] !== 'function') throw Object.assign(new Error(), { code: 'HOST_OPERATION_UNAVAILABLE' });
          result = await host[command.operation](command.input ?? {});
        }
        if (host.signal.aborted && command.operation !== 'stop') break;
        write({ type: 'reply', id: command.id, result });
        if (command.operation === 'stop') break;
      } catch (error) {
        if (host.signal.aborted) break;
        write({ type: 'error', ...(typeof command?.id === 'string' && command.id.length <= 128 ? { id: command.id } : {}), code: failureCode(error) });
      }
    }
    return { reason: host.signal.aborted ? 'host-stop' : 'input-ended' };
  } finally { host.signal.removeEventListener('abort', abort); lines.close(); host.stop(); }
}
