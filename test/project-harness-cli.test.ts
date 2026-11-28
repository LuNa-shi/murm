import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { createHarnessSession, HarnessRpcClient } from '@luna-shi/murm';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../scripts/murm.js', import.meta.url));

function rpcClient(t, cwd, args) {
  const child = spawn(process.execPath, [cli, ...args], { cwd, stdio: 'pipe' });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const exit = once(child, 'close');
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
  const record = async () => {
    const next = await lines.next();
    assert.ok(!next.done, `RPC closed before the next record: ${stderr}`);
    return JSON.parse(next.value);
  };
  return {
    child, exit, record, stderr: () => stderr,
    send: value => child.stdin.write(JSON.stringify(value) + '\n'),
    async take(predicate) {
      for (;;) {
        const message = await record();
        if (predicate(message)) return message;
      }
    },
  };
}

test('the project CLI launches external ESM with the requested prompt and actual project bytes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-project-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const launcher = join(directory, 'launcher');
  const project = join(directory, 'project');
  const output = join(project, 'runs');
  await Promise.all([mkdir(launcher), mkdir(project), mkdir(join(directory, 'modules'))]);
  await writeFile(join(project, '.settings'), 'hidden\n');
  await writeFile(join(project, 'run'), Buffer.from([0, 255]));
  await chmod(join(project, 'run'), 0o755);
  await writeFile(join(directory, 'modules', 'asset.txt'), 'from module\n');
  await writeFile(join(directory, 'modules', 'harness.mjs'), `
    import { readFile } from 'node:fs/promises';
    export default { id: 'project-probe', apiVersion: 1, async run(context) {
      const { input, initial, markRunning } = context;
      markRunning();
      return {
        outcome: 'completed', reason: 'probe-completed',
        result: { cwd: input.cwd, prompt: input.prompt, caller: process.cwd(),
          moduleAsset: await readFile(new URL('./asset.txt', import.meta.url), 'utf8'),
          files: initial.files },
        artifacts: [], cleanup: { status: 'complete' },
      };
    } };
  `);
  const { stdout } = await execute(process.execPath, [
    cli, '--harness', '../modules/harness.mjs', '--cwd', '../project',
    '--prompt', '  \u68c0\u67e5\u9879\u76ee  ', '--output-dir', '../project/runs',
  ], { cwd: launcher, timeout: 10_000 });
  const record = JSON.parse(stdout);
  assert.equal(record.type, 'result');
  assert.equal(record.result.harness.id, 'project-probe');
  assert.equal(record.result.outcome, 'completed');
  assert.deepEqual(record.result.result, {
    cwd: project, prompt: '  \u68c0\u67e5\u9879\u76ee  ', caller: launcher, moduleAsset: 'from module\n',
    files: {
      '.settings': { encoding: 'base64', data: 'aGlkZGVuCg==', mode: 0o644 },
      run: { encoding: 'base64', data: 'AP8=', mode: 0o755 },
    },
  });
  assert.match(record.result.initial.digest, /^complete:sha256:[a-f0-9]{64}$/);
  const manifest = JSON.parse(await readFile(record.result.initial.manifestPath, 'utf8'));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(manifest, [
    { path: '.settings', mode: 0o644, bytes: 7, sha256: hash('hidden\n') },
    { path: 'run', mode: 0o755, bytes: 2, sha256: hash(Buffer.from([0, 255])) },
  ]);
  assert.ok(record.result.reportPath.startsWith(output + '/'));
  assert.deepEqual(JSON.parse(await readFile(record.result.reportPath, 'utf8')).result, record.result.result);
  assert.equal((await readdir(join(output, record.runId))).some(name => name.startsWith('.initial-files-')), false);
  assert.equal(await readFile(record.result.prompt.path, 'utf8'), '  \u68c0\u67e5\u9879\u76ee  ');
});

