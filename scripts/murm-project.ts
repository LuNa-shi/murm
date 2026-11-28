import { captureHarnessSnapshot, createHarnessSession, failureCode, getHarnessExitCode, loadProjectHarness, stopHarnessTransport } from '../src/harness/project-harness.js';
import { resolveHarnessInput } from '../src/harness/project-input.js';
import { runProjectRpc } from '../src/harness/project-rpc.js';
import type { ProjectCommand } from './murm-arguments.js';

const builtins = {
  'lead-worker': new URL('../examples/lead-worker/project.js', import.meta.url).href,
  peermesh: new URL('../examples/peermesh/project.js', import.meta.url).href,
  notes: new URL('../examples/notes/project.js', import.meta.url).href,
  messages: new URL('../examples/messages/project.js', import.meta.url).href,
  taskpool: new URL('../examples/taskpool/project.js', import.meta.url).href,
  substrate: new URL('../examples/substrate/project.js', import.meta.url).href,
  subagents: new URL('../examples/subagents/project.js', import.meta.url).href,
};

const MAX_QUEUED_OUTPUT_BYTES = 1_048_576;
const MAX_OUTPUT_RECORD_BYTES = 8 * 1024 * 1024;
const OUTPUT_FLUSH_TIMEOUT_MS = 5_000;

interface OutputFrame {
  data: string;
  bytes: number;
  replaceableState: boolean;
  flushed: PromiseWithResolvers<void>;
}

export async function runProjectCommand(command: ProjectCommand, launchDirectory: string) {
  const stdout = process.stdout.write;
  const transport = stdout.bind(process.stdout);
  const startup = new AbortController();
  let session: ReturnType<typeof createHarnessSession> | undefined;
  let signalCode: number | undefined;
  let outputFailed = false;
  let lastWrite: Promise<void> | undefined;
  const outputQueue: OutputFrame[] = [];
  let queuedBytes = 0;
  let flushing = false;

  const signal = (name: 'SIGINT' | 'SIGTERM') => {
    if (session) stopHarnessTransport(session, name);
    if (!session || captureHarnessSnapshot(session).stopReason === name) signalCode ??= name === 'SIGINT' ? 130 : 143;
    startup.abort();
  };
  const pipeFailed = () => {
    if (outputFailed) return;
    outputFailed = true;
    for (const frame of outputQueue.splice(0)) frame.flushed.resolve();
    queuedBytes = 0;
    if (session) stopHarnessTransport(session, 'output-failed');
    startup.abort();
  };

  async function flushOutput() {
    if (flushing) return;
    flushing = true;
    try {
      for (let frame = outputQueue.shift(); frame; frame = outputQueue.shift()) {
        queuedBytes -= frame.bytes;
        let timer: NodeJS.Timeout | undefined;
        try {
          const data = frame.data;
          await new Promise<void>((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Output flush timed out')), OUTPUT_FLUSH_TIMEOUT_MS);
            transport(data, error => error ? reject(error) : resolve());
          });
        } catch {
          pipeFailed();
        } finally {
          clearTimeout(timer);
          frame.flushed.resolve();
        }
      }
    } finally {
      flushing = false;
    }
  }

  const write = (record: unknown, replaceableState = false): Promise<void> => {
    if (outputFailed) return Promise.resolve();
    let encoded: string;
    try {
      encoded = JSON.stringify(record);
    } catch {
      pipeFailed();
      return Promise.resolve();
    }
    const data = encoded + '\n';
    const bytes = Buffer.byteLength(data);
    const last = outputQueue.at(-1);
    const replace = replaceableState && last?.replaceableState ? last : undefined;
    const otherBytes = queuedBytes - (replace?.bytes ?? 0);
    if (bytes > MAX_OUTPUT_RECORD_BYTES ||
        (otherBytes > 0 && otherBytes + bytes > MAX_QUEUED_OUTPUT_BYTES)) {
      pipeFailed();
      return Promise.resolve();
    }
    // Only an unsent state with no intervening ordinary record can be replaced.
    const flushed = replace?.flushed ?? Promise.withResolvers<void>();
    const frame = { data, bytes, replaceableState, flushed };
    if (replace) outputQueue[outputQueue.length - 1] = frame;
    else outputQueue.push(frame);
    queuedBytes = otherBytes + bytes;
    lastWrite = flushed.promise;
    void flushOutput();
    return lastWrite;
  };
  const ignoreDiagnosticError = () => {};
  process.on('SIGINT', signal);
  process.on('SIGTERM', signal);
  process.stdout.on('error', pipeFailed);
  process.stderr.on('error', ignoreDiagnosticError);
  // Only the host's captured transport can write protocol output.
  process.stdout.write = process.stderr.write.bind(process.stderr);
  try {
    const config = { launchDirectory, configPath: command.configPath, outputRoot: command.outputRoot,
      lifetime: command.lifetime, clientCapabilities: { questions: command.interaction === 'questions' } };
    const stopped = Promise.withResolvers<never>();
    const abortStartup = () => stopped.reject(startup.signal.reason);
    startup.signal.addEventListener('abort', abortStartup, { once: true });
    let definition;
    try {
      definition = await Promise.race([loadProjectHarness(launchDirectory, command.harness, builtins), stopped.promise]);
      startup.signal.throwIfAborted();
    } finally {
      startup.signal.removeEventListener('abort', abortStartup);
    }
    session = createHarnessSession(definition, config);
    const input = command.mode === 'foreground'
      ? resolveHarnessInput({ cwd: command.cwd, prompt: command.prompt }, launchDirectory)
      : undefined;
    if (command.mode === 'rpc' || command.lifetime === 'interactive' || config.clientCapabilities.questions) {
      const code = await runProjectRpc(session, process.stdin, write, launchDirectory, input);
      await lastWrite;
      return signalCode ?? (outputFailed ? 1 : code);
    }
    await session.start(input!, { requestId: 'foreground-start' });
    const result = await session.completion!;
    await write({ type: 'result', runId: result.runId, result });
    return signalCode ?? (outputFailed ? 1 : getHarnessExitCode(session));
  } catch (error) {
    if (!startup.signal.aborted) {
      const code = failureCode(error, 'HARNESS_COMMAND_FAILED');
      await write({ type: 'error', code, ...(error instanceof Error ? { message: error.message } : {}) });
    }
    return signalCode ?? (outputFailed ? 1 : 2);
  } finally {
    process.stdout.write = stdout;
    process.off('SIGINT', signal);
    process.off('SIGTERM', signal);
    process.stdout.off('error', pipeFailed);
    process.stderr.off('error', ignoreDiagnosticError);
  }
}
