// Run against the built worker image. This creates one disposable local
// container with no network and performs no model calls.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { DockerAgentDisk } from '../src/runtime/docker-agent-disk.js';
import { openSandboxMissionKey, openSandboxAgentKey } from '../src/runtime/opensandbox-metadata.js';

const exec = promisify(execFile);
const docker = (...args: any) => exec('docker', args, { timeout: 20_000 });
const sandboxId = `disk-probe-${randomUUID()}`;
const name = `sandbox-${sandboxId}`;
const agent: any = { mission_id: 'mission:disk', agent_id: 'agent:disk', resource_key: 'agent:disk-resource' };
const catalog = JSON.parse((await readFile(new URL('../services/opensandbox-agent/pi-models.json', import.meta.url))) as unknown as string);
const { assertShippedModelPair } = await import('../src/agent/model-catalog.js');
const modelCatalogResource = await assertShippedModelPair({ provider: 'gpt_proxy', model: catalog.providers.gpt_proxy.models[0].id });
const request = async (route: any, payload?: unknown) => JSON.parse((await docker('exec', name, 'node', '-e', `
  const [path, data] = process.argv.slice(1);
  const request = { headers: { authorization: 'Bearer diskprobe' } };
  if (data) Object.assign(request, { method: 'POST', body: data });
  fetch('http://127.0.0.1:44100' + path, request).then(r => r.json()).then(x => console.log(JSON.stringify(x)));
`, route, ...(payload ? [JSON.stringify(payload)] : []))).stdout);

try {
  await docker('run', '--network', 'none', '--name', name, '--detach', '--memory', '512m', '--pids-limit', '128',
    '--label', `opensandbox.io/id=${sandboxId}`, '--label', `mission_key=${openSandboxMissionKey(agent.mission_id)}`,
    '--label', `agent_key=${openSandboxAgentKey(agent.agent_id)}`, '--label', `resource_key=${openSandboxAgentKey(agent.resource_key)}`,
    process.argv[2] ?? 'murm/agent:issue122', '--token', 'diskprobe', '--require-project-quota');
  const projectQuota = await new DockerAgentDisk({ bytes: 16 * 1024 ** 2, inodes: 1024 }).isolate({ sandboxId, agent });
  const script = `
    set -eu
    r=/workspace/runtime/tmp
    for target in /tmp/agent-outside /dev/shm/agent-outside /dev/mqueue/agent-outside; do
      if (echo bad >"$target") 2>/dev/null; then exit 3; fi
    done
    ln -s /tmp "$r/link"
    if (echo bad >"$r/link/agent-outside") 2>/dev/null; then exit 4; fi
    echo yes >/dev/null
    if dd if=/dev/zero of="$r/bounded" bs=1M count=20 2>/dev/null; then exit 5; fi
    test "$(stat -c %s "$r/bounded")" -lt 20971520
    rm "$r/bounded"
    bash -c 'if (echo bad >/tmp/agent-child-outside) 2>/dev/null; then exit 6; fi'
    mkdir "$r/inodes"
    for ((i=0; i<1024; i++)); do if ! (>"$r/inodes/$i") 2>/dev/null; then break; fi; done
    test "$i" -ge 1
    test "$i" -lt 1024
    rm -rf "$r/inodes"
    touch "$r/passed"
  `;
  for (let attempt = 0; ; attempt++) {
    try { assert.equal((await request('/health')).ok, true); break; }
    catch (error: any) { if (attempt === 19) throw error; }
  }
  await docker('exec', name, 'node', '-e', `
    const fs = require('node:fs');
    fs.mkdirSync('/opt/murm/probe-bin', { recursive: true });
    fs.writeFileSync('/opt/murm/probe-bin/pi', '#!/bin/bash\\nexec /bin/bash "$@"\\n', { mode: 0o555 });
  `);
  const result = await request('/start', { command: 'pi', args: ['-c', script], contract_version: 'murm-core-v1',
    resources: [], system_prompt: 'Controlled filesystem policy probe', system_prompt_path: '/workspace/runtime/profile-prompt.txt',
    env: { PATH: '/opt/murm/probe-bin:/usr/local/bin:/usr/bin:/bin' }, project_quota: projectQuota, model_catalog_resource: modelCatalogResource });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.result.project_quota, projectQuota);
  assert.deepEqual(result.result.model_catalog_resource, modelCatalogResource);
  for (let attempt = 0; ; attempt++) {
    try { await docker('exec', name, 'test', '-f', '/workspace/runtime/tmp/passed'); break; }
    catch (error: any) { if (attempt === 39) throw error; }
  }
  assert.equal((await request('/stop', {})).result.stopped, true);
  console.log('Docker worker enforced byte and inode quotas and descendant write restrictions.');
} finally {
  await docker('rm', '--force', name).catch(() => undefined);
}
