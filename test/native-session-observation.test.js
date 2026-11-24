import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNativeSessionObserver, SESSION_OBSERVATION_COMMAND } from '../src/environments/endurance/native-session-observation.js';
import { openSandboxBotKey, openSandboxRuntimeKey } from '../src/runtime/opensandbox-metadata.js';

function fixture({mismatch=false,conflict=false,sse=false,mismatchAfter=false,missingTerminal=false,noAuth=false,localRoute=false}={}) {
  const calls=[];let commandSeen=false;const runtimeId='actual-runtime';
  const resources=['a','b','c','d'].map((botId,index)=>({botId,sandboxId:`sandbox-${index}`,requestId:`spawn-${index}`,allocationSeq:index*4+3,readySeq:index*4+4,source:'host'}));
  const fetchImpl=async(input,options={})=>{
    const url=new URL(input);calls.push({url:String(url),...options});
    if(url.origin==='http://provider.test'){
      assert.equal(options.method??'GET','GET');assert.equal(options.headers['OPEN-SANDBOX-API-KEY'],'private-provider');
      const resource=resources.find(row=>url.pathname.includes('/sandboxes/'+row.sandboxId));assert.ok(resource);
      if(url.pathname.endsWith('/endpoints/44772'))return Response.json({endpoint:`http://execd.test/${resource.sandboxId}`,headers:noAuth?{}:{'X-EXECD-ACCESS-TOKEN':'private-execd'}});
      return Response.json({id:resource.sandboxId,status:{state:'Running'},metadata:{runtime_key:openSandboxRuntimeKey(mismatch||mismatchAfter&&commandSeen?'foreign':runtimeId),bot_key:openSandboxBotKey(resource.botId),resource_key:openSandboxBotKey(resource.botId)}},{headers:{date:new Date().toUTCString()}});
    }
    commandSeen=true;assert.equal(options.method,'POST');assert.equal(options.headers['X-EXECD-ACCESS-TOKEN'],noAuth?undefined:'private-execd');assert.equal(options.headers['OPEN-SANDBOX-API-KEY'],undefined);
    const payload=JSON.parse(options.body);assert.equal(payload.command,SESSION_OBSERVATION_COMMAND);assert.equal(payload.background,false);
    const index=Number(url.pathname.split('/')[1].slice(8));
    const sessionId=`00000000-0000-0000-0000-${String(index).padStart(12,'0')}`;
    const stdout=JSON.stringify({sessionId,sessionFile:`2026-11-23T00-00-00Z_${conflict?'different':sessionId}.jsonl`});
    if(sse)return new Response(`event: stdout\ndata: ${JSON.stringify({text:stdout})}\n\n${missingTerminal?'':'event: execution_complete\ndata: {"exit_code":0}\n\n'}`,{headers:{'content-type':'text/event-stream'}});
    return Response.json({stdout,stderr:'',exit_code:0});
  };
  return {calls,runtimeId,resources,observe:createNativeSessionObserver({provider:{baseUrl:'http://provider.test/v1',headers:{'OPEN-SANDBOX-API-KEY':'private-provider'},...(localRoute?{endpointHost:'127.0.0.1'}:{})},fetchImpl})};
}

for(const sse of [false,true])test(`native observer binds exact admitted resource and authenticated ${sse?'SSE':'JSON'} command output`,async()=>{
  const fixture_=fixture({sse});const rows=await fixture_.observe({...fixture_,timeoutMs:1000});
  assert.equal(rows.length,4);assert.deepEqual(rows.map(row=>row.botId),['a','b','c','d']);
  assert.equal(fixture_.calls.length,16);
  assert.ok(fixture_.calls.every(row=>!row.url.includes('page')&&!['DELETE','PUT'].includes(row.method)));
  assert.equal(JSON.stringify(rows).includes('private-'),false);
});

test('wrong provider owner prevents every sandbox command',async()=>{
  const f=fixture({mismatch:true});await assert.rejects(f.observe({...f,timeoutMs:1000}),{code:'NATIVE_SESSION_RESOURCE_MISMATCH'});
  assert.ok(f.calls.every(row=>row.method!=='POST'));
});

