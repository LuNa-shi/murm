import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createRuntime } from '@swarmenv/core';
import { ServiceRegistry } from '@swarmenv/core/services';
import { createPiOpenSandboxBackend } from '@swarmenv/core/backends/pi-opensandbox';
import { createIsolationUpstream } from './fixtures/core-isolation-upstream.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';

const execute = promisify(execFile);
const disk = { bytes: 64 * 1024 ** 2, inodes: 4096 };

async function endpoint(t, host) {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('T03_ENDPOINT_OK'); });
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://${host}:${server.address().port}`, count: () => requests };
}

function guestCommand({ role, writable, repeat = false, allowedUrl, deniedUrl, botId, quota = false }) {
  const script = `import os,json,errno,shutil,urllib.request,urllib.error
checks={}
role=${JSON.stringify(role)}
expected=${JSON.stringify(role === 'A' ? 'A_PRIVATE_FILE' : 'B_PRIVATE_FILE')}
checks['image']=open('/opt/swarmenv/core-profile-marker').read()==role+'\\n'
checks['ordinary_env']=os.environ.get('CORE_ROLE')==role
checks['secret_env']=os.environ.get('CORE_APP_SECRET')==role+'_test_only'
checks['host_env_absent']='CORE_HOST_SENTINEL' not in os.environ
checks['management_absent']='SWARMENV_WORKER_TOKEN' not in os.environ and 'OPEN_SANDBOX_API_KEY' not in os.environ
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
health=probe(os.environ['SWARMENV_BRIDGE_URL']+'/health',{'Authorization':'Bearer '+os.environ['SWARMENV_BRIDGE_TOKEN']})
checks['bridge_auto']=health is not None and json.loads(health).get('botId')==${JSON.stringify(botId)}
checks['allowed_network']=(probe(${JSON.stringify(allowedUrl)})=='T03_ENDPOINT_OK')==${role === 'A' ? 'True' : 'False'}
checks['denied_network']=probe(${JSON.stringify(deniedUrl)}) is None
v=os.statvfs('.')
checks['quota_bytes']=v.f_blocks*v.f_frsize==${disk.bytes}
checks['quota_inodes']=v.f_files==${disk.inodes}
if ${quota ? 'True' : 'False'}:
 try:
  with open('quota-fill','wb') as f:
   for _ in range(70): f.write(b'x'*(1024*1024))
  checks['byte_limit_enforced']=False
 except OSError as e: checks['byte_limit_enforced']=e.errno==errno.ENOSPC
 finally:
  if os.path.exists('quota-fill'): os.unlink('quota-fill')
 os.mkdir('quota-inodes')
 try:
  for n in range(4200): open('quota-inodes/'+str(n),'w').close()
  checks['inode_limit_enforced']=False
 except OSError as e: checks['inode_limit_enforced']=e.errno==errno.ENOSPC
 finally: shutil.rmtree('quota-inodes')
print(json.dumps(checks))
`;
  return `python3 - <<'CORE_ISOLATION_PY'\n${script}CORE_ISOLATION_PY`;
}

async function containerEvidence(container) {
  const image = JSON.parse((await execute('docker', ['inspect', '--format', '{{json .Config.Image}}', container], { timeout: 5000 })).stdout);
  const sessionScript = "const f=require('fs');for(const p of f.readdirSync('/proc')){try{const a=f.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0');const i=a.indexOf('--session-id');if(i>=0){process.stdout.write(a[i+1]);break}}catch{}}";
  const session = (await execute('docker', ['exec', container, 'node', '-e', sessionScript], { timeout: 5000 })).stdout.trim();
  assert.match(session, /^[a-f0-9-]{36}$/);
  return { image, session };
}

