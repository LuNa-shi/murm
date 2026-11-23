import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { agentContract, BOT_PROTOCOL_VERSION, BOT_RESOURCES } from '../src/agent/bot-contract.js';

test('OpenSandbox image carries the direct Pi model catalog', async () => {
  const dockerfile = await readFile(new URL('../services/opensandbox-agent/Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /COPY --chown=0:0 services\/opensandbox-agent\/pi-models\.json \/opt\/swarmenv\/pi-agent\/models\.json/);
  assert.match(dockerfile, /PI_CODING_AGENT_DIR=/);
  assert.match(dockerfile, /chmod 0555 \/opt\/swarmenv\/scripts\/swarm\.mjs/);
  assert.match(dockerfile, /mkdir -p \/workspace/);
  assert.match(dockerfile, /COPY --chown=0:0 src \/opt\/swarmenv\/src/);
  assert.match(dockerfile, /chmod 0755 \/opt\/swarmenv\s/);
  assert.match(dockerfile, /chmod -R u=rwX,go=rX \/opt\/swarmenv\/src\s/);
});

const agentImage = process.env.SWARMENV_TEST_AGENT_IMAGE;

async function runImageProbes(probes, { image = agentImage, run = promisify(execFile), timeoutMs = 25_000 } = {}) {
  const owner = randomUUID();
  const label = `swarmenv.image-contract-probe=${owner}`;
  const names = probes.map((_, index) => `swarmenv-image-contract-${owner}-${index}`);
  const results = await Promise.allSettled(probes.map((args, index) => run('docker', [
    'run', '--rm', '--name', names[index], '--label', label,
    '--cpus', '1', '--memory', '512m', '--pids-limit', '64', '--network', 'none',
    '--entrypoint', 'node', image, '--input-type=module', '-e', ...args,
  ], { timeout: timeoutMs, maxBuffer: 1024 * 1024 })));
  // Drain every Docker client before removing names, so a delayed create
  // cannot race ahead of cleanup after a sibling probe has failed.
  await Promise.allSettled(names.map(name => run('docker', ['rm', '--force', name], { timeout: 5000 })));
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
  try {
    const remaining = await run('docker', ['ps', '--all', '--quiet', '--filter', `label=${label}`], { timeout: 5000 });
    assert.equal(remaining.stdout.trim(), '', 'Image probes must leave no owned containers');
  } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'Image probe execution or cleanup failed');
  return results.map(result => result.value);
}

test('image probe cleanup drains failed and delayed Docker clients before deleting every owned container', async () => {
  const containers = new Set();
  const events = [];
  const run = async (command, args, options) => {
    assert.equal(command, 'docker');
    if (args[0] === 'run') {
      const name = args[args.indexOf('--name') + 1];
      const label = args[args.indexOf('--label') + 1];
      assert.match(name, /^swarmenv-image-contract-[a-f0-9-]+-[01]$/);
      assert.match(label, /^swarmenv\.image-contract-probe=[a-f0-9-]+$/);
      for (const [flag, value] of [['--cpus', '1'], ['--memory', '512m'], ['--pids-limit', '64'], ['--network', 'none']]) {
        assert.equal(args[args.indexOf(flag) + 1], value);
      }
      assert.equal(options.timeout, 25_000);
      containers.add(name);
      if (args.at(-1) === 'timeout') {
        events.push('timeout');
        throw Object.assign(new Error('Docker client timed out with container alive'), { killed: true });
      }
      await new Promise(resolve => setTimeout(resolve, 20));
      events.push('delayed-client-settled');
      return { stdout: '' };
    }
    if (args[0] === 'rm') {
      assert.ok(events.includes('delayed-client-settled'));
      containers.delete(args.at(-1));
      events.push('removed');
      return { stdout: '' };
    }
    assert.deepEqual(args.slice(0, 4), ['ps', '--all', '--quiet', '--filter']);
    assert.match(args[4], /^label=swarmenv\.image-contract-probe=/);
    return { stdout: [...containers].join('\n') };
  };
  await assert.rejects(runImageProbes([['timeout'], ['delayed']], { image: 'controlled-image', run }), error => {
    assert.equal(error.errors.length, 1);
    assert.equal(error.errors[0].killed, true);
    return true;
  });
  assert.equal(containers.size, 0);
  assert.equal(events.filter(event => event === 'removed').length, 2);
});

test('image probe cleanup reports a retained owned container after a failed removal', async () => {
  const run = async (_command, args) => {
    if (args[0] === 'rm') throw new Error('Controlled deletion failure');
    return { stdout: args[0] === 'ps' ? 'retained-container' : '' };
  };
  await assert.rejects(runImageProbes([['fixed']], { image: 'controlled-image', run }), error => {
    assert.match(error.errors[0].message, /leave no owned containers/);
    return true;
  });
});

test('built OpenSandbox image starts Pi with the host-pinned immutable Bot contract', { skip: !agentImage, timeout: 45_000 }, async () => {
  const catalog = await readFile(new URL('../services/opensandbox-agent/pi-models.json', import.meta.url));
  const modelCatalogResource = { path: '/opt/swarmenv/pi-agent/models.json', sha256: createHash('sha256').update(catalog).digest('hex') };
  const probe = `
    import assert from 'node:assert/strict';
    import { spawn } from 'node:child_process';
    import { createHash } from 'node:crypto';
    import { lstat, readFile, realpath } from 'node:fs/promises';
    import { dirname } from 'node:path';
    import { setTimeout as delay } from 'node:timers/promises';

    const input = JSON.parse(process.argv[1]);
    const origin = 'http://127.0.0.1:44100';
    const token = 'image-contract-test';
    const worker = spawn(process.execPath, ['/opt/swarmenv/agent-worker.mjs', '--token', token], { stdio: 'inherit' });
    const post = (path, body) => fetch(origin + path, {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    async function verify() {
      const startDeadline = Date.now() + 5000;
      for (;;) {
        const healthy = await fetch(origin + '/health', { signal: AbortSignal.timeout(500) }).catch(() => null);
        if (healthy?.ok) break;
        assert.ok(Date.now() < startDeadline && worker.exitCode === null, 'worker did not become healthy');
        await delay(50);
      }
      const response = await post('/start', { ...input, command: 'bash', args: ['-c', 'pi --version && swarm judge check --help && jq -n -e true && python3 -c "import json" && python --version && rg --version && curl --version && ! command -v lean && ! command -v lake && ! command -v elan'] });
      const started = await response.json();
      if (input.expect_rejection) {
        assert.equal(response.status, 400);
        assert.equal(started.code, 'BOT_STARTUP_CONTRACT');
        assert.equal(started.ok, false);
        const health = await fetch(origin + '/health');
        assert.equal((await health.json()).pid, null);
        return;
      }
      assert.equal(response.status, 200, started.error);
      assert.ok(started.result.pid > 0);
      assert.deepEqual(started.result.contract, { version: input.contract_version, resources: input.resources });
      assert.deepEqual(started.result.model_catalog_resource, input.model_catalog_resource);

      for (const { path, sha256 } of input.resources) {
        const info = await lstat(path);
        assert.ok(info.isFile() && info.uid === 0 && (info.mode & 0o022) === 0 && (info.mode & 0o004), path);
        assert.equal(await realpath(path), path);
        assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), sha256, path);
        for (let parent = dirname(path); parent !== '/'; parent = dirname(parent)) {
          const info = await lstat(parent);
          assert.ok(info.isDirectory() && info.uid === 0 && (info.mode & 0o022) === 0 && (info.mode & 0o001), parent);
        }
      }
      const exitDeadline = Date.now() + 5000;
      for (;;) {
        const replay = await post('/rpc', { type: 'get_state', since: 0 });
        const { result } = await replay.json();
        const exit = result.records.find(record => record.type === 'worker_exit');
        if (exit) {
          assert.equal(exit.code, 0, 'Pi version and Swarm CLI help must work under the Bot UID');
          break;
        }
        assert.ok(Date.now() < exitDeadline, 'Pi did not finish');
        await delay(50);
      }
      assert.equal((await post('/stop', {})).status, 200);
    }
    try { await verify(); } finally {
      worker.kill('SIGKILL');
    }
  `;
  const contract = agentContract();
  const input = { contract_version: contract.protocolVersion, resources: contract.resources, model_catalog_resource: modelCatalogResource };
  await runImageProbes([input,
    { ...input, expect_rejection: true, contract_version: 'swarm-bot-v1-draft.2' },
    { ...input, expect_rejection: true, resources: contract.resources.map(resource => ({ ...resource, sha256: '0'.repeat(64) })) },
  ].map(value => [probe, JSON.stringify(value)]));
});

test('built worker prepares a complete large input with exact bytes, replay and permission fencing', { skip: !agentImage, timeout: 45_000 }, async () => {
  const probe = `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    import { readFile, readdir, stat } from 'node:fs/promises';
    import { SandboxProject } from '/opt/swarmenv/sandbox-project.mjs';
    const project = new SandboxProject(); await project.initialize();
    const files = {}, manifest = {};
    for (let i = 0; i < 6; i++) {
      const path = 'benchmark/chunk-' + i + '.bin', bytes = Buffer.alloc(2 * 1024 * 1024, i + 1);
      files[path] = bytes.toString('base64');
      manifest[path] = {bytes:bytes.length,content_hash:createHash('sha256').update(bytes).digest('hex')};
    }
    const input = {execution_id:'large-input',binding_version:1,files,manifest};
    await assert.rejects(project.prepare({...input,files:{...files,'../escape':'YQ=='}}));
    await assert.rejects(project.prepare({...input,files:{...files,'benchmark/chunk-0.bin':'YQ=='}}));
    assert.deepEqual(await readdir('/workspace/project'),[]);
    const began = Date.now(); const result = await project.prepare(input);
    assert.equal(result.state,'PREPARED'); assert.equal(result.bytes,12 * 1024 * 1024);
    assert.ok(Date.now()-began < 5000, 'local preparation must not incur per-chunk process latency');
    for (const [path,encoded] of Object.entries(files)) {
      assert.equal((await readFile('/workspace/project/'+path)).toString('base64'),encoded);
      const info = await stat('/workspace/project/'+path); assert.equal(info.uid,0); assert.equal(info.mode & 0o222,0);
    }
    assert.equal((await project.prepare(input)).state,'PREPARED');
    await assert.rejects(project.prepare({...input,execution_id:'other'}));
    await project.grant(input);
    assert.equal((await stat('/workspace/project/benchmark/chunk-0.bin')).uid,10001);
    await assert.rejects(project.prepare(input),/closed/);
  `;
  await runImageProbes([[probe]]);
});