test('RPC acknowledges one Run, keeps control available during input and saves actual stop receipts', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-project-rpc-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'work');
  await mkdir(project);
  await writeFile(join(project, 'seed.txt'), 'first version\n');
  await writeFile(join(directory, 'harness.mjs'), `
    import { setTimeout } from 'node:timers/promises';
    console.log('module diagnostic');
    export default { id: 'rpc-probe', apiVersion: 1, input: true, async run(context) {
      const { signal, registerInput, markRunning, initial, emit } = context;
      let admitted = 0;
      registerInput(async (payload, { requestId }) => {
        admitted++;
        emit({ kind: 'input-started' });
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        return { status: 'unknown', requestId, payload };
      });
      markRunning();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      await setTimeout(30);
      return { outcome: 'cancelled', reason: 'requested', artifacts: [],
        result: { admitted, seed: initial.files['seed.txt'].data }, cleanup: { status: 'complete' } };
    } };
  `);
  const client = rpcClient(t, directory, ['--harness', './harness.mjs', '--mode', 'rpc', '--output-dir', './results']);
  assert.deepEqual((await client.record()).harness, { id: 'rpc-probe', apiVersion: 1 });
  client.send({ id: 'start', operation: 'run', input: { cwd: './work', prompt: 'Read the seed' } });
  const acknowledged = await client.record();
  assert.equal(acknowledged.type, 'reply');
  assert.equal(acknowledged.result.phase, 'starting');
  const runId = acknowledged.runId;
  client.send({ id: 'start', operation: 'run', input: { prompt: 'Read the seed', cwd: './work' } });
  assert.deepEqual(await client.take(message => message.id === 'start'), acknowledged);
  assert.equal((await client.take(message => message.event?.phase === 'running')).runId, runId);

  await writeFile(join(project, 'seed.txt'), 'second version\n');
  client.send({ id: 'i1', operation: 'input', input: { text: 'extra' } });
  await client.take(message => message.event?.kind === 'input-started');
  client.send({ id: 'i1', operation: 'input', input: { text: 'different' } });
  assert.equal((await client.take(message => message.id === 'i1')).code, 'REQUEST_ID_CONFLICT');
  client.send({ id: 'i1', operation: 'input', input: { text: 'extra' } });
  client.send({ id: 'i2', operation: 'input', input: { text: 'queued' } });
  client.send({ id: 'status', operation: 'status' });
  assert.equal((await client.take(message => message.id === 'status')).result.phase, 'running');
  client.send({ id: 'stop', operation: 'stop' });
  assert.equal((await client.take(message => message.id === 'stop')).result.phase, 'stopping');
  assert.equal((await client.take(message => message.id === 'i2')).code, 'RUN_STOPPING');
  const unknown = await client.take(message => message.id === 'i1');
  assert.equal(unknown.result.status, 'unknown');
  assert.equal(unknown.result.requestId, 'i1');
  assert.deepEqual(await client.take(message => message.id === 'i1'), unknown);
  const final = await client.take(message => message.type === 'result');
  assert.deepEqual(final.result.result, { admitted: 1, seed: 'Zmlyc3QgdmVyc2lvbgo=' });
  assert.equal(final.result.cleanup.status, 'complete');
  assert.equal(final.result.stopReason, 'requested');
  assert.equal(JSON.parse(await readFile(final.result.reportPath, 'utf8')).stopReason, 'requested');
  assert.deepEqual(await client.exit, [1, null]);
  assert.match(client.stderr(), /module diagnostic/);
});

