import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
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
      const config: Config = (await import(pathToFileURL(resolve(filename)).href)).default;
      const report = await runSubagentsHarness(
        task && task !== '--interactive' ? { ...config, goal: task } : config,
        interrupt.signal, task === '--interactive' || config.interactive ? readInteraction : undefined);
      process.stdout.write(`${JSON.stringify(report)}\n`);
      process.exitCode = report.businessFailure || report.cleanupFailure || report.reportSaveFailure ? 1 : 0;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }
}
