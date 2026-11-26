import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskPoolStores } from './fixtures/taskpool-task-stores.js';
import { createTaskPoolPublicationServices } from '../src/harnesses/taskpool/publication-services.js';
import { ServiceRegistry, snapshotServiceRegistry, invokeService } from '../src/core/services.js';
import { completeDigest, decodeFileSeed } from '../scripts/core-file-seed.js';
import { createHash } from 'node:crypto';
import { prepareTaskPoolInputs } from '../src/harnesses/taskpool/prepare-inputs.js';
import { MurmError } from '../src/errors.js';
import { stableStringify, makeEnvelope } from '../src/protocol/envelope.js';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'taskpool-publication-'));
  const stores = await createTaskPoolStores(root);
  stores.tasks.contextService = stores.context;
  t.after(async () => { stores.close(); await rm(root, { recursive:true, force:true }); });
  const agentId = options.agentId ?? 'actual-agent';
  stores.tasks.registerAgent({ agentId, missionId:stores.missionId, legacySlotId:'slot:A', selectionDeadline:new Date(Date.now()+60000).toISOString() });
  stores.tasks.markCoreAgentReady(agentId);
  let execution = stores.tasks.takeTask(stores.task.task_id, { owner_ref:agentId, core_id:'slot:A', take_key:'fixed-take' }).execution;
  await prepareTaskPoolInputs({execution, taskService:stores.tasks, missionWorkspace:stores.workspace, workspaceId:stores.workspaceId, workspaceManager:stores.manager, contextService:stores.context, check() {}});
  execution=stores.tasks.getExecution(execution.execution_id);
  execution = stores.tasks.dispatch('start_execution', { core_id:'slot:A' }, makeEnvelope({ actorRef:agentId, taskId:execution.task_id, executionId:execution.execution_id, specVersion:execution.spec_version, stateVersion:execution.state_version, fencingVersion:execution.fencing_version })).execution;
  const runtime = options.runtime ?? { id:'runtime:flat', async get(id) { assert.equal(id,agentId); return {id,profile:'researcher',status:'running'}; } };
  let publication, registrations;
  const restartPublication = () => {
    publication = createTaskPoolPublicationServices({ runtime, taskService:stores.tasks, contextService:stores.context, missionId:stores.missionId, missionWorkspace:stores.workspace, workspaceId:stores.workspaceId, deadline:()=>Date.now()+60000, ...options });
    const registry = new ServiceRegistry();
    for (const registration of publication.registrations) registry.registerService(registration);
    registrations = snapshotServiceRegistry(registry);
    return publication;
  };
  restartPublication();
  const call = (service,operation,input={},requestId=operation) => invokeService(registrations.get(service), { operation,input,envelope:{operation_id:requestId}, caller:{runtimeId:runtime.id,agentId,profile:'researcher'} });
  return {...stores,root,agentId,runtime,publication,call,execution,restartPublication};
}

test('flat Material publication and linked finish preserve actual ownership, public bytes and duplicate identity', async t => {
  const finished=[];
  const f=await fixture(t,{onFinish: row=>finished.push(row)});
  const published=await f.call('context','context_publish_material',{content:'Fixed public result',title:'A verified small result'},'publish');
  assert.equal(f.context.getMaterial(published.material.material_id).content,'Fixed public result');
  assert.equal(published.material.producer_execution_id,f.execution.execution_id);
  assert.deepEqual(await f.call('context','context_publish_material',{content:'Fixed public result',title:'A verified small result'},'publish'),published);
  await assert.rejects(f.call('context','context_publish_material',{content:'Different result'},'publish'),{code:'CONFLICT'});
  await assert.rejects(f.call('task','task_finish',{outcome:'done',material_ids:[published.material.material_id]},'unlinked'),{code:'INVALID_CONTRACT'});
  await f.call('task','task_link_material',{task_id:f.task.task_id,material_id:published.material.material_id,role:'experience'},'link');
  const result=await f.call('task','task_finish',{outcome:'done',material_ids:[published.material.material_id]},'finish');
  assert.equal(result.disposition,'closing');
  assert.equal(f.tasks.getTask(f.task.task_id).state,'RUNNING');
  assert.equal(f.tasks.getExecution(f.execution.execution_id).state,'CLOSING');
  assert.deepEqual(await f.call('task','task_finish',{outcome:'done',material_ids:[published.material.material_id]},'finish'),result);
  assert.equal(finished.length,1);
  await assert.rejects(f.call('context','context_publish_material',{content:'Late write'},'late'),{code:'NOT_ALLOWED'});
});


