import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { installNotesExample, execute } from './fixtures/notes-installed-package.js';

test('installed Substrate host resolves the public backend and saves an aborted run without allocating resources', { timeout: 180_000 }, async t => {
  const installed = await installNotesExample(); t.after(() => installed.close());
  const main = join(installed.directory, 'node_modules/@murm/core/dist/examples/substrate/main.js');
  const script = `import assert from 'node:assert/strict';
    import {readFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';
    const {runSubstrateExample,runFateExample}=await import(pathToFileURL(${JSON.stringify(main)}));
    const signal=AbortSignal.abort(Object.assign(new Error('Controlled stop'),{code:'CONTROLLED_ABORT'}));
    process.env.MURM_SUBSTRATE_RUN='installed-abort';process.env.MURM_SUBSTRATE_IMAGE='no-allocation';
    process.env.MURM_SUBSTRATE_MODEL_URL='http://127.0.0.1:1/v1/responses';
    process.env.MURM_SUBSTRATE_MODEL_TOKEN='PRIVATE_MODEL_TOKEN';
    const config=(await import(new URL('./config.js',pathToFileURL(${JSON.stringify(main)})))).default;
    assert.equal(config.poolSize,3);assert.equal(config.maxRounds,2);
    assert.equal(config.models.default.provider,'kimi_proxy');assert.equal(config.models.default.model,'k3');
    const report=await runSubstrateExample({...config,outputDir:${JSON.stringify(join(installed.directory, 'output'))}},signal);
    assert.equal(report.businessFailure.code,'CONTROLLED_ABORT');assert.equal(report.cleanup,null);
    assert.deepEqual(report.peers,[]);assert.equal(report.reportSaveFailure,null);
    const saved=JSON.parse(await readFile(report.reportPath,'utf8'));
    assert.deepEqual(saved.peers,[]);assert.equal(saved.businessFailure.code,'CONTROLLED_ABORT');
    assert.equal(JSON.stringify(saved).includes('PRIVATE_MODEL_TOKEN'),false);
    assert.ok(import.meta.resolve('@murm/core').includes('/node_modules/@murm/core/'));
    const fate = { ...config, poolSize: 4, fate: {projectRoot:'unused', leanRoot:'unused'} };
    const withModel = (provider, model) => ({
      ...fate,
      models: {default: {...fate.models.default, provider, model}},
    });
    await assert.rejects(runFateExample(fate,signal),{code:'CONTROLLED_ABORT'});
    await assert.rejects(runFateExample(withModel('gpt_proxy','gpt-6.1-sol'),signal),{code:'CONTROLLED_ABORT'});
    await assert.rejects(runFateExample(withModel('kimi_proxy','gpt-6.1-sol'),signal),{code:'FATE_MODEL_INVALID'});
    console.log(JSON.stringify({aborted:true}));`;
  const child = await execute(process.execPath, ['--input-type=module', '-e', script], {
    cwd: installed.directory, env: installed.env, timeout: 15_000, maxBuffer: 1024 ** 2,
  });
  assert.equal(JSON.parse(child.stdout).aborted, true);
});

test('installed Substrate CLI offers help and saved inspection without loading credentials, and hides configuration errors', { timeout: 180_000 }, async t => {
  const installed = await installNotesExample(); t.after(() => installed.close());
  const main = join(installed.directory, 'node_modules/@murm/core/dist/examples/substrate/main.js');
  const { writeFile } = await import('node:fs/promises');
  const config = join(installed.directory, 'private-config.mjs');
  await writeFile(config, "throw new Error('PRIVATE_MODEL_TOKEN');\n");
  const options = { cwd: installed.directory, env: installed.env, timeout: 15_000, maxBuffer: 1024 ** 2 };
  const help = await execute(process.execPath, [main, '--help'], options);
  assert.match(help.stdout, /--result/);
  await assert.rejects(execute(process.execPath, [main, config], options), error => {
    assert.equal(error.code, 1); assert.equal(error.stdout, '');
    assert.deepEqual(JSON.parse(error.stderr), { code: 'SUBSTRATE_START_FAILED' }); return true;
  });
  await assert.rejects(execute(process.execPath, [main, '--result', installed.directory, '--runtime-id', 'missing-run'], options), error => {
    assert.equal(error.code, 1); const value = JSON.parse(error.stdout);
    assert.equal(value.harness.state, 'missing'); assert.equal(value.core.state, 'missing'); return true;
  });
});
