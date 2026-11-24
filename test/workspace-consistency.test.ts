import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissionWorkspace } from '../src/runtime/mission-workspace.js';
import { SwarmEnvError } from '../src/errors.js';
const run = promisify(execFile);

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-workspace-consistency-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new MissionWorkspace({ rootDir: root, ...options });
  const created = await store.create({ workspaceId: 'workspace-test', missionId: 'mission:test', initialFiles: { 'initial.txt': 'initial\n' } });
  return { root, store, workspaceId: created.workspace_id };
}

test('concurrent saves allocate immutable revisions with actual Git parents', async t => {
  const { store, workspaceId } = await fixture(t);
  const saved = await Promise.all(['one', 'two'].map(value => store.save({ workspaceId, baseRevision: '0.1', requestId: `save:${value}`, files: { 'initial.txt': 'initial\n', [`${value}.txt`]: value } })));
  assert.equal(new Set(saved.map(result => result.revision)).size, 2);
  const history = await store.listRevisions({ workspaceId });
  const initial = history.find(revision => revision.revision === '0.1');
  for (const result of saved) {
    const revision = history.find(row => row.revision === result.revision);
    assert.match(revision.git_commit, /^[0-9a-f]{40,64}$/);
    const { stdout } = await run('git', ['-C', store.workspacePath(workspaceId), 'rev-list', '--parents', '-n', '1', revision.git_commit]);
    assert.deepEqual(stdout.trim().split(' ').slice(1), [initial.git_commit]);
  }
  assert.equal((await store.get({ workspaceId })).main_revision, '0.1');
});

test('checker sees the final combined tree and concurrent approved merges have one CAS winner', async t => {
  const { store, workspaceId } = await fixture(t);
  const first = await store.save({ workspaceId, baseRevision: '0.1', files: { 'initial.txt': 'initial\n', 'main.txt': 'main\n' } });
  const sources = await Promise.all(['left', 'right'].map(value => store.save({ workspaceId, baseRevision: '0.1', files: { 'initial.txt': 'initial\n', [`${value}.txt`]: value } })));
  const main = await store.merge({ workspaceId, fromRevision: first.revision, expectedMainRevision: '0.1' });
  let entered = 0;
  let release;
  const checked = new Promise(resolve => { release = resolve; });
  const outcomes = await Promise.allSettled(sources.map((source, index) => store.merge({ workspaceId, fromRevision: source.revision, expectedMainRevision: main.main_revision, requestId: `merge:${index}`,
    checker: async ({ files }) => { assert.equal(files['main.txt'], 'main\n'); entered += 1; if (entered === 2) release(); await checked; return true; },
  })));
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(outcome => outcome.status === 'rejected').reason.code, 'MAIN_MOVED');
});

test('freeze accepted during checker prevents the late merge from advancing main', async t => {
  const { store, workspaceId } = await fixture(t);
  const source = await store.save({ workspaceId, baseRevision: '0.1', files: { 'initial.txt': 'new\n' } });
  await assert.rejects(store.merge({ workspaceId, fromRevision: source.revision, expectedMainRevision: '0.1', checker: async () => {
    await store.freeze({ workspaceId, submissionId: 'submission:first' });
    return true;
  } }), { code: 'MISSION_SUBMITTING' });
  assert.equal((await store.get({ workspaceId })).main_revision, '0.1');
});

test('recovery after main ref commit restores the original request result exactly once', async t => {
  let crash = false;
  const { root, store, workspaceId } = await fixture(t, { fault: stage => { if (crash && stage === 'after_ref') throw new Error('simulated process loss'); } });
  const source = await store.save({ workspaceId, baseRevision: '0.1', requestId: 'save:original', files: { 'initial.txt': 'new\n' } });
  crash = true;
  const request = { workspaceId, fromRevision: source.revision, expectedMainRevision: '0.1', requestId: 'merge:original' };
  await assert.rejects(store.merge(request), { code: 'WORKSPACE_RESULT_UNKNOWN', retryable: true });
  const recovered = new MissionWorkspace({ rootDir: root });
  const current = await recovered.get({ workspaceId });
  const replay = await recovered.merge(request);
  assert.equal(replay.main_revision, current.main_revision);
  assert.equal((await recovered.listRevisions({ workspaceId })).length, 3);
  await assert.rejects(recovered.merge({ ...request, fromRevision: '0.1' }), { code: 'CONFLICT' });
});

