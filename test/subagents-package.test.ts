import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { installNotesExample, execute } from './fixtures/notes-installed-package.js';

test('external installed subagents example imports only package exports and adjacent host modules', { timeout: 210_000 }, async t => {
  const installed = await installNotesExample(); t.after(() => installed.close());
  for (const name of ['main.js', 'project.js', 'business.js', 'harness/controller.js', 'services/collaboration-service.js', 'prompts/prompts.js']) {
    const target = join(installed.directory, name);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(installed.directory, 'node_modules/@luna-shi/murm/dist/examples/subagents', name), target);
  }
  await writeFile(join(installed.directory, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import {runSubagentsHarness} from './main.js';
assert.ok(import.meta.resolve('@luna-shi/murm').startsWith(new URL('./node_modules/',import.meta.url).href));
const cancelled=new AbortController(); cancelled.abort();
for (const maxAgents of [2,3,7]) {
const report=await runSubagentsHarness({maxAgents,sandbox:{},image:'unused',outputDir:'./runs-'+maxAgents},cancelled.signal);
assert.equal(report.businessFailure.message,'This operation was aborted'); assert.equal(report.cleanup,null); assert.ok(report.reportPath);
}
console.log(JSON.stringify({external:true,cancelled:true}));
`);
  const result = await execute(process.execPath, ['smoke.mjs'], { cwd: installed.directory, env: installed.env, timeout: 15_000 });
  assert.deepEqual(JSON.parse(result.stdout), { external: true, cancelled: true });
});
