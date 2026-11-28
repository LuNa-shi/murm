import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installNotesExample, execute } from './fixtures/notes-installed-package.js';

test('offline package omits retired hour runners and retains ordinary and staged entry points', {timeout:180000}, async t=>{
  const installed=await installNotesExample();t.after(()=>installed.close());
  await writeFile(join(installed.directory,'containment.mjs'),`
import assert from 'node:assert/strict';
import {access,cp} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=new URL('./node_modules/@luna-shi/murm/',import.meta.url).pathname;
for(const path of ['src/harnesses/endurance','src/harnesses/taskpool','src/harness/hour-window.js','examples/hour-matrix',
 'examples/subagents/hour.mjs','examples/subagents/hour-config.mjs','examples/subagents/hour-artifacts.mjs',
 'examples/subagents/communication-fixture.js','examples/subagents/communication-fixture-controller.js',
 'examples/subagents/communication-fixture-prompts.js','examples/subagents/stages.js',
 'test/core-endurance-quota.test.js','test/fixtures/hour-quota-owner.js','test/fixtures/subagents-hour-backend.js','docs/architecture/prompts/13-hour-matrix.md']) {
 await assert.rejects(access(join(root,path)),{code:'ENOENT'});
 await assert.rejects(access(join(root,'dist',path)),{code:'ENOENT'});
}
for(const path of ['dist/test','dist/benchmarks','dist/test-support/taskpool-legacy']) {
 await assert.rejects(access(join(root,path)),{code:'ENOENT'});
}
for(const path of ['examples/taskpool/harness/harness.js','examples/peermesh/harness/index.js','examples/substrate/harness/index.js','examples/lead-worker/harness/index.js',
 'test-support/subagents/stages.js',
 'examples/substrate/main.js']) await import(pathToFileURL(join(root,'dist',path)));
for(const name of ['drop-peer-response','judge-peer-fixture','project-install-rollback-probe','sandbox-project-probe']) await access(join(root,'dist/test-support',name+'.js'));
// Notes and Subagents are editable adjacent-module examples; assemble their documented layout.
await import('./main.mjs');
await cp(join(root,'dist/examples/subagents'),'subagents',{recursive:true});
await import('./subagents/main.js');
assert.ok(import.meta.resolve('@luna-shi/murm').includes('/node_modules/@luna-shi/murm/'));
console.log(JSON.stringify({contained:true,ordinary:true,staged:true}));
`);
  const result=await execute(process.execPath,['containment.mjs'],{cwd:installed.directory,env:installed.env,timeout:15000});
  assert.deepEqual(JSON.parse(result.stdout),{contained:true,ordinary:true,staged:true});
});
