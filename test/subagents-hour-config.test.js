import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createSubagentsHourConfiguration } from '../examples/subagents-environment/hour-config.mjs';

async function settings(t) {
  const root=await mkdtemp(join(tmpdir(),'subagents-hour-config-'));
  const workload=join(root,'workload.mjs'),source='export default {prompt:()=>"fixed original programming task",verify:()=>true};';await writeFile(workload,source);
  return {root,env:{SWARMENV_HOUR_IMAGE:'sha256:'+'a'.repeat(64),SWARMENV_HOUR_WORKLOAD:workload,SWARMENV_HOUR_WORKLOAD_SHA256:createHash('sha256').update(source).digest('hex'),SWARMENV_HOUR_UPSTREAM_URL:'http://127.0.0.1:1/v1/responses',SWARMENV_HOUR_UPSTREAM_HEADERS_JSON:'{"authorization":"Bearer PRIVATE_PROVIDER_TOKEN"}',SWARMENV_HOUR_LIFECYCLE_TOKEN:'PRIVATE_LIFECYCLE_TOKEN',SWARMENV_HOUR_OUTPUT_ROOT:join(root,'experiments')}};
}

test('private native subagents composition validates natural null policy and persists one stable time-only owner without a provider call',async t=>{
  const {env,root}=await settings(t);let config;
  t.after(async()=>{await config?.quota.close();await rm(root,{recursive:true,force:true});});
  config=await createSubagentsHourConfiguration({env});
  assert.equal(config.backend.modelGateway.maxOutputTokens,null);assert.equal(config.backend.models.default.upstream.url,config.quota.url);
  assert.equal(config.backend.sandbox.timeoutSeconds,5160);assert.equal(config.quota.receipt().profile,'time_only');assert.equal(config.quota.receipt().forwarded,0);
  assert.equal(config.programming.prompt({peer:0,stage:0}),'fixed original programming task');
  assert.equal((await stat(config.outputDir)).mode&0o077,0);assert.equal((await stat(config.custodyPath)).mode&0o077,0);
  const text=await readFile(config.custodyPath,'utf8');assert.equal(text.includes('PRIVATE_'),false);assert.equal(JSON.parse(text).closed,false);
  await config.quota.close();assert.equal(JSON.parse(await readFile(config.custodyPath,'utf8')).closed,true);
});

test('a changed task digest rejects before creating a model listener or output allocation',async t=>{
  const {env,root}=await settings(t);t.after(()=>rm(root,{recursive:true,force:true}));env.SWARMENV_HOUR_WORKLOAD_SHA256='b'.repeat(64);
  await assert.rejects(createSubagentsHourConfiguration({env}),{code:'SUBAGENTS_HOUR_WORKLOAD_MISMATCH'});
  await assert.rejects(stat(env.SWARMENV_HOUR_OUTPUT_ROOT),{code:'ENOENT'});
});

test('the existing global provider credentials feed both backend and native observer without entering private metadata',async t=>{
  const {env,root}=await settings(t);let config;
  t.after(async()=>{await config?.quota.close();await rm(root,{recursive:true,force:true});});
  delete env.SWARMENV_HOUR_LIFECYCLE_TOKEN;env.OPEN_SANDBOX_API_KEY='PRIVATE_EXISTING_PROVIDER';env.SWARMENV_EXECD_ACCESS_TOKEN='PRIVATE_EXISTING_EXECD';
  config=await createSubagentsHourConfiguration({env});
  assert.equal(config.backend.sandbox.apiKey,'PRIVATE_EXISTING_PROVIDER');assert.equal(config.backend.sandbox.execdToken,'PRIVATE_EXISTING_EXECD');
  assert.equal((await readFile(config.custodyPath,'utf8')).includes('PRIVATE_'),false);
});
