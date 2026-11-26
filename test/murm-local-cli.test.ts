import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/murm.js', import.meta.url));
const setup = fileURLToPath(new URL('../../scripts/setup', import.meta.url));

test('the host bin and checkout entry advertise the same setup command', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.bin.murm, 'dist/scripts/murm.js');
  assert.equal(manifest.bin.swarm, 'dist/scripts/swarm.js');
  const result = execFileSync(process.execPath, [cli, 'setup', '--help'], { encoding: 'utf8' });
  assert.equal(result.trim(), 'Usage: murm setup');
  assert.equal(execFileSync(setup, ['--help'], { encoding: 'utf8' }), result);
});

test('setup rejects project options at both entry points', () => {
  const args = ['--template', 'subagents', '--dir', '/does-not-exist'];
  for (const [exe, run] of [[process.execPath, [cli, 'setup', ...args]], [setup, args]]) {
    const result = spawnSync(exe, run, { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: murm setup/);
  }
});

test('bare murm executes the current project entry in interactive mode', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-interactive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(join(directory, 'config.js'), 'export default {};');
  await writeFile(join(directory, 'main.js'), 'console.log(JSON.stringify(process.argv.slice(2)));');
  const absent = spawnSync(process.execPath, [cli], { cwd: directory, encoding: 'utf8' });
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /murm init/);
  await mkdir(join(directory, '.murm'));
  await writeFile(join(directory, '.murm/installed.json'), '{}');
  const active = spawnSync(process.execPath, [cli], { cwd: directory, encoding: 'utf8' });
  assert.equal(active.status, 0, active.stderr);
  assert.deepEqual(JSON.parse(active.stdout), [join(directory, 'config.js'), '--interactive']);
});

test('murm rejects an invalid argument before loading developer configuration', () => {
  const result = spawnSync(process.execPath, [cli, 'doctor', '--config', '/does-not-exist', '--unknown'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: murm doctor/);
});


test('doctor rejects invalid editable backend settings before infrastructure work', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-doctor-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backend = {
    sandbox: { lifecycleBaseUrl: 'http://127.0.0.1:1/v1' },
    bridge: { host: '0.0.0.0', publicUrl: 'http://172.17.0.1:{port}' },
    modelGateway: { host: '0.0.0.0', advertiseHost: '172.17.0.1' },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: '', headers: {} } } },
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  };
  const filename = join(directory, 'config.mjs');
  for (const changed of [
    { ...backend, bridge: { ...backend.bridge, publicUrl: 'http://127.0.0.1:{port}' } },
    { ...backend, isolation: { ...backend.isolation, disk: { bytes: 1, inodes: 4096 } } },
  ]) {
    await writeFile(filename, 'export default ' + JSON.stringify({ image: 'unused', backend: changed }));
    const result = spawnSync(process.execPath, [cli, 'doctor', '--config', filename, '--smoke'], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.ok(report.checks.some(check => check.id === 'config.backend' && !check.ok), result.stdout);
    assert.equal(report.smoke, undefined);
    assert.deepEqual(report.timings, []);
  }
});

test('doctor classifies invalid active model routes before allocation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-doctor-model-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'config.mjs');
  await writeFile(filename, `export default {
    image: 'unused', model: 'default', childModel: 'child', backend: {
      sandbox: { lifecycleBaseUrl: 'http://127.0.0.1:1/v1' },
      bridge: { host: '0.0.0.0', publicUrl: 'http://172.17.0.1:{port}' },
      modelGateway: { host: '0.0.0.0', advertiseHost: '172.17.0.1' },
      models: {
        default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'https://example.com/v1/responses', headers: {} } },
        child: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'https://example.com/', headers: {} } },
      },
      isolation: { network: 'local-docker', disk: { bytes: 67108864, inodes: 4096 } },
    }
  }`);
  const result = spawnSync(process.execPath, [cli, 'doctor', '--config', filename], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.model.configuration, 'invalid');
  assert.ok(report.checks.some(check => check.id === 'config.models' && !check.ok));
  assert.deepEqual(report.timings, []);
});
