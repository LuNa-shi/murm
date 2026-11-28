import { runtimeSettings } from './fixtures/core-runtime-settings.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createRuntime } from '@luna-shi/murm';
import { ServiceRegistry } from '@luna-shi/murm';

import { createIsolationUpstream } from './fixtures/core-isolation-upstream.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { cleanupRuntimes } from './fixtures/core-runtime-cleanup.js';
import { sessionEvidence } from './fixtures/core-session-evidence.js';
import { openSandboxAgentKey } from '../src/core/sandbox/opensandbox-metadata.js';

const execute = promisify(execFile);

async function endpoint(t, host) {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('T03_ENDPOINT_OK'); });
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://${host}:${server.address().port}`, count: () => requests };
}

function guestCommand({ role, writable, repeat = false, allowedUrl, deniedUrl, agentId }) {
  const script = `import os,json,socket,urllib.request,urllib.error,urllib.parse
checks={}
role=${JSON.stringify(role)}
expected=${JSON.stringify(role === 'A' ? 'A_PRIVATE_FILE' : 'B_PRIVATE_FILE')}
checks['image']=open('/opt/murm/core-profile-marker').read()==role+'\\n'
checks['ordinary_env']=os.environ.get('CORE_ROLE')==role
checks['secret_env']=os.environ.get('CORE_APP_SECRET')==role+'_test_only'
checks['host_env_absent']='CORE_HOST_SENTINEL' not in os.environ
checks['management_absent']='MURM_WORKER_TOKEN' not in os.environ and 'OPEN_SANDBOX_API_KEY' not in os.environ
checks['upstream_secret_absent']='host-only-test-credential' not in os.environ.values()
checks['other_secret_absent']=('A_test_only' if role!='A' else 'B_test_only') not in os.environ.values()
checks['workdir']=os.getcwd()=='/workspace/project'
if ${writable ? 'True' : 'False'}:
 if not ${repeat ? 'True' : 'False'}:
  checks['initially_private']=not os.path.exists('same.txt')
  open('same.txt','w').write(expected+'\\n')
 checks['private_file']=open('same.txt').read()==expected+'\\n'
else:
 try:
  open('same.txt','w').write('must-fail')
  checks['readonly']=False
 except PermissionError: checks['readonly']=True
 checks['no_peer_file']=not os.path.exists('same.txt')
def probe(url,headers={}):
 try:
  with urllib.request.urlopen(urllib.request.Request(url,headers=headers),timeout=2) as r: return r.read().decode()
 except (OSError,urllib.error.URLError): return None
health=probe(os.environ['MURM_BRIDGE_URL']+'/health',{'Authorization':'Bearer '+os.environ['MURM_BRIDGE_TOKEN']})
checks['bridge_auto']=health is not None and json.loads(health).get('agentId')==${JSON.stringify(agentId)}
checks['allowed_network']=(probe(${JSON.stringify(allowedUrl)})=='T03_ENDPOINT_OK')==${role === 'A' ? 'True' : 'False'}
denied=urllib.parse.urlsplit(${JSON.stringify(deniedUrl)})
try:
 with socket.create_connection((denied.hostname,denied.port),timeout=2): checks['denied_network']=False
except OSError: checks['denied_network']=True
print(json.dumps(checks))
`;
  return `python3 - <<'CORE_ISOLATION_PY'\n${script}CORE_ISOLATION_PY`;
}

async function containerEvidence(container) {
  const identity = JSON.parse((await execute('docker', ['inspect', '--format',
    '{"requestedImage":{{json .Config.Image}},"imageId":{{json .Image}},"labels":{{json .Config.Labels}},"memory":{{json .HostConfig.Memory}},"nanoCpus":{{json .HostConfig.NanoCpus}},"cpuQuota":{{json .HostConfig.CpuQuota}},"cpuPeriod":{{json .HostConfig.CpuPeriod}}}', container], { timeout: 5000 })).stdout);
  return { containerId: container, requestedImage: identity.requestedImage, imageId: identity.imageId,
    agentKey: identity.labels.agent_key, memory: identity.memory,
    nanoCpus: identity.nanoCpus, cpuQuota: identity.cpuQuota, cpuPeriod: identity.cpuPeriod };
}

