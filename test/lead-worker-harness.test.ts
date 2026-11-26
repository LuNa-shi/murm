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
import { runWithReport } from '../src/harnesses/shared/run-report.js';
import { leadWorkerCommand, adjustedDirection } from './fixtures/lead-worker-upstream.js';
import { transport } from './fixtures/core-agent-service-backend.js';
import { closeLeadWorkerFixture, drainLeadWorkerFixture } from './fixtures/lead-worker-scenario-cleanup.js';
const execute = promisify(execFile);
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return { url: new URL('./fixtures/lead-worker-backend.js', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
const { createLeadWorkerHarness } = await import('../src/harnesses/lead-worker/index.js'); hooks.deregister();

async function scenario(t, failure, fixturePrograms = false, helperCount = 2, staged = false) {
  const helpers = Array.from({ length: helperCount }, (_, index) => `helper${index + 1}`);
  transport.reset(); transport.collectable = true; let harness; let lock; let server;
  const work = new Set(), guests = new Map(), commands = new AbortController(); let stopping = false;
  let drain;
  const drainWork = () => drain ??= drainLeadWorkerFixture({ guests: guests.values(), work,
    stopWork() { stopping = true; commands.abort(); },
  });
  const run = (command, args, options = {}) => {
    if (stopping) return Promise.reject(new Error('Fixture is stopping'));
    return execute(command, args, { timeout: 15000, ...options, signal: commands.signal });
  };
  const directory = await mkdtemp(join(tmpdir(), 'lead-worker-public-'));
  t.after(() => closeLeadWorkerFixture({ directory, server, drain: drainWork,
    async reconcile() {
      if (lock) { lock.exec('ROLLBACK'); lock.close(); }
      transport.onStop = undefined;
      await harness?.close({ timeoutMs: 2000 });
      const reconciled = await harness?.close({ timeoutMs: 2000 });
      if (harness) {
        assert.equal(reconciled.cleanup, 'complete');
        assert.ok(reconciled.agents.every(row => row.execution === 'stopped' && row.cleanup === 'complete'));
      }
      if (failure === 'locked-failed') {
        assert.equal(harness.snapshot().board.subtasks.find(row => row.id === 'helper1').failure.code, 'input_failed');
      }
    },
  }));
  const repository = join(directory, 'repo.git'); await run('git', ['init', '--bare', repository]);
  if (fixturePrograms) { const seed = join(directory, 'seed'); await run('git', ['init', '-b', 'main', seed]); await writeFile(join(seed, 'README.txt'), 'Initial project\n'); await run('git', ['-C', seed, 'add', '.']); await run('git', ['-C', seed, '-c', 'user.name=fixture', '-c', 'user.email=fixture@test.invalid', 'commit', '-m', 'Seed']); await run('git', ['-C', seed, 'push', repository, 'main']); }
  const bin = join(directory, 'bin'); await mkdir(bin); await writeFile(join(bin, 'swarm'), `#!/usr/bin/env node\nimport(${JSON.stringify(new URL('../scripts/swarm.js', import.meta.url).href)});\n`, { mode: 0o700 });
  const fileReads = new Map();
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost'); let result;
      if (url.pathname.includes('/branches/')) result = { commit: { id: (await run('git', ['--git-dir', repository, 'rev-parse', url.pathname.split('/').at(-1)])).stdout.trim() } };
      else if (url.pathname.includes('/contents/')) {
        const path = decodeURIComponent(url.pathname.split('/contents/')[1]); let content = (await run('git', ['--git-dir', repository, 'show', `${url.searchParams.get('ref')}:${path}`])).stdout;
        fileReads.set(path, (fileReads.get(path) ?? 0) + 1);
        if (failure === 'pinned-corruption' && path === 'helper1-stage-0.txt' && fileReads.get(path) > 1) content = 'corrupt fixed object';
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
    const role = start.options.profile; team[role] = start.agentId; privateDirectories[role] = join(directory, role); await mkdir(privateDirectories[role]);
    assert.equal(start.options.parentId, undefined); assert.equal(start.options.secretEnv.GITEA_TOKEN, `private-${role}`);
    assert.equal(start.options.collect.required,true);
    assert.equal(start.options.collect.includeGit,true);
    assert.equal(start.profile.services.agent, undefined); assert.equal(start.profile.env.WORK_BRANCH, actors[role].branch);
    if (role !== 'lead' && !fixturePrograms) { await run('git', ['clone', repository, privateDirectories[role]]); await run('git', ['-C', privateDirectories[role], 'switch', '-c', role]); }
  };
  const call = async (role, operation, input = {}, requestId) => {
    const start = transport.spawns.get(team[role]); const file = join(privateDirectories[role], 'request.json'); await writeFile(file, JSON.stringify(input));
    const result = await run(process.execPath, [new URL('../scripts/swarm.js', import.meta.url).pathname, 'board', operation, '--input', file, '--request-id', requestId ?? `${role}-${operation}-${++serial}`], { cwd: privateDirectories[role], env: { ...process.env, ...start.credentials.environment, ...start.credentials.secretEnvironment }, timeout: 10000 });
    return JSON.parse(result.stdout);
  };
  let serial = 0;
  function arm() { transport.next = inputId => {
    const pending = (async () => {
    arm();
    const input = transport.submissions.get(inputId); const payload = JSON.parse(input.input); const role = Object.keys(team).find(role => team[role] === input.agentId);
    assert.equal(input.mode, 'followUp');
    const helperInput = payload.type === 'helper-initial' || payload.type === 'helper-followup';
    try {
      if (fixturePrograms) {
        const start = transport.spawns.get(input.agentId);
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
          guest.stdin.write(JSON.stringify(leadWorkerCommand(payload.type, { sessionDirectory })) + '\n');
        });
        assert.equal(result.ok, true, result.stderr);
        const row = JSON.parse(result.stdout); assert.equal(row.role, role); assert.equal(row.agentId, input.agentId);
        transport.spawns.get(input.agentId).onEvent({ type: 'settled', outcome: 'completed', output: 'PUBLIC_OK' });
        return;
      }

      if (payload.type === 'prepare-stage') {
        await call(role, 'read');
        await call(role, 'note', { text: payload.ready_note });
      } else if (role === 'lead') {
        const state = await call(role, 'read');
        if (payload.type === 'initialize') {
          assert.deepEqual(payload.helpers, Object.fromEntries(helpers.map(name => [name, team[name]])));
          await call(role, 'announce', { text: 'Implement basic checks', feedback_ids: [] });
          for (const helper of helpers) { await call(role, 'assign', { helper_id: team[helper], text: helper }); await call(role, 'create_subtask', { id: helper, title: 'Initial artifact', path: staged ? payload.paths[helper] : `${helper}.txt` }); }
        } else {
          assert.equal(payload.supplement, staged ? `Evidence stage ${payload.stage}` : 'Add explicit evidence');
          await call(role, 'announce', { text: staged ? `Evidence direction ${payload.stage}` : 'Add explicit evidence based on public feedback', feedback_ids: staged && failure !== 'stale-feedback' ? payload.feedback_ids : state.notes.filter(row => !staged || row.subtask_id).map(row => row.seq), user_input_id: payload.user_input_id });
          for (const helper of helpers) await call(role, 'create_subtask', { id: staged ? `${helper}-stage-${payload.stage}` : `${helper}-next`, title: 'Adopt evidence direction', path: staged ? payload.paths[helper] : `${helper}-next.txt` });
        }
      } else {
        const state = await call(role, 'read'); const correction = payload.type === 'helper-correction'; const next = payload.type === 'helper-followup' || correction;
        const id = correction ? payload.subtaskId : staged && next ? `${role}-stage-${payload.stage}` : role + (next ? '-next' : '');
        if (correction) {
          assert.ok(payload.instruction.includes('No reference answer'));
          assert.ok(payload.instruction.includes('Preserve'));
          await call(role, 'create_subtask', { id, title: 'Correct rejected programming result', path: payload.paths[role] });
          if (failure === 'program-correction-unknown') { input.receipt = { status: 'unknown' }; return; }
        }
        const owned = await call(role, 'claim', { subtask_id: id, expected_revision: 0 });
        if (failure && !failure.startsWith('program-') && !['stale-feedback', 'pinned-corruption'].includes(failure) && role === 'helper1' && !next) {
          if (failure === 'unknown') { input.receipt = { status: 'unknown' }; return; }
          if (failure === 'locked-failed') { lock = new DatabaseSync(join(directory, 'lead-worker-test', 'board.sqlite')); lock.exec('BEGIN IMMEDIATE'); }
          transport.spawns.get(input.agentId).onEvent({ type: 'settled', outcome: 'failed', error: { code: 'FIXED_FAILURE', message: 'Controlled failure' } }); return;
        }
        const other = role === 'helper1' ? 'helper2' : 'helper1';
        await assert.rejects(call(role, 'announce', { text: 'forged lead', feedback_ids: [] }));
        await assert.rejects(call(role, 'update_subtask', { subtask_id: other, expected_revision: 0, text: 'unauthorized' }));
        const text = next ? `Adopted ${state.directions.at(-1).text}\n` : `${role} actual initial delivery\n`;
        const path = staged ? payload.paths[role] : `${id}.txt`;
        let artifactText = text;
        await writeFile(join(privateDirectories[role], path), artifactText);
        const git = args => run('git', ['-C', privateDirectories[role], ...args], { env: { ...process.env, GIT_AUTHOR_NAME: role, GIT_COMMITTER_NAME: role, GIT_AUTHOR_EMAIL: `${role}@test.invalid`, GIT_COMMITTER_EMAIL: `${role}@test.invalid` } });
        await git(['add', '--', path]);
        await git(['commit', '-m', id]); await git(['push', 'origin', role]);
        const commit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
        const delivery = { commit, path, bytes: Buffer.byteLength(artifactText), sha256: createHash('sha256').update(artifactText).digest('hex') };
        await call(role, 'complete', { subtask_id: id, expected_revision: owned.revision, direction_id: state.directions.at(-1).seq, delivery });
        await call(role, 'note', { subtask_id: id, text: next ? 'New direction adopted and verified' : 'Please require explicit evidence in the next direction' });
      }
      if(staged==='stage-deadline'&&helperInput&&payload.stage===0&&role==='helper1')await new Promise(resolve=>setTimeout(resolve,1100));
      transport.spawns.get(input.agentId).onEvent({ type: 'settled', outcome: 'completed', output: 'Public Board records contain evidence' });
    } catch (error) { if (stopping) return; backgroundFailure = error; transport.spawns.get(input.agentId).onEvent({ type: 'settled', outcome: 'failed', error: { code: 'FIXTURE_FAILED', message: 'Deterministic fixture failed' } }); }
    })().finally(() => work.delete(pending));
    work.add(pending); return pending;
  }; } arm();
  if (failure === 'unknown') transport.onStop = agentId => { if (agentId === team.helper1) throw new Error('Controlled stop uncertainty'); };
  const configuration = { runId: 'test', outputDir: directory, image: 'test', backend: {}, ...(helperCount === 2 ? {} : { helperCount }), turnTimeoutMs: 10000, workTimeoutMs: 30000, closeTimeoutMs: 1000,
    prepare: async () => ({ runId: 'test', origin, repository: { owner: 'owner', name: 'repo' }, repositoryUrl: `${origin}/owner/repo.git`, actors }) };
  if(staged==='stage-deadline')configuration.turnTimeoutMs=1000;
  const report = await runWithReport({ outputDir: directory, closeTimeoutMs: 1000, createRuntime: async () => {
    const owned = await createLeadWorkerHarness(configuration);
    // The simulator cannot outlive the first Core close: a complete receipt is
    // cached, so a later close cannot flush evidence from an unfinished send.
    harness = { ...owned, async close(options) { await drainWork(); return owned.close(options); } };
    return harness;
  }, run: async owned => {
    if (!staged) return owned.runWorkflow({ goal: 'Deliver one check per assigned helper', supplement: fixturePrograms ? adjustedDirection : 'Add explicit evidence' });
    const prepared = await owned.prepareStages();
    assert.equal(prepared.inputs.length, 4); assert.equal(prepared.notes.length, 4);
    await assert.rejects(owned.prepareStages(), { code: 'INVALID_STAGE_PREPARATION' });
    const stages = [];
    for (let stage = 0; stage < 4; stage++) {
      for (const agentId of Object.values(team)) assert.equal((await owned.get(agentId)).status, 'idle');
      const payload = { ...(stage ? { supplement: `Evidence stage ${stage}` } : { goal: 'Deliver initial evidence' }),
        paths: Object.fromEntries(helpers.map(role => [role, `${role}-stage-${stage}.txt`])) };
      if(staged==='stage-deadline'){
        await assert.rejects(owned.runStage({...payload,deadlineAtMs:performance.now()-1}),{code:'INVALID_STAGE'});
        await assert.rejects(owned.runStage({...payload,deadlineAtMs:performance.now()+901000}),{code:'INVALID_STAGE'});
        payload.deadlineAtMs=performance.now()+10000;
      }
      if(failure?.startsWith('program-')) {
        payload.deadlineAtMs=performance.now()+10000;
        payload.verifyCandidate=async task=>{
          if(stage!==1 || task.owner!==team.helper2) return true;
          if(failure==='program-verifier-exception') throw new Error('Controlled checker unavailable');
          if(task.path.includes('-correction-') && !(failure==='program-correction-twice' && task.path.endsWith('-correction-1.json'))) return true;
          return {correction:'The candidate was explicitly rejected. No reference answer is supplied; fix the assigned result.',
            rejected:{code:failure==='program-wrong-code'?'UNTRUSTED_REJECTION':'STAGE_CANDIDATE_REJECTED'}};
        };
      }
      const progressing = owned.runStage(payload);
      await assert.rejects(owned.runStage(payload), { code: 'INVALID_STAGE' });
      stages.push(await progressing);
      await assert.rejects(owned.runStage({ supplement: 'Reuse old paths', paths: payload.paths }), { code: 'INVALID_STAGE' });
    }
    await assert.rejects(owned.runStage({ supplement: 'fifth', paths: {} }), { code: 'INVALID_STAGE' });
    return { stages, harness: owned.snapshot() };
  }, redact: value => harness ? harness.redact(value) : value });
  if (!failure) assert.equal(backgroundFailure, undefined, backgroundFailure?.stderr ?? String(backgroundFailure));
  assert.equal(transport.spawns.size, helperCount + 1, JSON.stringify(report.businessFailure)); assert.equal(JSON.stringify(report).includes('private-helper'), false);
  if(failure?.startsWith('program-')) {
    if(['program-correction','program-correction-twice'].includes(failure)) {
      assert.equal(report.businessFailure,null,JSON.stringify(report.businessFailure));
      const receipt=report.result.stages[1];
      const attempts=failure==='program-correction-twice'?2:1;
      assert.equal(receipt.rejected.length,attempts);assert.equal(receipt.attemptInputs.length,4+attempts);
      assert.equal(receipt.rejected[0].input.receipt.status,'accepted');
      assert.equal(receipt.rejected[0].input.settled.outcome,'completed');
      const corrected=receipt.deliveries.find(task=>task.owner===team.helper2);
      assert.ok(corrected.path.endsWith(`-correction-${attempts}.json`));
      assert.equal(new Set(receipt.rejected.map(row=>row.task.delivery.commit)).size,attempts);
      assert.equal(new Set(receipt.attemptInputs.map(row=>row.inputId)).size,4+attempts);
      assert.notEqual(corrected.delivery.commit,receipt.rejected[0].task.delivery.commit);
      assert.equal(report.result.harness.rejections.length,attempts);
    } else {
      assert.ok(report.businessFailure);
      const state=harness.snapshot();
      assert.equal(state.stages.length,1);
      assert.equal(state.inputs.filter(row=>row.source==='helper-correction').length,failure==='program-correction-unknown'?1:0);
      assert.equal(state.rejections.length,failure==='program-correction-unknown'?1:0);
      if(failure==='program-correction-unknown') assert.equal(state.inputUnknown.length,1);
      if(failure==='program-wrong-code') assert.equal(report.businessFailure.code,'STAGE_CANDIDATE_UNCONFIRMED');
    }
    assert.equal(report.cleanup.cleanup,'complete');return;
  }
  if (failure) {
    assert.ok(report.businessFailure);
    if (failure === 'locked-failed') assert.equal(report.businessFailure.code, 'input_failed', 'Board persistence failure cannot replace the native failure');
    const state = report.businessFailure.details.at(-1).board;
    if (failure === 'pinned-corruption') {
      assert.equal(report.businessFailure.code, 'DELIVERY_INVALID');
      assert.equal(state.subtasks.filter(row => row.state === 'complete').length, 12);
      assert.equal(transport.submissions.size, 20);
      return;
    }
    if (failure === 'stale-feedback') {
      assert.equal(report.businessFailure.code, 'DIRECTION_ADJUSTMENT_INVALID');
      assert.equal(transport.submissions.size, 13, 'no helpers receive the stage with stale feedback');
      assert.equal(state.subtasks.filter(row => row.state === 'complete').length, 6);
      return;
    }
    const task = state.subtasks.find(row => row.id === 'helper1'); assert.equal(task.owner, team.helper1); if (failure === 'locked-failed') assert.ok(report.businessFailure.details.at(-1).pendingBoardFailures.some(row => row.agentId === team.helper1 && row.code === 'input_failed')); else assert.ok(task.failure); assert.equal(task.state, 'claimed');
    assert.equal(transport.submissions.size, staged ? 8 : helperCount + 1, 'No adjustment, replacement or resubmission after failure');
    if (failure === 'unknown') { assert.ok(report.cleanupFailure); assert.equal(report.cleanup.agents.find(row => row.agentId === team.helper1).execution, 'unknown'); }
  } else {
    assert.equal(report.businessFailure, null, JSON.stringify(report.businessFailure)); assert.equal(report.cleanupFailure, null, JSON.stringify(report.cleanup));
    const result = report.result; if (staged) {
      assert.equal(result.stages.length, 4); assert.equal(result.harness.delivered.length, 12);
      assert.equal(result.stages[3].pinnedDeliveries.length, 12);
      assert.equal(new Set(result.harness.delivered.map(row => row.path)).size, 12);
      for (let stage = 0; stage < 4; stage++) {
        const receipt = result.stages[stage];
        assert.equal(receipt.stage, stage); assert.equal(receipt.inputs.length, 4);
        assert.equal(receipt.deliveries.length, 3); assert.equal(receipt.feedback.length, 3);
        assert.deepEqual(new Set(receipt.deliveries.map(row => row.owner)), new Set(helpers.map(role => team[role])));
        for (const input of receipt.inputs) { assert.equal(input.receipt.status, 'accepted'); assert.equal(input.settled.outcome, 'completed'); assert.equal(input.settled.agentId, input.agentId); }
        if (stage) assert.deepEqual(new Set(receipt.direction.feedback_ids), new Set(result.stages[stage-1].feedback.map(row => row.seq)));
      }
      assert.equal(report.cleanup.cleanup, 'complete'); return;
    }
    assert.equal(result.harness.delivered.length, helperCount * 2); assert.equal(result.harness.inputs.length, helperCount * 2 + 2); assert.equal(result.harness.unfinished.length, fixturePrograms ? 1 : 0);
    assert.deepEqual(new Set(result.harness.delivered.map(row => row.owner)), new Set(helpers.map(role => team[role])));
    assert.equal(result.adjustedDirection.user_input_id, 'lead-adjust'); assert.equal(result.adjustedDirection.feedback_ids.length, helperCount);
    assert.equal(report.cleanup.agents.length, helperCount + 1); assert.equal(report.cleanup.cleanup, 'complete');
    const saved = JSON.parse(await readFile(report.reportPath)); assert.equal(saved.result.harness.delivered.length, helperCount * 2);
  }
}

