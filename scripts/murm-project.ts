import { createProjectHost, failureCode, loadProjectHarness } from '../src/harnesses/shared/project-harness.js';
import { resolveHarnessInput } from '../src/harnesses/shared/project-input.js';
import { runProjectRpc } from '../src/harnesses/shared/project-rpc.js';
import type { ProjectCommand } from './murm-arguments.js';

const builtins = {
  'lead-worker': new URL('../examples/lead-worker/project.js', import.meta.url).href,
  peermesh: new URL('../examples/peermesh/project.js', import.meta.url).href,
  notes: new URL('../examples/notes/project.js', import.meta.url).href,
  messages: new URL('../examples/bridge-services/project.js', import.meta.url).href,
  taskpool: new URL('../examples/taskpool/project.js', import.meta.url).href,
  substrate: new URL('../examples/substrate/project.js', import.meta.url).href,
  subagents: new URL('../examples/subagents/project.js', import.meta.url).href,
};

export async function runProjectCommand(command: ProjectCommand, launchDirectory: string) {
  const stdout = process.stdout.write;
  const transport = stdout.bind(process.stdout);
  const startup = new AbortController();
  let host: ReturnType<typeof createProjectHost> | undefined;
  let signalCode: number | undefined;
  let outputFailed = false;
  let lastWrite: Promise<void> | undefined;
  let outstanding = 0;

  const signal = (name: 'SIGINT' | 'SIGTERM') => {
    if (!host || host.stop(name).stopReason === name) signalCode ??= name === 'SIGINT' ? 130 : 143;
    startup.abort();
  };
  const pipeFailed = () => {
    outputFailed = true;
    host?.stop('output-failed');
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
    if (outstanding !== 0 && outstanding + bytes > 1_048_576) {
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
    const config = { launchDirectory, configPath: command.configPath, outputRoot: command.outputRoot };
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
    if (command.mode === 'rpc') {
      host = createProjectHost(definition, config, record => void write(record));
      const code = await runProjectRpc(host, process.stdin, write, launchDirectory);
      await lastWrite;
      return signalCode ?? (outputFailed ? 1 : code);
    }
    const input = resolveHarnessInput({ cwd: command.cwd, prompt: command.prompt }, launchDirectory);
    host = createProjectHost(definition, config, () => {});
    const { result, code } = await host.start(input).completion;
    await write({ type: 'result', runId: result.runId, result });
    return signalCode ?? (outputFailed ? 1 : code);
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
  }
}
