import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { tmpdir } from 'node:os';
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
  const child = spawn(process.execPath, ['dist/examples/taskpool/deploy/service-hosts/start-service-host.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MURM_SERVICE_ID: serviceId,
      MURM_SERVICE_ISOLATED: 'true',
      MURM_SERVICE_HOST: '127.0.0.1',
      MURM_SERVICE_PORT: String(port),
      MURM_SERVICE_PUBLIC_URL: endpoint,
      MURM_SERVICE_DATABASE: join(root, `${serviceId}.sqlite`),
      MURM_SERVICE_TOKEN: 'deprecated-shared-token',
      MURM_SERVICE_PRINCIPALS: JSON.stringify([{ token: 'isolated-probe-token', actor_ref: 'operator:isolated-probe', role: 'bound' }]),
      ...Object.fromEntries(Object.entries(endpoints).map(([id, url]) => [`MURM_${id.toUpperCase()}_SERVICE_URL`, url])),
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
    const child = spawn(process.execPath, ['dist/scripts/swarm.js', ...args], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('built-in service image includes the checker git dependency and prebuild entrypoint', async () => {
  const dockerfile = await readFile(new URL('../examples/taskpool/deploy/service-hosts/Dockerfile', import.meta.url), 'utf8');
  const entrypoint = await readFile(new URL('../examples/taskpool/deploy/service-hosts/service-host-entrypoint.sh', import.meta.url), 'utf8');
  const compose = await readFile(new URL('../examples/taskpool/deploy/service-hosts/compose.yaml', import.meta.url), 'utf8');
  assert.match(dockerfile, /apt-get install[\s\S]*ca-certificates git/);
  assert.match(dockerfile, /ENTRYPOINT \["\.\/scripts\/service-host-entrypoint\.sh"\]/);
  assert.match(entrypoint, /MURM_JUDGE_PREBUILD/);
  assert.match(entrypoint, /MURM_JUDGE_PREBUILD_KEY/);
  assert.match(compose, /MURM_CONTEXT_SERVICE_TOKEN: \$\{MURM_CONTEXT_SERVICE_TOKEN:-\}/);
  assert.match(compose, /MURM_TASK_SERVICE_TOKEN: \$\{MURM_TASK_SERVICE_TOKEN:-\}/);
  assert.match(compose, /MURM_JUDGE_SERVICE_TOKEN: \$\{MURM_JUDGE_SERVICE_TOKEN:-\}/);
  for (const id of ['TASK', 'CONTEXT', 'JUDGE', 'CATALOG']) {
    assert.ok(compose.includes('MURM_SERVICE_PRINCIPALS: ${MURM_' + id + '_SERVICE_PRINCIPALS:-[]}'));
  }
});

test('service-host isolated mode owns one service database and HTTP manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'murm-isolated-service-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['dist/examples/taskpool/deploy/service-hosts/start-service-host.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MURM_SERVICE_ID: 'context',
      MURM_SERVICE_ISOLATED: 'true',
      MURM_SERVICE_HOST: '127.0.0.1',
      MURM_SERVICE_PORT: String(port),
      MURM_SERVICE_PUBLIC_URL: `http://127.0.0.1:${port}`,
      MURM_SERVICE_DATABASE: join(root, 'context.sqlite'),
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

test('isolated hosts remain discoverable while Context fails closed without Mission authority, including after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'murm-isolated-services-'));
  const ports = { task: await freePort(), context: await freePort(), judge: await freePort(), catalog: await freePort() };
  const urls = Object.fromEntries(Object.entries(ports).map(([id, port]) => [id, `http://127.0.0.1:${port}`]));
  const services = [];
  const cliEnv = {
    ...process.env,
    MURM_SERVICE_ENDPOINTS: JSON.stringify(Object.fromEntries(Object.entries(urls).map(([id, url]) => [id, { url, token: 'isolated-probe-token' }]))),
    MURM_CONTEXT_SERVICE_URL: urls.context,
    MURM_CONTEXT_SERVICE_TOKEN: 'isolated-probe-token',
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

    const membership = await fetch(`${urls.task}/v1/manifest`).then(response => response.json());
    const capability = membership.result.capabilities.find(candidate => candidate.operation === 'task_take');
    const request = (token, actor, role, owner) => fetch(`${urls.task}${capability.path}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ envelope: { operation_id: 'identity-probe', actor_ref: actor, task_id: 'other-task',
        execution_id: null, spec_version: null, state_version: null, fencing_version: null }, role,
        input: { task_id: 'other-task', owner_ref: owner } }),
    });
    assert.equal((await request('deprecated-shared-token', 'operator:isolated-probe', 'bound')).status, 401);
    assert.equal((await request('isolated-probe-token', 'agent:forged', 'bound')).status, 403);
    assert.equal((await request('isolated-probe-token', 'operator:isolated-probe', 'recovery')).status, 403);
    assert.equal((await request('isolated-probe-token', 'operator:isolated-probe', 'bound', 'agent:forged')).status, 403);


    const inputPath = join(root, 'material.json');
    await writeFile(inputPath, JSON.stringify({ content: { marker: 'persisted-material' } }));
    const published = await runCli(['material', 'publish', '--input', inputPath, '--actor-ref', 'operator:isolated-probe', '--json'], cliEnv);
    assert.notEqual(published.code, 0);
    assert.match(published.stderr, /SERVICE_NOT_READY|authenticated Mission authority/);
    const ready = await fetch(`${urls.context}/readyz`);
    assert.equal(ready.ok, false);

    const context = services.find((service) => service.manifest.service_id === 'context');
    await stopServiceProcess(context.child);
    const restarted = await startService('context', ports.context, root, { task: urls.task });
    services.push(restarted);
    const read = await runCli(['material', 'view', '--material-id', 'arbitrary-public-id', '--actor-ref', 'operator:isolated-probe', '--json'], cliEnv);
    assert.notEqual(read.code, 0);
    assert.match(read.stderr, /SERVICE_NOT_READY|authenticated Mission authority/);
  } finally {
    await Promise.all(services.map(({ child }) => stopServiceProcess(child)));
    await rm(root, { recursive: true, force: true });
  }
});
