import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { createHarnessSession, HarnessRpcClient } from '@luna-shi/murm';
import firstHarness from './harness.js';

const rpc = process.argv[2] === '--rpc';
const [cwd = process.cwd(), prompt = 'Prepare a release handoff.'] = process.argv.slice(rpc ? 3 : 2);
const file = fileURLToPath(new URL('./harness.js', import.meta.url));
const child = rpc ? spawn('murm', ['--harness', file, '--mode', 'rpc', '--interaction', 'questions'],
  { stdio: ['pipe', 'pipe', 'inherit'] }) : undefined;
const session = child ? new HarnessRpcClient(child) : createHarnessSession(firstHarness, { clientCapabilities: { questions: true } });
const terminal = createInterface({ input: process.stdin, output: process.stderr });
const stop = (reason: string) => { void session.stop({ requestId: randomUUID(), reason }).catch(() => {}); };
const interrupt = () => stop('SIGINT');
const terminate = () => stop('SIGTERM');
const eof = () => stop('input-ended');
const unsubscribe = session.onEvent(async event => {
  if (event.type !== 'question' || event.question.status !== 'pending') return;
  try {
    const answer = await terminal.question(`${event.question.text}\nRelease channel: `);
    await session.respond(event.question.questionId, answer, { requestId: randomUUID() });
  } catch { stop('answer-failed'); }
}, { onError: () => stop('observation-failed') });

terminal.on('close', eof);
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);
try {
  if (session instanceof HarnessRpcClient) await session.ready;
  await session.start({ cwd, prompt }, { requestId: 'start' });
  const result = (await session.completion)!;
  console.log(JSON.stringify(result, null, 2));
  if (result.outcome !== 'completed' || result.export?.status !== 'complete' || result.cleanup.status !== 'complete' || result.reportSaveFailure) process.exitCode = 1;
} finally {
  unsubscribe();
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', terminate);
  terminal.off('close', eof);
  terminal.close();
  child?.stdin.end();
}
