import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { join } from 'node:path';

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startService(serviceId, port, root, endpoints = {}) {
  const endpoint = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['scripts/service-host.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SWARMENV_SERVICE_ID: serviceId,
      SWARMENV_SERVICE_ISOLATED: 'true',
      SWARMENV_SERVICE_HOST: '127.0.0.1',
      SWARMENV_SERVICE_PORT: String(port),
      SWARMENV_SERVICE_PUBLIC_URL: endpoint,
      SWARMENV_SERVICE_DATABASE: join(root, `${serviceId}.sqlite`),
      SWARMENV_SERVICE_TOKEN: 'isolated-probe-token',
      ...Object.fromEntries(Object.entries(endpoints).map(([id, url]) => [`SWARMENV_${id.toUpperCase()}_SERVICE_URL`, url])),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let errorOutput = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { errorOutput += chunk; });
  const deadline = Date.now() + 10_000;
  let manifest = null;
  while (Date.now() < deadline && !manifest) {
    try {
      const response = await fetch(`${endpoint}/healthz`);
      if (response.ok) manifest = await response.json();
    } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  if (!manifest) {
    await stopServiceProcess(child);
    throw new Error(`${serviceId} Service did not become ready: ${errorOutput}`);
  }
  return { child, endpoint, manifest, get output() { return output; } };
}

async function stopServiceProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close').catch(() => undefined);
  child.kill('SIGTERM');
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
}

async function runCli(args, env) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/swarm.mjs', ...args], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('built-in service image includes the checker git dependency and prebuild entrypoint', async () => {
  const dockerfile = await readFile(new URL('../services/builtin/Dockerfile', import.meta.url), 'utf8');
  const entrypoint = await readFile(new URL('../scripts/service-host-entrypoint.sh', import.meta.url), 'utf8');
  const compose = await readFile(new URL('../services/builtin/compose.yaml', import.meta.url), 'utf8');
  assert.match(dockerfile, /apt-get install[\s\S]*ca-certificates git/);
  assert.match(dockerfile, /ENTRYPOINT \["\.\/scripts\/service-host-entrypoint\.sh"\]/);
  assert.match(entrypoint, /SWARMENV_JUDGE_PREBUILD/);
  assert.match(entrypoint, /SWARMENV_JUDGE_PREBUILD_KEY/);
  assert.match(compose, /SWARMENV_CONTEXT_SERVICE_TOKEN: \$\{SWARMENV_SERVICE_TOKEN:-\}/);
  assert.match(compose, /SWARMENV_TASK_SERVICE_TOKEN: \$\{SWARMENV_SERVICE_TOKEN:-\}/);
  assert.match(compose, /SWARMENV_JUDGE_SERVICE_TOKEN: \$\{SWARMENV_SERVICE_TOKEN:-\}/);
});

test('service-host isolated mode owns one service database and HTTP manifest', async () => {
  const root = await mkdtemp('/tmp/swarmenv-isolated-service-');
  const port = await freePort();
  const child = spawn(process.execPath, ['scripts/service-host.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SWARMENV_SERVICE_ID: 'context',
      SWARMENV_SERVICE_ISOLATED: 'true',
      SWARMENV_SERVICE_HOST: '127.0.0.1',
      SWARMENV_SERVICE_PORT: String(port),
      SWARMENV_SERVICE_PUBLIC_URL: `http://127.0.0.1:${port}`,
      SWARMENV_SERVICE_DATABASE: join(root, 'context.sqlite'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  try {
    const deadline = Date.now() + 10_000;
    let manifest = null;
    while (Date.now() < deadline && !manifest) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/manifest`);
        if (response.ok) manifest = await response.json();
      } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }
    assert.equal(manifest?.result?.service_id, 'context');
    assert.match(output, /"service_id":"context"/);
  } finally {
    await stopServiceProcess(child);
    await rm(root, { recursive: true, force: true });
  }
});

test('isolated Task, Context, Judge and Catalog hosts are independently reachable and Context state survives restart', async () => {
  const root = await mkdtemp('/tmp/swarmenv-isolated-services-');
  const ports = { task: await freePort(), context: await freePort(), judge: await freePort(), catalog: await freePort() };
  const urls = Object.fromEntries(Object.entries(ports).map(([id, port]) => [id, `http://127.0.0.1:${port}`]));
  const services = [];
  const cliEnv = {
    ...process.env,
    SWARMENV_SERVICE_ENDPOINTS: JSON.stringify(Object.fromEntries(Object.entries(urls).map(([id, url]) => [id, { url, token: 'isolated-probe-token' }]))),
    SWARMENV_CONTEXT_SERVICE_URL: urls.context,
    SWARMENV_CONTEXT_SERVICE_TOKEN: 'isolated-probe-token',
  };
  try {
    services.push(await startService('context', ports.context, root));
    services.push(await startService('task', ports.task, root, { context: urls.context }));
    services.push(await startService('judge', ports.judge, root, { task: urls.task }));
    services.push(await startService('catalog', ports.catalog, root, urls));
    const listed = await runCli(['service', 'list', '--json'], cliEnv);
    assert.equal(listed.code, 0);
    const listedServices = JSON.parse(listed.stdout).services;
    assert.deepEqual(new Set(listedServices.map((service) => service.service_id)), new Set(['task', 'context', 'judge', 'catalog']));
    assert.equal(new Set(services.map((service) => service.manifest.service_id)).size, 4);

    const inputPath = join(root, 'material.json');
    await writeFile(inputPath, JSON.stringify({ kind: 'fact', scope: 'mission', role: 'experience', content: { marker: 'persisted-material' }, evidence_state: 'observed' }));
    const published = await runCli(['material', 'publish', '--input', inputPath, '--json'], cliEnv);
    assert.equal(published.code, 0);
    const materialId = JSON.parse(published.stdout).material.material_id;

    const context = services.find((service) => service.manifest.service_id === 'context');
    await stopServiceProcess(context.child);
    const restarted = await startService('context', ports.context, root);
    services.push(restarted);
    const read = await runCli(['material', 'get', '--material-id', materialId, '--json'], cliEnv);
    assert.equal(read.code, 0);
    assert.equal(JSON.parse(read.stdout).material.content.marker, 'persisted-material');
  } finally {
    await Promise.all(services.map(({ child }) => stopServiceProcess(child)));
    await rm(root, { recursive: true, force: true });
  }
});
