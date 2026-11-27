import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
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
  assert.equal(result.trim(), 'Usage: murm setup [--mode existing|local] [--config <module>]');
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


test('doctor rejects invalid editable Runtime settings before infrastructure work', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-doctor-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sandbox = {
    lifecycleBaseUrl: 'http://127.0.0.1:1/v1',
    isolation: { disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  };
  const settings = {
    sandbox, connection: { advertiseHost: '172.17.0.1' },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } },
  };
  const filename = join(directory, 'config.mjs');
  for (const changed of [
    { ...settings, connection: { advertiseHost: '127.0.0.1' } },
    { ...settings, sandbox: { ...sandbox, isolation: { disk: { bytes: 1, inodes: 4096 } } } },
  ]) {
    await writeFile(filename, 'export default ' + JSON.stringify({ image: 'unused', ...changed }));
    const result = spawnSync(process.execPath, [cli, 'doctor', '--config', filename, '--smoke'], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.ok(report.checks.some(check => check.id === 'config.runtime' && !check.ok), result.stdout);
    assert.equal(report.smoke, undefined);
    assert.deepEqual(report.timings, []);
  }
});

test('doctor classifies invalid active model routes before allocation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-doctor-model-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'config.mjs');
  await writeFile(filename, `export default {
    image: 'unused', model: 'default', childModel: 'child',
      sandbox: { lifecycleBaseUrl: 'http://127.0.0.1:1/v1', isolation: { disk: { bytes: 67108864, inodes: 4096 } } },
      connection: { advertiseHost: '172.17.0.1' },
      models: {
        default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'https://example.com/v1/responses', headers: {} } },
        child: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'https://example.com/', headers: {} } },
      },
  }`);
  const result = spawnSync(process.execPath, [cli, 'doctor', '--config', filename], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.model.configuration, 'invalid');
  assert.ok(report.checks.some(check => check.id === 'config.models' && !check.ok));
  assert.deepEqual(report.timings, []);
});

test('doctor uses the shared lifecycle environment and requires an authenticated existing endpoint without Docker', async t => {
  const requests: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    requests.push(request.headers['open-sandbox-api-key'] as string | undefined);
    response.writeHead(requests.at(-1) === 'doctor-test-key' ? 200 : 401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ items: [] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address() as { port: number };
  const { stdout } = await promisify(execFile)(process.execPath, [cli, 'doctor'], {
    env: { PATH: '/does-not-exist', MURM_LIFECYCLE_URL: `http://127.0.0.1:${address.port}/v1`, MURM_LIFECYCLE_TOKEN: 'doctor-test-key' },
  });
  const report = JSON.parse(stdout);
  assert.equal(report.infrastructure, 'preflight-passed');
  assert.ok(requests.includes(undefined));
  assert.ok(requests.includes('doctor-test-key'));
  assert.doesNotMatch(stdout, /doctor-test-key/);
});

test('configured doctor preserves shell values while loading an adjacent environment', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-doctor-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createServer((request, response) => {
    const ready = request.headers['open-sandbox-api-key'] === 'shell-test-key';
    response.writeHead(ready ? 200 : 403, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ items: [] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address() as { port: number };
  await writeFile(join(directory, '.env'),
    `TEST_CONFIG_URL=http://127.0.0.1:${address.port}/v1\nMURM_LIFECYCLE_TOKEN=file-test-credential\n`);
  const filename = join(directory, 'config.mjs');
  await writeFile(filename, `export default {
    image: 'unused', sandbox: { lifecycleBaseUrl: process.env.TEST_CONFIG_URL },
    connection: { advertiseHost: 'localhost' },
  };`);
  const { stdout } = await promisify(execFile)(process.execPath, [cli, 'doctor', '--config', filename], {
    env: { PATH: '/does-not-exist', MURM_LIFECYCLE_URL: 'http://127.0.0.1:1/v1', MURM_LIFECYCLE_TOKEN: 'shell-test-key' },
  });
  const report = JSON.parse(stdout);
  assert.equal(report.mode, 'existing');
  assert.equal(report.infrastructure, 'preflight-passed');
  assert.equal(report.lifecycleSource, 'config');
  assert.doesNotMatch(stdout, /shell-test-key|file-test-credential/);
});

test('local setup preserves a port conflict without sending it a lifecycle key', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'murm-setup-port-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'docker'), `#!/bin/sh
case "$1" in
  context) printf '[{"Endpoints":{"docker":{"Host":"unix:///dev/null"}}}]';;
  info) printf '{"OSType":"linux","SecurityOptions":[]}';;
  network) printf '[]';;
  *) exit 1;;
esac
`, { mode: 0o700 });
  let requests = 0;
  const occupant = createServer((_request, response) => { requests++; response.end('still running'); });
  occupant.listen(0, '127.0.0.1');
  await once(occupant, 'listening');
  t.after(() => occupant.close());
  const address = occupant.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  await assert.rejects(promisify(execFile)(process.execPath, [cli, 'setup', '--mode', 'local'], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`,
      DOCKER_CONTEXT: 'test', MURM_LIFECYCLE_URL: `${url}/v1`, MURM_LIFECYCLE_TOKEN: 'local-test-credential' },
  }), error => {
    const { stdout, code } = error as { stdout: string; code: number };
    assert.equal(code, 1);
    const report = JSON.parse(stdout);
    assert.match(report.checks.find(check => !check.ok).detail, /port is already occupied/);
    assert.equal(report.smoke, undefined);
    assert.doesNotMatch(stdout, /local-test-credential/);
    return true;
  });
  assert.equal(requests, 0);
  assert.equal(await (await fetch(url)).text(), 'still running');
});
