import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { TaskService } from '../src/task/task-service.js';
import { controls, transport } from './fixtures/flat-controller-backend.js';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return { url: new URL('./fixtures/flat-controller-backend.js', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
const { createFlatAffirmativeEnvironment } = await import('../src/environments/endurance/flat.js');
const { runFlatNaturalHour } = await import('../src/environments/endurance/flat-hour.js');
const { createFlatProgrammingWorkload } = await import('../src/environments/endurance/flat-workload.js');
hooks.deregister();
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


for (const badProgram of [false,true]) test(`controlled Flat hour ${badProgram?'rejects an independently wrong program result':'retains four original Executions for four real program groups then verifies stopped-owner adoption'}`, {timeout:120_000}, async t=>{
  const root=await mkdtemp(join(tmpdir(),'flat-hour-positive-'));const pending=new Set();t.after(async()=>{await Promise.allSettled([...pending]);await rm(root,{recursive:true,force:true});});
  transport.reset();controls.credentials.clear();controls.preparedFiles.clear();controls.stopError=null;controls.destroyError=null;
  const directories=new Map(),bindings=new Map();let team,backgroundFailure,time=0;const programs=[];
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  controls.onPrepare=async(id,entries)=>{const dir=join(root,id);await mkdir(dir,{recursive:true});directories.set(id,dir);for(const entry of entries)await writeFile(join(dir,entry.path),entry.bytes);};
  t.after(()=>{controls.onPrepare=null;});
  const cli=async(id,...args)=>{const c=controls.credentials.get(id);const env={...process.env,...c.environment,...c.secretEnvironment};const u=new URL(env.SWARMENV_BRIDGE_URL);u.hostname='127.0.0.1';env.SWARMENV_BRIDGE_URL=u.href.replace(/\/$/,'');const {stdout}=await execute(process.execPath,[new URL('../scripts/swarm.mjs',import.meta.url).pathname,...args],{env,timeout:10_000});return JSON.parse(stdout);};
  const simulate=async id=>{
    const submitted=transport.submissions.get(id),bot=submitted.botId,input=submitted.input;
    if(input.startsWith('Read public Tasks')){
      const listing=await cli(bot,'task','list','--state','ready');const index=team.indexOf(bot);const task=listing.tasks[index<0?0:index];assert.ok(task);
      const taken=await cli(bot,'task','take',task.task_id,'--request-id',`take-${bot}`);bindings.set(bot,{taskId:task.task_id,revision:taken.workspace.revision});
    }else if(input.startsWith('FLAT_PROGRAM_GROUP')){
      const [,p,s]=/peer=(\d+) phase=(\d+)/.exec(input),peer=Number(p),phase=Number(s),binding=bindings.get(bot);
      const proofKey=/proofKey:([^,]+),/.exec(input)[1];assert.match(input,/Return the actual Python result/);
      const source=`import json\nprint(json.dumps({'value': ${peer+10*(phase+1)+(badProgram&&peer===0&&phase===0?1:0)}}))\n`;
      const ran=await execute('python3',['-c',source],{timeout:2000});const answers=JSON.parse(ran.stdout);
      await writeFile(join(directories.get(bot),`hour-program-${phase+1}.py`),source);await writeFile(join(directories.get(bot),`hour-program-${phase+1}.stdout.json`),ran.stdout);
      const programming={...answers,sourceSha256:hash(source),answersSha256:hash(JSON.stringify(answers))};programs.push({bot,phase,programming});
      let adopted;
      const origin=/Read Material ([^ ]+) and public revision ([0-9.]+)/.exec(input);
      if(origin){const original=await cli(bot,'material','view',origin[1]);const value=typeof original.material.content==='string'?JSON.parse(original.material.content):original.material.content;adopted={materialId:origin[1],sourceSha256:value.programming.sourceSha256,answersSha256:value.programming.answersSha256};await cli(bot,'material','consume','--material-ids',JSON.stringify([origin[1]]),'--action','task','--impact','Read and adopted original program hashes');await cli(bot,'workspace','files','--revision',origin[2].replace(/\.$/,''));}
      let merge;
      const chosen=/host candidate ([0-9.]+)\./.exec(input)[1];
      const precursor=/candidate revisions ([0-9., ]+) in order/.exec(input);
      const sources=precursor?precursor[1].split(', '):[chosen];
      for(const from of sources) {
      for(let attempt=0;attempt<20;attempt++){try{merge=await cli(bot,'workspace','merge','--from',from,'--request-id',`merge-${peer}-${phase}-${from}-${attempt}`);break;}catch(error){if(!/MAIN_MOVED|WORKSPACE_BUSY/.test(error.stderr))throw error;}}
      assert.ok(merge); } const content=JSON.stringify({proofKey,peer,phase,revision:merge.main_revision,programming,...(adopted?{adopted}:{})});
      const published=await cli(bot,'material','publish','--content',content,'--request-id',`publish-${peer}-${phase}`);
      const materialId=published.material.material_id;
      await cli(bot,'task','link','--task-id',binding.taskId,'--material-id',materialId,'--role','experience','--receiving-task-id',binding.taskId,'--request-id',`link-${peer}-${phase}`);
    }else if(input.startsWith('Finish your actual Task')){
      const revision=/workspace_revision ([0-9.]+) and/.exec(input)[1],material=JSON.parse(/material_ids (\[[^\]]+\])/.exec(input)[1]);
      try{await cli(bot,'task','finish','--outcome','done','--workspace-revision',revision,'--material-ids',JSON.stringify(material),'--request-id',`finish-${bot}`);}catch(error){if(!/NOT_ALLOWED|ECONNRESET|fetch failed/.test(error.stderr))throw error;}
    }else throw new Error('Unexpected fixture input');
    transport.listeners.get(bot)({type:'settled',outcome:'completed'});
  };
  const accept=id=>{transport.confirm(id,'started');transport.next=accept;const work=simulate(id).catch(error=>{backgroundFailure??=error;transport.listeners.get(transport.submissions.get(id).botId)?.({type:'settled',outcome:'failed'});}).finally(()=>pending.delete(work));pending.add(work);};transport.next=accept;
  const budgets={setupMs:60_000,workMs:3_900_000,turnMs:60_000,cleanupMs:10_000,recoveryMs:1000,marginMs:1000};
  const meter={profile:'time_only',deadlineAt:Date.now()+budgets.setupMs+budgets.workMs,forwarded:1,active:0,closed:false};
  const owner={receipt:()=>({...meter}),async close(){meter.closed=true;}};
  const workload=createFlatProgrammingWorkload({programming:{prompt:()=> 'Return the actual Python result as programming with value, sourceSha256 and answersSha256.',verify:({peer,stage,submission})=>submission.value===peer+stage*10&&/^[a-f0-9]{64}$/.test(submission.sourceSha256)&&submission.answersSha256===hash(JSON.stringify({value:peer+stage*10}))}});
  const report=await runFlatNaturalHour({options:{backend:{},image:'fixture',outputDir:root,candidates:Array.from({length:5},(_,i)=>({summary:`Fixed independent candidate ${i}`,files:{[`candidate-${i}-0.txt`]:`Host candidate ${i} phase0\n`},laterFiles:Array.from({length:3},(_,p)=>({[`candidate-${i}-${p+1}.txt`]:`Host candidate ${i} phase${p+1}\n`}))})),checker:{identity:{checker_ref:'fixed-files',checker_version:'1',environment_ref:'controlled'},timeoutMs:5000,async check(plan){assert.ok(Object.keys(plan.files).some(path=>path.startsWith('candidate-')));return{verdict:'PASS',check_mode:'lean-project',checked_paths:Object.keys(plan.files)};}}},workload,quota:owner,modelGate:{check:()=>owner.receipt()},budgets,clock:()=>time,waitForMs:async ms=>{time+=ms;},onReady:({botIds})=>{team=botIds;},admit:async({runtime,botIds,workMs})=>({runtimeId:runtime.id,workDeadlineAtMs:time+workMs,resources:botIds.map(botId=>({botId}))})});
  if(badProgram){assert.equal(report.businessFailure?.code,'HOUR_PROGRAMMING_INVALID');assert.equal(report.result,null);assert.equal(report.cleanup.cleanup,'complete');assert.equal(owner.receipt().closed,true);return;}
  assert.equal(report.businessFailure,null,JSON.stringify(report.businessFailure));
  assert.equal(backgroundFailure,undefined,backgroundFailure?.stderr??String(backgroundFailure));assert.equal(report.cleanupFailure,null,JSON.stringify(report.cleanupFailure));
  assert.equal(report.result.state,'controlled');assert.equal(report.result.durationMs,3_600_000);assert.equal(report.result.admissions.length,3);assert.equal(report.result.proofs.length,17);assert.ok(report.result.proofs.every(proof=>proof.programming?.sourceSha256&&proof.programming?.answersSha256));
  assert.ok(report.result.windows.every(window=>window.botIds.length===4));assert.equal(programs.length,17);
  assert.notEqual(report.result.publisher,report.result.replacement);assert.equal(report.cleanup.cleanup,'complete');assert.equal(owner.receipt().closed,true);
});