test('flat Workspace save captures trusted bytes once and keeps immutable revision provenance', async t => {
  let f, captures=0;
  const files={'input.txt':Buffer.from('fixed λ\n'),'result.txt':Buffer.from('Fixed actual guest result\n')};
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const manifest=Object.fromEntries(Object.entries(files).map(([path,bytes])=>[path,{bytes:bytes.length,content_hash:hash(bytes)}]));
  f=await fixture(t,{async snapshotProject({agentId,executionId,fencingVersion}) {
    captures++; assert.equal(agentId,f.agentId);
    return {execution_id:executionId,binding_version:fencingVersion,state:'ACTIVE',files:Object.fromEntries(Object.entries(files).map(([p,b])=>[p,b.toString('base64')])),manifest,content_hash:hash(stableStringify(manifest))};
  }});
  await assert.rejects(f.call('workspace','workspace_apply',{ from:'0.1' },'injected-apply'),{code:'NOT_FOUND'});
  const saved=await f.call('workspace','workspace_save',{},'save');
  assert.notEqual(saved.revision,'0.1');
  const published=await f.workspace.exportRevision({workspaceId:f.workspaceId,revision:saved.revision});
  assert.equal(Buffer.from(published.files['result.txt']).toString(),'Fixed actual guest result\n');
  const provenance=f.workspace.readDeliveryRevision({workspaceId:f.workspaceId,missionId:f.missionId,revision:saved.revision});
  assert.equal(provenance.source.agent_id,f.agentId);
  assert.equal(provenance.source.execution_id,f.execution.execution_id);
  assert.equal(provenance.source.fencing_version,f.execution.fencing_version);
  assert.deepEqual(await f.call('workspace','workspace_save',{},'save'),saved);
  assert.equal(captures,1);
  await assert.rejects(f.call('workspace','workspace_save',{files:{'fake.txt':'fake'}},'forged'),{code:'SERVICE_INPUT_INVALID'});
});

test('TaskPool registers only public Workspace reads without a trusted snapshot binding', async t => {
  const fixtureState = await fixture(t);
  const workspace = await fixtureState.call('workspace', 'workspace_public_view');
  assert.equal(workspace.workspace_id, fixtureState.workspaceId);
  for (const operation of ['workspace_save', 'workspace_status', 'workspace_current_diff']) {
    await assert.rejects(fixtureState.call('workspace', operation), { code: 'NOT_FOUND' });
  }
  assert.equal((await fixtureState.workspace.listRevisions({ workspaceId: fixtureState.workspaceId })).length, 1);
});

test('TaskPool advertises enough transport time for a trusted project checker', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const taskService = { db, setWorkspaceDeliveryReader() {} };
  const publication = createTaskPoolPublicationServices({
    runtime: () => ({}), taskService, contextService: {}, missionWorkspace: {},
    missionId: 'bench', workspaceId: 'bench', deadline: () => Date.now() + 3_600_000,
    judgeService: { taskService, processTimeoutMs: 300_000, missionBudget: { queueWaitMs: 120_000 }, dispatch() {} },
    workspaceMergeChecker: {
      identity: { checker_ref: 'lean', checker_version: '4.33.1', environment_ref: 'locked' },
      timeoutMs: 300_000, check() {},
    },
  });
  const capabilities = publication.registrations.flatMap(({ manifest }) => manifest.capabilities);
  const timeout = operation => capabilities.find(capability => capability.operation === operation)?.timeout_ms;
  assert.ok(timeout('workspace_check') > 720_000);
  assert.ok(timeout('workspace_merge') > 300_000);
  assert.equal(timeout('get_check_result'), undefined);
});

test('fencing during a trusted capture prevents Workspace publication',async t=>{
  let f;
  f=await fixture(t,{async snapshotProject({executionId}) {
    const execution=f.tasks.getExecution(executionId);
    f.tasks.dispatch('fence_execution',{reason:'Fixed concurrent ownership change'},makeEnvelope({actorRef:'host',taskId:execution.task_id,executionId,specVersion:execution.spec_version,stateVersion:execution.state_version,fencingVersion:execution.fencing_version}));
    return {files:{},manifest:{},content_hash:'invalid'};
  }});
  await assert.rejects(f.call('workspace','workspace_save',{},'stale'),error=>error.code==='WORKSPACE_REQUEST_ABORTED' && error.details.cause_code==='NOT_ALLOWED');
  assert.equal((await f.workspace.listRevisions({workspaceId:f.workspaceId})).length,1);
});

