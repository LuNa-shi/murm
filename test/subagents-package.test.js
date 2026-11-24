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
import {createSubagentsHourConfiguration} from './node_modules/@swarmenv/core/examples/subagents-environment/hour-config.mjs';
import {writeFile,readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const taskSource='export default {prompt:()=>"offline task",verify:()=>true}';
await writeFile('workload.mjs',taskSource);
const native=await createSubagentsHourConfiguration({env:{
 SWARMENV_HOUR_IMAGE:'sha256:'+'a'.repeat(64),
 SWARMENV_HOUR_WORKLOAD:new URL('./workload.mjs',import.meta.url).pathname,
 SWARMENV_HOUR_WORKLOAD_SHA256:createHash('sha256').update(taskSource).digest('hex'),
 SWARMENV_HOUR_UPSTREAM_URL:'http://127.0.0.1:1/v1/responses',
 SWARMENV_HOUR_UPSTREAM_HEADERS_JSON:'{}',
 SWARMENV_HOUR_OUTPUT_ROOT:new URL('./experiments',import.meta.url).pathname,
}});
try {
 assert.equal(native.backend.modelGateway.maxOutputTokens,null);
 assert.equal(native.budgets.turnMs,600000);
 assert.equal(native.budgets.workMs,3900000);
 assert.equal(native.backend.sandbox.timeoutSeconds,5160);
 assert.equal(JSON.parse(await readFile(native.outputDir+"/configuration.json","utf8")).budgets.turnMs,600000);
 assert.equal(native.backend.models.default.upstream.url,native.quota.url);
 assert.equal(native.quota.receipt().forwarded,0);
 assert.equal(typeof native.observeSessions,'function');
 assert.equal((await stat(native.outputDir)).mode&0o077,0);
}finally{await native.quota.close();}
assert.equal(JSON.parse(await readFile(native.custodyPath,'utf8')).closed,true);

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