test('one concurrent request runs its checker once and replays the same committed result', async t => {
  const { store, workspaceId } = await fixture(t);
  const source = await store.save({ workspaceId, baseRevision: '0.1', files: { 'initial.txt': 'replacement\n' } });
  let checks = 0;
  const request = { workspaceId, fromRevision: source.revision, requestId: 'merge:same', checker: async () => { checks += 1; return true; } };
  const [first, second] = await Promise.all([store.merge(request), store.merge(request)]);
  assert.deepEqual(first, second);
  assert.equal(checks, 1);
  assert.deepEqual(await store.merge(request), first);
  assert.equal(checks, 1);
});

test('a rejected final-tree check is replayed without charging another checker attempt', async t => {
  const { store, workspaceId } = await fixture(t);
  const source = await store.save({ workspaceId, files: { 'initial.txt': 'replacement\n' } });
  let checks = 0;
  const request = { workspaceId, fromRevision: source.revision, requestId: 'merge:fail', checker: async () => { checks += 1; return false; } };
  await assert.rejects(store.merge(request), /final Workspace tree check failed/);
  await assert.rejects(store.merge(request), /final Workspace tree check failed/);
  assert.equal(checks, 1);
});

test('binary file bytes and deleted historical files remain available by their immutable revision', async t => {
  const { store, workspaceId } = await fixture(t);
  const bytes = Buffer.from([0, 255, 128, 10]);
  const saved = await store.save({ workspaceId, files: { 'binary.dat': bytes } });
  const merged = await store.merge({ workspaceId, fromRevision: saved.revision });
  const removed = await store.save({ workspaceId, baseRevision: merged.main_revision, files: {} });
  await store.merge({ workspaceId, fromRevision: removed.revision });
  const historical = await store.read({ workspaceId, revision: saved.revision, path: 'binary.dat' });
  assert.equal(historical.encoding, 'base64');
  assert.deepEqual(Buffer.from(historical.content, 'base64'), bytes);
  await assert.rejects(store.read({ workspaceId, path: 'binary.dat' }), /unavailable/);
});

test('recovery before main ref update aborts that request rather than claiming success', async t => {
  let crash = false;
  const { root, store, workspaceId } = await fixture(t, { fault: stage => { if (crash && stage === 'after_intent') throw new Error('simulated process loss'); } });
  const source = await store.save({ workspaceId, files: { 'initial.txt': 'replacement\n' } });
  const request = { workspaceId, fromRevision: source.revision, requestId: 'merge:before-ref' };
  crash = true;
  await assert.rejects(store.merge(request), { code: 'WORKSPACE_RESULT_UNKNOWN', retryable: true });
  const recovered = new MissionWorkspace({ rootDir: root });
  assert.equal((await recovered.get({ workspaceId })).main_revision, '0.1');
  await assert.rejects(recovered.merge(request), { code: 'WORKSPACE_REQUEST_ABORTED' });
});