test('malformed trusted snapshot evidence cannot create a public revision',async t=>{
  const f=await fixture(t,{async snapshotProject({executionId,fencingVersion}) {
    return {execution_id:executionId,binding_version:fencingVersion,state:'ACTIVE',files:{'result.txt':Buffer.from('actual').toString('base64')},manifest:{'result.txt':{bytes:6,content_hash:'forged'}},content_hash:'forged'};
  }});
  await assert.rejects(f.call('workspace','workspace_save',{},'invalid'),{code:'INVALID_CONTRACT'});
  assert.equal((await f.workspace.listRevisions({workspaceId:f.workspaceId})).length,1);
});

test('flat rejects mismatched capture evidence and still publishes exact bounded binary bytes', { timeout: 60_000 }, async t => {
  const hash = value => createHash('sha256').update(value).digest('hex');
  const encode = files => {
    const manifest = Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, { bytes: bytes.length, content_hash: hash(bytes) }]));
    return { files: Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, bytes.toString('base64')])),
      manifest, content_hash: hash(stableStringify(manifest)) };
  };
  const small = encode({ 'result.bin': Buffer.from([0, 255, 128, 10]) });
  const fullFile = Buffer.alloc(2 * 1024 * 1024, 0x80);
  const variants = [
    ['foreign Execution', snapshot => ({ ...snapshot, execution_id: 'foreign-execution' })],
    ['stale resource binding', snapshot => ({ ...snapshot, binding_version: snapshot.binding_version + 1 })],
    ['closed capture', snapshot => ({ ...snapshot, state: 'CLOSED' })],
    ['escaping path', snapshot => ({ ...snapshot, ...encode({ '../escaped.bin': Buffer.from([1]) }) })],
    ['protected path', snapshot => ({ ...snapshot, ...encode({ '.env/private': Buffer.from([1]) }) })],
    ['noncanonical base64', snapshot => ({ ...snapshot, files: { 'result.bin': `${snapshot.files['result.bin']}\n` } })],
    ['extra manifest entry', snapshot => ({ ...snapshot, manifest: { ...snapshot.manifest, 'hidden.bin': { bytes: 0, content_hash: hash(Buffer.alloc(0)) } } })],
    ['oversized file', snapshot => ({ ...snapshot, ...encode({ 'large.bin': Buffer.alloc(fullFile.length + 1) }) })],
    ['oversized project', snapshot => ({ ...snapshot, ...encode(Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`part-${index}.bin`, fullFile]))) })],
  ];
  let captures = 0;
  let transform = snapshot => snapshot;
  const f = await fixture(t, { async snapshotProject({ executionId, fencingVersion }) {
    captures++;
    return transform({ execution_id: executionId, binding_version: fencingVersion, state: 'ACTIVE', ...structuredClone(small) });
  } });
  for (const [name, invalidSnapshot] of variants) {
    transform = invalidSnapshot;
    await assert.rejects(f.call('workspace', 'workspace_save', {}, `reject-${name}`), { code: 'INVALID_CONTRACT' }, name);
    assert.equal((await f.workspace.listRevisions({ workspaceId: f.workspaceId })).length, 1, name);
  }
  const beforeValid = captures;
  transform = snapshot => ({ ...snapshot, ...encode({ 'result.bin': fullFile }) });
  const saved = await f.call('workspace', 'workspace_save', {}, 'valid-binary');
  assert.equal(captures, beforeValid + 1);
  assert.equal((await f.workspace.listRevisions({ workspaceId: f.workspaceId })).length, 2);
  const published = await f.workspace.exportRevision({ workspaceId: f.workspaceId, revision: saved.revision });
  assert.deepEqual(Buffer.from(published.files['result.bin']), fullFile);
  assert.deepEqual(await f.call('workspace', 'workspace_save', {}, 'valid-binary'), saved);
  assert.equal(captures, beforeValid + 1);
});

