import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPeerUpstream, peerInputs } from './fixtures/peermesh-peer-upstream.js';
import { peerCommand } from './fixtures/peermesh-peer-upstream.js';
import { execFileSync } from 'node:child_process';

test('both fixed Bash tool programs parse as native Node modules without executing them', () => {
  for (const turn of [1, 2]) {
    const script = peerCommand(turn, 'http://172.17.0.1:12345').split('\n').slice(1, -1).join('\n');
    execFileSync(process.execPath, ['--check', '--input-type=module'], { input: script, timeout: 5000 });
  }
});

test('controlled peer fixture counts every arrival and permits only four fixed local requests', async t => {
  let failureCalls = 0;
  const upstream = await createPeerUpstream({ deniedOrigin: 'http://172.17.0.1:1', onFailure: record => { failureCalls++; assert.deepEqual(record, { code: 'FIXED_PEER_PROTOCOL_FAILED', stage: 'bounds', turn: 2, arrival: 5 }); } }); t.after(() => upstream.close()); upstream.start();
  const pushedCommit = 'a'.repeat(40); const privateCommit = 'b'.repeat(40);
  for (let number = 1; number <= 5; number++) {
    const turn = number <= 2 ? 1 : 2;
    const evidence = turn === 1 ? { turn, cwd: '/project', pushedCommit, prNumber: 1, messageId: 'message', boardLabel: 'G1', networkDenied: true }
      : { turn, cwd: '/project', pushedCommit, privateCommit, continued: true, untrackedBase64: 'AP9BCg==' };
    const response = await fetch(upstream.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'k3', input: [
      { type: 'message', content: peerInputs[turn - 1] }, ...(number % 2 ? [] : [{ type: 'function_call_output', call_id: `call_peer_${turn}`, output: JSON.stringify(evidence) }]),
    ] }) });
    const text = await response.text(); assert.equal(response.status, 200);
    if (number === 5) { assert.match(text, /failed_peer_5/); assert.match(text, /response.failed/); assert.doesNotMatch(text, /response.completed/); assert.match(text, /FIXED_PEER_PROTOCOL_FAILED/); }
  }
  assert.equal(failureCalls, 1);
  assert.equal(upstream.receipt().arrivals, 5); assert.equal(upstream.receipt().accepted, 4); assert.equal(upstream.receipt().failure, 'FIXED_PEER_PROTOCOL_FAILED');
});