test('Core isolates concurrent Bots, frozen roles and independent Runtimes on actual Pi/OpenSandbox', {
  skip: process.env.SWARMENV_CORE_ISOLATION_REAL_TEST !== '1' && 'Explicit reviewed local-system run required', timeout: 220_000,
}, async t => {
  const host = process.env.SWARMENV_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const imageA = process.env.SWARMENV_CORE_TEST_IMAGE_A;
  const imageB = process.env.SWARMENV_CORE_TEST_IMAGE_B;
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
  const reports = { resources: {}, turns: {}, cleanup: [], failure: true };
  const runtimes = [];
  const callers = [];
  let deadlineExpired = false;
  const deadline = setTimeout(() => {
    deadlineExpired = true;
    for (const runtime of runtimes) void runtime.close({ timeoutMs: 1 }).catch(() => {});
  }, 180_000);
  t.after(() => clearTimeout(deadline));
  t.after(async () => {
    for (const runtime of runtimes) {
      const closed = await runtime.close({ timeoutMs: 30_000 });
      reports.cleanup.push({ runtimeId: runtime.id, cleanup: closed.cleanup,
        bots: closed.bots.map(bot => ({ botId: bot.botId, execution: bot.execution, cleanup: bot.cleanup })) });
      reports.resources[runtime.id] = { empty: (await ownedContainers(runtime.id)).length === 0 };
    }
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
    return createPiOpenSandboxBackend({
      sandbox: { lifecycleBaseUrl: process.env.SWARMENV_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
        endpointHost: process.env.SWARMENV_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', apiKey: process.env.SWARMENV_CORE_TEST_API_KEY,
        resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000 },
      bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` },
      modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 15_000, maxOutputTokens: 256 },
      models: {
        alpha: { provider: 'kimi_proxy', model: 'k3', upstream: { url: upstream.url, headers: { 'x-core-test-credential': 'host-only-test-credential' } } },
        beta: { provider: 'gpt_proxy', model: 'gpt-6.1-sol', upstream: { url: upstream.url, headers: {} } },
      }, isolation: { network: 'local-docker', disk },
    });
  }
  const profiles = {
    writer: { prompt: 'FROZEN_PROFILE_A', model: 'alpha', image: imageA, writable: true, services: {},
      env: { CORE_ROLE: 'A' }, network: { allow: [allowed.url] } },
    peer: { prompt: 'FROZEN_PROFILE_B', model: 'beta', image: imageB, writable: true, services: {}, env: { CORE_ROLE: 'B' } },
  };
  const modelAccessPolicy = { authorize(caller) { callers.push(caller); return { phase: 'work', deadlineAt: Date.now() + 15_000 }; }, withCommit: commit => commit() };
  const runtime = await createRuntime({ backend: configuration(), profiles, services: new ServiceRegistry(), maxBots: 2, outputDir, modelAccessPolicy });
  runtimes.push(runtime);
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
  const initial = await Promise.all(containers.map(containerEvidence));
  assert.deepEqual(new Set(initial.map(row => row.image)), new Set([imageA, imageB]));
  assert.notEqual(initial[0].session, initial[1].session);
  reports.distinctSessions = true;
  const other = await createRuntime({ backend: configuration(), profiles: {
    observer: { prompt: 'FROZEN_PROFILE_C', model: 'alpha', image: imageB, writable: false, services: {}, env: { CORE_ROLE: 'B' } },
  }, services: new ServiceRegistry(), maxBots: 1, outputDir, modelAccessPolicy });
  runtimes.push(other);
  const c = await other.spawn({ requestId: 'spawn-C', profile: 'observer', secretEnv: { CORE_APP_SECRET: 'B_test_only' } });
  await assert.rejects(other.get(a.id), { code: 'NOT_FOUND' });
  await assert.rejects(runtime.send(c.id, 'foreign', { requestId: 'foreign' }), { code: 'NOT_FOUND' });
  async function turn(owner, bot, id, role, writable, repeat, quota) {
    assert.equal(deadlineExpired, false);
    plan.set(id, { model: role === 'A' || id.startsWith('T03_C') ? 'k3' : 'gpt-6.1-sol',
      prompt: id.startsWith('T03_C') ? 'FROZEN_PROFILE_C' : `FROZEN_PROFILE_${role}`,
      command: guestCommand({ role, writable, repeat, quota, allowedUrl: allowed.url, deniedUrl: denied.url, botId: bot.id }) });
    let resolve;
    const completed = new Promise(done => { resolve = done; });
    const unsubscribe = owner.onEvent(event => { if (event.botId === bot.id && event.type === 'settled') resolve(event); });
    const timer = setTimeout(() => resolve({ outcome: 'timeout' }), 35_000);
    try {
      assert.equal((await owner.send(bot.id, id, { requestId: id, mode: 'followUp' })).status, 'accepted');
      const settled = await completed;
      assert.equal(settled.outcome, 'completed');
      assert.equal(settled.output, id === 'T03_A1' ? 'A_PRIVATE_SESSION_FACT' : `${id}_OK`);
      assert.equal((await owner.get(bot.id)).status, 'idle');
      assert.ok(plan.get(id).evidence);
      reports.turns[id] = plan.get(id).evidence;
    } finally { clearTimeout(timer); unsubscribe(); }
  }
  await turn(runtime, a, 'T03_A1', 'A', true, false, true);
  await turn(runtime, b, 'T03_B1', 'B', true, false, false);
  await turn(runtime, a, 'T03_A2', 'A', true, true, false);
  assert.deepEqual(await ownedContainers(runtime.id), containers);
  assert.deepEqual(await Promise.all(containers.map(containerEvidence)), initial);
  await assert.rejects(runtime.spawn({ requestId: 'still-no-slot', profile: 'writer' }), { code: 'CONFLICT' });
  await turn(other, c, 'T03_C1', 'B', false, false, false);
  const firstClose = await runtime.close({ timeoutMs: 30_000 });
  assert.equal(firstClose.cleanup, 'complete');
  assert.deepEqual(await ownedContainers(runtime.id), []);
  assert.equal((await ownedContainers(other.id)).length, 1);
  await turn(other, c, 'T03_C2', 'B', false, true, false);
  assert.ok(callers.some(caller => caller.botId === a.id && caller.model === 'alpha'));
  assert.ok(callers.some(caller => caller.botId === b.id && caller.model === 'beta'));
  assert.equal(upstream.failure, undefined);
  assert.equal(upstream.receipts.length, 10);
  assert.equal(denied.count(), 0);
  assert.equal(deadlineExpired, false);
  reports.failure = false;
  t.diagnostic('Controlled local Responses fixtures only; redacted evidence in ignored experiments/core-isolation-*/acceptance.json');
});
