import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { installNotesExample, execute } from './fixtures/notes-installed-package.js';

test('actual installed package resolves public Core and lead-helper CLI outside checkout with no hosted or sandbox call', { timeout: 180_000 }, async t => {
  const installed = await installNotesExample(); t.after(() => installed.close());
  const main = join(installed.directory, 'node_modules/@swarmenv/core/dist/examples/lead-helper-environment/main.mjs');
  const script = `import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';const core=import.meta.resolve('@swarmenv/core');const services=import.meta.resolve('@swarmenv/core/services');const backend=import.meta.resolve('@swarmenv/core/backends/pi-opensandbox');for(const path of [core,services,backend])assert.ok(path.includes('/node_modules/@swarmenv/core/'));const {runLeadHelperExample}=await import(pathToFileURL(${JSON.stringify(main)}));const controller=new AbortController();controller.abort();const report=await runLeadHelperExample({runId:'preflight',image:'no-image-start',outputDir:${JSON.stringify(join(installed.directory, 'output'))},backend:{sandbox:{lifecycleBaseUrl:'http://127.0.0.1:1/v1'},bridge:{host:'127.0.0.1',publicUrl:'http://172.17.0.1:{port}'},modelGateway:{host:'127.0.0.1',advertiseHost:'172.17.0.1'},models:{default:{provider:'kimi_proxy',model:'k3',upstream:{url:'http://127.0.0.1:1/v1/responses',headers:{}}}},isolation:{network:'local-docker',disk:{bytes:67108864,inodes:4096}}}},controller.signal);assert.equal(report.businessFailure.code,'ENVIRONMENT_START_ABORTED');assert.equal(report.cleanupFailure,null);console.log(JSON.stringify({core,services,backend,aborted:true}));`;
  const child = await execute(process.execPath, ['--input-type=module', '-e', script], { cwd: installed.directory, env: installed.env, timeout: 15000, maxBuffer: 1024 ** 2 });
  assert.equal(JSON.parse(child.stdout).aborted, true);
});
