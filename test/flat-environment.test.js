import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFlatTaskStores } from './fixtures/flat-task-stores.js';
import { registerHooks } from 'node:module';
import { promisify } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stableStringify } from '../src/protocol/envelope.js';
import { transport, controls } from './fixtures/flat-controller-backend.js';
const hooks=registerHooks({resolve(specifier,context,next){
  if(specifier==='./pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return {url:new URL('./fixtures/flat-controller-backend.js',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}});
const {runFlatEnvironment}=await import('../src/environments/flat/environment.js');hooks.deregister();

test('flat host refuses unsupported live Workspace binding before creating any Runtime or Bot',async t=>{
  const root=await mkdtemp(join(tmpdir(),'flat-environment-'));
  const stores=await createFlatTaskStores(root);
  t.after(async()=>{stores.close();await rm(root,{recursive:true,force:true});});
  const report=await runFlatEnvironment({...stores,taskService:stores.tasks,contextService:stores.context,missionWorkspace:stores.workspace,workspaceManager:stores.manager,
    outputDir:root,deadlineAt:Date.now()+10000,backend:{},model:'default',image:'fixture'});
  assert.equal(report.businessFailure.code,'SERVICE_NOT_READY');
  assert.equal(report.cleanup,null);
  assert.equal(report.result,null);
  assert.ok(report.reportPath);
  const saved=JSON.parse(await readFile(report.reportPath,'utf8'));
  assert.equal(saved.businessFailure.code,'SERVICE_NOT_READY');
  assert.equal(stores.tasks.listExecutions(stores.task.task_id).length,0);
});


test('flat host composes public Bash publication and controller finish with durable public results after close',async t=>{
  const root=await mkdtemp(join(tmpdir(),'flat-closed-loop-'));
  const stores=await createFlatTaskStores(root);
  t.after(async()=>{stores.close();await rm(root,{recursive:true,force:true});});
  transport.reset();controls.credentials.clear();controls.stopError=null;controls.destroyError=null;
  const accept=id=>{transport.confirm(id,'started');transport.next=accept;};transport.next=accept;
  const files={'input.txt':Buffer.from('fixed λ\n'),'result.txt':Buffer.from('Fixed public result\n')};
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const manifest=Object.fromEntries(Object.entries(files).map(([path,bytes])=>[path,{bytes:bytes.length,content_hash:hash(bytes)}]));
  let materialId,revision,captures=0;
  const report=await runFlatEnvironment({...stores,taskService:stores.tasks,contextService:stores.context,missionWorkspace:stores.workspace,workspaceManager:stores.manager,
    outputDir:root,deadlineAt:Date.now()+10000,backend:{},model:'default',image:'fixture',capacity:1,
    async snapshotProject({executionId,fencingVersion}) {captures++;return {execution_id:executionId,binding_version:fencingVersion,state:'ACTIVE',files:Object.fromEntries(Object.entries(files).map(([path,bytes])=>[path,bytes.toString('base64')])),manifest,content_hash:hash(stableStringify(manifest))};},
    async drive(controller) {
      const bot=controller.snapshot().bots[0];
      const credentials=controls.credentials.get(bot.botId);
      const env={...process.env,...credentials.environment,...credentials.secretEnvironment};
      const bridge=new URL(env.SWARMENV_BRIDGE_URL);bridge.hostname='127.0.0.1';env.SWARMENV_BRIDGE_URL=bridge.href.replace(/\/$/,'');
      const cli=async args=>{const {stdout}=await promisify(execFile)(process.execPath,['scripts/swarm.mjs',...args],{env,timeout:5000});return JSON.parse(stdout);};
      await cli(['task','take',stores.task.task_id,'--request-id','take']);
      const attachment=Buffer.from([0,255,65,10]);
      const seed=await cli(['material','publish','--content','Original observation','--receiving-task-id',stores.task.task_id,
        '--title','t'.repeat(120),'--summary','s'.repeat(500),'--attachments',JSON.stringify([{name:'original.bin',content_base64:attachment.toString('base64')}]),'--request-id','seed']);
      const correctionInput=['material','publish','--content','Corrected observation','--supersedes',seed.material.material_id,
        '--expected-version','0','--supersede-reason','Fixed source correction','--attachments',JSON.stringify([{name:'copied.bin',content_hash:hash(attachment),
          source:{material_id:seed.material.material_id,attachment_name:'original.bin'}}]),'--request-id','correction'];
      const corrected=await cli(correctionInput);
      assert.deepEqual(await cli(correctionInput),corrected);
      const correction=await cli(['material','view',seed.material.material_id]);
      assert.equal(correction.active_successors[0].replacement_material_id,corrected.material.material_id);
      assert.equal(stores.context.getMaterial(corrected.material.material_id,{verifyIntegrity:true}).supersedes,seed.material.material_id);
      assert.deepEqual(corrected.material.attachments,[{name:'copied.bin',media_type:'application/octet-stream',content_hash:hash(attachment),size_bytes:4}]);
      const received=await cli(['material','view',corrected.material.material_id,'--attachment-name','copied.bin']);
      assert.equal(received.attachment.content_base64,attachment.toString('base64'));
      const discovered=await cli(['material','list','--producer-task-id',stores.task.task_id,'--include-history','true']);
      assert.ok(JSON.stringify(discovered).includes(corrected.material.material_id));
      await assert.rejects(cli(['material','view',corrected.material.material_id,'--attachment-name','missing.bin']),error=>JSON.parse(error.stderr).code==='INVALID_CONTRACT');
      const publicBefore=stores.context.publicChangeToken(stores.missionId);
      const rejectsInput=async args=>assert.rejects(cli(args),error=>JSON.parse(error.stderr).code==='SERVICE_INPUT_INVALID');
      for(const [option,value] of [['--title','t'.repeat(121)],['--summary','s'.repeat(501)],['--producer-task-id','forged'],
        ['--attachments',JSON.stringify(Array.from({length:17},(_,index)=>({name:`a${index}`,content_base64:'QQ=='})))],
        ['--attachments',JSON.stringify([{name:'copy',source:{material_id:seed.material.material_id,attachment_name:'original.bin',bot_id:'forged'},content_hash:hash(attachment)}])]]) {
        await rejectsInput(['material','publish','--content','Invalid publication',option,value,'--request-id',`invalid-${option}`]);
      }
      await assert.rejects(cli(['material','publish','--content','Stale correction','--supersedes',seed.material.material_id,
        '--expected-version','0','--supersede-reason','Stale observed relation','--request-id','stale-correction']),error=>JSON.parse(error.stderr).code==='STALE_VERSION');
      assert.deepEqual(stores.context.publicChangeToken(stores.missionId),publicBefore);
      await rejectsInput(['task','finish','--outcome','blocked','--blocker','invalid-string','--request-id','invalid-finish']);
      assert.equal(stores.tasks.getTask(stores.task.task_id).state,'RUNNING');
      const material=await cli(['material','publish','--content','Fixed public result','--request-id','publish']);materialId=material.material.material_id;
      await cli(['task','link','--task-id',stores.task.task_id,'--material-id',materialId,'--role','experience',
        '--receiving-task-id',stores.task.task_id,'--request-id','link']);
      const save=await cli(['workspace','save','--request-id','save']);revision=save.revision;
      assert.deepEqual(await cli(['workspace','save','--request-id','save']),save);
      assert.equal(captures,1,'Replaying a public CLI save must recover the original capture');
      await assert.rejects(cli(['workspace','save','--files','{}','--request-id','forged-save']),error=>
        JSON.parse(error.stderr).code==='SERVICE_INPUT_INVALID');
      assert.equal(captures,1,'Model-supplied files must fail before trusted capture');
      assert.equal((await stores.workspace.listRevisions({workspaceId:stores.workspaceId})).length,2);
      try {await cli(['task','finish','--outcome','done','--material-ids',JSON.stringify([materialId]),'--request-id','finish']);}
      catch(error) {assert.ok(stores.tasks.listExecutions(stores.task.task_id)[0].finish,'A lost reply must still have a durable accepted finish');}
      await controller.tick();
    },
  });
  assert.equal(report.businessFailure,null);assert.equal(report.cleanupFailure,null);assert.equal(report.cleanup.cleanup,'complete');
  assert.equal(report.result.completion,'all-tasks-terminal');assert.equal(report.result.bots[0].released,true);
  assert.equal(stores.tasks.getTask(stores.task.task_id).state,'DONE');
  assert.equal(stores.context.getMaterial(materialId).content,'Fixed public result');
  assert.equal(Buffer.from((await stores.workspace.exportRevision({workspaceId:stores.workspaceId,revision})).files['result.txt']).toString(),'Fixed public result\n');
  assert.equal(JSON.parse(await readFile(report.reportPath,'utf8')).result.bots[0].lastStop.execution,'stopped');
});

async function runPublicationProbe(t, snapshotProject, probe) {
  const root = await mkdtemp(join(tmpdir(), 'flat-publication-admission-'));
  const stores = await createFlatTaskStores(root);
  t.after(async () => { stores.close(); await rm(root, { recursive: true, force: true }); });
  transport.reset(); controls.credentials.clear(); controls.stopError = null; controls.destroyError = null;
  const accept = id => { transport.confirm(id, 'started'); transport.next = accept; };
  transport.next = accept;
  let probeFailure;
  const report = await runFlatEnvironment({ ...stores, taskService: stores.tasks, contextService: stores.context,
    missionWorkspace: stores.workspace, workspaceManager: stores.manager, outputDir: root,
    deadlineAt: Date.now() + 20_000, backend: {}, model: 'default', image: 'fixture', capacity: 1,
    // Trusted test capture only. This does not provide a production live snapshot.
    snapshotProject,
    async drive(controller) {
      try {
        const bot = controller.snapshot().bots[0];
        const credentials = controls.credentials.get(bot.botId);
        const env = { ...process.env, ...credentials.environment, ...credentials.secretEnvironment };
        const bridge = new URL(env.SWARMENV_BRIDGE_URL); bridge.hostname = '127.0.0.1';
        env.SWARMENV_BRIDGE_URL = bridge.origin;
        await promisify(execFile)(process.execPath, [new URL('../scripts/swarm.mjs', import.meta.url).pathname,
          'task', 'take', stores.task.task_id, '--request-id', 'probe-take'], { env, timeout: 5000 });
        const call = async (operation, operationId, payload = {}) => {
          const response = await fetch(`${bridge.origin}/call`, { method: 'POST',
            headers: { authorization: `Bearer ${env.SWARMENV_BRIDGE_TOKEN}`, 'content-type': 'application/json' },
            body: JSON.stringify({ service_id: 'workspace', operation, operation_id: operationId, payload }),
            signal: AbortSignal.timeout(5000) });
          return { status: response.status, body: await response.json() };
        };
        await probe({ ...stores, bot, call, controller });
      } catch (error) { probeFailure = error; }
      finally { controller.halt('publication-probe-finished'); }
    },
  });
  if (probeFailure) throw probeFailure;
  assert.equal(report.businessFailure?.code, 'FLAT_BUSINESS_FAILED');
  assert.equal(report.cleanupFailure, null);
  assert.equal(report.cleanup.cleanup, 'complete');
}

function publicationSnapshot({ executionId, fencingVersion }, content) {
  const bytes = Buffer.from(content);
  const digest = value => createHash('sha256').update(value).digest('hex');
  const manifest = { 'result.txt': { bytes: bytes.length, content_hash: digest(bytes) } };
  return { execution_id: executionId, binding_version: fencingVersion, state: 'ACTIVE',
    files: { 'result.txt': bytes.toString('base64') }, manifest, content_hash: digest(stableStringify(manifest)) };
}

test('real Bridge joins concurrent flat save requests and rejects changed replay before a second capture', { timeout: 25_000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let captures = 0;
  await runPublicationProbe(t, async identity => {
    captures++;
    entered.resolve();
    await release.promise;
    return publicationSnapshot(identity, 'One immutable public result\n');
  }, async ({ call, workspace, workspaceId }) => {
    const first = call('workspace_save', 'same-save');
    void first.catch(() => {});
    let duplicate;
    try {
      await entered.promise;
      duplicate = call('workspace_save', 'same-save');
      void duplicate.catch(() => {});
      const conflict = await call('workspace_save', 'same-save', { resolved: true });
      assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'CONFLICT');
      assert.equal(captures, 1);
      assert.equal((await workspace.listRevisions({ workspaceId })).length, 1);
    } finally {
      release.resolve();
      await Promise.allSettled([first, duplicate]);
    }
    const [saved, joined] = await Promise.all([first, duplicate]);
    assert.equal(saved.status, 200); assert.deepEqual(joined, saved);
    assert.equal(captures, 1);
    assert.equal((await workspace.listRevisions({ workspaceId })).length, 2);
    assert.deepEqual(await call('workspace_save', 'same-save'), saved);
    const conflict = await call('workspace_save', 'same-save', { resolved: true });
    assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'CONFLICT');
    assert.equal(captures, 1);
  });
});

test('real Bridge status and diff replays preserve one observation while new identities observe changed bytes', { timeout: 25_000 }, async t => {
  let content = 'First private observation\n', captures = 0;
  await runPublicationProbe(t, async identity => {
    captures++;
    return publicationSnapshot(identity, content);
  }, async ({ call, workspace, workspaceId }) => {
    for (const operation of ['workspace_status', 'workspace_current_diff']) {
      const before = captures;
      const observed = await call(operation, `${operation}:first`);
      assert.equal(observed.status, 200);
      assert.equal(observed.body.result.dirty, true);
      assert.ok(observed.body.result.changed_paths.includes('result.txt'));
      if (operation === 'workspace_current_diff') {
        assert.equal(observed.body.result.changes.find(row => row.path === 'result.txt').after.bytes, Buffer.byteLength(content));
      }
      content += 'Changed after the observation\n';
      assert.deepEqual(await call(operation, `${operation}:first`), observed);
      assert.equal(captures, before + 1);
      const later = await call(operation, `${operation}:later`);
      assert.equal(later.status, 200);
      assert.notEqual(later.body.result.content_hash, observed.body.result.content_hash);
      assert.equal(captures, before + 2);
      assert.equal((await workspace.listRevisions({ workspaceId })).length, 1);
    }
  });
});

for (const expired of ['lease_expires_at', 'execution_deadline']) {
  test(`real Bridge refuses a save when ${expired} expires while trusted capture waits`, { timeout: 25_000 }, async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    let captures = 0;
    await runPublicationProbe(t, async identity => {
      captures++; entered.resolve();
      await release.promise;
      return publicationSnapshot(identity, 'Private bytes after the authorization expired\n');
    }, async ({ call, tasks, task, workspace, workspaceId }) => {
      const pending = call('workspace_save', 'expires-during-capture');
      try {
        await entered.promise;
        const execution = tasks.listExecutions(task.task_id)[0];
        // Simulate durable expiry without depending on a delayed timer firing.
        tasks.db.prepare(`UPDATE executions SET ${expired} = ? WHERE execution_id = ?`)
          .run('2000-01-01T00:00:00.000Z', execution.execution_id);
      } finally { release.resolve(); }
      const rejected = await pending;
      assert.equal(rejected.body.ok, false);
      assert.equal(rejected.body.error.code, 'WORKSPACE_REQUEST_ABORTED');
      assert.equal(rejected.body.error.details.cause_code, 'NOT_ALLOWED');
      const replay = await call('workspace_save', 'expires-during-capture');
      assert.equal(replay.status, 403); assert.equal(replay.body.error.code, 'NOT_ALLOWED');
      assert.equal(captures, 1);
      assert.equal((await workspace.listRevisions({ workspaceId })).length, 1);
      assert.equal(tasks.getTask(task.task_id).state, 'RUNNING');
    });
  });
}

test('fatal Core revocation prevents a held flat capture from publishing before domain stop', { timeout: 25_000 }, async t => {
  const captureEntered = Promise.withResolvers();
  const releaseCapture = Promise.withResolvers();
  const feedbackSent = Promise.withResolvers();
  const releaseFeedback = Promise.withResolvers();
  await runPublicationProbe(t, async identity => {
    captureEntered.resolve();
    await releaseCapture.promise;
    return publicationSnapshot(identity, 'Bytes returned after fatal revocation\n');
  }, async ({ bot, call, controller, task, tasks, workspace, workspaceId }) => {
    // Keep the controller in a pending input admission so Core can revoke the
    // caller while the durable Task and Execution still authorize its owner.
    transport.next = async inputId => {
      feedbackSent.resolve();
      await releaseFeedback.promise;
      transport.confirm(inputId, 'started');
    };
    const feedback = controller.feedback({ taskId: task.task_id, requestId: 'hold-feedback', input: 'Hold controller admission' });
    void feedback.catch(() => {});
    let save;
    try {
      await feedbackSent.promise;
      save = call('workspace_save', 'fatal-held-capture');
      void save.catch(() => {});
      await captureEntered.promise;
      const execution = tasks.listExecutions(task.task_id)[0];
      transport.listeners.get(bot.botId)({ type: 'error', fatal: true, error: { code: 'WORKER_FAILED' } });
      const rejected = await save;
      assert.equal(rejected.status, 503);
      assert.equal(rejected.body.error.details.request_outcome, 'unknown');
      assert.equal((await call('workspace_save', 'new-after-fatal')).status, 403);
      releaseCapture.resolve();
      // Join behind the admitted save at its existing transaction boundary so
      // absence of a revision cannot be asserted before that save settles.
      const lock = createHash('sha256').update(`execution:${execution.execution_id}`).digest('hex');
      const deadline = Date.now() + 4000;
      while (true) {
        try {
          await workspace.repository.requestLocked(workspace.workspacePath(workspaceId), lock, () => {});
          break;
        } catch (error) {
          if (error.code !== 'WORKSPACE_BUSY' || Date.now() >= deadline) throw error;
          await wait(20);
        }
      }
      assert.equal(tasks.getExecution(execution.execution_id).state, 'RUNNING');
      assert.equal((await workspace.listRevisions({ workspaceId })).length, 1);
    } finally {
      releaseCapture.resolve();
      releaseFeedback.resolve();
      await Promise.allSettled([feedback, save]);
    }
  });
});

test('flat rejects a configured Workspace from another Mission before allocating Core resources', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flat-read-authority-'));
  const stores = await createFlatTaskStores(root);
  t.after(async () => { stores.close(); await rm(root, { recursive: true, force: true }); });
  const foreign = await stores.workspace.create({ missionId: 'mission:foreign', workspaceId: 'foreign-workspace',
    initialFiles: { 'secret.txt': 'PRIVATE_FOREIGN_CONTENT' } });
  transport.reset(); controls.credentials.clear(); controls.stopError = null; controls.destroyError = null;
  const accept = id => { transport.confirm(id, 'started'); transport.next = accept; };
  transport.next = accept;
  let entered = false;
  const report = await runFlatEnvironment({ ...stores, taskService: stores.tasks, contextService: stores.context,
    missionWorkspace: stores.workspace, workspaceManager: stores.manager, workspaceId: foreign.workspace_id,
    outputDir: root, deadlineAt: Date.now() + 10_000, backend: {}, model: 'default', image: 'fixture', capacity: 1,
    snapshotProject: async () => { throw new Error('No capture is needed for a public read'); },
    async drive(controller) { entered = true; controller.halt('unexpected-admission'); },
  });
  assert.equal(report.businessFailure?.code, 'NOT_ALLOWED');
  assert.equal(report.result, null);
  assert.equal(report.cleanup, null);
  assert.equal(report.cleanupFailure, null);
  assert.equal(report.reportSaveFailure, null);
  assert.equal(entered, false);
  assert.equal(controls.credentials.size, 0);
  assert.equal(stores.tasks.listExecutions(stores.task.task_id).length, 0);
  const saved = JSON.parse(await readFile(report.reportPath, 'utf8'));
  assert.deepEqual(saved.businessFailure, report.businessFailure);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_FOREIGN_CONTENT/);
});

