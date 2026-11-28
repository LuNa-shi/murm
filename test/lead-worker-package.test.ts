import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { installNotesExample, execute } from './fixtures/notes-installed-package.js';

test('actual installed package resolves public Core and lead-worker CLI outside checkout with no hosted or sandbox call', { timeout: 180_000 }, async t => {
  const installed = await installNotesExample(); t.after(() => installed.close());
  const main = join(installed.directory, 'node_modules/@luna-shi/murm/dist/benchmarks/lead-worker-orders/main.js');
  const script = `import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';const core=import.meta.resolve('@luna-shi/murm');assert.ok(core.includes('/node_modules/@luna-shi/murm/'));const {runLeadWorkerExample}=await import(pathToFileURL(${JSON.stringify(main)}));const controller=new AbortController();controller.abort();const report=await runLeadWorkerExample({runId:'preflight',image:'no-image-start',outputDir:${JSON.stringify(join(installed.directory, 'output'))},sandbox:{lifecycleBaseUrl:'http://127.0.0.1:1/v1',isolation:{disk:{bytes:67108864,inodes:4096}}},connection:{advertiseHost:'172.17.0.1'},models:{default:{provider:'kimi_proxy',model:'k3',upstream:{url:'http://127.0.0.1:1/v1/responses',headers:{}}}}},controller.signal);assert.equal(report.businessFailure.code,'HARNESS_START_ABORTED');assert.equal(report.cleanupFailure,null);console.log(JSON.stringify({core,aborted:true}));`;
  const child = await execute(process.execPath, ['--input-type=module', '-e', script], { cwd: installed.directory, env: installed.env, timeout: 15000, maxBuffer: 1024 ** 2 });
  assert.equal(JSON.parse(child.stdout).aborted, true);
});
