import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createHarnessSession, type HarnessJson } from '@luna-shi/murm';
import subagents from './project.js';
import { runSubagentsHarness, type Config, type SubagentsRun } from './business.js';

export { createSubagentsHarness, runSubagentsHarness } from './business.js';

async function readInteraction(env: SubagentsRun, signal: AbortSignal) {
  const input = createInterface({ input: process.stdin, terminal: false });
  const done = () => input.close();
  let rootFailure: unknown;
  const showReply: Parameters<SubagentsRun['onReply']>[0] = reply => {
    if (reply.type === 'settled' && reply.output) process.stdout.write(`${reply.output}\n`);
    if (reply.type === 'exit' || (reply.type === 'settled' && reply.outcome === 'failed')) {
      rootFailure = Object.assign(new Error('Root did not complete the task'), { code: 'ROOT_FAILED', event: reply });
      done();
    }
  };
  const stopReply = env.onReply(showReply);
  const last = env.lastReply();
  if (last) showReply(last);
  if (signal.aborted) done();
  else signal.addEventListener('abort', done, { once: true });
  try {
    for await (const line of input) {
      if (line === '/exit') break;
      if (!line.trim()) continue;
      const work = line === '/status' ? env.status().then(value => { process.stdout.write(`${JSON.stringify(value)}\n`); })
        : env.input(line).then(value => { process.stderr.write(`${JSON.stringify(value)}\n`); });
      void work.catch(error => {
        process.stderr.write(`${error.code ?? 'INPUT_ERROR'}\n`);
      });
    }
  } finally {
    input.close();
    signal.removeEventListener('abort', done);
    stopReply();
  }
  if (rootFailure) throw rootFailure;
  signal.throwIfAborted();
  return { rootId: env.rootId, interaction: 'closed' };
}

async function runEditableSession(config: Config, signal: AbortSignal) {
  const terminal = createInterface({ input: process.stdin, terminal: false });
  const session = createHarnessSession(subagents, { configuration: config, lifetime: 'interactive',
    outputRoot: config.outputDir });
  let completion: typeof session.completion;
  const stop = () => {
    terminal.close();
    if (completion) void session.stop({ requestId: 'editable-host-stop', reason: 'editable-host-exit' });
  };
  const publish = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  const unsubscribe = session.onEvent(frame => {
    if (frame.type !== 'event' || !frame.event || typeof frame.event !== 'object' ||
        !('kind' in frame.event) || frame.event.kind !== 'agent') return;
    const agent = frame.event.event as { type?: string; output?: HarnessJson };
    if (agent.type === 'settled' && agent.output) process.stdout.write(String(agent.output) + '\n');
  });
  async function start(prompt: string) {
    await session.start({ cwd: process.cwd(), prompt }, { requestId: 'editable-host-start' });
    completion = session.completion;
    if (signal.aborted) stop();
    void completion?.then(() => terminal.close());
  }
  signal.addEventListener('abort', stop, { once: true });
  try {
    signal.throwIfAborted();
    if (config.goal?.trim()) await start(config.goal);
    else process.stdout.write('Enter the initial prompt. Use /status or /exit on a new line.\n');
    for await (const line of terminal) {
      if (line === '/exit') break;
      if (!line.trim()) continue;
      if (line === '/status') { publish(await session.getState()); continue; }
      if (!completion) await start(line);
      else await session.input(line, { requestId: randomUUID() }).then(publish, error => {
        console.error(error.code ?? 'INPUT_ERROR');
      });
    }
  } finally {
    stop();
    if (completion) {
      const result = await completion;
      publish(result);
      if (result.outcome !== 'completed' || result.cleanup.status !== 'complete' ||
          (result.export && result.export.status !== 'complete') || result.reportSaveFailure) process.exitCode = 1;
    }
    unsubscribe();
    signal.removeEventListener('abort', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , filename, task] = process.argv;
  if (!filename || filename === '--help') {
    process.stdout.write('Usage: node main.js <config.js> ["task" | --interactive]\n');
  } else {
    const interrupt = new AbortController();
    const stop = () => interrupt.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      const exported = (await import(pathToFileURL(resolve(filename)).href)).default;
      const config: Config = typeof exported === 'function' ? await exported() : exported;
      if (task === '--interactive') {
        await runEditableSession(config, interrupt.signal);
      } else {
        const report = await runSubagentsHarness(task ? { ...config, goal: task } : config,
          interrupt.signal, config.interactive ? readInteraction : undefined);
        process.stdout.write(`${JSON.stringify(report)}\n`);
        process.exitCode = report.businessFailure || report.cleanupFailure || report.reportSaveFailure ? 1 : 0;
      }
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }
}
