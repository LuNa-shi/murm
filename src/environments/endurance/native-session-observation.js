import { openSandboxBotKey, openSandboxRuntimeKey } from '../../runtime/opensandbox-metadata.js';
const fail = code => Object.assign(new Error(code), { code });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

// Fixed privileged observation: read only the first metadata line, never a
// conversation record, and export only the Session ID and a basename.
const script = `import os,json,re,sys
try:
 root='/workspace/runtime/pi-session'
 if os.path.realpath(root)!=root: raise ValueError()
 files=[e.name for e in os.scandir(root) if e.name.endswith('.jsonl') and e.is_file(follow_symlinks=False)]
 if len(files)!=1: raise ValueError()
 name=files[0]
 fd=os.open(root+'/'+name,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb') as stream: line=stream.readline(65537)
 if len(line)>65536 or not line.endswith(b'\\n'): raise ValueError()
 header=json.loads(line)
 sid=header.get('id')
 if header.get('type')!='session' or not isinstance(sid,str) or not re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',sid): raise ValueError()
 if not re.fullmatch(r'\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z_'+sid+r'\\.jsonl',name): raise ValueError()
 print(json.dumps({'sessionId':sid,'sessionFile':name},separators=(',',':')))
except Exception:
 sys.exit(1)
`;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export const SESSION_OBSERVATION_COMMAND = `python3 -I -c ${quote(script)}`;

function endpoint(value, host) {
  const wrapped = value?.result ?? value?.data ?? value;
  const candidate = typeof wrapped === 'string' ? wrapped : wrapped?.url ?? wrapped?.endpoint?.url ?? wrapped?.endpoint;
  if (typeof candidate !== 'string' || !candidate) throw fail('NATIVE_SESSION_ENDPOINT_INVALID');
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `http://${candidate.replace(/^\/\//,'')}`); }
  catch { throw fail('NATIVE_SESSION_ENDPOINT_INVALID'); }
  if (!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash) throw fail('NATIVE_SESSION_ENDPOINT_INVALID');
  if (host) url.hostname = host;
  return { url:url.href.replace(/\/$/,''), headers:wrapped?.headers??{} };
}
function headers(value) {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.entries(value).some(([name,item])=>!name||typeof item!=='string'||/[\r\n]/.test(name+item))) throw fail('NATIVE_SESSION_CONFIG_INVALID');
  return {...value};
}
function eventObject(text) {
  let value;
  try { value = JSON.parse(text); }
  catch { throw fail('NATIVE_SESSION_STREAM_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('NATIVE_SESSION_STREAM_INVALID');
  return value;
}

function* commandEvents(text) {
  // The installed Execd v1.1 uses JSON records under its SSE media type.
  if (text.trimStart().startsWith('{')) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const value = eventObject(line);
      yield { event: value.type ?? value.event, value };
    }
    return;
  }
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let event = 'message'; const data = [];
    const lines = block.split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length && lines.every(line => !line || line.startsWith(':'))) continue;
    const value = eventObject(data.join('\n'));
    yield { event: event === 'message' ? value.type ?? value.event ?? event : event, value };
  }
}

function commandOutput(text, contentType) {
  let stdout='', stderr='', completed=false, exitCode;
  if (contentType.includes('text/event-stream')) {
    for (const { event, value } of commandEvents(text)) {
      if(event==='stdout'||event==='output')stdout+=value.text??value.data??'';
      if(event==='stderr')stderr+=value.text??value.data??'';
      if(event==='error')throw fail('NATIVE_SESSION_COMMAND_FAILED');
      if(['execution_complete','complete'].includes(event)){
        if(completed)throw fail('NATIVE_SESSION_COMMAND_UNKNOWN');completed=true;exitCode=value.exit_code??value.exitCode??0;
      }
    }
  } else {
    const envelope=JSON.parse(text), value=envelope.result??envelope.data??envelope;
    if(value.running||value.timed_out||value.truncated)throw fail('NATIVE_SESSION_COMMAND_UNKNOWN');
    stdout=value.stdout;stderr=value.stderr??'';exitCode=value.exit_code;completed=Number.isInteger(exitCode);
  }
  if(!completed)throw fail('NATIVE_SESSION_COMMAND_UNKNOWN');
  if(exitCode!==0||stderr||typeof stdout!=='string'||Buffer.byteLength(stdout)>8192)throw fail('NATIVE_SESSION_COMMAND_FAILED');
  const observed=JSON.parse(stdout);
  if(Object.keys(observed).sort().join(',')!=='sessionFile,sessionId'||!UUID.test(observed.sessionId??'')||typeof observed.sessionFile!=='string'||!new RegExp(`^\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z_${observed.sessionId}\\.jsonl$`).test(observed.sessionFile))throw fail('NATIVE_SESSION_INVALID');
  return observed;
}

/** Host-only port. Construction has no I/O; observation never allocates,
 * lists all sandboxes, changes work, or requests a model. */
