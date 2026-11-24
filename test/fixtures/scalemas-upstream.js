import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { streamResponse } from './core-controlled-upstream.js';

export const sourceContent = 'ARITHMETIC_SEED: 7+5=12.\n';
export function scaleMASCommand(peer, cycle, { poolSize = 3 } = {}) {
  assert.ok([3, 6].includes(poolSize));
  assert.ok(Number.isSafeInteger(peer) && peer >= 0 && peer < poolSize && [0, 1].includes(cycle));
  return `python3 - <<'SCALEMAS_FIXED'
import json,os,pathlib,re,subprocess,time
peer=${peer}
cycle=${cycle}
source=${JSON.stringify(sourceContent)}
def cli(operation,value,request_id):
 path=pathlib.Path('request.json'); path.write_text(json.dumps(value))
 result=subprocess.run(['swarm','substrate',operation,'--input',str(path),'--request-id',request_id],capture_output=True,text=True,timeout=10)
 assert result.returncode==0, 'substrate CLI failed'
 return json.loads(result.stdout)
pid=os.getppid()
for _ in range(12):
 stat=pathlib.Path(f'/proc/{pid}/stat').read_text(); fields=stat[stat.rindex(')')+2:].split()
 if stat[stat.index('(')+1:stat.rindex(')')] in ['pi','pi-rpc']:
  identity={'pid':pid,'starttime':fields[19]}; break
 pid=int(fields[1]); assert pid>1
else: raise AssertionError('Native Pi process missing')
assert os.getcwd()=='/workspace/project'
if cycle==0:
 previous=None
else:
 previous=json.loads(pathlib.Path('continuity.json').read_text())
 assert previous['process']==identity and previous['cwd']==os.getcwd()
 sessions=list(pathlib.Path('/workspace/runtime/pi-session').rglob('*.jsonl')); assert len(sessions)==1
 match=re.fullmatch(r'\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z_([a-f0-9-]{36})[.]jsonl',sessions[0].name); assert match
session_id=match[1] if cycle else None
adopted=None
if peer==0:
 content=source if cycle==0 else 'Producer continuation retains original bytes.'
 refs=[] if cycle==0 else [previous['published']['address']]
elif peer==1:
 if cycle==0:
  for _ in range(30):
   search=cli('search',{'query':'ARITHMETIC_SEED','limit':1},'search-initial')
   assert len(search['results'])<=1
   if search['results']: break
   time.sleep(.1)
  assert search['results']
  adopted=cli('visit',{'address':search['results'][0]['address']},'visit-original')
 else:
  if ${poolSize}==6:
   search=cli('search',{'query':'ARITHMETIC_SEED','limit':1},'search-after-producer-stop')
   assert len(search['results'])==1 and search['results'][0]['address']==previous['adopted']['address']
  adopted=cli('visit',{'address':previous['adopted']['address']},'visit-after-producer-stop')
  assert adopted==previous['adopted']
 assert adopted['content']==source and adopted['version']==1
 content='Adopted exact: '+adopted['content']+('Second reader cycle.' if cycle else '')
 refs=[adopted['address']]+([previous['published']['address']] if cycle else [])
else:
 content='Independent peer fixed contribution '+str(cycle)
 refs=[] if cycle==0 else [previous['published']['address']]
published=cli('publish',{'content':content,'references':refs},'publish-'+str(cycle))
assert published['content']==content and published['references']==sorted(refs)
assert cli('publish',{'content':content,'references':refs},'publish-'+str(cycle))==published
row={'peer':peer,'cycle':cycle,'process':identity,'cwd':os.getcwd(),'published':published,'adopted':adopted,'sessionId':session_id}
pathlib.Path('result-'+str(cycle)+'.json').write_text(json.dumps(row))
if cycle==0: pathlib.Path('continuity.json').write_text(json.dumps(row))
print(json.dumps(row))
SCALEMAS_FIXED`;
}

