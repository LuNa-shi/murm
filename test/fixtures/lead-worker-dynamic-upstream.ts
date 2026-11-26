import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { calculation, corrected, generatedService, ordersCli } from './lead-worker-dynamic-orders.js';
import { streamResponse } from './core-controlled-upstream.js';

const assignments = ['helper1', 'helper2'];
function program(initial: boolean) {
  return `python3 - <<'LEAD_WORKER'
import hashlib,json,os,pathlib,subprocess,time,urllib.request,urllib.error,uuid
initial=${initial ? 'True' : 'False'}
files=json.loads(${JSON.stringify(JSON.stringify({ calculation, corrected, generatedService, ordersCli }))})
helpers=${JSON.stringify(assignments)}
branch=os.environ['WORK_BRANCH']
role=next(role for role in ['lead','helper1','helper2','checker'] if branch.startswith(role+'-'))
root=pathlib.Path('.')
def run(*args,**options):
 return subprocess.run(args,capture_output=True,text=True,timeout=15,**options)
def git(*args):
 result=run('git',*args)
 assert result.returncode==0, 'git '+args[0]+': '+result.stderr[:300]
 return result.stdout.strip()
def cli(service,operation,value,denied=False,request=None):
 path=root/'.murm-request.json'
 path.write_text(json.dumps(value))
 result=run('swarm',service,operation,'--input',str(path),'--request-id',request or str(uuid.uuid4()))
 if denied:
  assert result.returncode!=0, 'permission should deny'
  return json.loads(result.stderr)['code']
 assert result.returncode==0, service+' '+operation+': '+result.stderr[:500]
 return json.loads(result.stdout)
def board(operation,value={}):
 return cli('board',operation,value)
def wait_for(f):
 until=time.monotonic()+115
 while time.monotonic()<until:
  result=f()
  if result: return result
  time.sleep(.35)
 raise AssertionError('Board wait elapsed')
def completed(ids):
 state=board('read')
 rows=[row for row in state['subtasks'] if row['id'] in ids and row['state']=='complete']
 return rows if len(rows)==len(ids) else None
def add_task(id,path,agent,label):
 return board('create_subtask',{'id':id,'title':label,'path':path,'assignee_ids':[agent]})
def pinned(path):
 data=(root/path).read_bytes()
 return {'commit':git('rev-parse','HEAD'),'path':path,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
def publish(paths,reason):
 git('add','--',*paths); git('commit','-m',reason); git('push','origin',branch)
def accept(row):
 git('fetch','origin',row['delivery']['branch'])
 git('cherry-pick',row['delivery']['commit'])
if not (root/'.git').exists():
 git('init','.');git('remote','add','origin',os.environ['RUN_REPOSITORY']);git('fetch','origin','main');git('checkout','-b',branch,'origin/main')
state=board('read')
agent=state['team'][role]
valid='{"id":"a","currency":"USD","amount_cents":100}\\n'
mixed='\\n'+valid+valid+'{\\n'
service='runtime-orders'
marker=root/'.fixture-session.json'
session_files=sorted(str(file.name) for file in pathlib.Path('/workspace/runtime/pi-session').rglob('*.jsonl'))
identity={'agent':agent,'role':role,'branch':branch,'directory':os.getcwd(),'session':session_files}
if marker.exists(): assert identity==json.loads(marker.read_text()), 'session changed'
else: marker.write_text(json.dumps(identity))
result={'ok':True,'role':role,'agentId':agent,'session':session_files,'directory':os.getcwd(),'branch':branch}
if role=='lead' and initial:
 board('announce',{'text':'Build the orders validator and a complementary test.','feedback_ids':[]})
 add_task('initial-code','orders-lib.mjs',state['team']['helper1'],'Implement validating and summarizing orders')
 add_task('initial-test','orders-smoke.mjs',state['team']['helper2'],'Add a complementary tests file')
 for row in completed(['initial-code','initial-test']) or wait_for(lambda: completed(['initial-code','initial-test'])): accept(row)
 (root/'orders.mjs').write_text(files['ordersCli'])
 publish(['orders.mjs'],'Integrate the first executable candidate')
 proof=pinned('orders.mjs')
 (root/'.preliminary.json').write_text(json.dumps(proof))
 (root/'service.mjs').write_text(files['generatedService'])
 deployment={'source_path':'service.mjs','manifest':{'id':service,'title':'Generated orders checker','purpose':'Check row numbers and totals','operation':'check_orders'}}
 cli('manage','service_deploy',deployment,request='deployment')
 cli('manage','profile_register',{'id':'checker','prompt':'Verify this candidates behavior on a legal and mixed input. Report original line numbers.','check_service_id':service},request='new-profile')
 member=cli('team','spawn_member',{'profile':'checker'},request='join-checker')
 assert member['status']=='ready'
 assert cli('team','member_get',{'request_id':'join-checker'})==member
 worker=state['team']['helper1']
 scope={'agent_id':worker,'service_id':service,'operations':['check_orders']}
 add_task('before','before.txt',worker,'Probe the checker before delegation')
 wait_for(lambda: completed(['before']))
 cli('agent','grant',scope,request='grant-checker')
 add_task('granted','granted.txt',worker,'Use the granted service in your existing Session')
 wait_for(lambda: completed(['granted']))
 cli('agent','revoke',scope,request='revoke-checker')
 add_task('revoked','revoked.txt',worker,'Probe the checker after revocation')
 wait_for(lambda: completed(['revoked']))
 add_task('checker','check.txt',member['agentId'],'Check the committed candidate at '+proof['commit'])
 result['preliminary']=proof
elif role=='lead':
 feedback=next((row for row in state['notes'] if row['actor']==state['team'].get('checker')),None)
 if feedback and not any(row['id']=='adopt' for row in state['subtasks']):
  board('announce',{'text':'Fix the indexing bug demonstrated by the checker feedback.','feedback_ids':[feedback['seq']]})
  add_task('adopt','adopt.txt',state['team']['helper1'],'Keep original indexes including blank lines')
 elif feedback and completed(['adopt']):
  state=board('read')
  if all(row['state']=='complete' for row in state['subtasks']):
   for row in completed(['adopt']): accept(row)
   proof=pinned('orders.mjs')
   board('submit',{'delivery':proof,'feedback_ids':[feedback['seq']]})
   result['final']=proof
else:
 task=next(row for row in state['subtasks'] if row['state']=='ready' and agent in row['assignee_ids'])
 id,path=task['id'],task['path']
 claim=board('claim',{'subtask_id':id,'expected_revision':task['revision']})
 result['task']=id
 if id=='initial-code': (root/path).write_text(files['calculation'])
 elif id=='initial-test': (root/path).write_text("import assert from 'node:assert/strict';import { summarize } from './orders-lib.mjs';assert.deepEqual(summarize(''),{valid:[],totals:{},errors:[]});\\n")
 elif id in ['before','granted','revoked']:
  result['cli']=cli(service,'check_orders',{'jsonl':valid},denied=id!='granted')
  token=os.environ['MURM_BRIDGE_TOKEN']
  request=urllib.request.Request(os.environ['MURM_BRIDGE_URL'].rstrip('/')+'/call', method='POST',
    data=json.dumps({'service_id':service,'operation':'check_orders','operation_id':'direct-'+id,'payload':{'jsonl':valid}}).encode(),
    headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
  try:
   with urllib.request.urlopen(request,timeout=10) as reply: result['dispatch']=reply.status
  except urllib.error.HTTPError as rejection: result['dispatch']=rejection.code
  assert result['dispatch']==(200 if id=='granted' else 403), result['dispatch']
  (root/path).write_text('Actual authenticated CLI and Bridge probe: '+str(result['dispatch'])+'\\n')
 elif id=='checker':
  commit=task['title'].split()[-1]
  git('fetch','origin','lead-'+branch.removeprefix('checker-'))
  assert git('rev-parse','FETCH_HEAD')==commit
  git('cherry-pick',*git('rev-list','--reverse','origin/main..'+commit).splitlines())
  checked_good=cli(service,'check_orders',{'jsonl':valid})
  checked_mixed=cli(service,'check_orders',{'jsonl':mixed})
  execution=run('node','orders.mjs',input=mixed)
  assert execution.returncode==1
  actual=json.loads(execution.stdout)
  assert checked_good['totals']=={'USD':100}
  assert checked_mixed['errors']==[{'line':3,'code':'DUPLICATE_ID'},{'line':4,'code':'INVALID_JSON'}]
  assert actual['errors']!=checked_mixed['errors']
  feedback='Commit '+commit+' reports duplicate/malformed lines 2/3 for a leading blank. The checker reports original lines 3/4.'
  (root/path).write_text(feedback+'\\n')
  board('note',{'subtask_id':id,'text':feedback})
 elif id=='adopt':
  (root/'orders-lib.mjs').write_text(files['corrected'])
  (root/path).write_text('Apply the checker feedback by preserving original indexes including blank lines.\\n')
  git('add','orders-lib.mjs')
 publish([path],id)
 current=board('read')
 board('complete',{'subtask_id':id,'expected_revision':claim['revision'],'direction_id':current['directions'][-1]['seq'],'delivery':pinned(path)})
print(json.dumps(result))
LEAD_WORKER`;
}