export function createNativeSessionObserver({provider,fetchImpl=globalThis.fetch}={}) {
  let base;
  try {base=new URL(provider?.baseUrl);}catch{throw fail('NATIVE_SESSION_CONFIG_INVALID');}
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||typeof fetchImpl!=='function'||provider.endpointHost!==undefined&&provider.endpointHost!==null&&!/^[A-Za-z0-9.-]+$/.test(provider.endpointHost))throw fail('NATIVE_SESSION_CONFIG_INVALID');
  const origin=base.href.replace(/\/$/,''), providerHeaders=headers(provider.headers??{}),endpointHost=provider.endpointHost,execdToken=provider.execdToken;
  const uncertaintyMs=provider.uncertaintyMs??1000;
  if(!Number.isSafeInteger(uncertaintyMs)||uncertaintyMs<0||uncertaintyMs>60000||execdToken!==undefined&&execdToken!==null&&typeof execdToken!=='string')throw fail('NATIVE_SESSION_CONFIG_INVALID');
  return async function observeNativeSessions({runtimeId,resources,signal,timeoutMs=10000}={}) {
    if(typeof runtimeId!=='string'||!runtimeId||!Array.isArray(resources)||resources.length!==4||new Set(resources.map(row=>row.botId)).size!==4||new Set(resources.map(row=>row.sandboxId)).size!==4||resources.some(row=>typeof row.botId!=='string'||!row.botId||!/^[A-Za-z0-9_-]+$/.test(row.sandboxId??'')||typeof row.requestId!=='string'||!row.requestId||typeof row.source!=='string'||!row.source||!Number.isSafeInteger(row.allocationSeq)||!Number.isSafeInteger(row.readySeq)||row.allocationSeq<1||row.readySeq<=row.allocationSeq)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||signal!==undefined&&!(signal instanceof AbortSignal))throw fail('NATIVE_SESSION_CONFIG_INVALID');
    const local=new AbortController(),timer=setTimeout(()=>local.abort(),timeoutMs),live=AbortSignal.any([local.signal,...(signal?[signal]:[])]);
    const deadline=performance.now()+timeoutMs;
    const bounded=operation=>new Promise((resolve,reject)=>{
      const abort=()=>reject(fail('NATIVE_SESSION_ABORTED'));
      live.addEventListener('abort',abort,{once:true});
      Promise.resolve().then(()=>{live.throwIfAborted();return operation();}).then(resolve,reject).finally(()=>live.removeEventListener('abort',abort));
      if(live.aborted)abort();
    });
    async function request(url,options={}) {
      live.throwIfAborted();
      const response=await bounded(()=>fetchImpl(url,{...options,redirect:'error',signal:live}));
      if(!response.ok)throw fail('NATIVE_SESSION_PROVIDER_FAILED');
      const text=await bounded(async()=>{let bytes=0;const chunks=[];try{for await(const chunk of response.body){bytes+=chunk.length;if(bytes>65536)throw fail('NATIVE_SESSION_RESPONSE_LIMIT');chunks.push(chunk);}return Buffer.concat(chunks).toString('utf8');}finally{await response.body?.cancel().catch(()=>{});}});
      return {text,headers:response.headers};
    }
    async function resource(member) {
      const response=await request(`${origin}/sandboxes/${encodeURIComponent(member.sandboxId)}`,{headers:providerHeaders});
      const row=JSON.parse(response.text),date=response.headers.get('date'),stamp=Date.parse(date);
      if(!Number.isFinite(stamp)||new Date(stamp).toUTCString()!==date||Math.abs(Date.now()-stamp)>uncertaintyMs+1000||(response.headers.get('age')??'0')!=='0')throw fail('NATIVE_SESSION_PROVIDER_STALE');
      if(row.id!==member.sandboxId||row.status?.state!=='Running'||row.metadata?.runtime_key!==openSandboxRuntimeKey(runtimeId)||row.metadata?.bot_key!==openSandboxBotKey(member.botId)||row.metadata?.resource_key!==openSandboxBotKey(member.botId))throw fail('NATIVE_SESSION_RESOURCE_MISMATCH');
    }
    try {
      const result=[];
      for(const member of resources.map(row=>({...row}))){
        await resource(member);
        const reply=await request(`${origin}/sandboxes/${encodeURIComponent(member.sandboxId)}/endpoints/44772`,{headers:providerHeaders});
        const target=endpoint(JSON.parse(reply.text),endpointHost),auth=headers(target.headers);
        if(execdToken&&!Object.keys(auth).some(name=>name.toLowerCase()==='x-execd-access-token'))auth['X-EXECD-ACCESS-TOKEN']=execdToken;
        const authenticated=Object.entries(auth).some(([name,value])=>value&&/authorization|token|api[-_]?key/i.test(name));
        const localRoute=['127.0.0.1','localhost','[::1]'].includes(new URL(target.url).hostname);
        if(!authenticated&&!localRoute)throw fail('NATIVE_SESSION_ENDPOINT_UNTRUSTED');
        const response=await request(`${target.url}/command`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({command:SESSION_OBSERVATION_COMMAND,cwd:'/workspace',timeout:Math.max(1,Math.min(2000,Math.floor(deadline-performance.now()))),background:false,envs:{}})});
        const observed=commandOutput(response.text,response.headers.get('content-type')??'');
        await resource(member);
        result.push({botId:member.botId,sandboxId:member.sandboxId,...observed,transport:authenticated?'endpoint-authenticated':'trusted-local-route',requestId:member.requestId,allocationSeq:member.allocationSeq,readySeq:member.readySeq,observedAtMs:performance.now()});
      }
      if(new Set(result.map(row=>row.sessionId)).size!==4)throw fail('NATIVE_SESSION_INVALID');
      return result;
    }catch(error){
      if(live.aborted)throw fail('NATIVE_SESSION_ABORTED');
      if(typeof error?.code==='string'&&error.code.startsWith('NATIVE_SESSION_'))throw error;
      throw fail('NATIVE_SESSION_INVALID');
    }finally{clearTimeout(timer);local.abort();}
  };
}