test('project capture uses the selected Git working subtree and rejects unsupported file objects', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-project-git-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  const project = join(repo, 'subdir');
  await mkdir(project, { recursive: true });
  await execute('git', ['init', '-q', repo]);
  await Promise.all([
    writeFile(join(repo, 'outside'), 'outside'),
    writeFile(join(project, '.gitignore'), 'ignored\n'),
    writeFile(join(project, 'tracked'), 'index version'),
    writeFile(join(project, 'removed'), 'index only'),
  ]);
  await execute('git', ['-C', repo, 'add', '.']);
  await Promise.all([
    writeFile(join(project, 'tracked'), 'working version'),
    writeFile(join(project, '.untracked'), 'untracked'),
    writeFile(join(project, 'ignored'), 'ignored'),
    rm(join(project, 'removed')),
  ]);
  await writeFile(join(directory, 'files.mjs'), `
    export default { id: 'files', apiVersion: 1, async run({ initial }) {
      return { outcome: 'completed', reason: 'captured', result: initial.files,
        artifacts: [], cleanup: { status: 'complete' } };
    } };
  `);
  const args = [cli, '--harness', './files.mjs', '--cwd', './repo/subdir',
    '--prompt', 'Read this subtree', '--output-dir', './results'];
  const { stdout } = await execute(process.execPath, args, { cwd: directory });
  const { result } = JSON.parse(stdout);
  assert.equal(result.initial.selection, 'git-working-tree');
  assert.deepEqual(Object.keys(result.result).sort(), ['.gitignore', '.untracked', 'tracked']);
  assert.equal(result.result.tracked.data, 'd29ya2luZyB2ZXJzaW9u');

  await symlink(join(repo, 'outside'), join(project, 'link'));
  await assert.rejects(execute(process.execPath, args, { cwd: directory }), error => {
    const { result: failed } = JSON.parse(error.stdout);
    assert.equal(error.code, 1);
    assert.equal(failed.failure.code, 'PROJECT_FILE_UNSUPPORTED');
    assert.match(failed.failure.message, /"link"/);
    assert.equal(failed.initial, null);
    assert.equal(failed.cleanup.status, 'complete');
    return true;
  });
});

test('an accepted Run stopped before startup preserves a cancellation report and prompt', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-project-early-stop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'harness.mjs'), `
    export default { id: 'never-run', apiVersion: 1, async run() {
      throw new Error('Harness entered after admission sealed');
    } };
  `);
  const client = rpcClient(t, directory, ['--harness', './harness.mjs', '--mode', 'rpc', '--output-dir', './results']);
  assert.equal((await client.record()).type, 'ready');
  const requests = [
    { id: 'bad', operation: 'other' },
    { id: 'run', operation: 'run', input: { prompt: 'Preserve this' } },
    { id: 'stop', operation: 'stop' },
  ];
  client.child.stdin.write(requests.map(value => JSON.stringify(value)).join('\n') + '\n');
  assert.equal((await client.take(value => value.code === 'INVALID_REQUEST')).id, 'bad');
  assert.equal((await client.take(value => value.id === 'run')).result.phase, 'starting');
  assert.equal((await client.take(value => value.id === 'stop')).result.phase, 'stopping');
  const { result } = await client.take(value => value.type === 'result');
  assert.equal(result.initial, null);
  assert.equal(result.stopReason, 'requested');
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.cleanup.status, 'complete');
  assert.equal(await readFile(result.prompt.path, 'utf8'), 'Preserve this');
  assert.equal(JSON.parse(await readFile(result.reportPath, 'utf8')).runId, result.runId);
  assert.deepEqual(await client.exit, [1, null]);
});

