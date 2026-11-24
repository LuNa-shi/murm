import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPiOpenSandboxBackend } from '@swarmenv/core/backends/pi-opensandbox';
import { createTimedUpstreamMeter } from '../../src/environments/endurance/timed-upstream.js';
import { createNativeSessionObserver } from '../../src/environments/endurance/native-session-observation.js';
import { admitLifetime } from '../../test/fixtures/lifetime-host-observation.js';
const fail = code => Object.assign(new Error(code), {code});
async function record(path,value) {
  const temporary=`${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});await rename(temporary,path); }
  catch(error){await rm(temporary,{force:true}).catch(()=>{});throw error;}
}

/** Host composition only. Import does no I/O. Call explicitly after pinning the
 * source, Worker, standalone task module and provider configuration. */
export async function createSubagentsHourConfiguration({env=process.env,signal}={}) {
  const get=name=>env[`SWARMENV_HOUR_${name}`];
  const required=name=>{const value=get(name);if(typeof value!=='string'||!value)throw fail(`SUBAGENTS_HOUR_${name}_REQUIRED`);return value;};
  signal?.throwIfAborted();
  const image=required('IMAGE'),workloadSha256=required('WORKLOAD_SHA256');
  if(!/^sha256:[a-f0-9]{64}$/.test(image)||!/^[a-f0-9]{64}$/.test(workloadSha256))throw fail('SUBAGENTS_HOUR_PIN_INVALID');
  let programming;
  try {
    const bytes=await readFile(required('WORKLOAD'));
    if(bytes.length>1024*1024||createHash('sha256').update(bytes).digest('hex')!==workloadSha256)throw fail('SUBAGENTS_HOUR_WORKLOAD_MISMATCH');
    // Import exactly the verified standalone bytes, rather than a mutable path.
    programming=(await import(`data:text/javascript;base64,${bytes.toString('base64')}`)).default;
    if(typeof programming?.prompt!=='function'||typeof programming?.verify!=='function')throw fail('SUBAGENTS_HOUR_WORKLOAD_INVALID');
  }catch(error){throw fail(error?.code==='SUBAGENTS_HOUR_WORKLOAD_MISMATCH'?error.code:'SUBAGENTS_HOUR_WORKLOAD_INVALID');}
  const upstreamUrl=required('UPSTREAM_URL');let upstreamHeaders;
  try{upstreamHeaders=JSON.parse(required('UPSTREAM_HEADERS_JSON'));}catch{throw fail('SUBAGENTS_HOUR_HEADERS_INVALID');}
  const host=get('HOST')??'172.17.0.1',lifecycle=get('LIFECYCLE_URL')??'http://127.0.0.1:8080/v1',apiKey=get('LIFECYCLE_TOKEN')??env.OPEN_SANDBOX_API_KEY,execdToken=get('EXECD_TOKEN')??env.SWARMENV_EXECD_ACCESS_TOKEN,endpointHost=get('ENDPOINT_HOST')??'127.0.0.1';
  const budgets=Object.freeze({setupMs:600000,workMs:3900000,cleanupMs:180000,recoveryMs:300000,marginMs:120000,turnMs:180000});
  const {turnMs,...phases}=budgets;
  const provider={baseUrl:lifecycle,headers:apiKey?{'OPEN-SANDBOX-API-KEY':apiKey}:{},endpointHost,execdToken,uncertaintyMs:1000};
  const observeSessions=createNativeSessionObserver({provider});
  const controller=new AbortController(),live=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const outputRoot=resolve(get('OUTPUT_ROOT')??'experiments');
  if(!outputRoot.split(/[\\/]/).includes('experiments'))throw fail('SUBAGENTS_HOUR_PRIVATE_OUTPUT_REQUIRED');
  await mkdir(outputRoot,{recursive:true,mode:0o700});
  const outputDir=await mkdtemp(join(outputRoot,'subagents-hour-'));
  const info=await lstat(outputDir);if(!info.isDirectory()||info.uid!==process.getuid()||(info.mode&0o077))throw fail('SUBAGENTS_HOUR_PRIVATE_OUTPUT_REQUIRED');
  const custodyPath=join(outputDir,'model-owner.json');let owner;
  try {
    live.throwIfAborted();
    owner=await createTimedUpstreamMeter({upstreamUrl,upstreamHeaders,deadlineAt:Date.now()+budgets.setupMs+budgets.workMs,onDeadline:()=>controller.abort()});
    const quota=Object.freeze({url:owner.url,receipt:()=>owner.receipt(),async close(options){
      let result,first;
      try{result=await owner.close(options);}catch(error){first=error;}
      try{await record(custodyPath,owner.receipt());}catch{first??=fail('SUBAGENTS_MODEL_CUSTODY_UNKNOWN');}
      if(first)throw first;return result;
    }});
    const backend={
      sandbox:{lifecycleBaseUrl:lifecycle,endpointHost,apiKey,execdToken,timeoutSeconds:Math.ceil(Object.values(phases).reduce((sum,value)=>sum+value,0)/1000)+60,commandTimeoutMs:30000},
      bridge:{host:'0.0.0.0',publicUrl:`http://${host}:{port}`},
      modelGateway:{host:'0.0.0.0',advertiseHost:host,maxOutputTokens:null,requestTimeoutMs:180000},
      models:{default:{provider:'kimi_proxy',model:'k3',upstream:{url:quota.url,headers:{}}}},
      isolation:{network:'local-docker',disk:{bytes:1024**3,inodes:65536}},
    };
    // Exercise actual natural backend validation before any Runtime allocation.
    createPiOpenSandboxBackend(backend);
    await record(join(outputDir,'configuration.json'),{mode:'subagents',image,workloadSha256,budgets,timeoutSeconds:backend.sandbox.timeoutSeconds,model:'kimi_proxy/k3',modelPolicy:'time_only',maxBots:4});
    await record(custodyPath,quota.receipt());
    live.throwIfAborted();
    return {backend,image,model:'default',outputDir,programming,budgets,quota,signal:live,observeSessions,
      admit:parameters=>admitLifetime({...parameters,provider}),custodyPath,workloadSha256};
  }catch(error){
    if(owner){
      let cleanupFailure;
      try{await owner.close({timeoutMs:5000});}catch{cleanupFailure='SUBAGENTS_MODEL_CLOSE_UNKNOWN';}
      try{await record(custodyPath,owner.receipt());}catch{cleanupFailure??='SUBAGENTS_MODEL_CUSTODY_UNKNOWN';}
      if(cleanupFailure&&error&&typeof error==='object')error.modelOwnerFailure={code:cleanupFailure};
    }
    throw error;
  }
}
export default createSubagentsHourConfiguration;
