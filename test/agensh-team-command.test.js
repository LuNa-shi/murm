import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { teamCommand, teamFact, teamInputs } from './fixtures/agensh-team-upstream.js';
import { admitPatchSummary } from './fixtures/agensh-board-admission.js';

test('native Board admission continues to reject a PATCH_SUMMARY without actual evidence', () => {
  const check = content => admitPatchSummary({ type: 'PATCH_SUMMARY', content });
  assert.equal(check('T15 left.txt ' + 'a'.repeat(40)).status, 'rejected');
  assert.equal(check('files=left.txt | evidence=pending').status, 'rejected');
  assert.equal(check('files=left.txt | evidence=').status, 'rejected');
  assert.equal(check('x'.repeat(300) + '| evidence=verified bytes').status, 'rejected');
  assert.equal(admitPatchSummary({ type: 'PATCH_SUMMARY', content: 'files=left.txt', detail: 'evidence=verified bytes' }).status, 'rejected');
});

for (const key of ['a', 'h'])
test(`generated peer ${key} contribution passes native admission after actual local file and Git checks`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agensh-team-command-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project'), remote = join(directory, 'remote.git'), bin = join(directory, 'bin'), log = join(directory, 'calls.jsonl');
  await mkdir(project); await mkdir(bin);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Peer', GIT_AUTHOR_EMAIL: 'peer@example.invalid', GIT_COMMITTER_NAME: 'Peer', GIT_COMMITTER_EMAIL: 'peer@example.invalid',
    PATH: `${bin}:${process.env.PATH}`, RUN_OWNER: 'owner', RUN_REPO: 'repo', RUN_BOARD: 'board', RUN_CHANNEL: 'channel', WORK_BRANCH: `peer-${key}`, T15_CALL_LOG: log };
  const git = (...args) => execFileSync('git', args, { cwd: project, env, stdio: 'pipe' });
  git('init', '--bare', remote); git('init', '-b', `peer-${key}`); await writeFile(join(project, 'seed.txt'), 'seed\n'); git('add', 'seed.txt'); git('commit', '-m', 'seed'); git('remote', 'add', 'origin', remote);
  await writeFile(join(bin, 'swarm'), `#!${process.execPath}
import {readFileSync,appendFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';
import {admitPatchSummary} from ${JSON.stringify(new URL('./fixtures/agensh-board-admission.js', import.meta.url).href)};
const operation=process.argv[3],input=JSON.parse(readFileSync(process.argv[5],'utf8'));let result;
if(operation==='board_read')result={rendered:${JSON.stringify(teamFact)}};
else if(operation==='board_grep')result={total:2,entries:[{},{}]};
else if(operation==='pull_request_write')result={number:1,head:{sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()}};
else if(operation==='board_write')result=admitPatchSummary(input);
else if(operation==='post_message')result={id:'actual-local-message'};
else throw Error('Unexpected operation');
appendFileSync(process.env.T15_CALL_LOG,JSON.stringify({operation,input,result})+'\\n');console.log(JSON.stringify(result));
`, { mode: 0o700 });
  const batch = { batchId: 'batch-a', source: 'mattermost', eventId: 'post:actual-local', text: teamInputs[2] };
  const command = teamCommand(`${key}-contribution`, batch, { a: 'peer-a', b: 'peer-b' });
  const wrapper = join(directory, 'native-parent.mjs');
  await writeFile(wrapper, `import {readFileSync,writeFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';
process.title='pi';const raw=readFileSync('/proc/'+process.pid+'/stat','utf8');const fields=raw.slice(raw.lastIndexOf(')')+2).split(' ');
writeFileSync('.team-state.json',JSON.stringify({cwd:process.cwd(),pi:{pid:process.pid,start:fields[19]}}));
execFileSync('bash',['-c',${JSON.stringify(command)}],{stdio:'inherit'});
`);
  execFileSync(process.execPath, [resolve(wrapper)], { cwd: project, env, timeout: 10_000, stdio: 'pipe' });
  const result = JSON.parse(await readFile(join(project, 'contribution.json'), 'utf8'));
  assert.equal(result.head, git('rev-parse', 'HEAD').toString().trim());
  assert.equal(result.head, execFileSync('git', ['--git-dir', remote, 'rev-parse', `refs/heads/peer-${key}`]).toString().trim());
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  const summary = calls.find(row => row.operation === 'board_write');
  assert.equal(summary.result.status, 'admitted'); assert.ok(summary.input.content.includes(result.head));
  assert.match(summary.input.content, /evidence=.*verified/); assert.ok(summary.input.content.length <= 300);
  assert.equal(calls.at(-1).operation, key === 'a' ? 'post_message' : 'board_write');
  const expected = key === 'a' ? 'T15_LEFT_ACCEPTED\n' : `T15_EIGHT_ADOPTED ${teamFact}\n`;
  assert.equal(result.content, expected);
  assert.equal(await readFile(join(project, key === 'a' ? 'left.txt' : 'eight-h.txt'), 'utf8'), expected);
  if (key === 'h') assert.equal(calls.filter(row => row.operation === 'post_message').length, 0);
});