test('the installed executable resolves an import-only Harness package from a separate launch directory',
  { timeout: 120_000 }, async t => {
    const { preparePackageArchive } = await import('./fixtures/notes-installed-package.js');
    const root = await mkdtemp(join(tmpdir(), 'murm-project-package-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { archive } = await preparePackageArchive(root);
    const install = join(root, 'murm-install');
    const launcher = join(root, 'launcher');
    const project = join(root, 'project');
    const module = join(launcher, 'node_modules', 'test-harness');
    await Promise.all([mkdir(install), mkdir(project), mkdir(module, { recursive: true })]);
    await writeFile(join(install, 'package.json'), '{"private":true}');
    const env = { ...process.env };
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
    await execute('npm', ['install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', archive],
      { cwd: install, env, timeout: 60_000 });
    await writeFile(join(project, 'value.txt'), 'actual data');
    await writeFile(join(module, 'package.json'), '{"type":"module","exports":{"import":"./project.js"}}');
    await writeFile(join(module, 'project.js'), `
      export default { id: 'installed-probe', apiVersion: 1, async run({ initial, input, markRunning }) {
        markRunning();
        return { outcome: 'completed', reason: 'loaded', result: {
          data: initial.files['value.txt'].data, prompt: input.prompt,
        }, artifacts: [], cleanup: { status: 'complete' } };
      } };
    `);
    const { stdout } = await execute(join(install, 'node_modules', '.bin', 'murm'), [
      '--harness', 'test-harness', '--cwd', '../project', '--prompt', 'Use local package', '--output-dir', '../output',
    ], { cwd: launcher, env, timeout: 10_000 });
    const { result } = JSON.parse(stdout);
    assert.equal(result.harness.id, 'installed-probe');
    assert.deepEqual(result.result, { data: 'YWN0dWFsIGRhdGE=', prompt: 'Use local package' });
  });

test('EOF and SIGTERM preserve the admitted Run stop reason and saved result', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-project-transport-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'harness.mjs'), `
    export default { id: 'stop-probe', apiVersion: 1, async run({ signal, markRunning }) {
      markRunning();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return { outcome: 'cancelled', reason: 'received-stop', artifacts: [], cleanup: { status: 'complete' } };
    } };
  `);
  for (const action of ['EOF', 'SIGTERM']) {
    const client = rpcClient(t, directory, ['--harness', './harness.mjs', '--mode', 'rpc', '--output-dir', './results']);
    assert.equal((await client.record()).type, 'ready');
    client.send({ id: 'run', operation: 'run', input: { prompt: 'Wait for lifecycle stop' } });
    await client.take(value => value.id === 'run');
    await client.take(value => value.event?.phase === 'running');
    if (action === 'EOF') client.child.stdin.end();
    else assert.ok(client.child.kill('SIGTERM'));
    const { result } = await client.take(value => value.type === 'result');
    const expected = action === 'EOF' ? 'input-ended' : 'SIGTERM';
    assert.equal(result.stopReason, expected);
    assert.equal(result.cleanup.status, 'complete');
    assert.equal(JSON.parse(await readFile(result.reportPath, 'utf8')).stopReason, expected);
    assert.deepEqual(await client.exit, [action === 'EOF' ? 1 : 143, null]);
  }
});

test('team Git receives exact FileTree bytes and modes, and participant checkout preserves them', async t => {
  const { seedTeamRepository, seededCheckoutInstruction } = await import('../src/harness/project-git.js');
  const directory = await mkdtemp(join(tmpdir(), 'murm-team-git-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = join(directory, 'remote.git');
  const participant = join(directory, 'participant');
  await execute('git', ['init', '--bare', '--initial-branch=main', remote]);
  await mkdir(participant);
  await writeFile(join(participant, 'program'), Buffer.from([0, 180, 255]), { mode: 0o755 });
  await writeFile(join(participant, '.gitattributes'), 'program text eol=crlf\n');
  const files = {
    program: { encoding: 'base64', data: 'ALT/', mode: 0o755 },
    '.gitattributes': { encoding: 'utf8', data: 'program text eol=crlf\n' },
  } as const;
  const commit = await seedTeamRepository({ files, url: remote, owner: 'owner', token: 'unused' });
  assert.equal((await execute('git', ['--git-dir', remote, 'rev-parse', 'main'])).stdout.trim(), commit);
  const { stdout } = await execute('git', ['--git-dir', remote, 'ls-tree', 'main', 'program']);
  assert.match(stdout, /^100755 blob/);
  assert.deepEqual((await execute('git', ['--git-dir', remote, 'show', 'main:program'], { encoding: 'buffer' })).stdout,
    Buffer.from([0, 180, 255]));
  const checkout = /running (git init.+?)\. If/.exec(seededCheckoutInstruction)?.[1];
  assert.ok(checkout);
  await execute('sh', ['-ec', checkout], {
    cwd: participant, env: { ...process.env, RUN_REPOSITORY: remote, RUN_INITIAL_COMMIT: commit, WORK_BRANCH: 'member' },
  });
  assert.deepEqual(await readFile(join(participant, 'program')), Buffer.from([0, 180, 255]));
  assert.equal((await execute('git', ['rev-parse', 'HEAD'], { cwd: participant })).stdout.trim(), commit);
  assert.equal((await execute('git', ['branch', '--show-current'], { cwd: participant })).stdout.trim(), 'member');
});

test('broken RPC output cancels admitted work and saves the available cleanup evidence', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-project-pipe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'harness.mjs'), `
    export default { id: 'pipe-probe', apiVersion: 1, async run({ signal, markRunning, emit }) {
      const timer = setInterval(() => emit({ kind: 'probe-heartbeat' }), 20);
      markRunning();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      clearInterval(timer);
      return { outcome: 'cancelled', reason: 'observed-cancel', artifacts: [],
        cleanup: { status: 'complete', receipt: { closed: true } } };
    } };
  `);
  const output = join(directory, 'results');
  const client = rpcClient(t, directory, ['--harness', './harness.mjs', '--mode', 'rpc', '--output-dir', output]);
  await client.take(value => value.type === 'ready');
  client.send({ id: 'run', operation: 'run', input: { prompt: 'Keep running until the pipe fails' } });
  const { runId } = await client.take(value => value.id === 'run');
  await client.take(value => value.event?.phase === 'running');
  client.child.stdout.destroy();
  assert.deepEqual(await client.exit, [1, null]);
  const report = JSON.parse(await readFile(join(output, runId, 'project-run.json'), 'utf8'));
  assert.equal(report.stopReason, 'output-failed');
  assert.deepEqual(report.cleanup, { status: 'complete', receipt: { closed: true } });
});