export async function createDynamicLeadWorkerUpstream({ timeoutMs = 240_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const evidence: unknown[] = [];
  const inFlight = new Map<string, string>();
  let arrivals = 0;
  let failure: { code: string; ordinal: number } | undefined;
  const server = createServer(async (request, response) => {
    const ordinal = ++arrivals;
    try {
      assert.ok(!failure && ordinal <= 64 && Date.now() < deadline);
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/responses');
      let text = '';
      for await (const chunk of request) {
        text += chunk;
        assert.ok(Buffer.byteLength(text) <= 2 * 1024 ** 2);
      }
      const body = JSON.parse(text);
      assert.equal(body.model, 'k3');
      const start = body.input.findLastIndex(row => row.role === 'user' && row.content?.some?.(item => {
        try { return ['dynamic-goal', 'board-updates'].includes(JSON.parse(item.text).type); } catch { return false; }
      }));
      assert.ok(start >= 0);
      const user = body.input[start].content.map(item => { try { return JSON.parse(item.text); } catch { return null; } }).find(Boolean);
      const output = body.input.slice(start + 1).findLast(row => row.type === 'function_call_output' && inFlight.has(row.call_id));
      let item;
      if (output) {
        const receipt = JSON.parse(output.output.trim());
        assert.equal(receipt.ok, true);
        evidence.push(receipt);
        item = { type: 'message', id: `msg_${ordinal}`, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'Board records contain the work receipts.', annotations: [] }] };
      } else {
        const callId = `dynamic_lead_worker_${ordinal}`;
        inFlight.set(callId, user.type);
        item = { type: 'function_call', id: `fc_${callId}`, call_id: callId, name: 'bash',
          arguments: JSON.stringify({ command: program(user.type === 'dynamic-goal'), timeout: 150 }) };
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(streamResponse('k3', ordinal, item));
    } catch {
      failure ??= { code: 'DYNAMIC_SCRIPT_FAILED', ordinal };
      response.writeHead(500).end(JSON.stringify(failure));
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/v1/responses`,
    receipt: () => ({ arrivals, evidence, failure }),
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
