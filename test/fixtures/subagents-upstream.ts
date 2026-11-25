import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { streamResponse } from './core-controlled-upstream.js';

const identity = `pid=os.getppid()
for _ in range(12):
 stat=pathlib.Path(f'/proc/{pid}/stat').read_text()
 fields=stat[stat.rindex(')')+2:].split()
 if stat[stat.index('(')+1:stat.rindex(')')] in ['pi','pi-rpc']:
  process={'pid':pid,'starttime':fields[19]}
  break
 pid=int(fields[1])
 assert pid>1
else: raise AssertionError('Native process missing')`;
export function childCommand(followup) {
  return `python3 - <<'SUBAGENTS'
import json,os,pathlib,subprocess
${identity}
pathlib.Path('denied-child.json').write_text(json.dumps({'profile':'child'}))
denied=subprocess.run(['swarm','bot','spawn','--input','denied-child.json','--request-id','no-recursion'],capture_output=True,text=True,timeout=10)
assert denied.returncode!=0 and json.loads(denied.stderr)['code'] in ['CLI_ERROR','NOT_ALLOWED']
current={'process':process,'cwd':os.getcwd(),'recursionDenied':True}
${followup ? `assert json.loads(pathlib.Path('continuity.json').read_text())==current
assert pathlib.Path('context.txt').read_text()=='original child context'
files=list(pathlib.Path('/workspace/runtime/pi-session').rglob('*.jsonl'))
assert len(files)==1
current['sessionFile']=files[0].name` : `pathlib.Path('continuity.json').write_text(json.dumps(current))
pathlib.Path('context.txt').write_text('original child context')`}
print(json.dumps(current))
SUBAGENTS`;
}
export function delegationCommand() {
  return `python3 - <<'SUBAGENTS'
import json,pathlib,subprocess
def cli(*args):
 result=subprocess.run(['swarm',*args],capture_output=True,text=True,timeout=15)
 assert result.returncode==0
 return json.loads(result.stdout)
def denied(payload,name):
 path=name+'.json'
 pathlib.Path(path).write_text(json.dumps(payload))
 result=subprocess.run(['swarm','bot','spawn','--input',path,'--request-id',name],capture_output=True,text=True,timeout=10)
 assert result.returncode!=0 and json.loads(result.stderr)['code'] in ['SERVICE_INPUT_INVALID','NOT_ALLOWED']
 return True
checks=[denied({'profile':'parent'},'bad-profile'),denied({'profile':'child','parentId':'forged'},'forged-parent')]
children=[]
for role in ['A','B']:
 path='child-'+role+'.json'
 pathlib.Path(path).write_text(json.dumps({'profile':'child','input':'SUBAGENTS_CHILD_'+role,'mode':'followUp'}))
 result=cli('bot','spawn','--input',path,'--request-id','child-'+role)
 assert result['initialInput']['status']=='accepted'
 children.append(result['bot'])
assert len(set(child['id'] for child in children))==2
assert all(child['parentId']==children[0]['parentId'] for child in children)
for operation,target in [('get','foreign-runtime-bot'),('send','foreign-runtime-bot'),('stop',children[0]['parentId'])]:
 args=['swarm','bot',operation,'--bot-id',target,'--request-id','denied-'+operation]
 if operation=='send':
  pathlib.Path('foreign-send.json').write_text(json.dumps({'bot_id':target,'input':'forbidden','mode':'followUp'}))
  args=['swarm','bot','send','--input','foreign-send.json','--request-id','denied-send']
 result=subprocess.run(args,capture_output=True,text=True,timeout=10)
 assert result.returncode!=0 and json.loads(result.stderr)['code']=='NOT_ALLOWED'
 checks.append(True)
print(json.dumps({'children':children,'negativeChecks':checks}))
SUBAGENTS`;
}
function texts(value, result = []) {
  if (typeof value === 'string') result.push(value);
  else if (Array.isArray(value)) for (const item of value) texts(item, result);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) texts(item, result);
  return result;
}
// Pinned Pi Responses conversion emits each host text input as one user
// message with one input_text block. Assistant/tool echoes are not deliveries.
function deliveredResults(input, children, native, history) {
  const current = new Map();
  for (const message of input) {
    if (message.role !== 'user' || message.type !== undefined && message.type !== 'message' ||
        !Array.isArray(message.content) || message.content.length !== 1 || message.content[0].type !== 'input_text') continue;
    let row;
    try { row = JSON.parse(message.content[0].text); } catch { continue; }
    if (!row || typeof row !== 'object' || !Object.hasOwn(row, 'childId')) continue;
    assert.deepEqual(Object.keys(row).sort(), ['childId', 'eventSeq', 'outcome', 'output']);
    assert.equal(row.outcome, 'completed'); assert.ok(Number.isSafeInteger(row.eventSeq) && row.eventSeq > 0);
    const index = children?.findIndex(child => child.id === row.childId); assert.ok(index >= 0);
    const role = index === 0 ? 'A' : 'B';
    const source = native.find(entry => entry.role === role && entry.output === row.output); assert.ok(source);
    const key = `${row.childId}:${row.eventSeq}`;
    assert.ok(!current.has(key));
    if (source.eventSeq !== undefined) assert.equal(row.eventSeq, source.eventSeq);
    else {
      assert.ok(!history.has(key));
      const earlier = native.filter(entry => entry.role === role && entry.turn < source.turn);
      assert.ok(earlier.every(entry => Number.isSafeInteger(entry.eventSeq) && entry.eventSeq < row.eventSeq));
      source.eventSeq = row.eventSeq;
    }
    if (history.has(key)) assert.deepEqual(row, history.get(key));
    current.set(key, row); history.set(key, row);
  }
  return [...current.values()];
}
export async function createSubagentsUpstream({ onFailure = () => {}, observeSessions = async () => {} } = {}) {
  let arrivals = 0; let accepted = 0; let failure; let parentPhase = 'initial'; let children; let finalResults;
  const counts = { A: 0, B: 0 }; const results = new Map(); const native = [];
  const deadline = Date.now() + 120_000;
  const server = createServer(async (request, response) => {
    const ordinal = ++arrivals; let stage = 'bounds';
    try {
      assert.ok(!failure && ordinal <= 16 && Date.now() < deadline);
      stage = 'request'; assert.equal(request.url, '/v1/responses'); assert.equal(request.method, 'POST');
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 2 * 1024 ** 2); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(body.model, 'k3'); assert.ok(Array.isArray(body.input));
      const strings = texts(body.input); const parent = strings.includes('SUBAGENTS_PARENT');
      let item;
      const message = text => ({ type: 'message', id: `msg_${ordinal}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
      const tool = (id, command) => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name: 'bash', arguments: JSON.stringify({ command, timeout: 45 }) });
      const output = id => {
        const rows = body.input.filter(row => row.type === 'function_call_output' && row.call_id === id); assert.equal(rows.length, 1);
        return JSON.parse(rows[0].output.trim());
      };
      if (parent) {
        stage = `parent-${parentPhase}`;
        const currentResults = deliveredResults(body.input, children, native, results);
        if (parentPhase === 'initial') { item = tool('delegate', delegationCommand()); parentPhase = 'delegated'; }
        else if (parentPhase === 'delegated') {
          const row = output('delegate'); assert.equal(row.children.length, 2); assert.deepEqual(row.negativeChecks, [true, true, true, true, true]); children = row.children;
          item = message('Delegated two subproblems.'); parentPhase = 'results';
        } else if (parentPhase === 'followup-sent') {
          const row = output('followup'); assert.equal(row.status, 'accepted'); item = message('Waiting for the same child followup.'); parentPhase = 'results';
        } else if (native.length === 3) {
          assert.equal(currentResults.length, 3); assert.equal(results.size, 3);
          assert.equal(new Set(currentResults.map(row => row.childId)).size, 2);
          finalResults = currentResults;
          assert.equal(native.length, 3); await observeSessions('final', native);
          item = message(JSON.stringify({ summary: 'Request validation checks data shape; authentication establishes the caller. The original child adds that neither substitutes for authorization.',
            conclusions: currentResults.map(row => ({ childId: row.childId, eventSeq: row.eventSeq, quote: row.output })) }));
        } else if (results.size === 2 && counts.A === 2) {
          await observeSessions('before-followup', native);
          const child = children[0].id;
          item = tool('followup', `set -euo pipefail\nswarm bot get --bot-id ${child} | python3 -c 'import json,sys; assert json.load(sys.stdin)["status"]=="idle"'\npython3 - <<'SUBAGENTS'\nimport json,pathlib\npathlib.Path('followup.json').write_text(json.dumps({'bot_id':'${child}','input':'SUBAGENTS_FOLLOWUP','mode':'followUp'}))\nSUBAGENTS\nswarm bot send --input followup.json --request-id child-followup`);
          parentPhase = 'followup-sent';
        } else item = message('Waiting for remaining child results.');
      } else {
        const role = strings.includes('SUBAGENTS_CHILD_A') ? 'A' : strings.includes('SUBAGENTS_CHILD_B') ? 'B' : null; assert.ok(role);
        const turn = ++counts[role]; stage = `child-${role}-${turn}`; assert.ok(turn <= (role === 'A' ? 4 : 2));
        if (turn % 2) item = tool(`child_${role}_${turn}`, childCommand(turn === 3));
        else {
          const row = output(`child_${role}_${turn - 1}`); assert.equal(row.cwd, '/workspace/project'); assert.equal(row.recursionDenied, true); assert.ok(row.process.pid > 1); assert.match(row.process.starttime, /^\d+$/);
          if (turn === 4) { assert.deepEqual(row.process, native.find(entry => entry.role === 'A').process); assert.ok(row.sessionFile); }
          const text = role === 'B' ? 'Authentication establishes the caller identity.' : turn === 2 ? 'Validation checks input shape before side effects.' : 'Followup: authorization separately checks what this caller may do.';
          native.push({ role, turn, ...row, output: text });
          item = message(text);
        }
      }
      assert.ok(!failure); accepted++; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(streamResponse('k3', ordinal, item));
    } catch {
      const first = !failure; failure ??= { code: 'SUBAGENTS_FIXTURE_FAILED', stage, ordinal };
      const terminal = { type: 'response.failed', response: { id: `failed_${ordinal}`, object: 'response', model: 'k3', status: 'failed', output: [], error: { code: failure.code, message: failure.code }, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } };
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`event: response.failed\ndata: ${JSON.stringify(terminal)}\n\n`); if (first) onFailure();
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/v1/responses`, receipt: () => ({ arrivals, accepted, failure, children, results: [...results.values()], finalResults, native }), close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
