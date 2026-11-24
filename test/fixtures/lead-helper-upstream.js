import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { streamResponse } from './core-controlled-upstream.js';

export const adjustedDirection = 'Add explicit evidence and explain authorization as a separate check.';
export function leadHelperCommand(kind, { sessionDirectory = '/workspace/runtime/pi-session' } = {}) {
  assert.ok(['initialize', 'helper-initial', 'user-and-feedback', 'helper-followup'].includes(kind));
  return `python3 - <<'LEAD_HELPER'
import hashlib,json,os,pathlib,subprocess
kind=${JSON.stringify(kind)}
def cli(operation,payload,expected=None):
 cli.count+=1
 path=pathlib.Path('.request-'+str(cli.count)+'.json')
 path.write_text(json.dumps(payload))
 result=subprocess.run(['swarm','board',operation,'--input',str(path),'--request-id',kind+'-'+str(cli.count)],capture_output=True,text=True,timeout=10)
 if expected is not None:
  assert result.returncode!=0
  assert json.loads(result.stderr)['code'] in expected
  return True
 assert result.returncode==0
 return json.loads(result.stdout)
cli.count=0
state=cli('read',{})
branch=os.environ['WORK_BRANCH']
role=next(role for role in ['lead','helper1','helper2'] if branch.startswith(role+'-'))
assert (role=='lead')==(kind in ['initialize','user-and-feedback'])
bot=state['team'][role]
pid=os.getppid()
for _ in range(12):
 stat=pathlib.Path(f'/proc/{pid}/stat').read_text()
 fields=stat[stat.rindex(')')+2:].split()
 if stat[stat.index('(')+1:stat.rindex(')')] in ['pi','pi-rpc']:
  process={'pid':pid,'starttime':fields[19]}
  break
 pid=int(fields[1])
 assert pid>1
else: raise AssertionError('Native process missing')
continuity={'process':process,'cwd':os.getcwd(),'botId':bot,'role':role}
result={'kind':kind,**continuity}
checkpoint=pathlib.Path('.native-continuity.json')
if kind in ['user-and-feedback','helper-followup']:
 assert json.loads(checkpoint.read_text())==continuity
 files=list(pathlib.Path(${JSON.stringify(sessionDirectory)}).rglob('*.jsonl'))
 assert len(files)==1
 result['sessionFile']=files[0].name
else: checkpoint.write_text(json.dumps(continuity))
def git(*args):
 command=subprocess.run(['git',*args],capture_output=True,text=True,timeout=15)
 assert command.returncode==0
 return command.stdout.strip()
if kind in ['initialize','helper-initial']:
 git('init','.')
 git('remote','add','origin',os.environ['RUN_REPOSITORY'])
 git('fetch','origin','main')
 git('checkout','-b',branch,'origin/main')
if kind=='initialize':
 direction=cli('announce',{'text':'Build complementary reports with concrete checks.','feedback_ids':[]})
 for helper in ['helper1','helper2']:
  cli('assign',{'helper_id':state['team'][helper],'text':helper+' owns its text report'})
  cli('create_subtask',{'id':helper,'title':'Initial complementary report','path':helper+'.txt'})
 cli('create_subtask',{'id':'atomic-probe','title':'Exclusive claim race probe; retained unfinished intentionally','path':'probe.txt'})
 result['forgedOwnerDenied']=cli('create_subtask',{'id':'forged','title':'Invalid owner','path':'forged.txt','owner':bot},['SERVICE_INPUT_INVALID'])
 result['leadClaimDenied']=cli('claim',{'subtask_id':'atomic-probe','expected_revision':0},['NOT_ALLOWED','CLI_ERROR'])
 result['directionId']=direction['seq']
elif kind=='user-and-feedback':
 notes=[note['seq'] for note in state['notes'] if note['actor'] in [state['team']['helper1'],state['team']['helper2']] and note.get('subtask_id') in ['helper1','helper2']]
 assert len(notes)==2
 direction=cli('announce',{'text':${JSON.stringify(adjustedDirection)},'feedback_ids':notes,'user_input_id':'lead-adjust'})
 for helper in ['helper1','helper2']: cli('create_subtask',{'id':helper+'-next','title':'Adopt changed public direction in a new report','path':helper+'-next.txt'})
 result.update({'directionId':direction['seq'],'feedbackIds':notes,'userInputId':'lead-adjust'})
else:
 other='helper2' if role=='helper1' else 'helper1'
 result['leadOperationDenied']=cli('announce',{'text':'forged lead','feedback_ids':[]},['NOT_ALLOWED','CLI_ERROR'])
 result['otherOwnerDenied']=cli('update_subtask',{'subtask_id':other,'expected_revision':0,'text':'unauthorized'},['NOT_ALLOWED','CLI_ERROR'])
 if kind=='helper-initial':
  pathlib.Path('.probe.json').write_text(json.dumps({'subtask_id':'atomic-probe','expected_revision':0}))
  probe=subprocess.run(['swarm','board','claim','--input','.probe.json','--request-id','atomic-probe'],capture_output=True,text=True,timeout=10)
  result['probeWon']=probe.returncode==0
  if probe.returncode: assert json.loads(probe.stderr)['code']=='CONFLICT'
  result['probeOwner']=next(task['owner'] for task in cli('read',{})['subtasks'] if task['id']=='atomic-probe')
 taskId=role+('-next' if kind=='helper-followup' else '')
 claimed=cli('claim',{'subtask_id':taskId,'expected_revision':0})
 assert claimed['owner']==bot
 root=pathlib.Path('.')
 path=taskId+'.txt'
 text=(('Input validation checks shape before side effects.' if role=='helper1' else 'Authentication establishes caller identity.')+'\\nDirection: '+state['directions'][-1]['text']+'\\nEvidence: '+('new authorization check and original feedback' if kind=='helper-followup' else 'concrete initial check')+'\\n')
 (root/path).write_text(text)
 git('-C','.','add',path);git('-C','.','commit','-m',taskId);git('-C','.','push','origin',branch)
 data=(root/path).read_bytes()
 delivery={'commit':git('-C','.','rev-parse','HEAD'),'path':path,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
 complete=cli('complete',{'subtask_id':taskId,'expected_revision':claimed['revision'],'direction_id':state['directions'][-1]['seq'],'delivery':delivery})
 assert complete['state']=='complete' and complete['delivery']['verified']
 note=cli('note',{'subtask_id':taskId,'text':'Adopted changed direction in new verified report' if kind=='helper-followup' else 'Please require explicit evidence and a separate authorization check'})
 result.update({'subtaskId':taskId,'directionId':complete['directionId'],'delivery':complete['delivery'],'noteSeq':note['seq']})
print(json.dumps(result))
LEAD_HELPER`;
}
const userTexts = input => input.filter(row => row.role === 'user' && Array.isArray(row.content)).flatMap(row => row.content.filter(block => block.type === 'input_text').map(block => block.text));
export async function createLeadHelperUpstream({ onFailure = () => {}, observeSessions = async () => {} } = {}) {
  const deadline = Date.now() + 120_000; const pending = new Map(); const evidence = []; const identities = new Map();
  let arrivals = 0; let accepted = 0; let failure; let initialObserved = false;
  const server = createServer(async (request, response) => {
    const ordinal = ++arrivals; let stage = 'bounds';
    try {
      assert.ok(!failure && ordinal <= 16 && Date.now() < deadline);
      stage = 'request'; assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      const chunks = []; let bytes = 0; for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 2 * 1024 ** 2); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(body.model, 'k3'); assert.ok(Array.isArray(body.input));
      const inputs = userTexts(body.input).map(text => { try { return JSON.parse(text); } catch { return null; } }).filter(row => row && ['initialize', 'helper-initial', 'user-and-feedback', 'helper-followup'].includes(row.type));
      const current = inputs.at(-1); assert.ok(current); const kind = current.type; stage = kind;
      const outputs = body.input.filter(row => row.type === 'function_call_output' && pending.has(row.call_id));
      const latest = outputs.at(-1); let item;
      if (latest && !pending.get(latest.call_id).settled) {
        const call = pending.get(latest.call_id); assert.equal(call.kind, kind); const row = JSON.parse(latest.output.trim());
        assert.equal(row.kind, kind); assert.ok(['lead', 'helper1', 'helper2'].includes(row.role)); assert.equal(row.cwd, '/workspace/project'); assert.ok(row.process.pid > 1); assert.match(row.process.starttime, /^\d+$/);
        const round = kind === 'initialize' || kind === 'helper-initial' ? 1 : 2; const key = `${row.role}:${round}`;
        assert.ok(!evidence.some(entry => entry.key === key)); assert.equal(row.role === 'lead', kind === 'initialize' || kind === 'user-and-feedback');
        if (round === 1) identities.set(row.role, { botId: row.botId, process: row.process });
        else { assert.deepEqual({ botId: row.botId, process: row.process }, identities.get(row.role)); assert.ok(row.sessionFile); }
        if (row.role === 'lead') {
          if (round === 1) { assert.equal(row.forgedOwnerDenied, true); assert.equal(row.leadClaimDenied, true); assert.equal(new Set(Object.values(current.helpers)).size, 2); }
          else { assert.equal(current.supplement, adjustedDirection); assert.equal(row.userInputId, 'lead-adjust'); assert.equal(row.feedbackIds.length, 2); }
        } else { assert.equal(row.leadOperationDenied, true); assert.equal(row.otherOwnerDenied, true); assert.equal(row.delivery.verified, true); assert.match(row.delivery.commit, /^[a-f0-9]{40}$/); assert.equal(row.delivery.path, `${row.role}${round === 2 ? '-next' : ''}.txt`); }
        call.settled = true; evidence.push({ key, ...row });
        if (evidence.length === 6) await observeSessions('final', evidence);
        item = { type: 'message', id: `msg_${ordinal}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `${row.role}:${kind}:PUBLIC_OK`, annotations: [] }] };
      } else {
        if (kind === 'user-and-feedback' && !initialObserved) { assert.equal(evidence.length, 3); initialObserved = true; await observeSessions('before-adjust', evidence); }
        const sameKindPending = [...pending.values()].filter(row => row.kind === kind).length;
        assert.ok(sameKindPending < (kind.startsWith('helper-') ? 2 : 1));
        const callId = `lead_helper_${ordinal}`; pending.set(callId, { kind, settled: false });
        item = { type: 'function_call', id: `fc_${callId}`, call_id: callId, name: 'bash', arguments: JSON.stringify({ command: leadHelperCommand(kind), timeout: 45 }) };
      }
      assert.ok(!failure); accepted++; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(streamResponse('k3', ordinal, item));
    } catch {
      const first = !failure; failure ??= { code: 'LEAD_HELPER_FIXTURE_FAILED', stage, ordinal };
      const event = { type: 'response.failed', response: { id: `failed_${ordinal}`, object: 'response', model: 'k3', status: 'failed', output: [], error: { code: failure.code, message: failure.code }, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } };
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`event: response.failed\ndata: ${JSON.stringify(event)}\n\n`); if (first) onFailure();
    }
  }); server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/v1/responses`, receipt: () => ({ arrivals, accepted, failure, evidence }), close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