// The trusted host capture is injected; publication, Git and Task stores are real.
async function recoveryFixture(t) {
  const guest = { files: { 'input.txt': Buffer.from('fixed λ\n') }, captures: 0, before: null };
  const f = await fixture(t, { async snapshotProject({ executionId, fencingVersion }) {
    guest.captures++;
    await guest.before?.();
    const hash = value => createHash('sha256').update(value).digest('hex');
    const manifest = Object.fromEntries(Object.entries(guest.files).map(([path, bytes]) => [path, { bytes: bytes.length, content_hash: hash(bytes) }]));
    return { execution_id: executionId, binding_version: fencingVersion, state: 'ACTIVE',
      files: Object.fromEntries(Object.entries(guest.files).map(([path, bytes]) => [path, bytes.toString('base64')])),
      manifest, content_hash: hash(stableStringify(manifest)) };
  } });
  return { ...f, guest, save: id => f.call('workspace', 'workspace_save', {}, id),
    async revisions() { return f.workspace.listRevisions({ workspaceId: f.workspaceId }); },
    async bytes(saved, path) {
      const revision = await f.workspace.exportRevision({ workspaceId: f.workspaceId, revision: saved.revision });
      return Buffer.from(revision.files[path]);
    } };
}

test('flat busy capture failure survives adapter replacement without poisoning a fresh save', async t => {
  const f = await recoveryFixture(t);
  f.guest.before = () => { throw new MurmError('WORKSPACE_BUSY', 'controlled writer busy'); };
  let first;
  await assert.rejects(f.save('busy'), error => { first = { code: error.code, message: error.message, details: error.details }; return error.code === 'WORKSPACE_BUSY'; });
  f.guest.before = null;
  f.restartPublication();
  await assert.rejects(f.save('busy'), error => {
    assert.deepEqual({ code: error.code, message: error.message, details: error.details }, first);
    return true;
  });
  assert.equal(f.guest.captures, 1);
  assert.equal((await f.revisions()).length, 1);
  assert.equal((await f.call('workspace', 'workspace_status', {}, 'after-busy')).dirty, false);
  const saved = await f.save('fresh');
  assert.deepEqual(await f.bytes(saved, 'input.txt'), Buffer.from('fixed λ\n'));
  assert.equal((await f.revisions()).length, 2);
});

test('flat definitive publication rejection replays after replacement and permits a new request', async t => {
  const f = await recoveryFixture(t);
  const repository = f.workspace.repository;
  const importTree = repository.importTree.bind(repository);
  let reject = true;
  repository.importTree = async (...args) => {
    if (reject) { reject = false; throw new MurmError('NOT_ALLOWED', 'controlled publication rejection'); }
    return importTree(...args);
  };
  await assert.rejects(f.save('rejected'), { code: 'NOT_ALLOWED' });
  f.restartPublication();
  await assert.rejects(f.save('rejected'), { code: 'NOT_ALLOWED' });
  assert.equal(f.guest.captures, 1);
  assert.equal((await f.revisions()).length, 1);
  assert.equal((await f.call('workspace', 'workspace_status', {}, 'after-rejection')).dirty, false);
  const saved = await f.save('fresh');
  assert.deepEqual(await f.bytes(saved, 'input.txt'), Buffer.from('fixed λ\n'));
  assert.equal((await f.revisions()).length, 2);
});

test('flat unknown publication replays captured bytes after replacement without accepting a changed operation', async t => {
  const f = await recoveryFixture(t);
  const repository = f.workspace.repository;
  const importTree = repository.importTree.bind(repository);
  let reject = true;
  repository.importTree = async (...args) => {
    if (reject) { reject = false; throw new Error('controlled transient import loss'); }
    return importTree(...args);
  };
  f.guest.files = { 'exact.bin': Buffer.from([0, 255, 128, 10]) };
  await assert.rejects(f.save('unknown'), { code: 'SERVICE_UNAVAILABLE' });
  f.restartPublication();
  f.guest.files = { 'new.txt': Buffer.from('newer unsaved bytes') };
  await assert.rejects(f.call('workspace', 'workspace_status', {}, 'unknown'), { code: 'CONFLICT' });
  assert.equal((await f.revisions()).length, 1);
  const saved = await f.save('unknown');
  assert.deepEqual(Object.keys(saved.files), ['exact.bin']);
  assert.deepEqual(await f.bytes(saved, 'exact.bin'), Buffer.from([0, 255, 128, 10]));
  assert.equal(f.guest.captures, 1);
  assert.equal((await f.revisions()).length, 2);
  assert.deepEqual((await f.call('workspace', 'workspace_status', {}, 'new-status')).changed_paths, ['exact.bin', 'new.txt']);
});