test('public Core and actual CLI/Bridge verify initialization, both owners, Git bytes, user feedback and adopted direction', t => scenario(t));
test('helper failed round ends bounded work and preserves its original claim', t => scenario(t, 'failed'));
test('helper submission and stop unknown retain original owner, input identity and required dependencies', t => scenario(t, 'unknown'));

test('SQLite write lock cannot prevent Core stop or replace a failed input; pending evidence reconciles after unlock', t => scenario(t, 'locked-failed'));

test('exact generated native Bash programs use actual CLI, Core Board and Git while title-mutated processes persist', t => scenario(t, undefined, true));

test('four-Agent fixed lead-worker team completes both rounds with distinct authorized delivery owners', t => scenario(t, undefined, false, 3));
test('eight-Agent fixed lead-worker team completes both rounds with distinct authorized delivery owners', t => scenario(t, undefined, false, 7));
test('invalid helper capacity fails before provisioning', async () => {
  for (const helperCount of [1, 8, 2.5, '3', null]) {
    await assert.rejects(createLeadWorkerHarness({ helperCount, prepare: assert.fail }), {
      name: 'TypeError', message: 'Lead-Worker requires between two and seven helpers',
    });
  }
});

test('lead-worker provisions the capacity captured before async startup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lead-worker-capacity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    runId: 'test', image: 'test', outputDir: directory, helperCount: 3,
    async prepare({ helperCount }) {
      assert.equal(helperCount, 3);
      throw Object.assign(new Error('controlled startup stop'), { code: 'CAPACITY_OBSERVED' });
    },
  };
  const creating = createLeadWorkerHarness(options);
  options.helperCount = 7;
  await assert.rejects(creating, { code: 'CAPACITY_OBSERVED' });
});