test('startup rejection records the configuration error and zero allocated resources', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-startup-validation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project');
  await mkdir(project);
  for (const [id, setting] of [['notes', 'turnTimeoutMs: 0'], ['lead-worker', 'turnTimeoutMs: 0']]) {
    const config = join(directory, id + '.mjs');
    await writeFile(config, `export default {image:'unused', sandbox:{lifecycleBaseUrl:'http://127.0.0.1:1/v1', endpointHost:'127.0.0.1'}, models:{}, ${setting}};`);
    await assert.rejects(execute(process.execPath, [cli, '--harness', id, '--cwd', project,
      '--prompt', 'A task', '--config', config, '--output-dir', join(directory, 'output')],
    { cwd: directory, timeout: 10_000 }), error => {
      assert.equal(error.code, 2);
      const { result } = JSON.parse(error.stdout);
      assert.equal(result.reason, 'INVALID_RUN_CONFIGURATION');
      assert.equal(result.outcome, 'failed');
      assert.equal(result.cleanup.status, 'complete');
      assert.ok(!result.cleanup.pending);
      assert.match(result.reportPath, /project-run\.json$/);
      return true;
    });
  }
});

test('a non-Git chain of empty directories cannot exceed the capture depth bound', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-depth-validation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project');
  await mkdir(join(project, ...Array.from({ length: 129 }, () => 'd')), { recursive: true });
  const module = join(directory, 'harness.mjs');
  await writeFile(module, `export default {id:'unreachable',apiVersion:1,run(){throw new Error('allocating a Harness')}};`);
  await assert.rejects(execute(process.execPath, [cli, '--harness', module, '--cwd', project,
    '--prompt', 'A task', '--output-dir', join(directory, 'output')], { cwd: directory, timeout: 10_000 }), error => {
    const { result } = JSON.parse(error.stdout);
    assert.equal(result.reason, 'PROJECT_PATH_LIMIT');
    assert.match(result.failure.message, /capture depth limit/);
    assert.deepEqual(result.cleanup, { status: 'complete' });
    assert.equal(result.initial, null);
    return true;
  });
});

test('failed report persistence preserves separate business, export and cleanup facts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-project-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project');
  await mkdir(project);
  const module = join(directory, 'harness.mjs');
  await writeFile(module, `
    import { mkdir } from 'node:fs/promises';
    import { join } from 'node:path';
    export default {id:'report-fixture', apiVersion:1, async run(context) {
      context.markRunning();
      await mkdir(join(context.outputDir, 'project-run.json'));
      return {
        outcome:'completed', reason:'deadline', result:{work:'done'}, artifacts:[],
        export:{status:'failed', receipt:{code:'ARTIFACT_UNAVAILABLE'}},
        cleanup:{status:'pending', receipt:{agentId:'owned', execution:'unknown'}, pending:['owned']},
      };
    }};
  `);
  await assert.rejects(execute(process.execPath, [cli, '--harness', module, '--cwd', project,
    '--prompt', 'A task', '--output-dir', join(directory, 'output')], { cwd: directory, timeout: 10_000 }), error => {
    const { result } = JSON.parse(error.stdout);
    assert.equal(error.code, 1);
    assert.equal(result.outcome, 'completed');
    assert.equal(result.reason, 'deadline');
    assert.deepEqual(result.result, { work: 'done' });
    assert.deepEqual(result.export, { status: 'failed', receipt: { code: 'ARTIFACT_UNAVAILABLE' } });
    assert.deepEqual(result.cleanup, { status: 'pending', receipt: { agentId: 'owned', execution: 'unknown' }, pending: ['owned'] });
    assert.equal(result.reportSaveFailure.code, 'REPORT_SAVE_FAILED');
    assert.equal(result.reportPath, undefined);
    return true;
  });
});