for (const loss of ['Git receipt', 'SQLite acknowledgement']) test(`flat lost ${loss} recovers one immutable save after adapter replacement`, async t => {
  const f = await recoveryFixture(t);
  f.guest.files = { 'exact.bin': Buffer.from([0, 255, 128, 10]) };
  let faulted = false;
  if (loss === 'Git receipt') f.workspace.repository.fault = point => {
    if (point === 'after_receipt' && !faulted) { faulted = true; throw new Error('controlled loss after Git receipt'); }
  };
  else f.tasks.db.exec("CREATE TRIGGER reject_save_ack BEFORE UPDATE ON execution_workspace_state BEGIN SELECT RAISE(ABORT, 'controlled SQL ack failure'); END;");
  await assert.rejects(f.save('lost-ack'), error => error.code === 'WORKSPACE_RESULT_UNKNOWN' && error.retryable);
  f.workspace.repository.fault = null;
  if (loss === 'SQLite acknowledgement') f.tasks.db.exec('DROP TRIGGER reject_save_ack');
  f.restartPublication();
  f.guest.files = { 'new.txt': Buffer.from('must not recapture') };
  const saved = await f.save('lost-ack');
  assert.deepEqual(await f.bytes(saved, 'exact.bin'), Buffer.from([0, 255, 128, 10]));
  assert.deepEqual(Object.keys(saved.files), ['exact.bin']);
  assert.equal(f.guest.captures, 1);
  assert.equal((await f.revisions()).length, 2);
  f.restartPublication();
  assert.deepEqual(await f.save('lost-ack'), saved);
  assert.equal(f.guest.captures, 1);
  assert.equal((await f.revisions()).length, 2);
});

test('flat capture completing after Agent stop cannot publish or recapture its failed request', async t => {
  const f = await recoveryFixture(t);
  f.guest.before = () => { f.tasks.requestAgentStop(f.agentId, 'controlled-close', { terminalState: 'FAILED' }); };
  await assert.rejects(f.save('close-first'), { code: 'WORKSPACE_REQUEST_ABORTED' });
  assert.equal((await f.revisions()).length, 1);
  f.restartPublication();
  await assert.rejects(f.save('close-first'), { code: 'NOT_ALLOWED' });
  assert.equal(f.guest.captures, 1);
  assert.equal((await f.revisions()).length, 1);
});

test('flat admitted publication conflict keeps its identity against a changed service', async t => {
  const f = await recoveryFixture(t);
  const repository = f.workspace.repository;
  const importTree = repository.importTree.bind(repository);
  let reject = true;
  repository.importTree = async (...args) => {
    if (reject) { reject = false; throw new MurmError('CONFLICT', 'controlled publication guard conflict'); }
    return importTree(...args);
  };
  await assert.rejects(f.save('guard-conflict'), { code: 'CONFLICT' });
  await assert.rejects(f.call('context', 'context_publish_material', { content: 'must not publish under admitted save identity' }, 'guard-conflict'), { code: 'CONFLICT' });
  await assert.rejects(f.save('guard-conflict'), { code: 'CONFLICT' });
  assert.equal(f.guest.captures, 1);
  assert.equal((await f.revisions()).length, 1);
});

