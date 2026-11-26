import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installNotesExample, execute } from './fixtures/notes-installed-package.js';

test('installed Notes entry documents and inspects real failed Runtime receipts', { timeout: 210_000 }, async t => {
  const installed = await installNotesExample(); t.after(() => installed.close());
  const options = { cwd: installed.directory, env: installed.env, timeout: 20_000 };
  const run = (...args) => execute(process.execPath, [`--redirect-warnings=${join(installed.directory, 'node-warnings.log')}`, 'main.mjs', ...args], options);
  const help = await run('--help');
  assert.match(help.stdout, /--result <run-directory> --runtime-id <expected-id>/);
  const outputDir = join(installed.directory, 'failed-runs');
  await writeFile(join(installed.directory, 'failed-config.mjs'), `export default {
image:'unused',outputDir:${JSON.stringify(outputDir)},fact:{baseline:'',source:'x',finding:'x'},
sandbox:{lifecycleBaseUrl:'http://127.0.0.1:1/v1',isolation:{disk:{bytes:67108864,inodes:4096}}},
connection:{advertiseHost:'172.17.0.1'},
models:{default:{provider:'kimi_proxy',model:'k3',upstream:{url:'http://127.0.0.1:1/v1/responses',headers:{authorization:'PRIVATE_UNUSED_MODEL_KEY'}}}},
};`);
  let report;
  await assert.rejects(run('failed-config.mjs'), error => {
    assert.equal(error.code, 1); report = JSON.parse(error.stdout);
    assert.ok(report.businessFailure); assert.equal(report.cleanup.cleanup, 'complete');
    assert.deepEqual(report.cleanup.agents, []); return true;
  });
  const directory = join(outputDir, report.runtimeId);
  const inspected = JSON.parse((await run('--result', directory, '--runtime-id', report.runtimeId)).stdout);
  assert.equal(inspected.harness.business, 'failed');
  assert.equal(inspected.harness.acceptance, 'not-interpreted');
  assert.equal(inspected.core.recordedStatus, 'closed');
  assert.equal(inspected.core.cleanup, 'complete');
  assert.deepEqual(inspected.core.agents, []);
  assert.equal(JSON.stringify(inspected).includes('PRIVATE_UNUSED_MODEL_KEY'), false);
  assert.equal(inspected.harness.resultLocation.path, report.reportPath);
  assert.deepEqual(JSON.parse(await readFile(report.reportPath, 'utf8')).businessFailure, report.businessFailure);
  await assert.rejects(run('--result', directory, '--runtime-id', 'other-runtime'), error => {
    assert.equal(error.code, 1); const value = JSON.parse(error.stdout);
    assert.equal(value.harness.state, 'identity-mismatch'); assert.equal(value.core.state, 'identity-mismatch');
    assert.equal(value.harness.business, 'unknown'); return true;
  });
  for (const args of [[], ['failed-config.mjs','extra'], ['--result',directory], ['--result',directory,'--runtime-id','--help']]) {
    await assert.rejects(run(...args), error => { assert.equal(error.code, 2); assert.equal(JSON.parse(error.stderr).code,'NOTES_ARGUMENTS_INVALID'); return true; });
  }
  await writeFile(join(installed.directory, 'throwing-config.mjs'), "throw new Error('PRIVATE_CONFIG_VALUE');\n");
  await assert.rejects(run('throwing-config.mjs'), error => {
    assert.equal(error.code, 1); assert.deepEqual(JSON.parse(error.stderr), {code:'NOTES_START_FAILED'});
    assert.equal(error.stderr.includes('PRIVATE_CONFIG_VALUE'),false); return true;
  });
});