export async function createScaleMASUpstream({ deadlineAt, poolSize = 3, observe = async () => {}, onFailure = () => {} }) {
  assert.ok([3, 6].includes(poolSize));
  const maxRequests = poolSize * 4;
  let arrivals = 0, accepted = 0, failure;
  const stages = new Map(), evidence = [];
  const server = createServer(async (request, response) => {
    const arrival = ++arrivals; let stage = 'bounds';
    try {
      assert.ok(!failure && arrival <= maxRequests && Date.now() < deadlineAt);
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 2 * 1024 ** 2); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(body.model, 'k3'); assert.ok(Array.isArray(body.input));
      assert.ok(Number.isSafeInteger(body.max_output_tokens) && body.max_output_tokens > 0 && body.max_output_tokens <= 128);
      stage = 'fixed-input';
      const user = body.input.filter(row => row.role === 'user').at(-1);
      const text = typeof user?.content === 'string' ? user.content : user?.content?.map(row => row.text ?? '').join('');
      const match = /^scaleMAS peer=([0-9]+) cycle=([01])\n/.exec(text); assert.ok(match);
      const peer = Number(match[1]), cycle = Number(match[2]), key = `${peer}:${cycle}`;
      assert.ok(Number.isSafeInteger(peer) && peer < poolSize);
      const turn = (stages.get(key) ?? 0) + 1; assert.ok(turn <= 2); stages.set(key, turn);
      const callId = `scale_${peer}_${cycle}`; let item;
      if (turn === 1) {
        stage = 'native-observation';
        if (peer === 1 && cycle === 0) {
          while (!evidence.some(row => row.peer === 0 && row.cycle === 0)) {
            assert.ok(!failure && Date.now() < deadlineAt); await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        if (cycle === 1) await observe({ phase: 'before', peer, previous: evidence.find(row => row.peer === peer && row.cycle === 0) });
        item = { type: 'function_call', id: `fc_${callId}`, call_id: callId, name: 'bash', arguments: JSON.stringify({ command: scaleMASCommand(peer, cycle, { poolSize }), timeout: 40 }) };
      } else {
        stage = 'tool-result';
        const outputs = body.input.filter(row => row.type === 'function_call_output' && row.call_id === callId); assert.equal(outputs.length, 1);
        const row = JSON.parse(outputs[0].output.trim());
        assert.equal(row.peer, peer); assert.equal(row.cycle, cycle); assert.equal(row.cwd, '/workspace/project');
        assert.ok(Number.isSafeInteger(row.process?.pid) && row.process.pid > 1); assert.match(row.process.starttime, /^[0-9]+$/);
        assert.match(row.published.address, /^content:[a-f0-9]{64}$/); assert.equal(row.published.version, 1); assert.ok(row.published.author);
        if (cycle === 1) {
          const previous = evidence.find(value => value.peer === peer && value.cycle === 0); assert.ok(previous);
          assert.deepEqual(row.process, previous.process); assert.equal(row.published.author, previous.published.author);
          assert.match(row.sessionId, /^[a-f0-9-]{36}$/); await observe({ phase: 'after', peer, row });
        }
        if (peer === 0 && cycle === 0) assert.equal(row.published.content, sourceContent);
        if (peer === 1) {
          const source = evidence.find(value => value.peer === 0 && value.cycle === 0); assert.ok(source);
          assert.deepEqual(row.adopted, source.published); assert.ok(row.published.references.includes(source.published.address));
          assert.ok(row.published.content.includes(sourceContent));
        }
        evidence.push(row);
        item = { type: 'message', id: `msg_${callId}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'FIXED_CYCLE_OK', annotations: [] }] };
      }
      assert.ok(!failure && Date.now() < deadlineAt); accepted++;
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(streamResponse('k3', arrival, item));
    } catch {
      const first = !failure; failure ??= { code: 'FIXED_SCALEMAS_FAILED', stage, arrival };
      const terminal = { type: 'response.failed', response: { id: `scale_failed_${arrival}`, object: 'response', model: 'k3', status: 'failed', output: [],
        error: { code: failure.code, message: failure.code }, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } };
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`event: response.failed\ndata: ${JSON.stringify(terminal)}\n\n`);
      if (first) onFailure();
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/v1/responses`, receipt: () => ({ poolSize, maxRequests, arrivals, accepted, failure, evidence }),
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
