import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  const upstream = await createNotesEnvironmentUpstream(); t.after(() => upstream.close());
  const send = input => fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input }) });
  const rows = [
    { role: 'writer', cwd: '/workspace/project', session: 'a'.repeat(64), author: 'writer', replay: true, conflict: true, forged: true, permission: true },
    { role: 'reader', cwd: '/workspace/project', session: 'b'.repeat(64), author: 'writer', read: true, permission: true },
    { role: 'followup', cwd: '/workspace/project', session: 'b'.repeat(64), continuity: true, bytes: 200 },
  ];
  for (const row of rows) {
    assert.equal((await send([])).status, 200);
    assert.equal((await send([{ type: 'function_call_output', call_id: `notes_${row.role}`, output: JSON.stringify(row) }])).status, 200);
  }
  assert.deepEqual(upstream.receipt(), { arrivals: 6, accepted: 6, failure: undefined, evidence: rows });
  assert.match(await (await send([])).text(), /CONTROLLED_NOTES_ENVIRONMENT_FAILED/);
  assert.equal(upstream.receipt().accepted, 6);
});