test('large multibyte results stay complete on disk and share a bounded SDK, RPC, and foreground result', { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-project-large-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project');
  await mkdir(project);
  const module = join(directory, 'harness.mjs');
  await writeFile(module, `
    export default { id: 'large-result', apiVersion: 1, async run(context) {
      context.markRunning();
      return { outcome: 'completed', reason: 'done', result: '界'.repeat(3 * 1024 * 1024),
        artifacts: [], export: { status: 'complete' }, cleanup: { status: 'complete' } };
    }};
  `);
  const input = { cwd: project, prompt: 'A task' };
  const outputRoot = join(directory, 'runs');
  const session = createHarnessSession((await import(pathToFileURL(module).href)).default, { outputRoot });
  let sdkEvent: unknown;
  session.onEvent(event => { if (event.type === 'result') sdkEvent = event.result; });
  await session.start(input, { requestId: 'start' });
  const sdk = (await session.completion)!;
  assert.deepEqual(sdkEvent, sdk);
  assert.equal((await session.getState()).result?.outcome, 'completed');

  const rpc = rpcClient(t, directory, ['--harness', module, '--mode', 'rpc', '--output-dir', outputRoot]);
  const client = new HarnessRpcClient(rpc.child);
  await client.start(input, { requestId: 'start' });
  const rpcResult = (await client.completion)!;
  assert.deepEqual(await rpc.exit, [0, null]);

  const { stdout } = await execute(process.execPath, [cli, '--harness', module, '--cwd', project,
    '--prompt', input.prompt, '--output-dir', outputRoot], { cwd: directory });
  assert.equal(stdout.trim().split('\n').length, 1);
  const foreground = JSON.parse(stdout).result;
  for (const result of [sdk, rpcResult, foreground]) {
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 256 * 1024);
    assert.equal(result.snapshotTruncated, true);
    assert.equal(result.outcome, 'completed');
    assert.equal(result.export?.status, 'complete');
    assert.equal(result.cleanup.status, 'complete');
    assert.equal(result.reportSaveFailure, null);
    const saved = JSON.parse(await readFile(result.reportPath!, 'utf8'));
    assert.equal(saved.runId, result.runId);
    assert.equal(saved.result, '界'.repeat(3 * 1024 * 1024));
  }
});

test('startup error from a loaded module preserves unconfirmed cleanup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-project-external-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project');
  await mkdir(project);
  const module = join(directory, 'harness.mjs');
  await writeFile(module, `
    import { writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    export default {id:'startup-fixture', apiVersion:1, async run(context) {
      await writeFile(join(context.outputDir, 'allocated'), 'owned resource marker');
      throw Object.assign(new Error('Configuration rejected after allocation'), {code:'INVALID_RUN_CONFIGURATION'});
    }};
  `);
  await assert.rejects(execute(process.execPath, [cli, '--harness', module, '--cwd', project,
    '--prompt', 'A task', '--output-dir', join(directory, 'output')], { cwd: directory, timeout: 10_000 }), error => {
    const { result } = JSON.parse(error.stdout);
    assert.equal(result.reason, 'INVALID_RUN_CONFIGURATION');
    assert.equal(result.cleanup.status, 'pending');
    assert.deepEqual(result.cleanup.pending, ['harness-cleanup-unconfirmed']);
    return true;
  });
});

