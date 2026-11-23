import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { runWithReport } from '../src/environments/shared/run-report.js';
import { leadHelperCommand, adjustedDirection } from './fixtures/lead-helper-upstream.js';
import { transport } from './fixtures/core-bot-service-backend.js';
import { closeLeadHelperFixture, drainLeadHelperFixture } from './fixtures/lead-helper-scenario-cleanup.js';
const execute = promisify(execFile);
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return { url: new URL('./fixtures/lead-helper-backend.js', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
const { createLeadHelperEnvironment } = await import('../src/environments/lead-helper/index.js'); hooks.deregister();

async function scenario(t, failure, fixturePrograms = false, helperCount = 2) {
  const helpers = Array.from({ length: helperCount }, (_, index) => `helper${index + 1}`);
  transport.reset(); transport.collectable = true; let environment; let lock; let server;
  const work = new Set(), guests = new Map(), commands = new AbortController(); let stopping = false;
  let drain;
  const drainWork = () => drain ??= drainLeadHelperFixture({ guests: guests.values(), work,
    stopWork() { stopping = true; commands.abort(); },
  });
  const run = (command, args, options = {}) => {
    if (stopping) return Promise.reject(new Error('Fixture is stopping'));
    return execute(command, args, { timeout: 15000, ...options, signal: commands.signal });
  };
  const directory = await mkdtemp(join(tmpdir(), 'lead-helper-public-'));
  t.after(() => closeLeadHelperFixture({ directory, server, drain: drainWork,
    async reconcile() {
      if (lock) { lock.exec('ROLLBACK'); lock.close(); }
      transport.onStop = undefined;
      await environment?.close({ timeoutMs: 2000 });
      const reconciled = await environment?.close({ timeoutMs: 2000 });
      if (environment) {
        assert.equal(reconciled.cleanup, 'complete');
        assert.ok(reconciled.bots.every(row => row.execution === 'stopped' && row.cleanup === 'complete'));
      }
      if (failure === 'locked-failed') {
        assert.equal(environment.snapshot().board.subtasks.find(row => row.id === 'helper1').failure.code, 'input_failed');
      }
    },
  }));
  const repository = join(directory, 'repo.git'); await run('git', ['init', '--bare', repository]);
  if (fixturePrograms) { const seed = join(directory, 'seed'); await run('git', ['init', '-b', 'main', seed]); await writeFile(join(seed, 'README.txt'), 'Initial project\n'); await run('git', ['-C', seed, 'add', '.']); await run('git', ['-C', seed, '-c', 'user.name=fixture', '-c', 'user.email=fixture@test.invalid', 'commit', '-m', 'Seed']); await run('git', ['-C', seed, 'push', repository, 'main']); }
  const bin = join(directory, 'bin'); await mkdir(bin); await writeFile(join(bin, 'swarm'), `#!/usr/bin/env node\nimport(${JSON.stringify(new URL('../scripts/swarm.mjs', import.meta.url).href)});\n`, { mode: 0o700 });
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost'); let result;
      if (url.pathname.includes('/branches/')) result = { commit: { id: (await run('git', ['--git-dir', repository, 'rev-parse', url.pathname.split('/').at(-1)])).stdout.trim() } };
      else if (url.pathname.includes('/contents/')) {
        const path = decodeURIComponent(url.pathname.split('/contents/')[1]); const content = (await run('git', ['--git-dir', repository, 'show', `${url.searchParams.get('ref')}:${path}`])).stdout;
        result = { type: 'file', encoding: 'base64', path, size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64') };
      } else throw new Error('Unexpected fixture route');
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
    } catch { response.writeHead(400).end('{}'); }
  }); server.listen(0, '0.0.0.0'); await once(server, 'listening');
  const localAddress = Object.values(networkInterfaces()).flat().find(row => row.family === 'IPv4' && !row.internal).address;
  const origin = `http://${localAddress}:${server.address().port}`;
  const actors = Object.fromEntries(['lead', ...helpers].map(role => [role, { accountId: role, username: role, token: `private-${role}`, branch: role + (fixturePrograms ? '-test' : ''), binding: `test:${role}` }]));
  const team = {}; const privateDirectories = {}; let backgroundFailure;
  transport.onSpawn = async start => {
    const role = start.options.profile; team[role] = start.botId; privateDirectories[role] = join(directory, role); await mkdir(privateDirectories[role]);
    assert.equal(start.options.parentId, undefined); assert.equal(start.options.secretEnv.GITEA_TOKEN, `private-${role}`);
    assert.equal(start.profile.services.bot, undefined); assert.equal(start.profile.env.WORK_BRANCH, actors[role].branch);
    if (role !== 'lead' && !fixturePrograms) { await run('git', ['clone', repository, privateDirectories[role]]); await run('git', ['-C', privateDirectories[role], 'switch', '-c', role]); }
  };
  const call = async (role, operation, input = {}, requestId) => {
    const start = transport.spawns.get(team[role]); const file = join(privateDirectories[role], 'request.json'); await writeFile(file, JSON.stringify(input));
    const result = await run(process.execPath, [new URL('../scripts/swarm.mjs', import.meta.url).pathname, 'board', operation, '--input', file, '--request-id', requestId ?? `${role}-${operation}-${++serial}`], { cwd: privateDirectories[role], env: { ...process.env, ...start.credentials.environment, ...start.credentials.secretEnvironment }, timeout: 10000 });
    return JSON.parse(result.stdout);
  };
  let serial = 0;
  function arm() { transport.next = inputId => {
    const pending = (async () => {
    arm();
    const input = transport.submissions.get(inputId); const payload = JSON.parse(input.input); const role = Object.keys(team).find(role => team[role] === input.botId);
    assert.equal(input.mode, 'followUp');
    try {
      if (fixturePrograms) {
        const start = transport.spawns.get(input.botId);
        if (!guests.has(role)) {
          const program = `process.title='pi';const {execFile}=require('node:child_process');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const command=JSON.parse(line);execFile('bash',['-c',command],{timeout:15000,maxBuffer:4194304},(error,stdout,stderr)=>process.stdout.write(JSON.stringify({ok:!error,stdout,stderr})+'\\n'))});`;
          guests.set(role, spawn(process.execPath, ['-e', program], { detached: true, cwd: privateDirectories[role], env: { ...process.env, ...start.profile.env, ...start.credentials.environment, ...start.credentials.secretEnvironment, RUN_REPOSITORY: repository, PATH: bin + ':' + process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] }));
        }
        const sessionDirectory = join(privateDirectories[role], '.sessions');
        if (payload.type === 'user-and-feedback' || payload.type === 'helper-followup') { await mkdir(sessionDirectory); await writeFile(join(sessionDirectory, role + '.jsonl'), ''); }
        const guest = guests.get(role);
        const result = await new Promise((resolve, reject) => {
          let line = '';
          const finish = (error, value) => { clearTimeout(timer); guest.stdout.off('data', receive); guest.off('close', ended); if (error) reject(error); else resolve(value); };
          const ended = () => finish(new Error('Simulated guest stopped'));
          const receive = data => { line += data; if (line.includes('\n')) { try { finish(null, JSON.parse(line.trim())); } catch (error) { finish(error); } } };
          const timer = setTimeout(() => finish(new Error('Guest test deadline')), 18000);
          guest.stdout.on('data', receive); guest.once('close', ended);
          guest.stdin.write(JSON.stringify(leadHelperCommand(payload.type, { sessionDirectory })) + '\n');
        });
        assert.equal(result.ok, true, result.stderr);
        const row = JSON.parse(result.stdout); assert.equal(row.role, role); assert.equal(row.botId, input.botId);
        transport.spawns.get(input.botId).onEvent({ type: 'settled', outcome: 'completed', output: 'PUBLIC_OK' });
        return;
      }

      if (role === 'lead') {
        const state = await call(role, 'read');
        if (payload.type === 'initialize') {
          assert.deepEqual(payload.helpers, Object.fromEntries(helpers.map(name => [name, team[name]])));
          await call(role, 'announce', { text: 'Implement basic checks', feedback_ids: [] });
          for (const helper of helpers) { await call(role, 'assign', { helper_id: team[helper], text: helper }); await call(role, 'create_subtask', { id: helper, title: 'Initial artifact', path: `${helper}.txt` }); }
        } else {
          assert.equal(payload.supplement, 'Add explicit evidence');
          await call(role, 'announce', { text: 'Add explicit evidence based on public feedback', feedback_ids: state.notes.map(row => row.seq), user_input_id: payload.user_input_id });
          for (const helper of helpers) await call(role, 'create_subtask', { id: `${helper}-next`, title: 'Adopt evidence direction', path: `${helper}-next.txt` });
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
        const git = args => run('git', ['-C', privateDirectories[role], ...args], { env: { ...process.env, GIT_AUTHOR_NAME: role, GIT_COMMITTER_NAME: role, GIT_AUTHOR_EMAIL: `${role}@test.invalid`, GIT_COMMITTER_EMAIL: `${role}@test.invalid` } });
        await git(['add', path]); await git(['commit', '-m', id]); await git(['push', 'origin', role]);
        const commit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
        const delivery = { commit, path, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') };
        await call(role, 'complete', { subtask_id: id, expected_revision: owned.revision, direction_id: state.directions.at(-1).seq, delivery });
        await call(role, 'note', { subtask_id: id, text: next ? 'New direction adopted and verified' : 'Please require explicit evidence in the next direction' });
      }
      transport.spawns.get(input.botId).onEvent({ type: 'settled', outcome: 'completed', output: 'Public Board records contain evidence' });
    } catch (error) { if (stopping) return; backgroundFailure = error; transport.spawns.get(input.botId).onEvent({ type: 'settled', outcome: 'failed', error: { code: 'FIXTURE_FAILED', message: 'Deterministic fixture failed' } }); }
    })().finally(() => work.delete(pending));
    work.add(pending); return pending;
  }; } arm();
  if (failure === 'unknown') transport.onStop = botId => { if (botId === team.helper1) throw new Error('Controlled stop uncertainty'); };
  const configuration = { runId: 'test', outputDir: directory, image: 'test', backend: {}, ...(helperCount === 2 ? {} : { helperCount }), turnTimeoutMs: 10000, workTimeoutMs: 30000, closeTimeoutMs: 1000,
    prepare: async () => ({ runId: 'test', origin, repository: { owner: 'owner', name: 'repo' }, repositoryUrl: `${origin}/owner/repo.git`, actors }) };
  const report = await runWithReport({ outputDir: directory, closeTimeoutMs: 1000, createRuntime: async () => {
    const owned = await createLeadHelperEnvironment(configuration);
    // The simulator cannot outlive the first Core close: a complete receipt is
    // cached, so a later close cannot flush evidence from an unfinished send.
    environment = { ...owned, async close(options) { await drainWork(); return owned.close(options); } };
    return environment;
  }, run: owned => owned.runWorkflow({ goal: 'Deliver one check per assigned helper', supplement: fixturePrograms ? adjustedDirection : 'Add explicit evidence' }), redact: value => environment ? environment.redact(value) : value });
  if (!failure) assert.equal(backgroundFailure, undefined, backgroundFailure?.stderr ?? String(backgroundFailure));
  assert.equal(transport.spawns.size, helperCount + 1, JSON.stringify(report.businessFailure)); assert.equal(JSON.stringify(report).includes('private-helper'), false);
  if (failure) {
    assert.ok(report.businessFailure);
    if (failure === 'locked-failed') assert.equal(report.businessFailure.code, 'input_failed', 'Board persistence failure cannot replace the native failure');
    const state = report.businessFailure.details.at(-1).board;
    const task = state.subtasks.find(row => row.id === 'helper1'); assert.equal(task.owner, team.helper1); if (failure === 'locked-failed') assert.ok(report.businessFailure.details.at(-1).pendingBoardFailures.some(row => row.botId === team.helper1 && row.code === 'input_failed')); else assert.ok(task.failure); assert.equal(task.state, 'claimed');
    assert.equal(transport.submissions.size, helperCount + 1, 'No adjustment, replacement or resubmission after failure');
    if (failure === 'unknown') { assert.ok(report.cleanupFailure); assert.equal(report.cleanup.bots.find(row => row.botId === team.helper1).execution, 'unknown'); }
  } else {
    assert.equal(report.businessFailure, null, JSON.stringify(report.businessFailure)); assert.equal(report.cleanupFailure, null, JSON.stringify(report.cleanup));
    const result = report.result; assert.equal(result.environment.delivered.length, helperCount * 2); assert.equal(result.environment.inputs.length, helperCount * 2 + 2); assert.equal(result.environment.unfinished.length, fixturePrograms ? 1 : 0);
    assert.deepEqual(new Set(result.environment.delivered.map(row => row.owner)), new Set(helpers.map(role => team[role])));
    assert.equal(result.adjustedDirection.user_input_id, 'lead-adjust'); assert.equal(result.adjustedDirection.feedback_ids.length, helperCount);
    assert.equal(report.cleanup.bots.length, helperCount + 1); assert.equal(report.cleanup.cleanup, 'complete');
    const saved = JSON.parse(await readFile(report.reportPath)); assert.equal(saved.result.environment.delivered.length, helperCount * 2);
  }
}

test('public Core and actual CLI/Bridge verify initialization, both owners, Git bytes, user feedback and adopted direction', t => scenario(t));
test('helper failed round ends bounded work and preserves its original claim', t => scenario(t, 'failed'));
test('helper submission and stop unknown retain original owner, input identity and required dependencies', t => scenario(t, 'unknown'));

test('SQLite write lock cannot prevent Core stop or replace a failed input; pending evidence reconciles after unlock', t => scenario(t, 'locked-failed'));

test('exact generated native Bash programs use actual CLI, Core Board and Git while title-mutated processes persist', t => scenario(t, undefined, true));

test('four-Bot fixed lead-helper team completes both rounds with distinct authorized delivery owners', t => scenario(t, undefined, false, 3));
test('eight-Bot fixed lead-helper team completes both rounds with distinct authorized delivery owners', t => scenario(t, undefined, false, 7));
test('invalid helper capacity fails before provisioning', async () => {
  for (const helperCount of [1, 8, 2.5, '3', null]) {
    await assert.rejects(createLeadHelperEnvironment({ helperCount, prepare: assert.fail }), {
      name: 'TypeError', message: 'Lead-helper requires between two and seven helpers',
    });
  }
});

test('lead-helper provisions the capacity captured before async startup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lead-helper-capacity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    runId: 'test', image: 'test', outputDir: directory, helperCount: 3,
    async prepare({ helperCount }) {
      assert.equal(helperCount, 3);
      throw Object.assign(new Error('controlled startup stop'), { code: 'CAPACITY_OBSERVED' });
    },
  };
  const creating = createLeadHelperEnvironment(options);
  options.helperCount = 7;
  await assert.rejects(creating, { code: 'CAPACITY_OBSERVED' });
});
