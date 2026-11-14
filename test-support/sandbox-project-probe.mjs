import { BOT_RESOURCES, BOT_PROTOCOL_VERSION } from '../src/agent/bot-contract.js';
// Local, network-disabled container probe. No model or provider request is made.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { stableStringify } from '../src/protocol/envelope.js';
const run = promisify(execFile);
const name = `swarm-project-probe-${randomUUID()}`;
const token = 'controlled-worker-test-token';
const docker = args => run('docker', args, { timeout: 15_000, maxBuffer: 1024 * 1024 });
const call = async (path, body = null, authenticated = true) => JSON.parse((await docker(['exec', name, 'node', '--input-type=module', '-e', `
  const response = await fetch('http://127.0.0.1:44100' + process.argv[1], {
    method: process.argv[2] === 'null' ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(process.argv[3] ? { authorization: 'Bearer ' + process.argv[3] } : {}) },
    body: process.argv[2] === 'null' ? undefined : process.argv[2], signal: AbortSignal.timeout(8000),
  });
  console.log(JSON.stringify({ status: response.status, body: await response.json() }));
`, path, JSON.stringify(body), authenticated ? token : ''])).stdout);
const accepted = async (path, body) => {
  const response = await call(path, body);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.result;
};
const watcherCode = "const fs = require('fs'); const fd = fs.openSync('/workspace/project/input.txt', 'r'); setInterval(() => { try { fs.writeFileSync('/proc/self/fd/' + fd, 'watcher write'); fs.appendFileSync('/workspace/runtime/write-times', Date.now() + ','); } catch {} }, 1)";
const agentCode = `
import fs from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  let data;
  try {
    if (message.type === 'identity') {
      let rootEnvironment;
      try { fs.readFileSync('/proc/1/environ'); rootEnvironment = 'readable'; } catch (error) { rootEnvironment = error.code; }
      data = { uid: process.getuid(), cwd: process.cwd(), home: process.env.HOME, pi: process.env.PI_CODING_AGENT_DIR,
        workerToken: process.env.SWARMENV_WORKER_TOKEN ?? null, rootSecret: process.env.ROOT_ONLY_TEST_SECRET ?? null,
        rootEnvironment, status: fs.readFileSync('/proc/self/status', 'utf8') };
    } else if (message.type === 'write') { fs.writeFileSync(message.path, message.base64 ? Buffer.from(message.base64, 'base64') : message.content); data = { written: true }; }
    else if (message.type === 'remove') { fs.unlinkSync(message.path); data = { removed: true }; }
    else if (message.type === 'link') { fs.symlinkSync('/etc/passwd', message.path); data = { linked: true }; }
    else if (message.type === 'watch') {
      const watcher = spawn('/usr/local/bin/node', ['-e', ${JSON.stringify(watcherCode)}], { detached: true, stdio: 'ignore' });
      watcher.unref(); data = { pid: watcher.pid };
    } else if (message.type === 'background') {
      const process = spawn('/usr/local/bin/node', ['-e', "setInterval(() => require('fs').appendFileSync('/workspace/runtime/heartbeat', 'x'), 10)"], { detached: true, stdio: 'ignore' });
      process.unref(); data = { pid: process.pid };
    } else data = { exiting: true };
  } catch (error) { data = { error: error.code, message: error.message }; }
  process.stdout.write(JSON.stringify({ type: 'response', id: message.id, success: true, data }) + '\\n');
  if (message.type === 'exit') setTimeout(() => process.exit(0), 20);
});
`;
const rpc = async message => (await accepted('/rpc', { message: { ...message, id: randomUUID() }, timeout_ms: 3000 })).response.data;
try {
  await docker(['run', '--detach', '--name', name, '--network', 'none', '--cpus', '1', '--memory', '256m', '--pids-limit', '128',
    '--env', `SWARMENV_WORKER_TOKEN=${token}`, '--env', 'ROOT_ONLY_TEST_SECRET=must-not-reach-agent',
    '--tmpfs', '/workspace:rw,nosuid,nodev,size=64m',
    '--mount', `type=bind,source=${fileURLToPath(new URL('../scripts/opensandbox-agent-worker.mjs', import.meta.url))},target=/opt/swarmenv/agent-worker.mjs,readonly`,
    '--mount', `type=bind,source=${fileURLToPath(new URL('../scripts/sandbox-project.mjs', import.meta.url))},target=/opt/swarmenv/sandbox-project.mjs,readonly`,
    '--entrypoint', 'node', 'swarmenv/agent:issue122', '/opt/swarmenv/agent-worker.mjs']);
  await docker(['cp', fileURLToPath(new URL('../src/agent/bot-contract', import.meta.url)), `${name}:/opt/swarmenv/src/agent/bot-contract`]);
  await docker(['exec', name, 'chown', '-R', '0:0', '/opt/swarmenv/src/agent/bot-contract']);
  await docker(['exec', name, 'chmod', '-R', 'u=rwX,go=rX', '/opt/swarmenv/src/agent/bot-contract']);
  let health;
  for (let i = 0; i < 20; i += 1) {
    try { health = await call('/health'); if (health.status === 200) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(health?.status, 200);
  assert.equal((await call('/project/grant', { execution_id: 'e', binding_version: 1 }, false)).status, 401);
  await accepted('/start', { contract_version: BOT_PROTOCOL_VERSION, resources: BOT_RESOURCES, command: '/usr/local/bin/node', args: ['--input-type=module', '-e', agentCode], cwd: '/workspace/project', env: {}, secret_env: {} });
  const identity = await rpc({ type: 'identity' });
  assert.equal(identity.uid, 10001);
  assert.equal(identity.cwd, '/workspace/project');
  assert.equal(identity.home, '/workspace/runtime/home');
  assert.equal(identity.pi, '/workspace/runtime/pi-agent');
  assert.equal(identity.workerToken, null);
  assert.equal(identity.rootSecret, null);
  assert.equal(identity.rootEnvironment, 'EACCES');
  assert.match(identity.status, /NoNewPrivs:\s+1/);
  assert.match(identity.status, /CapBnd:\s+0000000000000000/);
  assert.equal((await rpc({ type: 'write', path: '/workspace/project/pre-take', content: 'forbidden' })).error, 'EACCES');
  assert.equal((await rpc({ type: 'write', path: '/workspace/replace-parent', content: 'forbidden' })).error, 'EACCES');
  assert.equal((await call('/project/grant', { execution_id: 'e', binding_version: 1 })).status, 400);
  const content = 'complete prepared project input';
  await docker(['exec', name, 'node', '-e', "require('fs').writeFileSync('/workspace/project/input.txt', process.argv[1])", content]);
  const manifest = { 'input.txt': { content_hash: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content) } };
  await accepted('/project/prepare', { execution_id: 'e', binding_version: 1, manifest });
  assert.equal((await rpc({ type: 'write', path: '/workspace/project/input.txt', content: 'too early' })).error, 'EACCES');
  assert.equal((await call('/project/grant', { execution_id: 'another', binding_version: 1 })).status, 400);
  if (process.argv.includes('--grant-failure')) {
    await docker(['exec', name, 'node', '-e', "require('fs').symlinkSync('/etc/passwd','/workspace/project/z-bad-link')"]);
    const failed = await call('/project/grant', { execution_id: 'e', binding_version: 1 });
    assert.equal(failed.status, 400);
    assert.match(failed.body.error, /symlink/);
    assert.equal((await call('/health')).body.pid, null);
    assert.equal((await call('/project/grant', { execution_id: 'e', binding_version: 1 })).status, 400);
    const directory = JSON.parse((await docker(['exec', name, 'node', '-e', "const s=require('fs').statSync('/workspace/project'); console.log(JSON.stringify({uid:s.uid, mode:s.mode & 511}));"])).stdout);
    assert.deepEqual(directory, { uid: 0, mode: 365 });
    console.log('PASS: partial grant failure closes and stops the Bot and revokes directory access');
  } else {
    await rpc({ type: 'watch' });
    await new Promise(resolve => setTimeout(resolve, 100));
    const granted = await accepted('/project/grant', { execution_id: 'e', binding_version: 1 });
    assert.ok(granted.paused_process_count >= 2);
    await new Promise(resolve => setTimeout(resolve, 100));
    const writes = JSON.parse((await docker(['exec', name, 'node', '-e', "console.log(JSON.stringify(require('fs').readFileSync('/workspace/runtime/write-times','utf8').split(',').filter(Boolean).map(Number)))"])).stdout);
    assert.ok(writes.length > 0);
    assert.ok(writes.every(at => at >= granted.granted_at));
    assert.equal((await rpc({ type: 'write', path: '/workspace/project/input.txt', content: 'active write' })).written, true);
    await rpc({ type: 'write', path: '/workspace/project/2', base64: Buffer.from([0, 255, 128]).toString('base64') });
    await rpc({ type: 'write', path: '/workspace/project/10', content: 'ten' });
    assert.equal((await call('/project/snapshot', { execution_id: 'e', binding_version: 2 })).status, 400);
    assert.equal((await call('/project/snapshot', { execution_id: 'e', binding_version: 1 }, false)).status, 401);
    const snapshot = await accepted('/project/snapshot', { execution_id: 'e', binding_version: 1 });
    assert.ok(snapshot.paused_process_count >= 2, 'pause both Pi and its detached pre-opened-FD writer');
    assert.equal(snapshot.content_hash, createHash('sha256').update(stableStringify(snapshot.manifest)).digest('hex'));
    for (const [path, bytes] of Object.entries(snapshot.files)) {
      const content = Buffer.from(bytes, 'base64');
      assert.equal(snapshot.manifest[path].content_hash, createHash('sha256').update(content).digest('hex'));
      assert.equal(snapshot.manifest[path].bytes, content.length);
    }
    assert.deepEqual(Buffer.from(snapshot.files['2'], 'base64'), Buffer.from([0, 255, 128]));
    await rpc({ type: 'remove', path: '/workspace/project/10' });
    assert.equal((await accepted('/project/snapshot', { execution_id: 'e', binding_version: 1 })).files['10'], undefined);
    await rpc({ type: 'link', path: '/workspace/project/unsafe-link' });
    assert.match((await call('/project/snapshot', { execution_id: 'e', binding_version: 1 })).body.error, /symlink/);
    await rpc({ type: 'remove', path: '/workspace/project/unsafe-link' });
    assert.ok((await accepted('/project/snapshot', { execution_id: 'e', binding_version: 1 })).files['2']);
    await docker(['exec', name, 'node', '-e', "const fs=require('fs'); fs.writeFileSync(Buffer.concat([Buffer.from('/workspace/project/x'),Buffer.from([255])]),'invalid byte name'); fs.writeFileSync('/workspace/project/x\ufffd','valid replacement character');"]);
    assert.match((await call('/project/snapshot', { execution_id: 'e', binding_version: 1 })).body.error, /ambiguous decoded filenames/);
    await docker(['exec', name, 'node', '-e', "const fs=require('fs'); fs.unlinkSync(Buffer.concat([Buffer.from('/workspace/project/x'),Buffer.from([255])])); fs.unlinkSync('/workspace/project/x\ufffd');"]);
    assert.ok((await accepted('/project/snapshot', { execution_id: 'e', binding_version: 1 })).files['2']);
    const background = await rpc({ type: 'background' });
    await rpc({ type: 'exit' });
    await new Promise(resolve => setTimeout(resolve, 200));
    const size = async () => Number((await docker(['exec', name, 'node', '-e', "console.log(require('fs').statSync('/workspace/runtime/heartbeat').size)"])).stdout);
    assert.ok(await size() > 0);
    await accepted('/stop', {});
    const stoppedSize = await size();
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await size(), stoppedSize);
    const processState = (await docker(['exec', name, 'node', '-e', "try { console.log(require('fs').readFileSync('/proc/' + process.argv[1] + '/status','utf8').match(/^State:.*$/m)[0]); } catch (error) { console.log(error.code); }", String(background.pid)])).stdout;
    assert.match(processState, /ENOENT|State:\s+Z/);
    assert.equal((await call('/project/grant', { execution_id: 'e', binding_version: 1 })).status, 400);
    assert.equal((await call('/start', { command: 'node', args: [] })).status, 400);
    console.log('PASS: protected project, atomic grant, authenticated stable snapshot with paused background writers, numeric paths, binary bytes, deletion and symlink rejection, detached descendant stop, late grant/start rejection');
  }
} finally {
  await docker(['rm', '--force', name]).catch(() => undefined);
}