test('Core isolates concurrent Agents, frozen roles and independent Runtimes on actual Pi/OpenSandbox', {
  skip: process.env.MURM_CORE_ISOLATION_REAL_TEST !== '1' && 'Explicit reviewed local-system run required', timeout: 220_000,
}, async t => {
  const host = process.env.MURM_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const imageA = process.env.MURM_CORE_TEST_IMAGE_A;
  const imageB = process.env.MURM_CORE_TEST_IMAGE_B;
  assert.ok(imageA && imageB && imageA !== imageB, 'Provide independently marked A/B image references');
  const plan = new Map();
  const upstream = await createIsolationUpstream(plan);
  t.after(() => upstream.close());
  const allowed = await endpoint(t, host);
  const denied = await endpoint(t, host);
  const startedAt = Date.now();
  const outputDir = join(process.cwd(), 'experiments', `core-isolation-${startedAt}`);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const oldSentinel = process.env.CORE_HOST_SENTINEL;
  process.env.CORE_HOST_SENTINEL = 'must-not-be-inherited';
  t.after(() => { if (oldSentinel === undefined) delete process.env.CORE_HOST_SENTINEL; else process.env.CORE_HOST_SENTINEL = oldSentinel; });
  const reports = { resources: {}, agents: [], turns: {}, cleanup: [], failure: true, workloadLimitMs: 180_000, cleanupTailLimitMs: 30_000 };
  const runtimes = [];
  let deadlineExpired = false;
  const deadline = setTimeout(() => {
    deadlineExpired = true;
    for (const runtime of runtimes) void runtime.close({ timeoutMs: 1 }).catch(() => {});
  }, 180_000);
  t.after(() => clearTimeout(deadline));
  t.after(async () => {
    reports.cleanup = await cleanupRuntimes(runtimes, { inspect: ownedContainers, resources: reports.resources });
    reports.failure ||= deadlineExpired || reports.cleanup.some(row => row.cleanup !== 'complete') ||
      Object.values(reports.resources).some(row => !row.empty);
    reports.upstream = upstream.receipts;
    reports.allowedRequests = allowed.count();
    reports.deniedRequests = denied.count();
    reports.elapsedMs = Date.now() - startedAt;
    await writeFile(join(outputDir, 'acceptance.json'), JSON.stringify(reports, null, 2), { mode: 0o600 });
    assert.ok(reports.cleanup.every(row => row.cleanup === 'complete'));
    assert.ok(Object.values(reports.resources).every(row => row.empty));
  });
  function configuration() {
    return runtimeSettings({
      sandbox: { lifecycleBaseUrl: process.env.MURM_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
        egressMode: 'dns+nft', apiKey: process.env.MURM_CORE_TEST_API_KEY,
        resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000 },
      bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` },
      modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 15_000, maxOutputTokens: 256 },
      models: {
        alpha: { provider: 'kimi_proxy', model: 'k3', upstream: { url: upstream.url, headers: { 'x-core-test-credential': 'host-only-test-credential' } } },
        beta: { provider: 'gpt_proxy', model: 'gpt-6.1-sol', upstream: { url: upstream.url, headers: {} } },
      }, isolation: { network: 'api' },
    });
  }
  const profiles = {
    writer: { prompt: 'FROZEN_PROFILE_A', model: 'alpha', image: imageA, writable: true, services: {},
      env: { CORE_ROLE: 'A' }, network: { allow: [allowed.url] } },
    peer: { prompt: 'FROZEN_PROFILE_B', model: 'beta', image: imageB, writable: true, services: {}, env: { CORE_ROLE: 'B' }, network: { allow: [] } },
  };
  const runtime = await createRuntime({ ...configuration(), profiles, services: new ServiceRegistry(), maxAgents: 2, outputDir });
  runtimes.push(runtime);
  reports.resources[runtime.id] = { maxAgents: 2, beforeSpawnCount: (await ownedContainers(runtime.id)).length };
  assert.equal(reports.resources[runtime.id].beforeSpawnCount, 0);
  profiles.writer.env.CORE_ROLE = 'mutated';
  profiles.writer.prompt = 'MUTATED_PROFILE';
  profiles.writer.image = imageB;
  profiles.writer.network.allow.length = 0;
  const [a, b] = await Promise.all([
    runtime.spawn({ requestId: 'spawn-A', profile: 'writer', secretEnv: { CORE_APP_SECRET: 'A_test_only' } }),
    runtime.spawn({ requestId: 'spawn-B', profile: 'peer', secretEnv: { CORE_APP_SECRET: 'B_test_only' } }),
  ]);
  assert.notEqual(a.id, b.id);
  await assert.rejects(runtime.spawn({ requestId: 'no-slot', profile: 'writer' }), { code: 'CONFLICT' });
  const containers = await ownedContainers(runtime.id);
  assert.equal(containers.length, 2);
  Object.assign(reports.resources[runtime.id], { afterSpawnCount: 2, idleCapacityRejected: true });
  const initial = await Promise.all(containers.map(containerEvidence));
  assert.deepEqual(new Set(initial.map(row => row.requestedImage)), new Set([imageA, imageB]));
  for (const agent of [a, b]) {
    const observed = initial.find(row => row.agentKey === openSandboxAgentKey(agent.id));
    assert.ok(observed);
    assert.match(observed.imageId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(observed.memory, 1024 ** 3);
    assert.ok(observed.nanoCpus === 1_000_000_000 || observed.cpuQuota > 0 && observed.cpuQuota === observed.cpuPeriod);
    reports.agents.push({ runtimeId: runtime.id, agentId: agent.id, profile: agent.profile, initialStatus: agent.status, ...observed });
  }
  const other = await createRuntime({ ...configuration(), profiles: {
    observer: { prompt: 'FROZEN_PROFILE_C', model: 'alpha', image: imageB, writable: false, services: {}, env: { CORE_ROLE: 'B' }, network: { allow: [] } },
  }, services: new ServiceRegistry(), maxAgents: 1, outputDir });
  runtimes.push(other);
  reports.resources[other.id] = { maxAgents: 1, beforeSpawnCount: (await ownedContainers(other.id)).length };
  assert.equal(reports.resources[other.id].beforeSpawnCount, 0);
  const c = await other.spawn({ requestId: 'spawn-C', profile: 'observer', secretEnv: { CORE_APP_SECRET: 'B_test_only' } });
  const otherContainers = await ownedContainers(other.id);
  assert.equal(otherContainers.length, 1);
  const cObserved = await containerEvidence(otherContainers[0]);
  assert.equal(cObserved.requestedImage, imageB);
  assert.equal(cObserved.agentKey, openSandboxAgentKey(c.id));
  reports.agents.push({ runtimeId: other.id, agentId: c.id, profile: c.profile, initialStatus: c.status, ...cObserved });
  Object.assign(reports.resources[other.id], { afterSpawnCount: 1 });
  await assert.rejects(other.get(a.id), { code: 'NOT_FOUND' });
  await assert.rejects(runtime.send(c.id, 'foreign', { requestId: 'foreign' }), { code: 'NOT_FOUND' });
  async function turn(owner, agent, id, role, writable, repeat) {
    assert.equal(deadlineExpired, false);
    plan.set(id, { model: role === 'A' || id.startsWith('T03_C') ? 'k3' : 'gpt-6.1-sol',
      prompt: id.startsWith('T03_C') ? 'FROZEN_PROFILE_C' : `FROZEN_PROFILE_${role}`,
      command: guestCommand({ role, writable, repeat, allowedUrl: allowed.url, deniedUrl: denied.url, agentId: agent.id }) });
    let resolve;
    const completed = new Promise(done => { resolve = done; });
    const unsubscribe = owner.onEvent(event => { if (event.agentId === agent.id && event.type === 'settled') resolve(event); });
    const timer = setTimeout(() => resolve({ outcome: 'timeout' }), 35_000);
    try {
      assert.equal((await owner.send(agent.id, id, { requestId: id, mode: 'followUp' })).status, 'accepted');
      const settled = await completed;
      assert.equal(settled.outcome, 'completed');
      assert.equal(settled.output, id === 'T03_A1' ? 'A_PRIVATE_SESSION_FACT' : `${id}_OK`);
      assert.equal((await owner.get(agent.id)).status, 'idle');
      assert.ok(plan.get(id).evidence);
      reports.turns[id] = plan.get(id).evidence;
    } finally { clearTimeout(timer); unsubscribe(); }
  }
  const agentEvidence = agent => reports.agents.find(row => row.agentId === agent.id);
  const observeSession = agent => sessionEvidence(agentEvidence(agent).containerId, execute);
  await turn(runtime, a, 'T03_A1', 'A', true, false);
  const aSession = await observeSession(a);
  Object.assign(agentEvidence(a), aSession);
  await turn(runtime, b, 'T03_B1', 'B', true, false);
  const bSession = await observeSession(b);
  Object.assign(agentEvidence(b), bSession);
  assert.notEqual(aSession.sessionId, bSession.sessionId);
  await turn(runtime, a, 'T03_A2', 'A', true, true);
  assert.deepEqual(await observeSession(a), aSession);
  agentEvidence(a).sessionRetained = true;
  assert.deepEqual(await ownedContainers(runtime.id), containers);
  assert.deepEqual(await Promise.all(containers.map(containerEvidence)), initial);
  reports.resources[runtime.id].idleRetained = true;
  await assert.rejects(runtime.spawn({ requestId: 'still-no-slot', profile: 'writer' }), { code: 'CONFLICT' });
  await turn(other, c, 'T03_C1', 'B', false, false);
  const cSession = await observeSession(c);
  Object.assign(agentEvidence(c), cSession);
  assert.ok([aSession.sessionId, bSession.sessionId].every(id => id !== cSession.sessionId));
  reports.distinctSessions = true;
  const firstClose = await runtime.close({ timeoutMs: 30_000 });
  assert.equal(firstClose.cleanup, 'complete');
  assert.deepEqual(await ownedContainers(runtime.id), []);
  assert.equal((await ownedContainers(other.id)).length, 1);
  reports.resources[runtime.id].emptyAfterExplicitClose = true;
  reports.resources[other.id].retainedAfterSiblingClose = true;
  await turn(other, c, 'T03_C2', 'B', false, true);
  assert.deepEqual(await ownedContainers(other.id), otherContainers);
  assert.deepEqual(await observeSession(c), cSession);
  agentEvidence(c).sessionRetained = true;
  reports.resources[other.id].idleRetained = true;
  assert.equal(upstream.failure, undefined);
  assert.equal(upstream.receipts.length, 10);
  assert.equal(denied.count(), 0);
  assert.equal(deadlineExpired, false);
  reports.failure = false;
  t.diagnostic('Controlled local Responses fixtures only; redacted evidence in ignored experiments/core-isolation-*/acceptance.json');
});
