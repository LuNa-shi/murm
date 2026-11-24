import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TaskService } from '../src/task/task-service.js';
import { controls, transport } from './fixtures/flat-controller-backend.js';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return { url: new URL('./fixtures/flat-controller-backend.js', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
const { createFlatAffirmativeEnvironment } = await import('../src/environments/endurance/flat.js'); hooks.deregister();
const execute = promisify(execFile);

test('four actual Flat slots claim/check/integrate fixed candidates and durably finish before replacement', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'flat-affirmative-'));
  transport.reset(); controls.credentials.clear(); controls.preparedFiles.clear();
  const accept = id => { transport.confirm(id, 'started'); transport.next = accept; }; transport.next = accept;
  let owned; let checked = 0;
  t.after(async () => { await owned?.close({ timeoutMs: 2000 }); await rm(root, { recursive: true, force: true }); });
  const directories = new Map();
  controls.onPrepare = async (botId, entries) => {
    const directory = join(root, botId); await mkdir(directory, { recursive: true }); directories.set(botId, directory);
    for (const entry of entries) await writeFile(join(directory, entry.path), entry.bytes);
  };
  t.after(() => { controls.onPrepare = null; });
  const candidates = Array.from({ length: 5 }, (_, i) => ({ summary: `Verify independent candidate ${i}`,
    files: { [`program-${i}.py`]: `assert sum([${i}, 2, 3]) == ${i + 5}\nprint('verified ${i}')\n` } }));
  owned = await createFlatAffirmativeEnvironment({ backend: {}, image: 'fixture', outputDir: root, deadlineAt: Date.now() + 50_000, candidates,
    checker: { identity: { checker_ref: 'actual-python', checker_version: '1', environment_ref: 'controlled' }, timeoutMs: 5000,
      async check(plan) {
        const files = Object.entries(plan.files);
        for (const [path, bytes] of files.filter(([path]) => path.endsWith('.py'))) {
          const source = Buffer.from(bytes).toString();
          const result = await plan.startProcess(() => execute('python3', ['-c', source], { timeout: 2000 }));
          assert.match(result.stdout, /verified/);
        }
        checked++;
        return { verdict: 'PASS', check_mode: 'lean-project', checked_paths: files.map(([path]) => path) };
      } },
    controller: { heartbeatMs: 1000, stallMs: 40_000, hardBudgetMs: 50_000 },
  });
  const cli = async (botId, ...args) => {
    const credentials = controls.credentials.get(botId); assert.ok(credentials);
    const env = { ...process.env, ...credentials.environment, ...credentials.secretEnvironment };
    const url = new URL(env.SWARMENV_BRIDGE_URL); url.hostname = '127.0.0.1'; env.SWARMENV_BRIDGE_URL = url.href.replace(/\/$/, '');
    const { stdout } = await execute(process.execPath, [new URL('../scripts/swarm.mjs', import.meta.url).pathname, ...args], { env, timeout: 15_000 });
    return JSON.parse(stdout);
  };
  const started = await owned.start(); assert.equal(started.bots.length, 4);
  const original = started.bots.map(row => row.botId);
  assert.equal(new Set(original).size, 4);
  await Promise.all(original.map((botId, i) => cli(botId, 'task', 'take', owned.candidates[i].taskId, '--request-id', `take-${i}`)));
  await assert.rejects(cli(original[0], 'workspace', 'save', '--request-id', 'forbidden-save'), error => /NOT_ALLOWED|unavailable|not allowed/i.test(error.stderr));
  transport.listeners.get(original[0])({ type: 'settled', outcome: 'completed' }); await owned.controller.flush();
  assert.ok(owned.snapshot().inputs.some(row => row.source === 'continuation' && row.botId === original[0]), JSON.stringify(owned.snapshot()));
  const finish = async (botId, i) => {
    const candidate = owned.candidates[i];
    const merged = await cli(botId, 'workspace', 'merge', '--from', candidate.revision, '--request-id', `merge-${i}`);
    assert.equal(merged.check.verdict, 'PASS');
    assert.deepEqual(await cli(botId, 'workspace', 'merge', '--from', candidate.revision, '--request-id', `merge-${i}`), merged);
    const published = await cli(botId, 'material', 'publish', '--content', `Independently executed fixed public candidate ${candidate.revision}; PASS ${merged.check.checked_tree}`, '--request-id', `material-${i}`);
    await cli(botId, 'task', 'link', '--task-id', candidate.taskId, '--material-id', published.material.material_id, '--role', 'experience', '--receiving-task-id', candidate.taskId, '--request-id', `link-${i}`);
    try { await cli(botId, 'task', 'finish', '--outcome', 'done', '--material-ids', JSON.stringify([published.material.material_id]), '--workspace-revision', merged.main_revision, '--request-id', `finish-${i}`); }
    catch (error) { assert.ok(owned.tasks.getExecution(owned.tasks.getBot(botId).execution_id).finish, error.stderr); }
    await owned.controller.tick();
    assert.equal(owned.tasks.getTask(candidate.taskId).state, 'DONE');
  };
  await finish(original[0], 0);
  const replacement = owned.snapshot().bots.find(row => !original.includes(row.botId)); assert.ok(replacement);
  assert.equal(replacement.slot, started.bots[0].slot);
  assert.equal(owned.tasks.getBot(original[0]).state, 'CLOSED');
  await cli(replacement.botId, 'task', 'take', owned.candidates[4].taskId, '--request-id', 'replacement-take');
  for (let i = 1; i < 4; i++) await finish(original[i], i);
  await finish(replacement.botId, 4);
  assert.equal(checked, 5);
  assert.equal(owned.snapshot().completion, 'all-tasks-terminal');
  assert.equal(owned.snapshot().liveCapture, false);
  const receipt = await owned.close({ timeoutMs: 5000 });
  assert.equal(receipt.cleanup, 'complete'); assert.ok(receipt.bots.length >= 5 && receipt.bots.length <= 8);
  assert.ok(receipt.bots.every(row => row.execution === 'stopped' && row.cleanup === 'complete'));
  const reopened = new TaskService(join(owned.directory, 'tasks.sqlite'));
  try { for (const row of owned.candidates) assert.equal(reopened.getTask(row.taskId).state, 'DONE'); } finally { reopened.close(); }
});