test('conflicting native header and filename identity cannot pass',async()=>{
  const f=fixture({conflict:true});await assert.rejects(f.observe({...f,timeoutMs:1000}),{code:'NATIVE_SESSION_INVALID'});
});

test('a provider that never responds is bounded and cannot trigger another request',async()=>{
  let calls=0;
  const f=fixture();const observe=createNativeSessionObserver({provider:{baseUrl:'http://provider.test/v1'},fetchImpl:()=>{calls++;return new Promise(()=>{});}});
  await assert.rejects(observe({...f,timeoutMs:20}),{code:'NATIVE_SESSION_ABORTED'});assert.equal(calls,1);
});

test('the fixed metadata command validates the actual header without exporting header paths or conversation lines',async()=>{
  const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
  const run=promisify(execFile);
  const harness=`import sys,shlex,json,io,types,unittest.mock as m
args=shlex.split(sys.argv[1])
assert args[:3]==['python3','-I','-c']
sid='00000000-0000-0000-0000-000000000123'
name='2026-11-23T00-00-00Z_'+sid+'.jsonl'
header={'type':'session','id':sid,'cwd':'PRIVATE_HEADER_PATH','parentSession':'PRIVATE_PARENT_PATH'}
if sys.argv[2]=='conflict':header['id']='00000000-0000-0000-0000-000000000999'
class OnlyHeader(io.BytesIO):
 def readline(self,limit):
  assert limit==65537
  assert self.tell()==0
  return super().readline(limit)
 def read(self,*args):raise AssertionError('conversation read')
stream=OnlyHeader((json.dumps(header)+'\\nPRIVATE_CONVERSATION_LINE\\n').encode())
entry=types.SimpleNamespace(name=name,is_file=lambda **kw:kw=={'follow_symlinks':False})
with m.patch('os.path.realpath',side_effect=lambda value:value),m.patch('os.scandir',return_value=[entry]),m.patch('os.open',return_value=123),m.patch('os.fdopen',return_value=stream):
 exec(compile(args[3],'<fixed-session-observer>','exec'))
`;
  const result=await run('python3',['-I','-c',harness,SESSION_OBSERVATION_COMMAND,'valid'],{timeout:1000});
  assert.equal(JSON.parse(result.stdout).sessionId,'00000000-0000-0000-0000-000000000123');
  assert.equal(result.stdout.includes('PRIVATE_'),false);
  await assert.rejects(run('python3',['-I','-c',harness,SESSION_OBSERVATION_COMMAND,'conflict'],{timeout:1000}));
});


test('an unauthenticated remote endpoint outside the trusted local route stays unsupported',async()=>{
  const f=fixture({noAuth:true});await assert.rejects(f.observe({...f,timeoutMs:1000}),{code:'NATIVE_SESSION_ENDPOINT_UNTRUSTED'});
  assert.ok(f.calls.every(row=>row.method!=='POST'));
});

test('ownership lost after command cannot produce a Session receipt',async()=>{
  const f=fixture({mismatchAfter:true});await assert.rejects(f.observe({...f,timeoutMs:1000}),{code:'NATIVE_SESSION_RESOURCE_MISMATCH'});
  assert.equal(f.calls.filter(row=>row.method==='POST').length,1);
});

test('a foreground command stream without confirmed completion stays unknown',async()=>{
  const f=fixture({sse:true,missingTerminal:true});await assert.rejects(f.observe({...f,timeoutMs:1000}),{code:'NATIVE_SESSION_COMMAND_UNKNOWN'});
});


test('the existing authoritative localhost Execd route remains supported without inventing an extra token requirement',async()=>{
  const f=fixture({noAuth:true,localRoute:true});const rows=await f.observe({...f,timeoutMs:1000});
  assert.equal(rows.length,4);assert.ok(rows.every(row=>row.transport==='trusted-local-route'));
  assert.equal(f.calls.filter(row=>row.method==='POST').length,4);
});
