import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installNotesExample, execute } from './fixtures/notes-installed-package.js';

test('offline package omits retired hour runners and retains ordinary and staged entry points', {timeout:180000}, async t=>{
  const installed=await installNotesExample();t.after(()=>installed.close());
  await writeFile(join(installed.directory,'containment.mjs'),`
import assert from 'node:assert/strict';
import {access,readdir,copyFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=new URL('./node_modules/@swarmenv/core/',import.meta.url).pathname;
for(const path of ['src/environments/endurance','src/environments/shared/hour-window.js','examples/hour-matrix',
 'examples/subagents-environment/hour.mjs','examples/subagents-environment/hour-config.mjs','examples/subagents-environment/hour-artifacts.mjs',
 'test/core-endurance-quota.test.js','test/fixtures/hour-quota-owner.js','test/fixtures/subagents-hour-backend.js','docs/architecture/prompts/13-hour-matrix.md']) {
 await assert.rejects(access(join(root,path)),{code:'ENOENT'});
 await assert.rejects(access(join(root,'dist',path)),{code:'ENOENT'});
}
for(const name of await readdir(join(root,'dist/test'))) {
 assert.ok(!/^hour-(?!harness-retirement)/.test(name)&&!/^subagents-hour/.test(name));
}
for(const path of ['src/environments/flat/environment.js','src/environments/agensh/index.js','src/environments/scalemas/index.js','src/environments/lead-helper/index.js',
 'examples/subagents-environment/stages.js',
 'examples/scalemas-environment/main.js','examples/lead-helper-environment/main.js']) await import(pathToFileURL(join(root,'dist',path)));
for(const name of ['bot-disk-probe','drop-peer-response','judge-peer-fixture','project-install-rollback-probe','sandbox-project-probe']) await access(join(root,'dist/test-support',name+'.js'));
// Notes and Subagents are editable adjacent-module examples; assemble their documented layout.
await import('./main.mjs');
await mkdir('subagents');
for(const name of ['main','controller','prompts','stages']) await copyFile(join(root,'dist/examples/subagents-environment',name+'.js'),'subagents/'+name+'.js');
await copyFile(join(root,'dist/src/environments/shared/run-report.js'),'subagents/run-report.js');
await import('./subagents/main.js');
assert.ok(import.meta.resolve('@swarmenv/core').includes('/node_modules/@swarmenv/core/'));
console.log(JSON.stringify({contained:true,ordinary:true,staged:true}));
`);
  const result=await execute(process.execPath,['containment.mjs'],{cwd:installed.directory,env:installed.env,timeout:15000});
  assert.deepEqual(JSON.parse(result.stdout),{contained:true,ordinary:true,staged:true});
});
