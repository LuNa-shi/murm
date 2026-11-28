import assert from 'node:assert/strict';
import { execPath } from 'node:process';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createHarnessSession, type Harness, type HarnessJson, type HarnessSession } from '../src/harness/project-harness.js';
import { HarnessRpcClient } from '../src/harness/project-rpc-client.js';
import { TerminalSession } from '../scripts/murm-tui-session.js';

const wait = (notify: Promise<void>, timeout = 3000) => {
  const timer = AbortSignal.timeout(timeout);
  return Promise.race([notify, new Promise<void>((_, reject) => timer.addEventListener('abort', () => reject(timer.reason)))]);
};

const definition: Harness = {
  id: 'terminal-contract', apiVersion: 1, input: true,
  async run(context) {
    const emit = (event: HarnessJson) => context.emit({ kind: 'agent', event: { type: 'session', agentId: 'root', event } });
    const complete = Promise.withResolvers<void>();
    context.registerInput(input => {
      if (input === 'complete') {
        emit({ type: 'messageEnd', messageId: 'id:message', message: { role: 'assistant', content: [{ type: 'text', text: '全角 👩‍💻 é' }] } });
        emit({ type: 'messageEnd', messageId: 'id:distinct', message: { role: 'assistant', content: [{ type: 'text', text: '全角 👩‍💻 é' }] } });
        emit({ type: 'messageEnd', messageId: 'id:hidden', message: { role: 'custom', display: false, content: 'hidden context' } });
      } else if (input === 'add') {
        emit({ type: 'textDelta', messageId: 'id:message', blockIndex: 1, delta: 'B2' });
      }
      return { status: 'queued' };
    });
    emit({ type: 'messageStart', messageId: 'id:message', role: 'assistant' });
    emit({ type: 'textDelta', messageId: 'id:message', blockIndex: 1, delta: 'B' });
    emit({ type: 'textDelta', messageId: 'id:message', blockIndex: 0, delta: 'A' });
    context.markRunning();
    context.signal.addEventListener('abort', () => complete.resolve(), { once: true });
    await complete.promise;
    return { outcome: 'cancelled', reason: 'test stop', artifacts: [], cleanup: { status: 'complete' } };
  },
};

for (const connection of ['sdk', 'rpc'] as const) {
  test('terminal reducer observes the same block, final-message and receipt identities over ' + connection, async t => {
    const work = await mkdtemp(join(tmpdir(), 'murm-tui-session-'));
    const directory = join(work, 'project');
    await mkdir(directory);
    t.after(() => rm(work, { recursive: true, force: true }));
    let session: HarnessSession;
    if (connection === 'sdk') {
      session = createHarnessSession(definition, { outputRoot: join(work, 'runs') });
    } else {
      const fixture = join(work, 'harness.mjs');
      // This deterministic contract fixture does not access any Worker.
      await writeFile(fixture, 'export default { apiVersion: 1, id: "terminal-contract", input: true, run: ' +
        definition.run.toString().replace(/^async run\(/, 'async function run(') + ' };\n');
      const child = spawn(execPath, [fileURLToPath(new URL('../scripts/murm.js', import.meta.url)), '--harness', fixture,
        '--mode', 'rpc', '--output-dir', join(work, 'runs')]);
      t.after(() => { child.kill(); });
      const client = new HarnessRpcClient(child);
      await client.ready;
      session = client;
    }
    let activity = Promise.withResolvers<void>();
    let model: TerminalSession | undefined;
    const observe = () => {
      activity.resolve();
      activity = Promise.withResolvers<void>();
    };
    async function until(ready: () => boolean) {
      const event = async () => { while (!ready()) await activity.promise; };
      await wait(event());
    }
    await session.start({ cwd: directory, prompt: 'launch' }, { requestId: 'start' });
    // Attach after the first two blocks to exercise the snapshot cut.
    const started = new TerminalSession(session, observe);
    await until(() => started.state?.phase === 'running' && [...started.messages.values()].some(message => message.blocks.has(1)));
    started.close();
    model = new TerminalSession(session, observe);
    t.after(() => model?.close());
    await until(() => model!.state?.phase === 'running' && [...model!.messages.values()].some(message => message.blocks.has(1)));

    await model.mutate('run:root', 'add', request => session.input('add', request));
    await until(() => [...model!.messages.values()][0]?.blocks.get(1) === 'BB2');
    assert.equal([...model.messages.values()][0].blocks.get(0), 'A');
    await model.mutate('run:root', 'complete', request => session.input('complete', request));
    await until(() => model!.messages.size === 3);
    assert.deepEqual([...model.messages.values()].map(message => [message.id, message.hidden, [...message.blocks.values()].join('')]), [
      ['id:message', false, '全角 👩‍💻 é'], ['id:distinct', false, '全角 👩‍💻 é'], ['id:hidden', true, ''],
    ]);
    await session.stop({ requestId: 'stop' });
    const result = await session.completion!;
    assert.equal(result.cleanup.status, 'complete');
  });
}

test('terminal controller retries the original identity and leaves slow observations outside the mutation path', async t => {
  const waitForRun = Promise.withResolvers<void>();
  const session = createHarnessSession({ id: 'terminal-reconciliation', apiVersion: 1, async run(context) {
    context.markRunning();
    context.signal.addEventListener('abort', () => waitForRun.resolve(), { once: true });
    await waitForRun.promise;
    return { reason: 'stop', outcome: 'cancelled', artifacts: [], cleanup: { status: 'complete' } };
  } });
  const model = new TerminalSession(session, () => {});
  t.after(() => model.close());
  const slow = Promise.withResolvers<void>();
  const read = model.read('slow', () => slow.promise);
  const seen: string[] = [];
  const submit = async ({ requestId }: { requestId: string }) => {
    seen.push(requestId);
    return { status: seen.length < 3 ? 'unknown' : 'accepted' };
  };
  await model.mutate('root', 'first', submit);
  await model.mutate('root', 'changed', submit);
  const original = [...model.operations].find(([, operation]) => operation.payload === 'first')!;
  assert.equal(original[1].status, 'unknown');
  await model.retry(original[0]);
  assert.equal(seen[0], seen[2]);
  assert.notEqual(seen[0], seen[1]);
  assert.equal(model.observations.get('slow')?.pending, true);
  slow.resolve();
  await read;
});
