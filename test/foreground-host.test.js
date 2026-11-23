import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { transport } from './fixtures/core-bot-service-backend.js';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return { url: new URL('./fixtures/agensh-team-backend.js', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
const { runForegroundEnvironment } = await import('../src/environments/shared/foreground-host.js');
hooks.deregister();

async function configuration(t) {
  transport.reset(); transport.collectable = true;
  const outputDir = await mkdtemp(join(tmpdir(), 'foreground-host-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const peers = ['a', 'b'].map(key => ({ key, branch: `branch-${key}`,
    gitea: { username: key, binding: `git-${key}`, accountId: key, token: `git-secret-${key}` },
    message: { binding: `mm-${key}`, accountId: key, token: `mm-secret-${key}` }, board: { binding: `board-${key}`, workerId: `worker-${key}` } }));
  return { mode: 'agensh', timeoutMs: 5000, options: { runId: 'foreground', image: 'fixture', outputDir, backend: {}, closeTimeoutMs: 1000,
    prepare: async () => ({ runId: 'foreground', repository: { owner: 'owner', name: 'repo' }, repositoryUrl: 'http://172.17.0.1:3000/owner/repo.git', channelId: 'channel', boardId: 'board', issueNumber: 1,
      endpoints: { gitea: 'http://172.17.0.1:3000', message: 'http://127.0.0.1:3001', board: 'http://127.0.0.1:3002' }, peers }),
    router: { workTimeoutMs: 5000, turnTimeoutMs: 1000, readContext: async () => 'private board context', subscribe: async () => ({ ready: true, stop: async () => {} }) } } };
}
function settle(id) {
  const submission = transport.submissions.get(id);
  transport.spawns.get(submission.botId).onEvent({ type: 'settled', outcome: 'completed', output: 'private model text' });
  transport.next = settle;
}

test('foreground host targets the existing agensh router and preserves request replay and shutdown', async t => {
  const config = await configuration(t); transport.next = settle;
  config.options.secretValues = ['worker-a'];
  let saved;
  const report = await runForegroundEnvironment(config, async host => {
    saved = host;
    const before = await host.status();
    assert.equal(before.mode, 'agensh');
    assert.deepEqual(before.peers.map(peer => peer.status), ['idle', 'idle']);
    assert.equal(before.runDirectory, join(config.options.outputDir, before.runtimeId));
    const kickoff = await host.kickoff({ recipient: 'a', input: 'initial' });
    assert.equal((await host.wait({ recipient: 'a', batchId: kickoff.batchId, timeoutMs: 1000 })).state, 'completed');
    const input = { recipient: 'a', input: 'directed feedback', requestId: 'user-event-1' };
    const first = await host.input(input);
    assert.equal((await host.wait({ recipient: 'a', batchId: first.batchId, timeoutMs: 1000 })).state, 'completed');
    assert.equal((await host.input(input)).batchId, first.batchId);
    assert.equal(transport.submissions.size, 2);
    const view = await host.status();
    assert.equal(view.peers[1].batches.length, 0);
    assert.ok(view.peers[0].cursor > before.peers[0].cursor);
    assert.ok([...transport.submissions.values()].every(row => row.mode === 'followUp'));
    assert.ok(!JSON.stringify(view).includes('private'));
    assert.deepEqual(host.stop(), { status: 'stopping' });
    await assert.rejects(host.input({ ...input, requestId: 'after-stop' }), { code: 'HOST_STOPPING' });
  });
  assert.equal(report.businessFailure, null, JSON.stringify(report));
  assert.equal(report.cleanup.cleanup, 'complete'); assert.equal(report.cleanup.bots.length, 2);
  const closed = await saved.status();
  assert.equal(closed.closing, true);
  assert.deepEqual(closed.peers.map(peer => [peer.status, peer.lastStop]), [
    ['closed', { execution: 'stopped', cleanup: 'complete' }],
    ['closed', { execution: 'stopped', cleanup: 'complete' }],
  ]);
  assert.equal(transport.submissions.size, 2);
});

test('host abort bounds an interaction that never returns and retains actual cleanup', async t => {
  const config = await configuration(t);
  const controller = new AbortController();
  const entered = Promise.withResolvers();
  const pending = runForegroundEnvironment({ ...config, signal: controller.signal }, async () => { entered.resolve(); await new Promise(() => {}); });
  await entered.promise; controller.abort();
  const report = await pending;
  assert.equal(report.cleanup.cleanup, 'complete'); assert.equal(report.cleanup.bots.length, 2);
  assert.equal(transport.submissions.size, 0);
});

test('foreground status follows Core activity and exposes only the latest error code', async t => {
  const config = await configuration(t);
  const sent = Promise.withResolvers();
  transport.next = sent.resolve;
  const report = await runForegroundEnvironment(config, async host => {
    const kickoff = await host.kickoff({ recipient: 'a', input: 'held work' });
    const { botId } = transport.submissions.get(await sent.promise);
    const backendBot = transport.spawns.get(botId);
    backendBot.onEvent({ type: 'error', error: { code: 'TRANSIENT_FAILURE', message: 'private operator detail' }, fatal: false });
    const active = await host.status();
    assert.deepEqual(active.peers.map(peer => [peer.status, peer.lastErrorCode]), [
      ['running', 'TRANSIENT_FAILURE'], ['idle', undefined],
    ]);
    assert.ok(!JSON.stringify(active).includes('private operator detail'));
    backendBot.onEvent({ type: 'settled', outcome: 'completed', output: 'private model output' });
    assert.equal((await host.wait({ recipient: 'a', batchId: kickoff.batchId, timeoutMs: 1000 })).state, 'completed');
    const idle = await host.status();
    assert.equal(idle.peers[0].status, 'idle');
    assert.ok(idle.peers[0].cursor > active.peers[0].cursor);
    assert.equal(idle.peers[0].lastErrorCode, undefined);
    assert.ok(!JSON.stringify(idle).includes('private model output'));
    host.stop();
  });
  assert.equal(report.businessFailure, null);
  assert.equal(report.cleanup.cleanup, 'complete');
});

test('flat host without production capture saves its readiness failure and admits zero Bots', async t => {
  const config = await configuration(t);
  let entered = false;
  const report = await runForegroundEnvironment({ ...config, mode: 'flat' }, async () => { entered = true; });
  assert.equal(report.businessFailure.code, 'SERVICE_NOT_READY'); assert.equal(report.cleanup, null);
  assert.equal(entered, false); assert.equal(transport.spawns.size, 0);
});

test('actual foreground CLI routes explicit peer commands and emits bounded saved close receipt', { timeout: 15_000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { createInterface } = await import('node:readline');
  const { once } = await import('node:events');
  const { readFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'foreground-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['scripts/run-environment.mjs', '--config', 'test/fixtures/foreground-host-configuration.mjs'],
    { env: { ...process.env, FOREGROUND_TEST_OUTPUT: root }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  const records = [], errors = []; child.stderr.on('data', bytes => errors.push(bytes));
  const send = (id, operation, input) => child.stdin.write(`${JSON.stringify({ id, operation, input })}\n`);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const record = JSON.parse(line); records.push(record);
    if (record.type === 'ready') {
      child.stdin.write('invalid secret payload\n');
      send('missing', 'input', { recipient: 'missing', requestId: 'not-rerouted', input: 'private direction' });
      send('kick', 'kickoff', { recipient: 'a', input: 'fixed kickoff' });
    }
    if (record.id === 'kick') send('first-done', 'wait', { recipient: 'a', batchId: record.result.batchId, timeoutMs: 1000 });
    if (record.id === 'first-done') send('feedback', 'input', { recipient: 'a', requestId: 'user-fixed', input: 'fixed direction' });
    if (record.id === 'feedback') send('second-done', 'wait', { recipient: 'a', batchId: record.result.batchId, timeoutMs: 1000 });
    if (record.id === 'second-done') send('view', 'status');
    if (record.id === 'view') send('end', 'stop');
  });
  const [exit] = await once(child, 'exit');
  assert.equal(exit, 0, Buffer.concat(errors).toString());
  assert.ok(records.some(record => record.type === 'error' && record.code === 'HOST_COMMAND_FAILED'));
  assert.ok(records.some(record => record.id === 'missing' && record.code === 'UNKNOWN_RECIPIENT'));
  assert.ok(records.some(record => record.id === 'second-done' && record.result.state === 'completed'));
  const view = records.find(record => record.id === 'view').result;
  assert.equal(view.runDirectory, join(root, view.runtimeId));
  assert.deepEqual(view.peers.map(peer => peer.status), ['idle', 'idle']);
  assert.ok(view.peers[0].cursor > 0);
  assert.equal(view.peers[0].batches.length, 2); assert.equal(view.peers[1].batches.length, 0);
  const result = records.find(record => record.type === 'result'); assert.equal(result.cleanup, 'complete'); assert.equal(result.bots.length, 2);
  assert.ok(result.bots.every(bot => bot.execution === 'stopped' && bot.cleanup === 'complete'));
  const saved = JSON.parse(await readFile(result.reportPath, 'utf8'));
  assert.equal(saved.cleanup.bots.length, 2); assert.equal(saved.cleanupFailure, null);
  const output = JSON.stringify(records);
  assert.ok(!output.includes('PRIVATE_')); assert.ok(!output.includes('private-git'));
});

test('foreground CLI records startup cancellation received while loading configuration', { timeout: 15_000 }, async t => {
  const { fork } = await import('node:child_process');
  const { once } = await import('node:events');
  const { writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'foreground-startup-')); t.after(() => rm(root, { recursive: true, force: true }));
  const configurationPath = join(root, 'loading.mjs');
  await writeFile(configurationPath, `export { default } from ${JSON.stringify(new URL('./fixtures/foreground-host-configuration.mjs', import.meta.url).href)};\nprocess.send('loading');\nawait new Promise(resolve => setTimeout(resolve, 50));\n`);
  const child = fork('scripts/run-environment.mjs', ['--config', configurationPath],
    { env: { ...process.env, FOREGROUND_TEST_OUTPUT: root }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  t.after(() => child.kill('SIGKILL'));
  const stdout = [], stderr = []; child.stdout.on('data', bytes => stdout.push(bytes)); child.stderr.on('data', bytes => stderr.push(bytes));
  const exited = once(child, 'exit');
  assert.deepEqual(await once(child, 'message'), ['loading', undefined]); child.kill('SIGINT');
  const [exit] = await exited; assert.equal(exit, 1, Buffer.concat(stderr).toString());
  const records = Buffer.concat(stdout).toString().trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, 1); assert.equal(records[0].type, 'result');
  assert.equal(records[0].businessFailureCode, 'ENVIRONMENT_START_ABORTED'); assert.equal(records[0].bots, null);
});

test('SIGTERM during an active CLI wait closes the team without replies after the final result', { timeout: 15_000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { createInterface } = await import('node:readline');
  const root = await mkdtemp(join(tmpdir(), 'foreground-active-stop-')); t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['scripts/run-environment.mjs', '--config', 'test/fixtures/foreground-host-configuration.mjs'],
    { env: { ...process.env, FOREGROUND_TEST_OUTPUT: root, FOREGROUND_TEST_HOLD: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  const records = [], stderr = []; child.stderr.on('data', value => stderr.push(value));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const record = JSON.parse(line); records.push(record);
    if (record.type === 'ready') child.stdin.write(`${JSON.stringify({ id: 'start', operation: 'kickoff', input: { recipient: 'a', input: 'hold this turn' } })}\n`);
    if (record.id === 'start') {
      child.stdin.write(`${JSON.stringify({ id: 'active-wait', operation: 'wait', input: { recipient: 'a', batchId: record.result.batchId, timeoutMs: 1000 } })}\n`);
      setTimeout(() => child.kill('SIGTERM'), 30);
    }
  });
  const [exit] = await once(child, 'exit'); assert.equal(exit, 0, Buffer.concat(stderr).toString());
  assert.equal(records.at(-1).type, 'result'); assert.equal(records.at(-1).cleanup, 'complete');
  assert.ok(!records.some(record => record.id === 'active-wait'));
  assert.ok(records.at(-1).bots.every(bot => bot.execution === 'stopped' && bot.cleanup === 'complete'));
});

test('an agensh router deadline ends foreground interaction before a longer host deadline', { timeout: 3000 }, async t => {
  const config = await configuration(t);
  config.options.router.workTimeoutMs = 40;
  const started = performance.now();
  const report = await runForegroundEnvironment(config, async () => new Promise(() => {}));
  assert.equal(report.cleanup.cleanup, 'complete');
  assert.equal(report.businessFailure?.code, 'AGENSH_TEAM_FENCED');
  assert.equal(report.businessFailure?.details?.[0]?.code, 'ROUTER_WORK_EXPIRED');
  assert.ok(performance.now() - started < 1000);
});

test('JSON-line stop overtakes an active wait, seals queued input and precedes the final CLI result', { timeout: 15_000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { createInterface } = await import('node:readline');
  const root = await mkdtemp(join(tmpdir(), 'foreground-command-stop-')); t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['scripts/run-environment.mjs', '--config', 'test/fixtures/foreground-host-configuration.mjs'],
    { env: { ...process.env, FOREGROUND_TEST_OUTPUT: root, FOREGROUND_TEST_HOLD: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  const records = [], stderr = []; child.stderr.on('data', value => stderr.push(value));
  const send = (id, operation, input) => child.stdin.write(`${JSON.stringify({ id, operation, input })}\n`);
  let stoppedAt;
  createInterface({ input: child.stdout }).on('line', line => {
    const record = JSON.parse(line); records.push(record);
    if (record.type === 'ready') send('start', 'kickoff', { recipient: 'a', input: 'hold this turn' });
    if (record.id === 'start') {
      send('waiting', 'wait', { recipient: 'a', batchId: record.result.batchId, timeoutMs: 4000 });
      setTimeout(() => {
        stoppedAt = performance.now();
        for (let index = 0; index < 70; index++) send(`overflow-${index}`, 'status');
        send('queued', 'input', { recipient: 'b', requestId: 'queued', input: 'never admitted' });
        send('end', 'stop');
        send('late', 'input', { recipient: 'b', requestId: 'late', input: 'never admitted' });
      }, 30);
    }
  });
  const [exit] = await once(child, 'exit');
  assert.equal(exit, 0, Buffer.concat(stderr).toString());
  assert.ok(performance.now() - stoppedAt < 1000);
  assert.deepEqual(records.slice(-2).map(row => row.type === 'reply' ? row.id : row.type), ['end', 'result']);
  assert.ok(!records.some(row => row.type === 'reply' && ['waiting', 'queued', 'late'].includes(row.id)));
  assert.ok(!records.some(row => row.id === 'late'));
  assert.ok(records.some(row => row.type === 'error' && row.code === 'HOST_COMMAND_LIMIT'));
  assert.ok(!records.some(row => row.type === 'reply' && row.id?.startsWith('overflow-')));
  assert.equal(records.at(-1).cleanup, 'complete');
  const saved = JSON.parse(await readFile(records.at(-1).reportPath, 'utf8'));
  assert.equal(saved.environment.peers[1].router.batches.length, 0);
});

test('source failure stays a safe team failure and host deadline stays a distinct failure', async t => {
  const config = await configuration(t);
  let failSource;
  config.options.router.subscribe = async ({ onFailure }) => { failSource = onFailure; return { ready: true, stop: async () => {} }; };
  const source = await runForegroundEnvironment(config, async () => {
    failSource({ code: 'PRIVATE_source_failure', message: 'private-git-a' });
    await new Promise(() => {});
  });
  assert.equal(source.businessFailure.code, 'AGENSH_TEAM_FENCED');
  assert.deepEqual(source.businessFailure.details, [{ code: 'AGENSH_SOURCE_FAILED' }]);
  assert.equal(source.cleanup.cleanup, 'complete');
  const deadline = await runForegroundEnvironment({ ...config, timeoutMs: 200 }, async () => new Promise(() => {}));
  assert.equal(deadline.businessFailure.code, 'HOST_WORK_TIMEOUT');
  assert.equal(deadline.cleanup.cleanup, 'complete');
});

test('CLI self-fence exits unsuccessfully and a configuration throwing null emits a safe startup error', { timeout: 15_000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'foreground-safe-failures-')); t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = new URL('./fixtures/foreground-host-configuration.mjs', import.meta.url).href;
  const fenced = join(root, 'fenced.mjs');
  await writeFile(fenced, `import config from ${JSON.stringify(fixture)};\nconfig.options.router.workTimeoutMs = 100;\nexport default config;\n`);
  for (const [path, expected, stream] of [[fenced, 'AGENSH_TEAM_FENCED', 'stdout'], [join(root, 'null.mjs'), 'HOST_START_FAILED', 'stderr']]) {
    if (stream === 'stderr') await writeFile(path, 'throw null;\n');
    const child = spawn(process.execPath, ['scripts/run-environment.mjs', '--config', path],
      { env: { ...process.env, FOREGROUND_TEST_OUTPUT: root }, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => child.kill('SIGKILL'));
    const stdout = [], stderr = []; child.stdout.on('data', bytes => stdout.push(bytes)); child.stderr.on('data', bytes => stderr.push(bytes));
    const [exit] = await once(child, 'exit'); assert.equal(exit, 1);
    const records = Buffer.concat(stream === 'stdout' ? stdout : stderr).toString().trim().split('\n').map(JSON.parse);
    assert.equal(stream === 'stdout' ? records.at(-1).businessFailureCode : records.at(-1).code, expected);
    if (stream === 'stdout') assert.equal(records.at(-1).cleanup, 'complete');
    else assert.deepEqual(records, [{ code: 'HOST_START_FAILED' }]);
  }
});

test('startup source self-fence preserves its first safe cause and actual cleanup across later subscription rejection', async t => {
  for (const rejectAfterFence of [false, true]) {
    const config = await configuration(t);
    const prepare = config.options.prepare;
    let facilityClosed = false, stopped = 0, entered = false;
    config.options.prepare = async options => {
      options.resources.own({ kind: 'facility', id: 'startup-owned', close() { facilityClosed = true; } });
      return prepare(options);
    };
    config.options.router.subscribe = async ({ onFailure }) => {
      onFailure({ code: 'EVENT_SOURCE_FAILED', message: 'private startup detail' });
      if (rejectAfterFence) throw Object.assign(new Error('private later detail'), { code: 'LATER_SUBSCRIPTION_FAILED' });
      return { ready: true, stop: async () => {} };
    };
    transport.onStop = () => { stopped++; };
    const report = await runForegroundEnvironment(config, async () => { entered = true; });
    assert.equal(report.businessFailure.code, 'AGENSH_TEAM_FENCED');
    assert.equal(report.businessFailure.cleanup, 'complete');
    assert.deepEqual(report.businessFailure.details[0], { code: 'EVENT_SOURCE_FAILED' });
    const [snapshot, receipt] = report.businessFailure.details.slice(1);
    assert.equal(snapshot.closing, true); assert.equal(snapshot.peers.length, 2);
    assert.equal(receipt.cleanup, 'complete');
    assert.ok(receipt.bots.every(bot => bot.execution === 'stopped' && bot.cleanup === 'complete'));
    assert.equal(facilityClosed, true); assert.equal(stopped, 2); assert.equal(entered, false);
    assert.equal(transport.submissions.size, 0);
    assert.ok(!JSON.stringify(report).includes('private startup detail'));
    assert.ok(!JSON.stringify(report).includes('LATER_SUBSCRIPTION_FAILED'));
  }
});
