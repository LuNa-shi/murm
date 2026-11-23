import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { completeSimple, isRetryableAssistantError } from '@earendil-works/pi-ai/compat';
import { test } from 'node:test';
import { installNotesExample, execute } from './fixtures/notes-installed-package.js';
import { createNotesEnvironmentUpstream, notesEnvironmentCommand } from './fixtures/notes-environment-upstream.js';

test('external installed archive resolves public exports and runs the copied Environment without a checkout import', { timeout: 210_000 }, async t => {
  const installed = await installNotesExample(); t.after(() => installed.close());
  const upstream = await createNotesEnvironmentUpstream(); t.after(() => upstream.close());
  await writeFile(join(installed.directory, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import { createRuntime } from '@swarmenv/core';
import { ServiceRegistry } from '@swarmenv/core/services';
import { createPiOpenSandboxBackend } from '@swarmenv/core/backends/pi-opensandbox';
import {runNotesEnvironment} from './main.mjs';
for (const specifier of ['@swarmenv/core','@swarmenv/core/services','@swarmenv/core/backends/pi-opensandbox']) {
 assert.ok(import.meta.resolve(specifier).startsWith(new URL('./node_modules/',import.meta.url).href));
}
const backend={sandbox:{lifecycleBaseUrl:'http://127.0.0.1:1/v1'},bridge:{host:'127.0.0.1',publicUrl:'http://172.17.0.1:{port}'},
modelGateway:{host:'127.0.0.1',advertiseHost:'172.17.0.1'},models:{default:{provider:'kimi_proxy',model:'k3',upstream:{url:${JSON.stringify(upstream.url)},headers:{}}}},isolation:{network:'local-docker',disk:{bytes:67108864,inodes:4096}}};
const runtime=await createRuntime({backend:createPiOpenSandboxBackend(backend),services:new ServiceRegistry(),profiles:{reader:{prompt:'fixed',model:'default',image:'unused',writable:false,services:{}}},maxBots:2,outputDir:'./preflight'});
const closed=await runtime.close(); assert.equal(closed.cleanup,'complete'); assert.deepEqual(closed.bots,[]);
const controller=new AbortController(); controller.abort();
const report=await runNotesEnvironment({backend,image:'unused',outputDir:'./cancelled'},controller.signal);
assert.ok(report.businessFailure); assert.equal(report.cleanup,null); assert.ok(report.reportPath);
console.log(JSON.stringify({resolved:true,closed:true,cancelled:true}));
`);
  const result = await execute(process.execPath, ['smoke.mjs'], { cwd: installed.directory, env: installed.env, timeout: 15_000 });
  assert.deepEqual(JSON.parse(result.stdout), { resolved: true, closed: true, cancelled: true });
  assert.equal(upstream.receipt().arrivals, 0);
  assert.match(installed.metadata.sha256, /^[a-f0-9]{64}$/);
});

test('fixed Notes scripts parse and response budget is sticky across malformed arrivals', async t => {
  for (const role of ['writer', 'reader', 'followup']) {
    const program = notesEnvironmentCommand(role).split("<<'NOTES_ENVIRONMENT'\n")[1].split('\nNOTES_ENVIRONMENT')[0];
    await execute('python3', ['-c', 'import ast,sys; ast.parse(sys.argv[1])', program]);
  }
  const upstream = await createNotesEnvironmentUpstream(); t.after(() => upstream.close());
  const send = body => fetch(upstream.url, { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await send({ model: 'k3', input: [] })).status, 200);
  const rejected = await send({ model: 'k3', input: [] });
  assert.equal(rejected.status, 200);
  assert.match(await rejected.text(), /CONTROLLED_NOTES_ENVIRONMENT_FAILED/);
  for (let index = 0; index < 5; index++) await send({ model: 'k3', input: [] });
  assert.equal(upstream.receipt().arrivals, 7); assert.equal(upstream.receipt().accepted, 1);
  assert.deepEqual(upstream.receipt().failure, { code: 'CONTROLLED_NOTES_ENVIRONMENT_FAILED', stage: 'writer-tool-evidence', ordinal: 2 });
});

test('the loopback fixture requires six uniquely correlated writer/reader/followup responses', async t => {
  const observations = [];
  const upstream = await createNotesEnvironmentUpstream({ observeSessions: async phase => observations.push(phase) }); t.after(() => upstream.close());
  const send = input => fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input }) });
  const rows = [
    { role: 'writer', cwd: '/workspace/project', process: { pid: 12, starttime: '34' }, author: 'writer', replay: true, conflict: true, forged: true, permission: true },
    { role: 'reader', cwd: '/workspace/project', process: { pid: 56, starttime: '78' }, author: 'writer', read: true, permission: true },
    { role: 'followup', cwd: '/workspace/project', process: { pid: 56, starttime: '78' }, sessionId: 'b'.repeat(36), continuity: true, bytes: 200 },
  ];
  for (const row of rows) {
    assert.equal((await send([])).status, 200);
    assert.equal((await send([{ type: 'function_call_output', call_id: `notes_${row.role}`, output: JSON.stringify(row) }])).status, 200);
  }
  assert.deepEqual(observations, ['before-followup', 'after-followup']);
  assert.deepEqual(upstream.receipt(), { arrivals: 6, accepted: 6, failure: undefined, evidence: rows });
  assert.match(await (await send([])).text(), /CONTROLLED_NOTES_ENVIRONMENT_FAILED/);
  assert.equal(upstream.receipt().accepted, 6);
});


test('native ancestry survives Pi process.title mutation and retains pid/starttime across turns', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'notes-title-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const program = notesEnvironmentCommand('reader').split("pid=os.getppid()\n")[1].split("evidence=")[0];
  await writeFile(join(directory, 'probe.mjs'), `
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
process.title='pi-rpc';
assert.ok(!readFileSync('/proc/self/cmdline','utf8').includes('--session-id'));
const program=${JSON.stringify('pid=os.getppid()\n' + program + 'print(json.dumps(identity))')};
const observe=()=>JSON.parse(execFileSync('python3',['-c','import os,pathlib,json\\n'+program],{encoding:'utf8'}));
const first=observe(); const second=observe();
assert.equal(first.pid,process.pid); assert.deepEqual(first,second);
console.log(JSON.stringify(first));
`);
  const fact = { baseline: 'fixed', source: 'source', finding: 'finding' };
  await writeFile(join(directory, 'review-input.json'), JSON.stringify(fact));
  await writeFile(join(directory, 'swarm'), `#!/usr/bin/env node
if(process.argv[3]==='put') {console.error(JSON.stringify({code:'NOT_ALLOWED'}));process.exit(1)}
console.log(JSON.stringify({author:'writer',text:${JSON.stringify(JSON.stringify(fact))}}));
`, { mode: 0o700 });
  await writeFile(join(directory, 'reader.mjs'), `
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
process.title='pi-rpc';
const command=${JSON.stringify(notesEnvironmentCommand('reader'))};
const row=JSON.parse(execFileSync('bash',['-c',command],{encoding:'utf8',env:{...process.env,PATH:process.cwd()+':'+process.env.PATH}}));
assert.equal(row.process.pid,process.pid); assert.ok(row.read&&row.permission);
assert.equal(readFileSync('review.md','utf8'),'# Source review\\n\\nBaseline: fixed\\nSource: source\\nFinding: finding\\n');
`);
  await execute(process.execPath, ['reader.mjs'], { cwd: directory });
  const result = await execute(process.execPath, ['probe.mjs'], { cwd: directory });
  assert.ok(JSON.parse(result.stdout).pid > 1);
});

test('Notes terminal failure is an error with no native Pi retry classification', async t => {
  const upstream = await createNotesEnvironmentUpstream(); t.after(() => upstream.close());
  const model = { id: 'k3', name: 'fixed', provider: 'kimi_proxy', api: 'openai-responses',
    baseUrl: upstream.url.replace(/\/responses$/, ''), reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 128 };
  // The first fixed exchange is admissible; the missing correlated tool result on
  // the next arrival is rejected through the actual Pi Responses parser.
  await fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: [] }) });
  const failed = await completeSimple(model, { messages: [{ role: 'user', content: 'fixed', timestamp: 0 }] },
    { apiKey: 'local-only', maxTokens: 128 });
  assert.equal(failed.stopReason, 'error'); assert.match(failed.errorMessage, /CONTROLLED_NOTES_ENVIRONMENT_FAILED/);
  assert.equal(isRetryableAssistantError(failed), false);
  assert.equal(upstream.receipt().arrivals, 2);
});
