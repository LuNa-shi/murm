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

export async function runProjectCommand(command: ProjectCommand, launchDirectory: string) {
  const stdout = process.stdout.write;
  const transport = stdout.bind(process.stdout);
  const startup = new AbortController();
  let session: ReturnType<typeof createHarnessSession> | undefined;
  let signalCode: number | undefined;
  let outputFailed = false;
  let lastWrite: Promise<void> | undefined;
  let outstanding = 0;

  const signal = (name: 'SIGINT' | 'SIGTERM') => {
    if (session) stopHarnessTransport(session, name);
    if (!session || captureHarnessSnapshot(session).stopReason === name) signalCode ??= name === 'SIGINT' ? 130 : 143;
    startup.abort();
  };
  const pipeFailed = () => {
    outputFailed = true;
    if (session) stopHarnessTransport(session, 'output-failed');
    startup.abort();
  };
  const write = (record: unknown): Promise<void> => {
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
    if (bytes > 8 * 1024 * 1024 || (outstanding !== 0 && outstanding + bytes > 1_048_576)) {
      pipeFailed();
      return Promise.resolve();
    }
    outstanding += bytes;
    let timer: NodeJS.Timeout | undefined;
    lastWrite = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Output flush timed out')), 5_000);
      transport(data, error => error ? reject(error) : resolve());
    }).catch(pipeFailed).finally(() => {
      outstanding -= bytes;
      clearTimeout(timer);
    });
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
