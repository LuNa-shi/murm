import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { agentContract, BOT_PROTOCOL_VERSION, BOT_RESOURCES } from '../src/agent/bot-contract.js';

test('OpenSandbox image carries the direct Pi model catalog without NuRouter', async () => {
  const dockerfile = await readFile(new URL('../services/opensandbox-agent/Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /COPY --chown=0:0 services\/opensandbox-agent\/pi-models\.json \/opt\/swarmenv\/pi-agent\/models\.json/);
  assert.match(dockerfile, /PI_CODING_AGENT_DIR=/);
  assert.doesNotMatch(dockerfile, /nu-router|NUROUTER_SHA256|SWARMENV_NUROUTER_VERSION/);
  assert.match(dockerfile, /chmod 0555 \/opt\/swarmenv\/scripts\/swarm\.mjs/);
  assert.match(dockerfile, /mkdir -p \/workspace/);
  assert.match(dockerfile, /COPY --chown=0:0 src \/opt\/swarmenv\/src/);
  assert.match(dockerfile, /chmod 0755 \/opt\/swarmenv\s/);
  assert.match(dockerfile, /chmod -R u=rwX,go=rX \/opt\/swarmenv\/src\s/);
});

const agentImage = process.env.SWARMENV_TEST_AGENT_IMAGE;

test('built OpenSandbox image starts Pi with the host-pinned immutable Bot contract', { skip: !agentImage, timeout: 30_000 }, async () => {
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
      const response = await post('/start', { ...input, command: 'bash', args: ['-c', 'pi --version && swarm judge check --help'] });
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
  const runProbe = input => promisify(execFile)('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'node',
    agentImage, '--input-type=module', '-e', probe, JSON.stringify(input)], { timeout: 25_000 });
  for (const mode of ['swarm', 'solver']) {
    const contract = agentContract(mode);
    const input = { contract_version: contract.protocolVersion, resources: contract.resources, model_catalog_resource: modelCatalogResource, env: { SWARMENV_AGENT_MODE: mode } };
    await Promise.all([runProbe(input), runProbe({ ...input, expect_rejection: true, resources: contract.resources.map(resource => ({ ...resource, sha256: '0'.repeat(64) })) })]);
  }
});
