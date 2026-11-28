import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { controls } from './fixtures/taskpool-controller-backend.js';
import { ServiceRegistry } from '../src/core/services.js';
import { installNotesExample } from './fixtures/notes-installed-package.js';

const hooks=registerHooks({resolve(specifier,context,next) {
  if(specifier==='./sandbox/opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return {url:new URL('./fixtures/taskpool-controller-backend.js',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}});
const { createTaskPoolStores } = await import('./fixtures/taskpool-task-stores.js');
const { createTaskPoolTaskService } = await import('../examples/taskpool/services/task/agent-service.js');
const { createTaskPoolPublicationServices } = await import('../examples/taskpool/services/workspace/publication-services.js');
const { stableStringify } = await import('../examples/taskpool/persistence/envelope.js');
const {createRuntime}=await import('@luna-shi/murm');hooks.deregister();
const execute=promisify(execFile);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const closeFromAnotherProcess=(root,agentId)=>execute(process.execPath,['--input-type=module','-e',`
  import { TaskService } from ${JSON.stringify(new URL('../examples/taskpool/services/task/task-service.js', import.meta.url).href)};
  const tasks=new TaskService(process.argv[1]);
  tasks.requestAgentStop(process.argv[2],'external-close',{terminalState:'FAILED'});
  tasks.close();
`,join(root,'state.sqlite'),agentId],{timeout:10000});

async function fixture(t,installed) {
  const root=await mkdtemp(join(tmpdir(),'taskpool-save-fence-'));
  const stores=await createTaskPoolStores(root,{persistent:true});
  stores.tasks.contextService=stores.context;
  let runtime,captures=0;
  const files={'input.txt':Buffer.from('fixed λ\n'),'exact.bin':Buffer.from([0,255,128,10])};
  const discovery=createTaskPoolTaskService({runtime:()=>runtime,taskService:stores.tasks,contextService:stores.context,missionWorkspace:stores.workspace,workspaceManager:stores.manager,
    missionId:stores.missionId,workspaceId:stores.workspaceId,missionDeadline:()=>Date.now()+60000});
  const publication=createTaskPoolPublicationServices({runtime:()=>runtime,taskService:stores.tasks,contextService:stores.context,missionWorkspace:stores.workspace,
    missionId:stores.missionId,workspaceId:stores.workspaceId,deadline:()=>Date.now()+60000,
    async snapshotProject({executionId,fencingVersion}) {
      captures++;
      const manifest=Object.fromEntries(Object.entries(files).map(([path,bytes])=>[path,{bytes:bytes.length,content_hash:hash(bytes)}]));
      return {execution_id:executionId,binding_version:fencingVersion,state:'ACTIVE',files:Object.fromEntries(Object.entries(files).map(([path,bytes])=>[path,bytes.toString('base64')])),manifest,content_hash:hash(stableStringify(manifest))};
    }});
  const services=new ServiceRegistry();services.registerService(publication.composeTask(discovery));
  for(const row of publication.registrations.filter(row=>row.manifest.id!=='task')) services.registerService(row);
  const allowed=Object.fromEntries(publication.registrations.map(row=>[row.manifest.id,row.manifest.capabilities.map(cap=>cap.operation)]));
  allowed.task.push(...discovery.manifest.capabilities.map(cap=>cap.operation));
  runtime=await createRuntime({sandbox: {},profiles:{researcher:{prompt:'Publish fixed bytes',model:'default',image:'fixture',writable:false,services:allowed}},services,maxAgents:1,outputDir:root});
  t.after(async()=>{publication.close();await discovery.close();await runtime.close({timeoutMs:1000});stores.close();await rm(root,{recursive:true,force:true});});
  const agent=await runtime.spawn({profile:'researcher',requestId:'contributor'});
  stores.tasks.registerAgent({agentId:agent.id,missionId:stores.missionId,legacySlotId:'taskpool-save-slot',selectionDeadline:new Date(Date.now()+60000).toISOString()});
  stores.tasks.markCoreAgentReady(agent.id);
  const credentials=controls.credentials.get(agent.id);
  const env={...installed.env,...credentials.environment,...credentials.secretEnvironment};
  const url=new URL(env.MURM_BRIDGE_URL);url.hostname='127.0.0.1';env.MURM_BRIDGE_URL=url.origin;
  const cli=async(...args)=>JSON.parse((await execute(process.execPath,[join(installed.directory,'node_modules/@luna-shi/murm/dist/scripts/swarm.js'),...args],{cwd:installed.directory,env,timeout:15000})).stdout);
  await cli('task','take',stores.task.task_id,'--request-id','take');
  return {...stores,root,agent,cli,captures:()=>captures};
}

test('installed CLI save preserves the cross-process publication fence', {timeout:180000}, async t=>{
  const installed=await installNotesExample();
  t.after(()=>installed.close());
  await t.test('another TaskService process closing before publication prevents the saved revision',async t=>{
    const f=await fixture(t,installed);
    const importTree=f.workspace.repository.importTree.bind(f.workspace.repository);
    let stopped=false;
    f.workspace.repository.importTree=async(...args)=>{
      await closeFromAnotherProcess(f.root,f.agent.id);stopped=true;
      return importTree(...args);
    };
    await assert.rejects(f.cli('workspace','save','--request-id','external-close-first'),error=>/NOT_ALLOWED/.test(error.stderr));
    assert.equal(stopped,true);assert.equal(f.captures(),1);
    assert.equal((await f.workspace.listRevisions({workspaceId:f.workspaceId})).length,1);
  });
  await t.test('SQLite publication lock excludes another writer between final guard and Git commit',async t=>{
    const f=await fixture(t,installed);
    let attempted=false,writerResult;
    f.workspace.repository.fault=point=>{
      if(point!=='after_intent')return;
      attempted=true;
      const result=execFileSync(process.execPath,['--input-type=module','-e',`
        import { DatabaseSync } from 'node:sqlite';
        const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout = 40');
        try { db.exec('BEGIN IMMEDIATE');console.log('incorrectly acquired');db.exec('ROLLBACK'); }
        catch(error) { if(error.errcode!==5)throw error;console.log('blocked'); }
        db.close();
      `,join(f.root,'state.sqlite')],{encoding:'utf8',timeout:5000});
      writerResult=result.trim();
    };
    const saved=await f.cli('workspace','save','--request-id','publication-first');
    assert.equal(attempted,true);assert.equal(writerResult,'blocked');f.workspace.repository.fault=null;
    assert.equal(f.captures(),1);
    assert.deepEqual(await f.cli('workspace','save','--request-id','publication-first'),saved);
    assert.equal(f.captures(),1);
    assert.equal((await f.workspace.listRevisions({workspaceId:f.workspaceId})).length,2);
    const bytes=await f.workspace.exportRevision({workspaceId:f.workspaceId,revision:saved.revision});
    assert.deepEqual(Buffer.from(bytes.files['exact.bin']),Buffer.from([0,255,128,10]));
    await closeFromAnotherProcess(f.root,f.agent.id);
    // A committed save's exact receipt remains readable; new work is closed.
    assert.deepEqual(await f.cli('workspace','save','--request-id','publication-first'),saved);
    await assert.rejects(f.cli('workspace','save','--request-id','new-after-close'),error=>/NOT_ALLOWED/.test(error.stderr));
    assert.equal(f.captures(),1);
    assert.deepEqual((await f.workspace.exportRevision({workspaceId:f.workspaceId,revision:saved.revision})).files,bytes.files);
  });
});
