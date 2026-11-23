import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRuntime } from '@swarmenv/core';
import { ServiceRegistry } from '@swarmenv/core/services';
import { botControlBackend, createBotControlUpstream, parentCommand } from './fixtures/core-bot-service-upstream.js';
import { cleanupRuntimes } from './fixtures/core-runtime-cleanup.js';
import { ownedContainers } from './fixtures/core-runtime-containers.js';

test('real parent Bash controls one child through two native Pi rounds and physical stop', {
 skip: process.env.SWARMENV_CORE_BOT_SERVICE_REAL_TEST !== '1' && 'Independent reviews and explicit local opt-in required', timeout: 160000,
}, async t => {
 const image = process.env.SWARMENV_CORE_TEST_IMAGE; assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
 const plan = {}; const upstream = await createBotControlUpstream(plan); t.after(() => upstream.close());
 const outputDir = join(process.cwd(), 'experiments', `core-bot-service-${Date.now()}`); await mkdir(outputDir, { recursive:true, mode:0o700 });
 const runtimes=[]; const resources={}; const report={version:1,failure:true,events:[]}; let expired=false;
 const deadline=setTimeout(()=>{expired=true; for(const runtime of runtimes)void runtime.close({timeoutMs:1}).catch(()=>{});},120000);
 t.after(()=>clearTimeout(deadline));
 t.after(async()=>{
  report.cleanup=await cleanupRuntimes(runtimes,{inspect:ownedContainers,resources});
  Object.assign(report,{resources,upstream:upstream.receipt(),deadlineExceeded:expired});
  const success=!expired&&!report.failure&&!report.upstream.failure&&report.upstream.arrivals===6&&report.upstream.accepted===6&&!report.upstream.deadlineExceeded&&report.cleanup.every(r=>r.cleanup==='complete')&&Object.values(resources).every(r=>r.empty);
  report.failure=!success; await writeFile(join(outputDir,'acceptance.json'),JSON.stringify(report,null,2),{mode:0o600}); assert.equal(success,true);
 });
  const host = process.env.SWARMENV_CORE_TEST_ADVERTISE_HOST ?? '172.17.0.1';
  const runtime = await createRuntime({ backend: botControlBackend(upstream, {
    lifecycleBaseUrl: process.env.SWARMENV_CORE_TEST_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
    endpointHost: process.env.SWARMENV_CORE_TEST_ENDPOINT_HOST ?? '127.0.0.1', apiKey: process.env.SWARMENV_CORE_TEST_API_KEY,
  }, { host }), profiles: {
    parent: { prompt: 'Execute the fixed parent control script with Bash.', image, model: 'default', writable: false, services: { bot: ['spawn','get','send','stop'] }, spawnProfiles: ['child'] },
    child: { prompt: 'Execute the fixed child steps with Bash.', image, model: 'child', writable: true, services: {} },
  }, services: new ServiceRegistry(), maxBots: 2, outputDir });
 runtimes.push(runtime); report.runtimeId=runtime.id;
 let resolve; const settled=new Promise(done=>{resolve=done;});
 runtime.onEvent(event=>{report.events.push(event); if(event.botId===plan.parentId&&event.type==='settled')resolve(event);});
 const parent=await runtime.spawn({profile:'parent',requestId:'parent'}); plan.parentId=parent.id; plan.command=parentCommand(parent.id); report.parentId=parent.id;
 report.input=await runtime.send(parent.id,'FIXED_PARENT_CONTROL',{requestId:'parent-control',mode:'followUp'}); assert.equal(report.input.status,'accepted');
 const outcome=await Promise.race([settled,new Promise(resolve=>{const timer=setTimeout(()=>resolve({outcome:'timeout'}),110000);timer.unref();})]);
 assert.equal(outcome.outcome,'completed'); assert.equal(outcome.output,'BOT_CONTROL_OK');
 const childId=upstream.receipt().evidence.childId; const child=await runtime.get(childId); report.child=child;
 assert.equal(child.parentId,parent.id); assert.equal(child.status,'closed');
 const childEvents=report.events.filter(e=>e.botId===childId); assert.equal(childEvents.filter(e=>e.type==='settled').length,2); assert.ok(childEvents.some(e=>e.type==='output')); assert.ok(childEvents.some(e=>e.type==='exit'));
 assert.equal((await ownedContainers(runtime.id)).length,1); report.failure=false;
});
