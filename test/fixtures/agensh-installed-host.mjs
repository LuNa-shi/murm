import { createPiOpenSandboxBackend } from '@swarmenv/core/backends/pi-opensandbox';
import { createLocalAgenshStack } from './node_modules/@swarmenv/core/test/fixtures/agensh-local-stack.js';
import { createCleanupBudget } from './node_modules/@swarmenv/core/test/fixtures/agensh-deadline.js';
import { readFile } from 'node:fs/promises';
const input=JSON.parse(await readFile(process.env.SWARMENV_AGENSH_HOST_INPUT,'utf8'));
const stack=await createLocalAgenshStack({directory:input.directory,advertiseHost:input.host});
process.on('message',async message=>{
 if(message.type!=='close-facilities')return;
 const budget=createCleanupBudget(Math.max(1,message.deadlineAt-Date.now())).start();
 try { const receipt=await stack.close(budget); process.send({type:'facilities-closed',receipt,resources:stack.receipt()}); }
 finally {budget.dispose();process.disconnect();}
});
let configuration;
try { configuration=await stack.start(); }
catch {process.send({type:'setup-failed'});throw Object.assign(new Error('LOCAL_SETUP_FAILED'),{code:'LOCAL_SETUP_FAILED'});}
process.send({type:'facilities',configuration:{gitea:configuration.gitea,mattermost:configuration.mattermost}});
export default {mode:'agensh',timeoutMs:180000,options:{...configuration,runId:input.runId,image:input.image,peerKeys:['a','b'],outputDir:input.outputDir,closeTimeoutMs:60000,
router:{workTimeoutMs:180000,turnTimeoutMs:80000,maxBatches:8,maxNudges:0,events:{pollIntervalMs:1000,maxPolls:180}},
backend:createPiOpenSandboxBackend({sandbox:{lifecycleBaseUrl:input.lifecycle,endpointHost:input.endpointHost,apiKey:input.apiKey,commandTimeoutMs:20000,resourceLimits:{cpu:'1',memory:'1Gi'}},bridge:{host:'0.0.0.0',publicUrl:'http://'+input.host+':{port}'},modelGateway:{host:'0.0.0.0',advertiseHost:input.host,maxOutputTokens:128,requestTimeoutMs:85000},models:{default:{provider:'kimi_proxy',model:'k3',upstream:{url:input.upstream,headers:{}}}},isolation:{network:'local-docker',disk:{bytes:134217728,inodes:8192}}})}};