test('the typed RPC client uses a fresh snapshot cut and preserves Unicode input', { timeout: 10_000 }, async t => {
  const { HarnessRpcClient } = await import('@luna-shi/murm');
  const directory = await mkdtemp(join(tmpdir(), 'murm-rpc-client-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'harness.mjs'), `
    export default { id: 'client-probe', apiVersion: 1, input: true, async run(context) {
      context.registerInput(text => {
        context.updateStatus({ business: { text } });
        return { status: 'accepted', input: text };
      });
      context.markRunning();
      await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
      return { outcome: 'cancelled', reason: 'stopped', artifacts: [], cleanup: { status: 'complete' } };
    } };
  `);
  const child = spawn(process.execPath, [
    cli, '--harness', './harness.mjs', '--mode', 'rpc', '--output-dir', './results',
  ], { cwd: directory, stdio: 'pipe' });
  const exit = once(child, 'close');
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const client = new HarnessRpcClient(child);
  assert.equal((await client.ready).harness.id, 'client-probe');
  const running = Promise.withResolvers<void>();
  const detach = client.onEvent(event => {
    if (event.type === 'state' && event.state.phase === 'running') running.resolve();
  });
  await client.start({ cwd: '.', prompt: 'Start' }, { requestId: 'start' });
  await running.promise;
  const text = '检查\u2028任务\u2029结果'.repeat(1024);
  const receipt = await client.input(text, { requestId: 'first' });
  assert.equal(receipt.result.input, text);
  const events = [];
  const receivedSnapshot = Promise.withResolvers<void>();
  const unsubscribe = client.onEvent(event => {
    events.push(event);
    if (event.type === 'snapshot') receivedSnapshot.resolve();
  }, { initialSnapshot: true });
  await receivedSnapshot.promise;
  const changed = await client.input('updated', { requestId: 'second' });
  assert.equal(changed.result.input, 'updated');
  assert.equal(events[0].state.business.text, text);
  assert.ok(events.some(event => event.type === 'state' && event.state.business?.text === 'updated'));
  unsubscribe();
  detach();
  assert.equal((await client.getState()).phase, 'running');
  await client.stop({ requestId: 'stop' });
  assert.equal((await client.completion).cleanup.status, 'complete');
  assert.deepEqual(await exit, [1, null]);
});


test('the typed RPC client restores pending questions and partial output before a later event in the same chunk', async () => {
  const transport = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
  const client = new HarnessRpcClient(transport);
  const captured = { phase: 'running', questions: [{ questionId: 'question', status: 'pending' }],
    output: [{ messageId: 'message', text: 'partial', complete: false }] };
  const later = { ...captured, business: { task: 'updated' } };
  const frame = (...rows: unknown[]) => transport.stdout.write(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  transport.stdin.on('data', bytes => {
    const request = JSON.parse(bytes.toString());
    assert.equal(request.operation, 'status');
    frame(
      { type: 'event', event: {}, sessionEvent: { type: 'state', state: { phase: 'starting' } } },
      { type: 'reply', id: request.id, result: captured },
      { type: 'event', event: {}, sessionEvent: { type: 'state', state: later } },
    );
  });
  frame({ type: 'ready', version: 'v1', harness: { id: 'test', apiVersion: 1 }, descriptor: {}, status: {} });
  const events: unknown[] = [];
  const latest = Promise.withResolvers<void>();
  const unsubscribe = client.onEvent(event => {
    events.push(event);
    if (event.type === 'state') latest.resolve();
  }, { initialSnapshot: true });
  try {
    await latest.promise;
    assert.deepEqual(events, [{ type: 'snapshot', state: captured }, { type: 'state', state: later }]);
  } finally {
    unsubscribe();
    transport.emit('close');
  }
});

test('the typed RPC client reserves capacity for answers and overall stop', async () => {
  const transport = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
  const client = new HarnessRpcClient(transport);
  const received: string[] = [];
  const input = createInterface({ input: transport.stdin });
  input.on('line', line => {
    const request = JSON.parse(line);
    received.push(request.operation);
    if (request.operation !== 'status') transport.stdout.write(JSON.stringify({
      type: 'reply', id: request.id, result: { status: request.operation === 'stop' ? 'accepted' : 'answered' },
    }) + '\n');
  });
  transport.stdout.write(JSON.stringify({
    type: 'ready', version: 'v1', harness: { id: 'test', apiVersion: 1 }, descriptor: {}, status: {},
  }) + '\n');
  const pending = Array.from({ length: 256 }, () => client.getState().catch(() => undefined));
  try {
    await assert.rejects(client.getState(), { code: 'REQUEST_LIMIT' });
    assert.equal((await client.respond('question', true, { requestId: 'answer' })).status, 'answered');
    assert.equal((await client.stop({ requestId: 'stop' })).status, 'accepted');
    assert.deepEqual(received.slice(-2), ['answer', 'stop']);
  } finally {
    input.close();
    transport.emit('close');
    await Promise.all(pending);
  }
});

test('ten thousand RPC status reads can precede answering and stopping the same Run', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-query-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const module = join(directory, 'harness.mjs');
  await writeFile(module, `
    export default { id: 'status-flood', apiVersion: 1, questions: true, async run(context) {
      context.markRunning();
      await context.askUser({ requestId: 'confirm', questionId: 'confirm', kind: 'confirm', text: 'Ready?' },
        { id: 'work', signal: context.signal });
      context.updateStatus({ business: 'answered' });
      await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
      return { outcome: 'cancelled', reason: 'stopped', artifacts: [], cleanup: { status: 'complete' } };
    }};
  `);
  const transport = spawn(process.execPath, [cli, '--harness', module, '--mode', 'rpc', '--interaction', 'questions', '--output-dir', './runs'],
    { cwd: directory, stdio: 'pipe' });
  t.after(() => { if (transport.exitCode === null) transport.kill('SIGKILL'); });
  const client = new HarnessRpcClient(transport);
  const pending = Promise.withResolvers<void>();
  const answered = Promise.withResolvers<void>();
  const unsubscribe = client.onEvent(event => {
    if (event.type === 'question' && event.question.status === 'pending') pending.resolve();
    if (event.type === 'state' && event.state.business === 'answered') answered.resolve();
  });
  t.after(unsubscribe);
  await client.start({ cwd: directory, prompt: 'work' }, { requestId: 'start' });
  await pending.promise;
  for (let count = 0; count < 10_000; count++) {
    assert.equal((await client.getState()).phase, 'running');
  }
  assert.equal((await client.respond('confirm', false, { requestId: 'answer' })).status, 'answered');
  await answered.promise;
  assert.equal((await client.getState()).business, 'answered');
  assert.equal((await client.stop({ requestId: 'stop' })).status, 'accepted');
  assert.equal((await client.completion)?.cleanup.status, 'complete');
});

test('an RPC client with a blocked observer delivers control and results and signals observation overflow', async () => {
  const transport = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
  const client = new HarnessRpcClient(transport);
  const frame = (record: unknown) => transport.stdout.write(JSON.stringify(record) + '\n');
  transport.stdin.on('data', bytes => {
    const request = JSON.parse(bytes.toString());
    frame({ type: 'reply', id: request.id, result: { status: 'accepted' } });
    if (request.operation === 'stop') frame({ type: 'result', result: { outcome: 'cancelled', cleanup: { status: 'complete' } } });
  });
  frame({ type: 'ready', version: 'v1', harness: { id: 'test', apiVersion: 1 }, descriptor: {}, status: { runId: 'active' } });
  const barrier = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<Error>();
  let invoked = 0;
  const slow = client.onEvent(async () => { invoked++; await barrier.promise; }, { ...{ onError: failed.resolve } });
  let next = 0;
  const fast = client.onEvent(event => {
    if (event.type === 'event' && event.event === next) next++;
  });
  try {
    for (let index = 0; index < 10_000; index++) {
      frame({ type: 'event', event: { index }, sessionEvent: { type: 'event', runId: 'active', event: index } });
    }
    assert.equal(invoked, 1);
    assert.equal(next, 10_000);
    assert.equal((await failed.promise as Error & { code: string }).code, 'OBSERVATION_OVERFLOW');
    slow();
    barrier.resolve();
    assert.equal((await client.stop({ requestId: 'stop' })).status, 'accepted');
    assert.equal((await client.completion)?.cleanup.status, 'complete');
    assert.equal(invoked, 1);
  } finally {
    barrier.resolve(); slow(); fast(); transport.emit('close');
  }
});
