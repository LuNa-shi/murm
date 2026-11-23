import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { streamResponse } from './core-controlled-upstream.js';

export function notesEnvironmentCommand(role) {
  return `python3 - <<'NOTES_ENVIRONMENT'
import hashlib,json,os,pathlib,re,subprocess
key='core-service-boundary'
def cli(*args):
 p=subprocess.run(['swarm',*args],capture_output=True,text=True,timeout=10)
 assert p.returncode==0, p.stderr
 return json.loads(p.stdout)
def denied(code,*args):
 p=subprocess.run(['swarm',*args],capture_output=True,text=True,timeout=10)
 assert p.returncode!=0
 assert json.loads(p.stderr)['code'] in code
 return True
fact=json.loads(pathlib.Path('review-input.json').read_text())
raw=pathlib.Path('review-input.json').read_text()
pid=os.getppid()
for _ in range(12):
 args=pathlib.Path(f'/proc/{pid}/cmdline').read_bytes().decode().split('\x00')
 if '--session-id' in args:
  session_id=args[args.index('--session-id')+1]
  assert re.fullmatch(r'[a-f0-9-]{36}',session_id)
  break
 pid=int(pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[1])
 assert pid>1
else: raise AssertionError('Pi Session was not found in the process ancestry')
session=hashlib.sha256(session_id.encode()).hexdigest()
evidence={'role':${JSON.stringify(role)},'cwd':os.getcwd(),'session':session}
${role === 'writer' ? `record=cli('notes','put','--key',key,'--text',raw,'--request-id','notes-put')
assert record['text']==raw and record['key']==key
assert cli('notes','put','--key',key,'--text',raw,'--request-id','notes-put')==record
assert cli('notes','put','--key',key,'--text',raw,'--request-id','notes-put-replay')==record
evidence.update(author=record['author'],replay=True,conflict=denied(['CONFLICT'],'notes','put','--key',key,'--text','different','--request-id','notes-conflict'),forged=denied(['SERVICE_INPUT_INVALID'],'notes','put','--key','forged','--text',raw,'--author','fake','--request-id','notes-forged'),permission=denied(['CLI_ERROR','NOT_ALLOWED'],'notes','get','--key',key,'--request-id','writer-denied'))` : role === 'reader' ? `record=cli('notes','get','--key',key,'--request-id','notes-get')
assert record['text']==raw
expected='# Source review\\n\\nBaseline: '+fact['baseline']+'\\nSource: '+fact['source']+'\\nFinding: '+fact['finding']+'\\n'
pathlib.Path('review.md').write_text(expected)
pathlib.Path('continuity.json').write_text(json.dumps({'session':session,'cwd':os.getcwd(),'pid':pid}))
evidence.update(author=record['author'],read=True,permission=denied(['CLI_ERROR','NOT_ALLOWED'],'notes','put','--key',key,'--text',raw,'--request-id','reader-denied'))` : `before=json.loads(pathlib.Path('continuity.json').read_text())
assert before=={'session':session,'cwd':os.getcwd(),'pid':pid}
sessions=list(pathlib.Path('/workspace/runtime/pi-session').rglob('*_'+session_id+'.jsonl'))
assert len(sessions)==1
content=pathlib.Path('review.md').read_bytes()
pathlib.Path('followup.md').write_bytes(content)
evidence.update(continuity=True,bytes=len(content))`}
print(json.dumps(evidence))
NOTES_ENVIRONMENT`;
}

export async function createNotesEnvironmentUpstream({ onFailure = () => {} } = {}) {
  let arrivals = 0; let accepted = 0; let failure; const evidence = [];
  const deadlineAt = Date.now() + 120_000;
  const roles = ['writer', 'reader', 'followup'];
  const server = createServer(async (request, response) => {
    const ordinal = ++arrivals;
    let stage = 'bounds';
    try {
      assert.ok(!failure && ordinal <= 6 && Date.now() < deadlineAt);
      stage = 'route';
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      stage = 'body';
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 2 * 1024 ** 2); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.model, 'k3'); assert.ok(Array.isArray(body.input));
      const role = roles[Math.floor((ordinal - 1) / 2)]; const callId = `notes_${role}`;
      let item;
      if (ordinal % 2) {
        stage = 'tool-dispatch';
        item = { type: 'function_call', id: `fc_${callId}`, call_id: callId, name: 'bash',
          arguments: JSON.stringify({ command: notesEnvironmentCommand(role), timeout: 40 }) };
      } else {
        stage = `${role}-tool-evidence`;
        const output = body.input.filter(item => item.type === 'function_call_output' && item.call_id === callId);
        assert.equal(output.length, 1);
        const row = JSON.parse(output[0].output.trim());
        assert.equal(row.role, role); assert.match(row.session, /^[a-f0-9]{64}$/); assert.equal(row.cwd, '/workspace/project');
        if (role === 'writer') { assert.ok(row.replay && row.conflict && row.forged && row.permission); assert.equal(typeof row.author, 'string'); }
        if (role === 'reader') { assert.ok(row.read && row.permission); assert.equal(row.author, evidence[0].author); }
        if (role === 'followup') { assert.ok(row.continuity && row.bytes > 0); assert.equal(row.session, evidence[1].session); assert.equal(row.cwd, evidence[1].cwd); }
        evidence.push(row);
        item = { type: 'message', id: `msg_${callId}`, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: `${role}_OK`, annotations: [] }] };
      }
      assert.ok(!failure); accepted++;
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(streamResponse('k3', ordinal, item));
    } catch {
      const first = !failure;
      failure ??= { code: 'CONTROLLED_NOTES_ENVIRONMENT_FAILED', stage, ordinal };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(streamResponse('k3', ordinal, { type: 'message', id: `notes_rejected_${ordinal}`, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: failure.code, annotations: [] }] }));
      if (first) onFailure();
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/v1/responses`, receipt: () => ({ arrivals, accepted, failure, evidence }),
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