test('SIGKILL after ref update releases the writer and recovers the original merge receipt', async t => {
  const { root, store, workspaceId } = await fixture(t);
  const source = await store.save({ workspaceId, files: { 'initial.txt': 'survives process loss\n' } });
  const script = `
    const { MissionWorkspace } = await import(process.argv[1]);
    const workspace = new MissionWorkspace({ rootDir: process.argv[2], fault: stage => { if (stage === 'after_ref') process.kill(process.pid, 'SIGKILL'); } });
    await workspace.merge({ workspaceId: 'workspace-test', fromRevision: process.argv[3], requestId: 'merge:killed' });
  `;
  await assert.rejects(run(process.execPath, ['--input-type=module', '-e', script, new URL('../src/runtime/mission-workspace.js', import.meta.url).href, root, source.revision]), error => error.signal === 'SIGKILL');
  const recovered = new MissionWorkspace({ rootDir: root });
  let current;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { current = await recovered.get({ workspaceId }); break; }
    catch (error) { if (error.code !== 'WORKSPACE_BUSY') throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.ok(current);
  const replay = await recovered.merge({ workspaceId, fromRevision: source.revision, requestId: 'merge:killed' });
  assert.equal(replay.main_revision, current.main_revision);
  assert.equal((await recovered.read({ workspaceId, path: 'initial.txt' })).content, 'survives process loss\n');
});

test('Git attributes cannot transform saved bytes or discard a special ordinary filename', async t => {
  const { store, workspaceId } = await fixture(t);
  const files = Object.fromEntries([['.gitattributes', '*.txt text eol=lf\n'], ['windows.txt', 'abc\r\n'], ['__proto__', 'ordinary file\n']]);
  const saved = await store.save({ workspaceId, files });
  const listing = await store.files({ workspaceId, revision: saved.revision });
  for (const [path, expected] of Object.entries(files)) {
    const actual = await store.read({ workspaceId, revision: saved.revision, path });
    assert.equal(actual.content, expected);
    assert.equal(actual.content_hash, listing.files.find(file => file.path === path).content_hash);
  }
  await assert.rejects(store.save({ workspaceId, files: { 'a\\b': 'one', 'a/b': 'two' } }), /collide/);
});

test('main ref committed before retention can be recovered without blocking the next revision', async t => {
  let crash = false;
  const { root, store, workspaceId } = await fixture(t, { fault: stage => { if (crash && stage === 'after_main_ref') throw new Error('interrupted before retention'); } });
  const source = await store.save({ workspaceId, files: { 'initial.txt': 'new\n' } });
  crash = true;
  await assert.rejects(store.merge({ workspaceId, fromRevision: source.revision, requestId: 'merge:ref-first' }), { code: 'WORKSPACE_RESULT_UNKNOWN', retryable: true });
  const recovered = new MissionWorkspace({ rootDir: root });
  const target = join(root, 'execution-output');
  const materialized = await recovered.materialize({ workspaceId, targetDir: target });
  assert.equal(materialized.revision, '0.3');
  const next = await recovered.save({ workspaceId, files: { 'initial.txt': 'next\n' } });
  assert.equal(next.revision, '0.4');
});

test('another coordinator cannot run the same request checker while its owner is alive', async t => {
  const { root, store, workspaceId } = await fixture(t);
  const source = await store.save({ workspaceId, files: { 'initial.txt': 'checked once\n' } });
  let entered;
  let finish;
  const checking = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const first = store.merge({ workspaceId, fromRevision: source.revision, requestId: 'merge:cross-process', checker: async () => { entered(); await gate; return true; } });
  await checking;
  const script = `
    const { MissionWorkspace } = await import(process.argv[1]);
    const store = new MissionWorkspace({ rootDir: process.argv[2] });
    try {
      const result = await store.merge({ workspaceId: 'workspace-test', fromRevision: process.argv[3], requestId: 'merge:cross-process', checker: async () => { throw new Error('duplicate checker invocation'); } });
      console.log(JSON.stringify({ result }));
    } catch (error) { console.log(JSON.stringify({ code: error.code, message: error.message, retryable: error.retryable })); }
  `;
  const args = ['--input-type=module', '-e', script, new URL('../src/runtime/mission-workspace.js', import.meta.url).href, root, source.revision];
  try {
    const busy = JSON.parse((await run(process.execPath, args)).stdout);
    assert.equal(busy.code, 'WORKSPACE_BUSY');
    assert.equal(busy.retryable, true);
  } finally { finish(); }
  const accepted = await first;
  const replay = JSON.parse((await run(process.execPath, args)).stdout);
  assert.deepEqual(replay.result, accepted);
});

test('a lost checker attempt cannot select a newer main or charge its original request again', async t => {
  const { root, store, workspaceId } = await fixture(t);
  const source = await store.save({ workspaceId, files: { 'initial.txt': 'uncertain result\n' } });
  const script = `
    const { MissionWorkspace } = await import(process.argv[1]);
    const store = new MissionWorkspace({ rootDir: process.argv[2] });
    await store.merge({ workspaceId: 'workspace-test', fromRevision: process.argv[3], requestId: 'merge:lost-checker', checker: async () => { process.kill(process.pid, 'SIGKILL'); } });
  `;
  await assert.rejects(run(process.execPath, ['--input-type=module', '-e', script, new URL('../src/runtime/mission-workspace.js', import.meta.url).href, root, source.revision]), error => error.signal === 'SIGKILL');
  await store.merge({ workspaceId, fromRevision: source.revision, requestId: 'merge:new-attempt' });
  await assert.rejects(store.merge({ workspaceId, fromRevision: source.revision, requestId: 'merge:lost-checker', checker: async () => assert.fail('old checker attempt must not rerun') }), { code: 'WORKSPACE_REQUEST_ABORTED' });
});

test('checker infrastructure failure has the same canonical outcome on initial response and replay', async t => {
  const { store, workspaceId } = await fixture(t);
  const source = await store.save({ workspaceId, files: { 'initial.txt': 'uncertain check\n' } });
  const request = { workspaceId, fromRevision: source.revision, requestId: 'merge:checker-unavailable', checker: async () => { throw new SwarmEnvError('SERVICE_UNAVAILABLE', 'checker unavailable', undefined, { retryable: true }); } };
  const errors = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { await store.merge(request); assert.fail('request must fail'); }
    catch (error) { errors.push({ code: error.code, message: error.message, details: error.details, retryable: error.retryable }); }
  }
  assert.deepEqual(errors[0], errors[1]);
  assert.equal(errors[0].code, 'WORKSPACE_REQUEST_ABORTED');
  assert.equal(errors[0].retryable, false);
});