for (const [operation, method, payload] of [
  ['workspace_public_view', 'get', {}],
  ['workspace_public_read', 'read', { path: 'input.txt' }],
  ['workspace_public_files', 'files', {}],
]) test(`flat ${operation} Core revocation cancels its actual queued read while another Bot and a write retain lock order`, {
  timeout: 20_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'flat-read-cancellation-'));
  const stores = await createFlatTaskStores(root);
  t.after(async () => { stores.close(); await rm(root, { recursive: true, force: true }); });
  transport.reset(); controls.credentials.clear(); controls.stopError = null; controls.destroyError = null;
  const accept = id => { transport.confirm(id, 'started'); transport.next = accept; };
  transport.next = accept;
  let probeFailure;
  const report = await runFlatEnvironment({ ...stores, taskService: stores.tasks, contextService: stores.context,
    missionWorkspace: stores.workspace, workspaceManager: stores.manager, outputDir: root,
    deadlineAt: Date.now() + 15_000, backend: {}, model: 'default', image: 'fixture', capacity: 2,
    snapshotProject: async () => { throw new Error('No capture is needed for a public read'); },
    async drive(controller, runtime) {
      controller.halt('public-read-probe');
      const [first, second] = controller.snapshot().bots;
      const call = async (bot, requestId) => {
        const credentials = controls.credentials.get(bot.botId);
        const url = new URL(credentials.environment.SWARMENV_BRIDGE_URL);
        url.hostname = '127.0.0.1';
        const response = await fetch(`${url.origin}/call`, { method: 'POST',
          headers: { authorization: `Bearer ${credentials.secretEnvironment.SWARMENV_BRIDGE_TOKEN}`,
            'content-type': 'application/json' },
          body: JSON.stringify({ service_id: 'workspace', operation, operation_id: requestId, payload }),
          signal: AbortSignal.timeout(5000) });
        return { status: response.status, body: await response.json() };
      };
      const original = stores.workspace[method].bind(stores.workspace);
      const lockEntered = Promise.withResolvers();
      const release = Promise.withResolvers();
      const queued = Promise.withResolvers();
      const actualRead = Promise.withResolvers();
      let holding, canceled, surviving, writing;
      stores.workspace[method] = async options => {
        if (!holding) {
          holding = stores.workspace.repository.locked(stores.workspace.workspacePath(stores.workspaceId), async () => {
            lockEntered.resolve();
            await release.promise;
          });
          await lockEntered.promise;
          const result = original(options);
          result.then(() => actualRead.resolve({ completed: true }), () => actualRead.resolve({ completed: false }));
          queued.resolve(options.signal);
          return result;
        }
        return original(options);
      };
      try {
        canceled = call(first, 'canceled-reader');
        const trustedSignal = await queued.promise;
        let survivorFinished = false, writeFinished = false;
        surviving = call(second, 'surviving-reader').then(result => { survivorFinished = true; return result; });
        writing = stores.workspace.save({ workspaceId: stores.workspaceId, baseRevision: '0.1',
          files: { 'input.txt': 'retained write' } }).then(result => { writeFinished = true; return result; });
        transport.listeners.get(first.botId)({ type: 'error', fatal: true,
          error: { code: 'CONTROLLED_READ_FENCE', message: 'Controlled caller revocation' } });
        const stopped = await runtime.stop(first.botId, { timeoutMs: 1000 });
        assert.equal(stopped.execution, 'stopped');
        const result = await canceled;
        assert.equal(result.status, 503);
        assert.equal(result.body.error.code, 'SERVICE_UNAVAILABLE');
        const settled = await Promise.race([actualRead.promise, wait(250).then(() => null)]);
        assert.deepEqual(settled, { completed: false }, 'the actual Workspace read must cancel before its predecessor lock releases');
        assert.ok(trustedSignal instanceof AbortSignal);
        assert.equal(trustedSignal.aborted, true);
        assert.equal(survivorFinished, false);
        assert.equal(writeFinished, false);
        release.resolve();
        await holding;
        const survivor = await surviving;
        assert.equal(survivor.status, 200);
        if (method === 'read') assert.equal(survivor.body.result.content, 'fixed λ\n');
        if (method === 'files') assert.equal(survivor.body.result.files[0].path, 'input.txt');
        if (method === 'get') assert.equal(survivor.body.result.mission_id, stores.missionId);
        const saved = await writing;
        assert.equal((await stores.workspace.read({ workspaceId: stores.workspaceId,
          revision: saved.revision, path: 'input.txt' })).content, 'retained write');
        assert.equal(stores.tasks.getBot(second.botId).execution_id, null);
      } catch (error) { probeFailure = error; }
      finally {
        release.resolve();
        await Promise.allSettled([holding, canceled, surviving, writing]);
        stores.workspace[method] = original;
      }
    },
  });
  if (probeFailure) throw probeFailure;
  assert.equal(report.businessFailure?.code, 'FLAT_BUSINESS_FAILED');
  assert.equal(report.cleanupFailure, null);
  assert.equal(report.cleanup.cleanup, 'complete');
  assert.equal(report.cleanup.bots.length, 2);
});
