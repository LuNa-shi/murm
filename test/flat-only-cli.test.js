import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../scripts/run-putnambench-benchmark.mjs', import.meta.url));

for (const late of [false, true]) test(`benchmark CLI handles SIGTERM ${late ? 'during aggregate output' : 'during failed observer startup'}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarm-cli-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = join(root, 'fixture');
  await mkdir(fixture);
  await writeFile(join(fixture, 'input.lean'), 'theorem fixture : True := by sorry\n');
  const git = (...args) => execFileSync('git', ['-C', fixture, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', 'input.lean');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Pin fixture');
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ putnambench_commit: git('rev-parse', 'HEAD'), problems:
    Array.from({ length: 12 }, (_, index) => ({ id: `fixture_${index}`, problem_file: 'input.lean' })) }));
  let child, healthChecks = 0;
  const server = createServer((request, response) => {
    healthChecks++;
    if (!late) child.kill('SIGTERM');
    response.statusCode = late ? 200 : 503;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ auth_version: 1, access_mode: 'loopback' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const observer = join(root, 'observer.json');
  await writeFile(observer, JSON.stringify({ host: '127.0.0.1', port: server.address().port,
    access_mode: 'loopback', database_path: join(root, 'observer.sqlite') }));
  const experiment = join(root, 'experiment'), reports = join(root, 'reports');
  const signalArguments = [];
  if (late) {
    const inject = join(root, 'inject-late-stop.mjs');
    await writeFile(inject, `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
const write = fs.writeFile;
fs.writeFile = async (path, ...args) => {
  if (path.endsWith('/aggregate-report.json')) {
    process.kill(process.pid, 'SIGTERM');
    await sleep(30);
  }
  return write(path, ...args);
};
syncBuiltinESMExports();`);
    signalArguments.push('--import', inject);
  }
  child = spawn(process.execPath, [...signalArguments, runner, '--problems', config, '--putnambench-root', fixture,
    ...(late ? [] : ['--problem', 'fixture_0']),
    '--experiment-root', root, '--experiment-dir', experiment, '--report-dir', reports, '--observability-metadata', observer],
  { env: { PATH: process.env.PATH, PI_GPT_PROXY_BASE_URL: 'http://127.0.0.1:1/v1', PI_GPT_PROXY_API_KEY: 'local-fixture' } });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code, signal] = await once(child, 'close');
  assert.equal(signal, null, stderr);
  assert.equal(code, late ? 0 : 143, stderr);
  assert.equal(healthChecks, 1);
  const aggregate = JSON.parse(await readFile(join(reports, 'aggregate-report.json')));
  const metadata = JSON.parse(await readFile(join(experiment, 'metadata', 'experiment.json')));
  assert.equal(metadata.valid_for_analysis, false);
  if (late) {
    assert.doesNotMatch(stderr, /stop_requested/);
    assert.equal(aggregate.projects.length, 12);
    assert.ok(aggregate.projects.every(project => project.stop_reason === null && project.invalid_reasons.includes('project_runner_error')));
    assert.equal(metadata.status, 'completed');
    assert.equal(metadata.stop_signal, undefined);
  } else {
    assert.match(stderr, /stop_requested/);
    assert.equal(aggregate.projects[0].stop_reason, 'operator_stop');
    assert.deepEqual(aggregate.projects[0].invalid_reasons, ['operator_stop']);
    assert.equal(metadata.status, 'operator_stopped');
    assert.equal(metadata.stop_signal, 'SIGTERM');
  }
});

test('benchmark CLI exposes one Mission Task model and rejects the removed model flags', () => {
  const help = spawnSync(process.execPath, [runner, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /--task-model|--normal-flow/);
  for (const flag of ['--task-model=legacy', '--task-model=flat', '--normal-flow']) {
    const result = spawnSync(process.execPath, [runner, flag], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, flag);
    assert.match(result.stderr, /unknown option:/, flag);
  }
});
