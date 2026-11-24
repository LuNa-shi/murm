import assert from 'node:assert/strict';
import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { installNotesExample, execute } from './fixtures/notes-installed-package.js';

test('external installed subagents example imports only package exports and adjacent host modules', { timeout: 210_000 }, async t => {
  const installed = await installNotesExample(); t.after(() => installed.close());
  for (const name of ['main', 'controller', 'prompts', 'stages', 'hour', 'hour-artifacts']) await copyFile(join(installed.directory, 'node_modules/@swarmenv/core/examples/subagents-environment', `${name}.mjs`), join(installed.directory, `${name}.mjs`));
  await writeFile(join(installed.directory, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import {runSubagentsEnvironment} from './main.mjs';
import {runSubagentsHour} from './hour.mjs';
for (const name of ['@swarmenv/core','@swarmenv/core/services','@swarmenv/core/backends/pi-opensandbox']) assert.ok(import.meta.resolve(name).startsWith(new URL('./node_modules/',import.meta.url).href));
const cancelled=new AbortController(); cancelled.abort();
for (const childCount of [2,3,7]) {
const report=await runSubagentsEnvironment({childCount,backend:{},image:'unused',outputDir:'./runs-'+childCount},cancelled.signal);
assert.equal(report.businessFailure.message,'This operation was aborted'); assert.equal(report.cleanup,null); assert.ok(report.reportPath);
}
let closed=false;
const url='http://127.0.0.1:1/v1/responses',deadlineAt=Date.now()+6000000;
const hour=await runSubagentsHour({backend:{models:{default:{upstream:{url}}}},image:'unused',outputDir:'./hour-cancelled',
  programming:{prompt(){assert.fail('cancelled workload');},verify(){assert.fail('cancelled verifier');}},
  admit(){assert.fail('cancelled admission');},observeSessions(){assert.fail('cancelled Session observation');},
  quota:{url,receipt:()=>({profile:'time_only',deadlineAt,forwarded:0,active:0,closed,unknownRequests:0}),async close(){closed=true;}},
},cancelled.signal);
assert.equal(hour.businessFailure.message,'This operation was aborted');assert.equal(hour.cleanup,null);
assert.equal(hour.quota.closed,true);assert.ok(hour.reportPath);
console.log(JSON.stringify({external:true,cancelled:true}));
`);
  const result = await execute(process.execPath, ['smoke.mjs'], { cwd: installed.directory, env: installed.env, timeout: 15_000 });
  assert.deepEqual(JSON.parse(result.stdout), { external: true, cancelled: true });
});