test('Core snapshot save recovers the original bytes after a lost reply and adapter replacement', async t => {
  const f = await fixture(t, { workspaceCapture: 'core' });
  let bytes = Buffer.from([0, 255, 128, 10]);
  const receipts = new Map();
  const ids = [];
  let lose = true;
  f.runtime.files = { async snapshot(agentId, options) {
    assert.equal(agentId, f.agentId);
    assert.deepEqual(options.paths, ['.']);
    ids.push(options.requestId);
    if (!receipts.has(options.requestId)) {
      const files = { 'proof.bin': { encoding: 'base64', data: bytes.toString('base64'), mode: 0o644 } };
      receipts.set(options.requestId, { agentId, requestId: options.requestId, version: 73, files, scope: 'complete', digest: completeDigest(decodeFileSeed(files).digest) });
    }
    if (lose) { lose = false; throw new MurmError('OUTCOME_UNKNOWN', 'lost snapshot reply'); }
    return receipts.get(options.requestId);
  } };
  await assert.rejects(f.call('workspace', 'workspace_save', {}, 'same-save'), { code: 'WORKSPACE_RESULT_UNKNOWN' });
  bytes = Buffer.from('later edits');
  f.restartPublication();
  await assert.rejects(f.call('workspace', 'workspace_save', {}, 'different-save'), { code: 'WORKSPACE_RESULT_UNKNOWN' });
  await assert.rejects(f.call('workspace', 'workspace_save', { resolved: true }, 'same-save'), { code: 'CONFLICT' });
  const saved = await f.call('workspace', 'workspace_save', {}, 'same-save');
  const exported = await f.workspace.exportRevision({ workspaceId: f.workspaceId, revision: saved.revision });
  assert.deepEqual(Buffer.from(exported.files['proof.bin']), Buffer.from([0, 255, 128, 10]));
  assert.equal(new Set(ids).size, 1);
  assert.equal(ids.length, 2);
  assert.equal(f.workspace.readDeliveryRevision({ workspaceId: f.workspaceId, missionId: f.missionId, revision: saved.revision }).source.fencing_version, f.execution.fencing_version);
  assert.deepEqual(await f.call('workspace', 'workspace_save', {}, 'same-save'), saved);
});

test('TaskPool apply keeps the original owner and records both proof parents before subsequent save', async t => {
  let files = { 'input.txt': { encoding: 'utf8', data: 'fixed λ\n' }, 'own.lean': { encoding: 'utf8', data: 'my progress\n' } };
  const snapshots = new Map();
  const replacements = new Map();
  let writes = 0;
  const runtime = { id: 'runtime:apply', async get(id) { return { id, profile: 'researcher', status: 'running' }; }, files: {
    async snapshot(agentId, input) {
      if (!snapshots.has(input.requestId)) snapshots.set(input.requestId, { agentId, requestId: input.requestId, version: snapshots.size + 1,
        files: structuredClone(files), scope: 'complete', digest: completeDigest(decodeFileSeed(files).digest) });
      return snapshots.get(input.requestId);
    },
    async replace(agentId, input) {
      const previous = replacements.get(input.requestId);
      if (previous) return previous;
      assert.equal(input.expectedDigest, completeDigest(decodeFileSeed(files).digest));
      files = structuredClone(input.files);
      const receipt = { agentId, requestId: input.requestId, digest: completeDigest(decodeFileSeed(files).digest), status: 'completed', writable: true };
      replacements.set(input.requestId, receipt);
      writes++;
      return { agentId, requestId: input.requestId, status: 'unknown' };
    },
  } };
  const f = await fixture(t, { runtime, workspaceCapture: 'core' });
  const incoming = await f.workspace.save({ workspaceId: f.workspaceId, baseRevision: '0.1', files: { 'input.txt': 'fixed λ\n', 'lemma.lean': 'peer lemma\n' } });
  await assert.rejects(f.call('workspace', 'workspace_apply', { from: incoming.revision }, 'dirty'), { code: 'WORKSPACE_BUSY' });
  const own = await f.call('workspace', 'workspace_save', {}, 'own');
  await assert.rejects(f.call('workspace', 'workspace_apply', { from: incoming.revision }, 'adopt'), { code: 'WORKSPACE_RESULT_UNKNOWN' });
  f.restartPublication();
  const applied = await f.call('workspace', 'workspace_apply', { from: incoming.revision }, 'adopt');
  assert.deepEqual(applied.parents, [own.revision, incoming.revision]);
  assert.equal(applied.conflicts.length, 0);
  assert.equal(f.tasks.getExecution(f.execution.execution_id).owner_ref, f.agentId);
  assert.equal(f.tasks.getExecution(f.execution.execution_id).state, 'RUNNING');
  assert.equal(writes, 1);
  const saved = await f.call('workspace', 'workspace_save', {}, 'combined');
  const exported = await f.workspace.exportRevision({ workspaceId: f.workspaceId, revision: saved.revision });
  assert.equal(Buffer.from(exported.files['own.lean']).toString(), 'my progress\n');
  assert.equal(Buffer.from(exported.files['lemma.lean']).toString(), 'peer lemma\n');
  assert.deepEqual(saved.parents, [own.revision, incoming.revision]);
});
