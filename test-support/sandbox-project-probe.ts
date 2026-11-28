// Local, network-disabled container probe. No model or provider request is made.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { stableStringify } from '../examples/taskpool/persistence/envelope.js';
const run = promisify(execFile);
const name = `swarm-project-probe-${randomUUID()}`;
const token = 'controlled-worker-test-token';
const docker = (args: any) => run('docker', args, { timeout: 15_000, maxBuffer: 1024 * 1024 });
const call = async (path: any, body: any = null, authenticated: any = true) => JSON.parse((await docker(['exec', name, 'node', '--input-type=module', '-e', `
  const response = await fetch('http://127.0.0.1:44100' + process.argv[1], {
    method: process.argv[2] === 'null' ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(process.argv[3] ? { authorization: 'Bearer ' + process.argv[3] } : {}) },
    body: process.argv[2] === 'null' ? undefined : process.argv[2], signal: AbortSignal.timeout(8000),
  });
  console.log(JSON.stringify({ status: response.status, body: await response.json() }));
`, path, JSON.stringify(body), authenticated ? token : ''])).stdout);
const accepted = async (path: any, body: any) => {
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
        workerToken: process.env.MURM_WORKER_TOKEN ?? null, rootSecret: process.env.ROOT_ONLY_TEST_SECRET ?? null,
        rootEnvironment, status: fs.readFileSync('/proc/self/status', 'utf8') };
    } else if (message.type === 'write') { fs.writeFileSync(message.path, message.base64 ? Buffer.from(message.base64, 'base64') : message.content); data = { written: true }; }
    else if (message.type === 'remove') { fs.unlinkSync(message.path); data = { removed: true }; }
    else if (message.type === 'link') { fs.symlinkSync('/etc/passwd', message.path); data = { linked: true }; }
    else if (message.type === 'open-file') {
      const reader = spawn('/usr/local/bin/node', ['-e', "require('fs').openSync(process.argv[1], 'r'); setInterval(()=>{},1000)", message.path], { detached: true, stdio: 'ignore' });
      reader.unref(); data = { pid: reader.pid };
    }
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
const rpc = async (message: any) => (await accepted('/rpc', { message: { ...message, id: randomUUID() }, timeout_ms: 3000 })).response.data;
try {
  await docker(['run', '--detach', '--name', name, '--network', 'none', '--cpus', '1', '--memory', '256m', '--pids-limit', '128',
    '--env', `MURM_WORKER_TOKEN=${token}`, '--env', 'ROOT_ONLY_TEST_SECRET=must-not-reach-agent',
    '--tmpfs', '/workspace:rw,nosuid,nodev,size=64m',
    ...['opensandbox-agent-worker.js', 'sandbox-project.js', 'project-install.js', 'project-processes.js',
      'core-work-dir.js', 'core-file-seed.js', 'core-collection.js', 'pi-rpc-submissions.js'].flatMap(file => [
      '--mount', `type=bind,source=${fileURLToPath(new URL('../scripts/' + file, import.meta.url))},target=/opt/murm/${file},readonly`,
    ]),
    '--entrypoint', 'node', 'murm/agent:issue122', '/opt/murm/opensandbox-agent-worker.js']);
  await docker(['exec', name, 'node', '-e', `
    const fs = require('node:fs');
    fs.mkdirSync('/opt/murm/probe-bin', { recursive: true });
    fs.writeFileSync('/opt/murm/probe-bin/probe.mjs', process.argv[1], { mode: 0o444 });
    fs.writeFileSync('/opt/murm/probe-bin/pi', '#!/bin/sh\\nexec node /opt/murm/probe-bin/probe.mjs\\n', { mode: 0o555 });
  `, agentCode]);
  let health: any;
  for (let i = 0; i < 20; i += 1) {
    try { health = await call('/health'); if (health.status === 200) break; } catch {}
    await new Promise<any>((resolve: any) => setTimeout(resolve, 100));
  }
  assert.equal(health?.status, 200);
  assert.equal((await call('/project/grant', { execution_id: 'e', binding_version: 1 }, false)).status, 401);
  await accepted('/start', { contract_version: 'murm-core-v2', resources: [], command: 'pi', args: [], cwd: '/workspace/project',
    system_prompt: 'Controlled project lifecycle probe', system_prompt_path: '/workspace/runtime/profile-prompt.txt',
    env: { PATH: '/opt/murm/probe-bin:/usr/local/bin:/usr/bin:/bin' }, secret_env: {} });
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
  const manifest: any = { 'input.txt': { content_hash: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content) } };
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
    console.log('PASS: partial grant failure closes and stops the Agent and revokes directory access');
  } else {
    await rpc({ type: 'watch' });
    await new Promise<any>((resolve: any) => setTimeout(resolve, 100));
    const granted = await accepted('/project/grant', { execution_id: 'e', binding_version: 1 });
    assert.ok(granted.paused_process_count >= 2);
    await new Promise<any>((resolve: any) => setTimeout(resolve, 100));
    const writes = JSON.parse((await docker(['exec', name, 'node', '-e', "console.log(JSON.stringify(require('fs').readFileSync('/workspace/runtime/write-times','utf8').split(',').filter(Boolean).map(Number)))"])).stdout);
    assert.ok(writes.length > 0);
    assert.ok(writes.every((at: any) => at >= granted.granted_at));
    assert.equal((await rpc({ type: 'write', path: '/workspace/project/input.txt', content: 'active write' })).written, true);
    await rpc({ type: 'write', path: '/workspace/project/2', base64: Buffer.from([0, 255, 128]).toString('base64') });
    await rpc({ type: 'write', path: '/workspace/project/10', content: 'ten' });
    assert.equal((await call('/project/snapshot', { execution_id: 'e', binding_version: 2 })).status, 400);
    assert.equal((await call('/project/snapshot', { execution_id: 'e', binding_version: 1 }, false)).status, 401);
    const snapshot = await accepted('/project/snapshot', { execution_id: 'e', binding_version: 1 });
    assert.ok(snapshot.paused_process_count >= 2, 'pause both Pi and its detached pre-opened-FD writer');
    assert.equal(snapshot.content_hash, createHash('sha256').update(stableStringify(snapshot.manifest)).digest('hex'));
    for (const [path, bytes] of Object.entries(snapshot.files as Record<string, any>)) {
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
    const beforeApply = await accepted('/project/snapshot', { execution_id: 'e', binding_version: 1 });
    const targetFiles: any = { ...beforeApply.files, '2': Buffer.from('installed bytes').toString('base64'), 'installed/note': Buffer.from('incoming').toString('base64') };
    const manifestOf = (files: any) => Object.fromEntries(Object.entries(files as Record<string, any>).map(([path, encoded]: any) => {
      const bytes = Buffer.from(encoded, 'base64');
      return [path, { bytes: bytes.length, content_hash: createHash('sha256').update(bytes).digest('hex') }];
    }));
    const treeHash = (files: any) => createHash('sha256').update(stableStringify(manifestOf(files))).digest('hex');
    const install: any = { execution_id: 'e', binding_version: 1, request_id: 'install-one', expected_content_hash: beforeApply.content_hash, content_hash: treeHash(targetFiles), files: targetFiles };
    const inode = async () => (await docker(['exec', name, 'node', '-e', "console.log(require('fs').statSync('/workspace/project').ino)"])).stdout;
    const initialInode = await inode();
    const installed = await accepted('/project/install', install);
    assert.equal(installed.phase, 'installed');
    assert.equal((await accepted('/project/install-result', install)).phase, 'installed');
    assert.equal((await call('/project/snapshot', { execution_id: 'e', binding_version: 1 })).body.code, 'WORKSPACE_BUSY');
    assert.equal(await inode(), initialInode);
    const confirmed = await accepted('/project/install-confirm', install);
    assert.equal(confirmed.phase, 'committed');
    assert.equal((await rpc({ type: 'identity' })).cwd, '/workspace/project');
    await rpc({ type: 'write', path: '/workspace/project/2', content: 'newer Agent edit after install' });
    assert.equal((await accepted('/project/install', install)).phase, 'committed');
    const afterReplay = await accepted('/project/snapshot', { execution_id: 'e', binding_version: 1 });
    assert.equal(Buffer.from(afterReplay.files['2'], 'base64').toString(), 'newer Agent edit after install');
    const unsafeFiles: any = { ...afterReplay.files, 'input.txt': Buffer.from('must not replace an open FD').toString('base64') };
    const unsafe = await call('/project/install', { ...install, request_id: 'open-fd', expected_content_hash: afterReplay.content_hash, content_hash: treeHash(unsafeFiles), files: unsafeFiles });
    assert.equal(unsafe.body.code, 'WORKSPACE_BUSY');
    assert.equal((await accepted('/project/snapshot', { execution_id: 'e', binding_version: 1 })).content_hash, afterReplay.content_hash);
    for (const path of ['literal (deleted)', 'space and\nnewline']) {
      await rpc({ type: 'write', path: '/workspace/project/' + path, content: 'open original' });
      await rpc({ type: 'open-file', path: '/workspace/project/' + path });
      await new Promise<any>((resolve: any) => setTimeout(resolve, 100));
      const before = await accepted('/project/snapshot', { execution_id: 'e', binding_version: 1 });
      const nextFiles: any = { ...before.files, [path]: Buffer.from('unsafe replacement').toString('base64') };
      assert.equal((await call('/project/install', { ...install, request_id: 'fd-' + path, expected_content_hash: before.content_hash, content_hash: treeHash(nextFiles), files: nextFiles })).body.code, 'WORKSPACE_BUSY');
    }
    const background = await rpc({ type: 'background' });
    if (process.argv.includes('--close-held')) {
      await new Promise<any>((resolve: any) => setTimeout(resolve, 100));
      const before = await accepted('/project/snapshot', { execution_id: 'e', binding_version: 1 });
      const nextFiles: any = { ...before.files, '2': Buffer.from('held install').toString('base64') };
      await accepted('/project/install', { ...install, request_id: 'close-held', expected_content_hash: before.content_hash, content_hash: treeHash(nextFiles), files: nextFiles });
    } else await rpc({ type: 'exit' });
    await new Promise<any>((resolve: any) => setTimeout(resolve, 200));
    const size = async () => Number((await docker(['exec', name, 'node', '-e', "console.log(require('fs').statSync('/workspace/runtime/heartbeat').size)"])).stdout);
    assert.ok(await size() > 0);
    const stopped = await accepted('/stop', {});
    assert.equal(stopped.project_installs.find((receipt: any) => receipt.request_id === 'install-one').phase, 'committed');
    if (process.argv.includes('--close-held')) {
      assert.equal(stopped.project_installs.find((receipt: any) => receipt.request_id === 'close-held').phase, 'installed');
      assert.equal((await call('/project/install-confirm', { ...install, request_id: 'close-held' })).status, 400);
    }
    const stoppedSize = await size();
    await new Promise<any>((resolve: any) => setTimeout(resolve, 150));
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
