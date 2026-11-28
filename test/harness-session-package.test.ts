import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { execute, preparePackageArchive } from './fixtures/notes-installed-package.js';

test('one external custom Harness uses the exact candidate SDK, RPC and text clients through package-root imports', { timeout: 180_000 }, async t => {
  const directory = await mkdtemp('/tmp/murm-session-installed-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.ok(relative(await realpath(join(import.meta.dirname, '../..')), await realpath(directory)).startsWith('..'));
  const { archive } = await preparePackageArchive(directory);
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  const env = { ...process.env }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
  await execute('tar', ['-xzf', archive, 'package/examples/harness-session'], { cwd: directory, timeout: 15_000 });
  const example = join(directory, 'package/examples/harness-session');
  env.PATH = join(example, 'node_modules/.bin') + ':' + env.PATH;
  await execute('npm', ['install', '--offline', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', archive], { cwd: example, env, timeout: 60_000 });
  assert.equal((await lstat(join(example, 'node_modules/@luna-shi/murm'))).isSymbolicLink(), false);
  await execute('npm', ['run', 'check'], { cwd: example, env, timeout: 30_000 });
  await execute('npm', ['run', 'build'], { cwd: example, env, timeout: 30_000 });
  const project = join(directory, 'project');
  await mkdir(project);
  await writeFile(join(project, 'seed.txt'), 'external-candidate-' + sha256);
  const results = [];
  for (const client of ['sdk', 'rpc']) {
    const execution = await execute(process.execPath, [join(example, 'dist', client + '.js'), project, 'Exercise the installed ' + client + ' contract'], { cwd: example, env, timeout: 20_000 });
    const result = JSON.parse(execution.stdout.trim());
    assert.equal(result.harness.id, 'session-example');
    assert.equal(result.cleanup.status, 'complete');
    assert.equal(result.export.status, 'complete');
    assert.deepEqual(result.result.answers, ['SDK and RPC', true]);
    assert.deepEqual(result.result.inputs, ['A subsequent input']);
    assert.equal(result.questions.length, 2);
    assert.ok(result.questions.every(question => question.status === 'answered'));
    const manifest = JSON.parse(await readFile(result.initial.manifestPath, 'utf8'));
    assert.equal(manifest[0].sha256, createHash('sha256').update(await readFile(join(project, 'seed.txt'))).digest('hex'));
    assert.deepEqual(JSON.parse(await readFile(result.artifacts[0].path, 'utf8')).answers, result.result.answers);
    results.push(result);
  }
  assert.equal(results[0].initial.digest, results[1].initial.digest);

  const child = spawn(process.execPath, [join(example, 'dist/terminal.js'), project, 'Exercise the installed text client'], { cwd: example, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Set<string>();
  const output: any[] = [];
  let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  lines.on('line', line => {
    let record;
    try { record = JSON.parse(line); } catch { return; }
    output.push(record);
    if (record.questionId && record.status === 'pending') pending.add(record.questionId);
    if (pending.has('name') && pending.has('confirm')) {
      pending.clear();
      child.stdin.write('/answer name "Terminal"\n/answer confirm true\nTerminal input\n/stop\n');
    }
  });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  const timer = setTimeout(() => child.kill('SIGTERM'), 15_000);
  try { assert.equal(await exited, 0, stderr); } finally { clearTimeout(timer); lines.close(); child.stdin.end(); }
  const terminalResult = output.find(record => record.harness?.id === 'session-example' && record.cleanup);
  assert.deepEqual(terminalResult?.result.answers, ['Terminal', true]);
  assert.deepEqual(terminalResult?.result.inputs, ['Terminal input']);
  assert.equal(terminalResult.cleanup.status, 'complete');
});