test('foreground readback command retains the original native process and private Git state and rejects changed bytes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agensh-direct-command-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project'), remote = join(directory, 'remote.git'); await mkdir(project);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Peer', GIT_AUTHOR_EMAIL: 'peer@example.invalid', GIT_COMMITTER_NAME: 'Peer', GIT_COMMITTER_EMAIL: 'peer@example.invalid', WORK_BRANCH: 'peer-a' };
  const git = (...args) => execFileSync('git', args, { cwd: project, env, stdio: 'pipe' }).toString().trim();
  git('init', '--bare', remote); git('init', '-b', 'peer-a'); await writeFile(join(project, 'left.txt'), 'T15_LEFT_ACCEPTED\n'); git('add', 'left.txt'); git('commit', '-m', 'public'); git('remote', 'add', 'origin', remote); git('push', '-u', 'origin', 'peer-a');
  const external = { batchId: 'external-batch', eventId: 'comment:1', source: 'gitea', text: teamInputs[4] };
  const direct = { batchId: 'direct-batch', eventId: 'direct-fixed', source: 'user', text: 'T15_FOREGROUND_A' };
  const original = teamCommand('a-user', external, {}), followup = teamCommand('a-foreground', direct, {});
  const wrapper = join(directory, 'parent.mjs');
  await writeFile(wrapper, `import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';
process.title='pi';const raw=readFileSync('/proc/'+process.pid+'/stat','utf8'),fields=raw.slice(raw.lastIndexOf(')')+2).split(' ');
writeFileSync('.team-state.json',JSON.stringify({cwd:process.cwd(),pi:{pid:process.pid,start:fields[19]}}));
execFileSync('bash',['-c',${JSON.stringify(original)}],{stdio:'pipe'});
execFileSync('bash',['-c',${JSON.stringify(followup)}],{stdio:'pipe'});
const accepted=readFileSync('foreground-event.json');writeFileSync('untracked.bin',Buffer.from([1,2]));
assert.throws(()=>execFileSync('bash',['-c',${JSON.stringify(followup)}],{stdio:'pipe'}));
assert.deepEqual(readFileSync('foreground-event.json'),accepted);
`);
  execFileSync(process.execPath, [wrapper], { cwd: project, env, timeout: 10000, stdio: 'pipe' });
  const prior = JSON.parse(await readFile(join(project, 'user-event.json'), 'utf8'));
  const proof = JSON.parse(await readFile(join(project, 'foreground-event.json'), 'utf8'));
  assert.deepEqual(proof.event, direct); assert.deepEqual(proof.pi, prior.pi);
  assert.equal(proof.cwd, project); assert.equal(proof.branch, 'peer-a');
  assert.equal(proof.privateHead, git('rev-parse', 'HEAD')); assert.equal(proof.publicHead, git('rev-parse', 'origin/peer-a'));
  assert.equal(proof.privateHead, prior.privateHead); assert.notEqual(proof.privateHead, proof.publicHead);
  assert.equal(proof.dirty, 'T15_DIRTY_PRIVATE\n'); assert.equal(proof.binary, 'AP9BCg==');
  assert.equal(await readFile(join(project, 'left.txt'), 'utf8'), proof.dirty);
});
