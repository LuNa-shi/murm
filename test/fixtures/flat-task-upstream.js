import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { streamResponse } from './core-controlled-upstream.js';

export function flatTakeCommand(taskId, id) {
  const script = `import os,json,subprocess,hashlib
TASK=${JSON.stringify(taskId)}
ID=${JSON.stringify(id)}
def command(args):
 return subprocess.run(['swarm','task']+args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=28)
def process_identity():
 return [os.getpid(),os.getppid(),os.getcwd()]
stage='native-context'
before=process_identity()
assert before[2]=='/workspace/project'
stage='readonly-probe'
try:
 open('before-grant.txt','w').write('BAD')
 raise AssertionError('readonly workDir was writable')
except PermissionError: pass
stage='discovery-list'
listed=command(['list','--state','ready','--request-id',ID+'-list'])
assert listed.returncode==0
assert any(t['task_id']==TASK for t in json.loads(listed.stdout)['tasks'])
stage='discovery-view'
viewed=command(['view',TASK,'--request-id',ID+'-view'])
assert viewed.returncode==0 and json.loads(viewed.stdout)['task']['task_id']==TASK
stage='take'
taken=command(['take',TASK,'--request-id',ID+'-take'])
checks={'readonly_before':True,'discovery':True,'same_process':process_identity()==before}
if taken.returncode==0:
 stage='winner-contract'
 result=json.loads(taken.stdout)
 assert result['execution']['state']=='RUNNING'
 assert result['handoff']['executionFence']==result['execution']['fencing_version']
 assert result['materials'][0]['content']=={'text':'fixed material bytes'}
 stage='input-bytes'
 assert open('input.txt','rb').read()=='fixed λ\\n'.encode('utf8')
 assert result['workspace']['revision']=='0.1'
 stage='native-write'
 open('native-result.txt','w').write('FIXED_NATIVE_WRITE\\n')
 assert open('native-result.txt').read()=='FIXED_NATIVE_WRITE\\n'
 checks.update({'role':'winner','pinned_bytes':True,'material_bytes':True,'native_write':True,'prepared_digest':result['handoff']['prepared']['digest'],'execution_fence':result['execution']['fencing_version'],'prepared_version':result['handoff']['prepared']['version']})
else:
 stage='loser-contract'
 assert json.loads(taken.stderr)['code']=='CONFLICT'
 assert not os.path.exists('input.txt') and not os.path.exists('native-result.txt')
 try:
  open('loser-must-not-write','w').write('BAD')
  raise AssertionError('conflict opened write access')
 except PermissionError: pass
 checks.update({'role':'loser','conflict_preserves_readonly':True})
stage='process-continuity'
assert checks['same_process']
checks['process_digest']=hashlib.sha256(json.dumps(before).encode()).hexdigest()
print(json.dumps(checks))
`;
  const guarded = `stage='bootstrap'\ntry:\n${script.trimEnd().split('\n').map(line => ' '+line).join('\n')}\nexcept BaseException as error:\n print(json.dumps({'fixture_failure':{'stage':stage,'kind':type(error).__name__}}))\n`;
  return `python3 - <<'FLAT_FIXED_TAKE'\n${guarded}FLAT_FIXED_TAKE`;
}

export async function createFlatTakeUpstream(taskId, deadlineAt) {
  let arrivals = 0, accepted = 0, failure, firstFailure;
  const turns = new Map(), evidence = {};
  const server = createServer(async (request, response) => {
    const arrival = ++arrivals;
    let stage = 'admission', id, turn;
    try {
      assert.ok(!failure && arrival <= 4 && Date.now() < deadlineAt);
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      let bytes = 0; const chunks = [];
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 2 * 1024 ** 2); chunks.push(chunk); }
      stage = 'request-shape';
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.model, 'k3'); assert.ok(Array.isArray(body.input));
      const user = body.input.filter(row => row.role === 'user').at(-1);
      stage = 'fixed-input';
      id = typeof user?.content === 'string' ? user.content : user?.content?.map(row => row.text ?? '').join('');
      assert.ok(['FLAT_T11_A', 'FLAT_T11_B'].includes(id));
      stage = 'turn-count';
      turn = (turns.get(id) ?? 0) + 1; assert.ok(turn <= 2); turns.set(id, turn);
      let item;
      if (turn === 1) item = { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: 'bash', arguments: JSON.stringify({ command: flatTakeCommand(taskId, id), timeout: 45 }) };
      else {
        stage = 'tool-correlation';
        const output = body.input.find(row => row.type === 'function_call_output' && row.call_id === `call_${id}`)?.output;
        assert.equal(typeof output, 'string');
        stage = 'tool-json';
        const checks = JSON.parse(output.trim());
        if (checks.fixture_failure) {
          const stages = ['bootstrap','native-context','readonly-probe','discovery-list','discovery-view','take','winner-contract','input-bytes','native-write','loser-contract','process-continuity'];
          if (stages.includes(checks.fixture_failure.stage)) stage = `native-${checks.fixture_failure.stage}`;
          throw new Error('Fixed native check failed');
        }
        stage = 'tool-evidence';
        assert.equal(checks.readonly_before, true); assert.equal(checks.discovery, true); assert.equal(checks.same_process, true);
        assert.match(checks.process_digest, /^[a-f0-9]{64}$/);
        if (checks.role === 'winner') {
          assert.equal(checks.pinned_bytes, true); assert.equal(checks.material_bytes, true); assert.equal(checks.native_write, true);
          assert.match(checks.prepared_digest, /^[a-f0-9]{64}$/);
          assert.ok(Number.isSafeInteger(checks.execution_fence) && checks.execution_fence > 0 && Number.isSafeInteger(checks.prepared_version) && checks.prepared_version > 0);
        } else { assert.equal(checks.role, 'loser'); assert.equal(checks.conflict_preserves_readonly, true); }
        evidence[id] = checks;
        item = { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `${id}_OK`, annotations: [] }] };
      }
      assert.ok(!failure && Date.now() < deadlineAt);
      accepted++;
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(streamResponse('k3', arrival, item));
    } catch {
      failure = 'FIXED_FLAT_TAKE_FAILED';
      firstFailure ??= { stage, arrival, ...( ['FLAT_T11_A', 'FLAT_T11_B'].includes(id) ? { input: id } : {}),
        ...(Number.isSafeInteger(turn) ? { turn } : {}) };
      const terminal = { type: 'response.failed', response: { id: `resp_flat_failure_${arrival}`, object: 'response',
        model: 'k3', status: 'failed', output: [], error: { code: failure, message: failure },
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`event: response.failed\ndata: ${JSON.stringify(terminal)}\n\n`);
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/v1/responses`, receipt: () => ({ arrivals, accepted, failure, firstFailure, evidence }),
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