test('four original Agents sustain four Board/Git stages with twelve new fixed deliveries and prior feedback adoption', t => scenario(t, undefined, false, 3, true));

test('staged lead cannot substitute accumulated old feedback for the previous three actual results', t => scenario(t, 'stale-feedback', false, 3, true));
test('staged helper failure fences all later stages and retains the exclusive owner', t => scenario(t, 'failed', false, 3, true));

test('final staged fixed-object read rejects corrupted remote bytes despite twelve verified Board deliveries', t => scenario(t, 'pinned-corruption', false, 3, true));

test('explicit absolute stage deadline retains the same accepted inputs past the ordinary per-input wait',t=>scenario(t,undefined,false,3,'stage-deadline'));

// Corrections belong to the ordinary staged controller, independent of timed experiments.
test('staged checker explicit rejection preserves the original task and admits one fresh helper correction',t=>scenario(t,'program-correction',false,3,true));
test('unknown staged correction retains its rejected candidate and sends no replacement input',t=>scenario(t,'program-correction-unknown',false,3,true));
test('staged checker exception creates no rejection or correction',t=>scenario(t,'program-verifier-exception',false,3,true));
test('staged checker malformed rejection code cannot authorize a correction',t=>scenario(t,'program-wrong-code',false,3,true));
test('staged repeated rejections retain distinct immutable tasks and input admissions',t=>scenario(t,'program-correction-twice',false,3,true));