test('generated peer Bash keeps diagnostic-emitting Git and CLI stderr out of structured evidence', async t => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { promisify } = await import('node:util'); const { execFile } = await import('node:child_process');
  const execute = promisify(execFile);
  const directory = await mkdtemp(join(tmpdir(), 'peer-bash-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin'), seed = join(directory, 'seed'), project = join(directory, 'project'), remote = join(directory, 'remote.git');
  for (const path of [bin, seed, project]) await mkdir(path);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixed Peer', GIT_AUTHOR_EMAIL: 'fixed@example.invalid', GIT_COMMITTER_NAME: 'Fixed Peer', GIT_COMMITTER_EMAIL: 'fixed@example.invalid',
    PATH: bin + ':' + process.env.PATH, RUN_REPOSITORY: remote, WORK_BRANCH: 'peer-fixed', RUN_OWNER: 'owner', RUN_REPO: 'repo', RUN_BOARD: 'board', RUN_CHANNEL: 'channel', RUN_ISSUE: '1' };
  const git = (...args) => execute('git', args, { cwd: seed, env, timeout: 5000 });
  await git('init', '--bare', remote); await git('init', '--initial-branch=main');
  await writeFile(join(seed, 'acceptance.txt'), 'INITIAL\n');
  await git('add', '.'); await git('commit', '-m', 'Initial'); await git('remote', 'add', 'origin', remote); await git('push', 'origin', 'main');
  await git('--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await writeFile(join(bin, 'curl'), '#!/bin/sh\nexit 7\n', { mode: 0o700 });
  await writeFile(join(bin, 'swarm'), `#!/usr/bin/env node
const fs=require('node:fs');const cp=require('node:child_process');
const operation=process.argv[3]; fs.appendFileSync(${JSON.stringify(join(directory, 'operations'))},operation+'\\n');
process.stderr.write('PRIVATE_CLI_DIAGNOSTIC\\n');
const rows={issue_read:{number:1},issue_write:{title:'Fixed peer evidence'},board_read:{},board_write:{status:'admitted',label:'G1'},board_grep:{total:1},board_unfold:{rendered:'T13 fixed detail'},post_message:{id:'message'},pull_request_write:{number:1,head:{sha:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()}}};
process.stdout.write(JSON.stringify(rows[operation]));
`, { mode: 0o700 });
  const upstream = await createPeerUpstream({ deniedOrigin: 'http://127.0.0.1:1' }); t.after(() => upstream.close()); upstream.start();
  const send = async (turn, output) => (await fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [
    { role: 'user', content: peerInputs[turn - 1] }, ...(output ? [{ type: 'function_call_output', call_id: `call_peer_${turn}`, output }] : []),
  ] }) })).text();
  const observations = [];
  for (const turn of [1, 2]) {
    assert.match(await send(turn), /function_call/);
    // Pi's Bash transport merges stdout/stderr. Exercise the generated command
    // with that behavior, actual Git clone/switch/push and a diagnostic CLI.
    const result = await execute('bash', ['-c', `{\n${peerCommand(turn, 'http://127.0.0.1:1')}\n} 2>&1`], { cwd: project, env, timeout: 15000 });
    assert.equal(result.stderr, ''); assert.doesNotMatch(result.stdout, /PRIVATE_CLI_DIAGNOSTIC|Cloning|Switched|To /);
    const observed = JSON.parse(result.stdout.trim()); assert.equal(observed.turn, turn); observations.push(observed);
    assert.match(await send(turn, result.stdout), new RegExp(`PEER_${turn}_OK`));
  }
  assert.equal(upstream.receipt().arrivals, 4); assert.equal(upstream.receipt().accepted, 4); assert.equal(upstream.receipt().failure, undefined);
  assert.equal(observations[1].continued, true); assert.equal(observations[1].pushedCommit, observations[0].pushedCommit);
  assert.equal(observations[1].untrackedBase64, 'AP9BCg==');
  assert.deepEqual(await readFile(join(project, 'untracked.bin')), Buffer.from([0, 255, 65, 10]));
  assert.deepEqual((await readFile(join(directory, 'operations'), 'utf8')).trim().split('\n'), ['issue_read','issue_write','board_read','board_write','board_grep','board_unfold','post_message','pull_request_write']);
});

test('peer parser reports only categorical turn/arrival/stage when merged tool evidence is invalid', async t => {
  const upstream = await createPeerUpstream({ deniedOrigin: 'http://127.0.0.1:1' }); t.after(() => upstream.close()); upstream.start();
  for (const output of [undefined, 'PRIVATE_DIAGNOSTIC\n{"turn":1}']) {
    const response = await fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [
      { role: 'user', content: peerInputs[0] }, ...(output ? [{ type: 'function_call_output', call_id: 'call_peer_1', output }] : []),
    ] }) });
    const body = await response.text(); assert.doesNotMatch(body, /PRIVATE_DIAGNOSTIC/);
    if (output) { assert.match(body, /response.failed/); assert.doesNotMatch(body, /response.completed/); }
  }
  assert.deepEqual(upstream.receipt().failureDetail, { code: 'FIXED_PEER_PROTOCOL_FAILED', stage: 'tool-json', turn: 1, arrival: 2 });
  assert.equal(upstream.receipt().accepted, 1); assert.equal(upstream.receipt().arrivals, 2);
});

test('native Pi consumes peer terminal failure once without retry or false success', async t => {
  const { completeSimple, isRetryableAssistantError } = await import('@earendil-works/pi-ai/compat');
  const upstream = await createPeerUpstream({ deniedOrigin: 'http://127.0.0.1:1' }); t.after(() => upstream.close()); upstream.start();
  const model = { id: 'k3', name: 'fixed', provider: 'kimi_proxy', api: 'openai-responses', baseUrl: upstream.url.replace(/\/responses$/, ''), reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 128 };
  const failed = await completeSimple(model, { messages: [{ role: 'user', content: 'INVALID_FIXED_INPUT', timestamp: 0 }] }, { apiKey: 'local-only', maxTokens: 128 });
  assert.equal(failed.stopReason, 'error'); assert.equal(isRetryableAssistantError(failed), false);
  assert.match(failed.errorMessage, /FIXED_PEER_PROTOCOL_FAILED/); assert.equal(upstream.receipt().arrivals, 1);
  assert.deepEqual(upstream.receipt().failureDetail, { code: 'FIXED_PEER_PROTOCOL_FAILED', stage: 'identity', turn: 1, arrival: 1 });
});