test('materialize rejects in-repository dot-prefix directories and symlink aliases', async t => {
  const { root, store, workspaceId } = await fixture(t);
  await assert.rejects(store.materialize({ workspaceId, targetDir: join(store.workspacePath(workspaceId), '..inside') }), { code: 'NOT_ALLOWED' });
  const alias = join(root, 'repo-alias');
  await symlink(store.workspacePath(workspaceId), alias, 'dir');
  await assert.rejects(store.materialize({ workspaceId, targetDir: join(alias, 'project') }), { code: 'NOT_ALLOWED' });
  const occupied = join(root, 'existing-project');
  await mkdir(join(occupied, 'unsaved-work'), { recursive: true });
  await assert.rejects(store.materialize({ workspaceId, targetDir: occupied }), { code: 'WORKSPACE_BUSY' });
});


test('materialize publishes one complete tree and never mixes concurrent revisions', async t => {
  let entered; let release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { root, store, workspaceId } = await fixture(t, { fault: async stage => {
    if (stage === 'materialize_file') { entered(); await gate; }
  } });
  const other = await store.save({ workspaceId, files: { 'other.txt': 'other' } });
  const targetDir = join(root, 'concurrent-project');
  const first = store.materialize({ workspaceId, revision: '0.1', targetDir });
  await started;
  try {
    assert.deepEqual(await readdir(targetDir), []);
    await assert.rejects(store.materialize({ workspaceId, revision: other.revision, targetDir }), { code: 'WORKSPACE_BUSY' });
  } finally { release(); }
  await first;
  assert.deepEqual(await readdir(targetDir), ['initial.txt']);
});

test('failed materialization leaves the target empty and permits a complete retry', async t => {
  let fail = true;
  const { root, store, workspaceId } = await fixture(t, { fault: stage => {
    if (fail && stage === 'materialize_file') throw new Error('copy interrupted');
  } });
  const source = await store.save({ workspaceId, files: { 'first.txt': 'first', 'second.txt': 'second' } });
  const request = { workspaceId, revision: source.revision, targetDir: join(root, 'retry-project') };
  await assert.rejects(store.materialize(request), /copy interrupted/);
  assert.deepEqual(await readdir(request.targetDir), []);
  fail = false;
  await store.materialize(request);
  assert.equal(await readFile(join(request.targetDir, 'second.txt'), 'utf8'), 'second');
  assert.equal((await readdir(root)).some(name => name.startsWith('.swarm-materialize-')), false);
});

test('aborting a Workspace read after lock admission drains it before the next writer', async t => {
  const { store, workspaceId } = await fixture(t);
  const controller = new AbortController();
  let entered, release;
  const admitted = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let finished = false, writerFinished = false;
  const reading = store.repository.locked(store.workspacePath(workspaceId), async () => {
    entered(); await gate; finished = true; return 'read completed';
  }, { signal: controller.signal });
  await admitted;
  const saved = store.save({ workspaceId, files: { 'initial.txt': 'written after read' } })
    .then(result => { writerFinished = true; return result; });
  try {
    controller.abort(new Error('read owner stopped'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    assert.equal(writerFinished, false);
    release();
    assert.equal(await reading, 'read completed', 'an admitted operation keeps ownership through completion');
    const revision = await saved;
    assert.equal((await store.read({ workspaceId, revision: revision.revision, path: 'initial.txt' })).content, 'written after read');
  } finally {
    release(); await Promise.allSettled([reading, saved]);
  }
});
