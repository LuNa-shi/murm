import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { runWithReport } from '../src/environments/shared/run-report.js';
import { transport } from './fixtures/core-bot-service-backend.js';
const execute = promisify(execFile);
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return { url: new URL('./fixtures/lead-helper-backend.js', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
const { createLeadHelperEnvironment } = await import('../src/environments/lead-helper/index.js'); hooks.deregister();

async function scenario(t, failure) {
  transport.reset(); transport.collectable = true; let environment; let lock;
  const directory = await mkdtemp(join(tmpdir(), 'lead-helper-public-')); t.after(async () => { if (lock) { lock.exec('ROLLBACK'); lock.close(); } transport.onStop = undefined; await environment?.close({ timeoutMs: 2000 }); const reconciled = await environment?.close({ timeoutMs: 2000 }); if (failure === 'locked-failed') { assert.equal(reconciled.cleanup, 'complete'); assert.ok(reconciled.bots.every(row => row.execution === 'stopped')); assert.equal(environment.snapshot().board.subtasks.find(row => row.id === 'helper1').failure.code, 'input_failed'); } await rm(directory, { recursive: true, force: true }); });
  const repository = join(directory, 'repo.git'); await execute('git', ['init', '--bare', repository]);
  const bin = join(directory, 'bin'); await mkdir(bin); await writeFile(join(bin, 'swarm'), `#!/usr/bin/env node\nimport(${JSON.stringify(new URL('../scripts/swarm.mjs', import.meta.url).href)});\n`, { mode: 0o700 });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost'); let result;
      if (url.pathname.includes('/git/refs/heads/')) result = { object: { sha: (await execute('git', ['--git-dir', repository, 'rev-parse', url.pathname.split('/').at(-1)])).stdout.trim() } };
      else if (url.pathname.includes('/contents/')) {
        const path = decodeURIComponent(url.pathname.split('/contents/')[1]); const content = (await execute('git', ['--git-dir', repository, 'show', `${url.searchParams.get('ref')}:${path}`])).stdout;
        result = { type: 'file', encoding: 'base64', path, size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64') };
      } else throw new Error('Unexpected fixture route');
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
    } catch { response.writeHead(400).end('{}'); }
  }); server.listen(0, '0.0.0.0'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const localAddress = Object.values(networkInterfaces()).flat().find(row => row.family === 'IPv4' && !row.internal).address;
  const origin = `http://${localAddress}:${server.address().port}`;
  const actors = Object.fromEntries(['lead', 'helper1', 'helper2'].map(role => [role, { accountId: role, username: role, token: `private-${role}`, branch: role, binding: `test:${role}` }]));
  const team = {}; const privateDirectories = {}; let backgroundFailure;
  transport.onSpawn = async start => {
    const role = start.options.profile; team[role] = start.botId; privateDirectories[role] = join(directory, role); await mkdir(privateDirectories[role]);
    assert.equal(start.options.parentId, undefined); assert.equal(start.options.secretEnv.GITEA_TOKEN, `private-${role}`);
    assert.equal(start.profile.services.bot, undefined); assert.equal(start.profile.env.WORK_BRANCH, role);
    if (role !== 'lead') { await execute('git', ['clone', repository, privateDirectories[role]]); await execute('git', ['-C', privateDirectories[role], 'switch', '-c', role]); }
  };
  const call = async (role, operation, input = {}, requestId) => {
    const start = transport.spawns.get(team[role]); const file = join(privateDirectories[role], 'request.json'); await writeFile(file, JSON.stringify(input));
    const result = await execute(process.execPath, [new URL('../scripts/swarm.mjs', import.meta.url).pathname, 'board', operation, '--input', file, '--request-id', requestId ?? `${role}-${operation}-${++serial}`], { cwd: privateDirectories[role], env: { ...process.env, ...start.credentials.environment, ...start.credentials.secretEnvironment }, timeout: 10000 });
    return JSON.parse(result.stdout);
  };
  let serial = 0;
  function arm() { transport.next = async inputId => {
    arm();
    const input = transport.submissions.get(inputId); const payload = JSON.parse(input.input); const role = Object.keys(team).find(role => team[role] === input.botId);
    assert.equal(input.mode, 'followUp');
    try {
      if (role === 'lead') {
        const state = await call(role, 'read');
        if (payload.type === 'initialize') {
          await call(role, 'announce', { text: 'Implement basic checks', feedback_ids: [] });
          for (const helper of ['helper1', 'helper2']) { await call(role, 'assign', { helper_id: team[helper], text: helper }); await call(role, 'create_subtask', { id: helper, title: 'Initial artifact', path: `${helper}.txt` }); }
        } else {
          assert.equal(payload.supplement, 'Add explicit evidence');
          await call(role, 'announce', { text: 'Add explicit evidence based on public feedback', feedback_ids: state.notes.map(row => row.seq), user_input_id: payload.user_input_id });
          for (const helper of ['helper1', 'helper2']) await call(role, 'create_subtask', { id: `${helper}-next`, title: 'Adopt evidence direction', path: `${helper}-next.txt` });
        }
      } else {
        const state = await call(role, 'read'); const next = payload.type === 'helper-followup'; const id = role + (next ? '-next' : '');
        const owned = await call(role, 'claim', { subtask_id: id, expected_revision: 0 });
        if (failure && role === 'helper1' && !next) {
          if (failure === 'unknown') { input.receipt = { status: 'unknown' }; return; }
          if (failure === 'locked-failed') { lock = new DatabaseSync(join(directory, 'lead-helper-test', 'board.sqlite')); lock.exec('BEGIN IMMEDIATE'); }
          transport.spawns.get(input.botId).onEvent({ type: 'settled', outcome: 'failed', error: { code: 'FIXED_FAILURE', message: 'Controlled failure' } }); return;
        }
        const other = role === 'helper1' ? 'helper2' : 'helper1';
        await assert.rejects(call(role, 'announce', { text: 'forged lead', feedback_ids: [] }));
        await assert.rejects(call(role, 'update_subtask', { subtask_id: other, expected_revision: 0, text: 'unauthorized' }));
        const text = next ? `Adopted ${state.directions.at(-1).text}\n` : `${role} actual initial delivery\n`;
        const path = `${id}.txt`; await writeFile(join(privateDirectories[role], path), text);
        const git = args => execute('git', ['-C', privateDirectories[role], ...args], { env: { ...process.env, GIT_AUTHOR_NAME: role, GIT_COMMITTER_NAME: role, GIT_AUTHOR_EMAIL: `${role}@test.invalid`, GIT_COMMITTER_EMAIL: `${role}@test.invalid` } });
        await git(['add', path]); await git(['commit', '-m', id]); await git(['push', 'origin', role]);
        const commit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
        const delivery = { commit, path, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') };
        await call(role, 'complete', { subtask_id: id, expected_revision: owned.revision, direction_id: state.directions.at(-1).seq, delivery });
        await call(role, 'note', { subtask_id: id, text: next ? 'New direction adopted and verified' : 'Please require explicit evidence in the next direction' });
      }
      transport.spawns.get(input.botId).onEvent({ type: 'settled', outcome: 'completed', output: 'Public Board records contain evidence' });
    } catch (error) { backgroundFailure = error; transport.spawns.get(input.botId).onEvent({ type: 'settled', outcome: 'failed', error: { code: 'FIXTURE_FAILED', message: 'Deterministic fixture failed' } }); }
  }; } arm();
  if (failure === 'unknown') transport.onStop = botId => { if (botId === team.helper1) throw new Error('Controlled stop uncertainty'); };
  const configuration = { runId: 'test', outputDir: directory, image: 'test', backend: {}, turnTimeoutMs: 10000, workTimeoutMs: 30000, closeTimeoutMs: 1000,
    prepare: async () => ({ runId: 'test', origin, repository: { owner: 'owner', name: 'repo' }, repositoryUrl: `${origin}/owner/repo.git`, actors }) };
  const report = await runWithReport({ outputDir: directory, closeTimeoutMs: 1000, createRuntime: async () => { environment = await createLeadHelperEnvironment(configuration); return environment; }, run: owned => owned.runWorkflow({ goal: 'Implement both checks', supplement: 'Add explicit evidence' }), redact: value => environment ? environment.redact(value) : value });
  if (!failure) assert.equal(backgroundFailure, undefined, backgroundFailure?.stderr ?? String(backgroundFailure));
  assert.equal(transport.spawns.size, 3, JSON.stringify(report.businessFailure)); assert.equal(JSON.stringify(report).includes('private-helper'), false);
  if (failure) {
    assert.ok(report.businessFailure);
    if (failure === 'locked-failed') assert.equal(report.businessFailure.code, 'input_failed', 'Board persistence failure cannot replace the native failure');
    const state = report.businessFailure.details.at(-1).board;
    const task = state.subtasks.find(row => row.id === 'helper1'); assert.equal(task.owner, team.helper1); if (failure === 'locked-failed') assert.ok(report.businessFailure.details.at(-1).pendingBoardFailures.some(row => row.botId === team.helper1 && row.code === 'input_failed')); else assert.ok(task.failure); assert.equal(task.state, 'claimed');
    assert.equal(transport.submissions.size, 3, 'No adjustment, replacement or resubmission after failure');
    if (failure === 'unknown') { assert.ok(report.cleanupFailure); assert.equal(report.cleanup.bots.find(row => row.botId === team.helper1).execution, 'unknown'); }
  } else {
    assert.equal(report.businessFailure, null, JSON.stringify(report.businessFailure)); assert.equal(report.cleanupFailure, null, JSON.stringify(report.cleanup));
    const result = report.result; assert.equal(result.environment.delivered.length, 4); assert.equal(result.environment.inputs.length, 6); assert.equal(result.environment.unfinished.length, 0);
    assert.deepEqual(new Set(result.environment.delivered.map(row => row.owner)), new Set([team.helper1, team.helper2]));
    assert.equal(result.adjustedDirection.user_input_id, 'lead-adjust'); assert.equal(result.adjustedDirection.feedback_ids.length, 2);
    assert.equal(report.cleanup.bots.length, 3); assert.equal(report.cleanup.cleanup, 'complete');
    const saved = JSON.parse(await readFile(report.reportPath)); assert.equal(saved.result.environment.delivered.length, 4);
  }
}

test('public Core and actual CLI/Bridge verify initialization, both owners, Git bytes, user feedback and adopted direction', t => scenario(t));
test('helper failed round ends bounded work and preserves its original claim', t => scenario(t, 'failed'));
test('helper submission and stop unknown retain original owner, input identity and required dependencies', t => scenario(t, 'unknown'));

test('SQLite write lock cannot prevent Core stop or replace a failed input; pending evidence reconciles after unlock', t => scenario(t, 'locked-failed'));
