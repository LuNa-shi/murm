import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { execute, installNotesExample } from './fixtures/notes-installed-package.js';

const feedback = taskId => ({ taskId, input: 'PRIVATE_FIXED_DIRECTION', requestId: 'fixed-direction', mode: 'steer' });

test('installed Flat CLI and headless host preserve the same directed Task binding and close receipts', { timeout: 180_000 }, async t => {
  const installed = await installNotesExample();
  t.after(() => installed.close());
  const root = join(installed.directory, 'node_modules/@swarmenv/core');
  const config = join(root, 'dist/test/fixtures/foreground-flat-configuration.js');
  const cliOutput = join(installed.directory, 'cli-flat');
  const headlessOutput = join(installed.directory, 'headless-flat');
  await mkdir(cliOutput); await mkdir(headlessOutput);
  const child = spawn(process.execPath, [`--redirect-warnings=${join(installed.directory, 'cli-warnings.log')}`, join(root, 'dist/scripts/run-environment.js'), '--config', config], {
    cwd: installed.directory, env: { ...installed.env, FOREGROUND_TEST_OUTPUT: cliOutput }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  const closed = once(child, 'close');
  const records = [];
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  const lines = createInterface({ input: child.stdout });
  t.after(() => lines.close());
  let handlerFailure;
  lines.on('line', line => {
    const record = JSON.parse(line); records.push(record);
    const send = (id, operation, input) => child.stdin.write(JSON.stringify({ id, operation, input }) + '\n');
    void (async () => {
      if (record.type === 'ready') {
        const { taskId } = JSON.parse(await readFile(join(cliOutput, 'fixture-binding.json'), 'utf8'));
        send('direction', 'input', feedback(taskId));
      }
      if (record.id === 'direction') send('replay', 'input', feedback(record.result.taskId));
      if (record.id === 'replay') send('conflict', 'input', { ...feedback(record.result.taskId), input: 'PRIVATE_CHANGED_DIRECTION' });
      if (record.id === 'conflict') send('status', 'status');
      if (record.id === 'status') send('stop', 'stop');
    })().catch(error => { handlerFailure = error; child.kill('SIGKILL'); });
  });
  const [code, signal] = await closed;
  assert.equal(handlerFailure, undefined); assert.equal(signal, null); assert.equal(code, 1, stderr); assert.equal(stderr, '');

  // Only shipped modules are resolved in this outside-checkout process.
  const entry = join(installed.directory, 'headless-flat.mjs');
  await writeFile(entry, `
import configuration from ${JSON.stringify(pathToFileURL(config).href)};
import {readFile} from 'node:fs/promises';
const {runForegroundEnvironment}=await import(${JSON.stringify(pathToFileURL(join(root, 'dist/src/environments/shared/foreground-host.js')).href)});
const records=[];
const report=await runForegroundEnvironment(configuration,async host=>{
  records.push({type:'ready',status:await host.status()});
  const {taskId}=JSON.parse(await readFile(process.env.FOREGROUND_TEST_OUTPUT+'/fixture-binding.json','utf8'));
  const input={...${JSON.stringify(feedback(null))},taskId};
  for(const [id,value] of [['direction',input],['replay',input],['conflict',{...input,input:'PRIVATE_CHANGED_DIRECTION'}]]) {
    try {records.push({type:'reply',id,result:await host.input(value)});}
    catch(error){records.push({type:'error',id,code:error.code});}
  }
  records.push({type:'reply',id:'status',result:await host.status()});host.stop();
});
console.log(JSON.stringify({records,reportPath:report.reportPath,runtimeId:report.runtimeId}));
`);
  const headless = JSON.parse((await execute(process.execPath, [`--redirect-warnings=${join(installed.directory, 'headless-warnings.log')}`, entry], {
    cwd: installed.directory, env: { ...installed.env, FOREGROUND_TEST_OUTPUT: headlessOutput }, timeout: 20_000,
  })).stdout);
  async function inspect(rows, output, reportPath) {
    const ready = rows.find(row => row.type === 'ready').status;
    const binding = JSON.parse(await readFile(join(output, 'fixture-binding.json'), 'utf8'));
    const saved = JSON.parse(await readFile(reportPath, 'utf8'));
    const core = JSON.parse(await readFile(join(ready.runDirectory, 'runtime.json'), 'utf8'));
    assert.deepEqual(core.config.profiles.researcher.services.workspace, ['workspace_public_diff', 'workspace_public_view', 'workspace_public_read', 'workspace_public_files']);
    assert.equal(ready.runtimeId, saved.runtimeId); assert.equal(core.runtimeId, ready.runtimeId);
    assert.equal(ready.runDirectory, join(output, ready.runtimeId));
    assert.equal(ready.bots.length, 1); assert.equal(ready.bots[0].botId, binding.botId);
    const direction = rows.find(row => row.id === 'direction').result;
    assert.equal(direction.status, 'accepted');
    assert.equal(direction.taskId, binding.taskId); assert.equal(direction.requestId, 'fixed-direction');
    assert.deepEqual(rows.find(row => row.id === 'replay').result, direction);
    assert.deepEqual(rows.filter(row => row.type === 'error'), [{ type: 'error', id: 'conflict', code: 'CONFLICT' }]);
    const status = rows.find(row => row.id === 'status').result;
    assert.equal(status.inputs.filter(row => row.requestId === 'fixed-direction').length, 1);
    assert.equal(status.bots[0].botId, binding.botId);
    const stored = saved.businessFailure.details[0].inputs.find(row => row.source === 'user');
    assert.equal(stored.requestId, 'fixed-direction'); assert.equal(stored.executionId, binding.executionId);
    assert.equal(stored.botId, binding.botId); assert.equal(stored.taskId, binding.taskId);
    assert.equal(stored.mode, 'steer'); assert.equal(stored.receipt.status, 'accepted');
    const journal = (await readFile(core.evidence.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(core.evidence.lost, 0); assert.equal(core.evidence.pending, 0);
    const admitted = journal.filter(row => row.type === 'input' && row.requestId === 'fixed-direction' && row.state === 'accepted');
    assert.equal(admitted.length, 1);
    assert.equal(admitted[0].botId, binding.botId); assert.equal(admitted[0].inputId, stored.receipt.inputId);
    assert.equal(admitted[0].mode, 'steer');
    const db = new DatabaseSync(join(output, 'state.sqlite'), { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT state FROM tasks WHERE task_id=?').get(binding.taskId).state, 'OPEN');
      const execution = db.prepare('SELECT owner_ref,state,task_id FROM executions WHERE execution_id=?').get(binding.executionId);
      assert.equal(execution.owner_ref, binding.botId); assert.equal(execution.task_id, binding.taskId);
      assert.equal(execution.state, 'FAILED');
    } finally { db.close(); }
    const reader = JSON.parse((await execute(process.execPath, [join(root, 'dist/scripts/read-environment-result.js'), '--run-directory', ready.runDirectory, '--runtime-id', ready.runtimeId], { cwd: installed.directory, env: installed.env, timeout: 10_000 })).stdout);
    assert.equal(reader.runtimeId, ready.runtimeId);
    assert.equal(saved.businessFailure.code, 'FLAT_BUSINESS_FAILED');
    assert.equal(saved.cleanupFailure, null); assert.equal(saved.reportSaveFailure, null);
    for (const receipt of [reader.environment, reader.core]) {
      assert.equal(receipt.state, 'read'); assert.equal(receipt.cleanup, 'complete'); assert.equal(receipt.pendingCount, 0);
      assert.deepEqual(receipt.bots.map(bot => [bot.botId, bot.execution, bot.cleanup]), [[binding.botId, 'stopped', 'complete']]);
    }
    assert.equal(reader.environment.acceptance, 'not-interpreted');
    assert.doesNotMatch(JSON.stringify({ rows, reader }), /PRIVATE_/);
    return { config: core.config, runtimeId: ready.runtimeId, binding, direction, reader };
  }
  const terminal = records.at(-1);
  assert.equal(terminal.type, 'result'); assert.equal(terminal.businessFailureCode, 'FLAT_BUSINESS_FAILED');
  const cli = await inspect(records, cliOutput, terminal.reportPath);
  const program = await inspect(headless.records, headlessOutput, headless.reportPath);
  assert.equal(terminal.runtimeId, cli.runtimeId); assert.equal(headless.runtimeId, program.runtimeId);
  assert.notEqual(cli.runtimeId, program.runtimeId); assert.notEqual(cli.binding.botId, program.binding.botId);
  assert.deepEqual(cli.config, program.config);
  assert.equal(cli.direction.status, program.direction.status);
  assert.deepEqual(terminal.bots, cli.reader.core.bots);
});
