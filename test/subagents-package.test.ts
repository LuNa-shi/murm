import assert from 'node:assert/strict';
import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { installNotesExample, execute } from './fixtures/notes-installed-package.js';

test('external installed subagents example imports only package exports and adjacent host modules', { timeout: 210_000 }, async t => {
  const installed = await installNotesExample(); t.after(() => installed.close());
  for (const name of ['main', 'controller', 'collaboration-service', 'prompts']) {
    await copyFile(join(installed.directory, 'node_modules/@murm/core/dist/examples/subagents', `${name}.js`), join(installed.directory, `${name}.js`));
  }
  await copyFile(join(installed.directory, 'node_modules/@murm/core/dist/src/harnesses/shared/run-report.js'), join(installed.directory, 'run-report.js'));
  await writeFile(join(installed.directory, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import {runSubagentsHarness} from './main.js';
for (const name of ['@murm/core','@murm/core/services','@murm/core/backends/pi-opensandbox']) assert.ok(import.meta.resolve(name).startsWith(new URL('./node_modules/',import.meta.url).href));
const cancelled=new AbortController(); cancelled.abort();
for (const maxAgents of [2,3,7]) {
const report=await runSubagentsHarness({maxAgents,backend:{},image:'unused',outputDir:'./runs-'+maxAgents},cancelled.signal);
assert.equal(report.businessFailure.message,'This operation was aborted'); assert.equal(report.cleanup,null); assert.ok(report.reportPath);
}
console.log(JSON.stringify({external:true,cancelled:true}));
`);
  const result = await execute(process.execPath, ['smoke.mjs'], { cwd: installed.directory, env: installed.env, timeout: 15_000 });
  assert.deepEqual(JSON.parse(result.stdout), { external: true, cancelled: true });
});
