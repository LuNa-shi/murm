// Run against the built worker image. This creates one disposable local
// container with no network and performs no model calls.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { BOT_RESOURCES, BOT_PROTOCOL_VERSION } from '../src/agent/bot-contract.js';
import { DockerBotDisk } from '../src/runtime/docker-bot-disk.js';
import { openSandboxMissionKey, openSandboxBotKey } from '../src/runtime/opensandbox-metadata.js';

const exec = promisify(execFile);
const agentImage = process.argv[2];
assert.ok(agentImage, 'Pass the explicitly selected Lean worker image');
const docker = (...args) => exec('docker', args, { timeout: 20_000 });
const sandboxId = `disk-probe-${randomUUID()}`;
const name = `sandbox-${sandboxId}`;
const bot = { mission_id: 'mission:disk', bot_id: 'bot:disk', resource_key: 'bot:disk-resource' };
const catalog = JSON.parse(await readFile(new URL('../services/opensandbox-agent/pi-models.json', import.meta.url)));
const { assertBenchmarkModelPair } = await import('../src/agent/bot-model-access.js');
const modelCatalogResource = await assertBenchmarkModelPair({ provider: 'gpt_proxy', model: catalog.providers.gpt_proxy.models[0].id, command: 'pi' });
const request = async (route, payload) => JSON.parse((await docker('exec', name, 'node', '-e', `
  const [path, data] = process.argv.slice(1);
  const request = { headers: { authorization: 'Bearer diskprobe' } };
  if (data) Object.assign(request, { method: 'POST', body: data });
  fetch('http://127.0.0.1:44100' + path, request).then(r => r.json()).then(x => console.log(JSON.stringify(x)));
`, route, ...(payload ? [JSON.stringify(payload)] : []))).stdout);

try {
  await docker('run', '--network', 'none', '--name', name, '--detach', '--memory', '2g', '--cpus', '2', '--pids-limit', '128',
    '--label', `opensandbox.io/id=${sandboxId}`, '--label', `mission_key=${openSandboxMissionKey(bot.mission_id)}`,
    '--label', `bot_key=${openSandboxBotKey(bot.bot_id)}`, '--label', `resource_key=${openSandboxBotKey(bot.resource_key)}`,
    agentImage, '--token', 'diskprobe', '--require-project-quota');
  const projectQuota = await new DockerBotDisk({ bytes: 96 * 1024 ** 2, inodes: 8192 }).isolate({ sandboxId, bot });
  const script = `
    set -eu
    r=/workspace/runtime/tmp
    lean --version >"$r/lean-version"
    jq -n -e true
    python3 -c "import json; assert json.load(open('/opt/swarmenv/lean-environment.json'))['trusted_mission_verdict'] is False"
    rg --version
    cat >"$r/Small.lean" <<'LEAN'
import Mathlib.Data.Nat.Basic
example : (1 : Nat) + 1 = 2 := by decide
LEAN
    cd "$r"
    timeout 40 lean -o Small.olean Small.lean >small.stdout 2>small.stderr
    cat >Full.lean <<'LEAN'
import Mathlib
example : (1 : Nat) + 1 = 2 := by norm_num
LEAN
    set +e
    timeout 40 lean -o Full.olean Full.lean >full.stdout 2>full.stderr
    echo "$?" >full.exit
    set -e
    if (echo changed >/opt/swarmenv/lean-deps/mathlib/Mathlib.olean) 2>/dev/null; then exit 9; fi
    touch passed
  `;
  for (let attempt = 0; ; attempt++) {
    try { assert.equal((await request('/health')).ok, true); break; }
    catch (error) { if (attempt === 19) throw error; }
  }
  const result = await request('/start', { command: '/bin/bash', args: ['-c', script], contract_version: BOT_PROTOCOL_VERSION,
    resources: BOT_RESOURCES, project_quota: projectQuota, model_catalog_resource: modelCatalogResource });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.result.project_quota, projectQuota);
  assert.deepEqual(result.result.model_catalog_resource, modelCatalogResource);
  const finishDeadline = Date.now() + 95_000;
  for (;;) {
    try { await docker('exec', name, 'test', '-f', '/workspace/runtime/tmp/passed'); break; }
    catch (error) { if (Date.now() >= finishDeadline) throw error; await delay(100); }
  }
  assert.equal((await request('/stop', {})).result.stopped, true);
  assert.equal((await docker('exec', name, 'cat', '/workspace/runtime/tmp/full.exit')).stdout.trim(), '0', 'Full Mathlib diagnostic compilation must succeed');
  const measurements = await docker('exec', name, 'sh', '-c', 'cat /workspace/runtime/tmp/lean-version /workspace/runtime/tmp/full.exit /sys/fs/cgroup/memory.peak; du -sb /workspace; cat /workspace/runtime/tmp/full.stderr');
  console.log(measurements.stdout);
  console.log('Local Lean diagnostics used the real worker with 2 CPU / 2 GiB and a 96 MiB / 8192 inode project quota.');
} catch (error) {
  console.error((await docker('exec', name, 'sh', '-c', 'cat /workspace/runtime/tmp/lean-version /workspace/runtime/tmp/small.stderr /workspace/runtime/tmp/full.stderr /workspace/runtime/tmp/full.exit /sys/fs/cgroup/memory.events /sys/fs/cgroup/memory.peak 2>/dev/null').catch(() => ({ stdout: "" }))).stdout);
  console.error(JSON.stringify(await request('/rpc', { type: 'get_state', since: 0 }).catch(() => null)));
  throw error;
} finally {
  await docker('rm', '--force', name).catch(() => undefined);
}
