import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { streamResponse } from './core-controlled-upstream.js';

// Pinned pi-coding-agent 1.3.0 cli/setup.js uses APP_NAME=pi; rpc-entry.js uses pi-rpc.
// Linux stat comm and starttime survive its process.title rewrite; original argv does not.
export function notesHarnessCommand(role, executor = 'pi') {
  return `python3 - <<'NOTES_HARNESS'
import json,os,pathlib,re,subprocess
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
 stat=pathlib.Path(f'/proc/{pid}/stat').read_text()
 name=stat[stat.index('(')+1:stat.rindex(')')]
 fields=stat[stat.rindex(')')+2:].split()
 if name in ${executor === 'codex' ? "['codex','codex-exec']" : "['pi','pi-rpc']"}:
  identity={'pid':pid,'starttime':fields[19]}
  break
 pid=int(fields[1])
 assert pid>1
else: raise AssertionError('Native executor process was not found in the ancestry')
evidence={'role':${JSON.stringify(role)},'cwd':os.getcwd(),'process':identity}
${role === 'writer' ? `assert json.loads(pathlib.Path('note-request.json').read_text())=={'key':key,'text':raw}
record=cli('notes','put','--input','note-request.json','--request-id','notes-put')
assert record['text']==raw and record['key']==key
assert cli('notes','put','--input','note-request.json','--request-id','notes-put')==record
assert cli('notes','put','--input','note-request.json','--request-id','notes-put-replay')==record
pathlib.Path('conflict-request.json').write_text(json.dumps({'key':key,'text':'different'}))
pathlib.Path('forged-request.json').write_text(json.dumps({'key':'forged','text':raw,'author':'fake'}))
evidence.update(author=record['author'],replay=True,conflict=denied(['CONFLICT'],'notes','put','--input','conflict-request.json','--request-id','notes-conflict'),forged=denied(['SERVICE_INPUT_INVALID'],'notes','put','--input','forged-request.json','--request-id','notes-forged'),permission=denied(['CLI_ERROR','NOT_ALLOWED'],'notes','get','--key',key,'--request-id','writer-denied'))` : role === 'reader' ? `record=cli('notes','get','--key',key,'--request-id','notes-get')
assert record['text']==raw
expected='# Source review\\n\\nBaseline: '+fact['baseline']+'\\nSource: '+fact['source']+'\\nFinding: '+fact['finding']+'\\n'
pathlib.Path('review.md').write_text(expected)
pathlib.Path('continuity.json').write_text(json.dumps({'process':identity,'cwd':os.getcwd()}))
pathlib.Path('denied-request.json').write_text(json.dumps({'key':key,'text':raw}))
evidence.update(author=record['author'],read=True,permission=denied(['CLI_ERROR','NOT_ALLOWED'],'notes','put','--input','denied-request.json','--request-id','reader-denied'))` : `before=json.loads(pathlib.Path('continuity.json').read_text())
assert before=={'process':identity,'cwd':os.getcwd()}
sessions=list(pathlib.Path('${executor === 'codex' ? '/workspace/runtime/codex-home/sessions' : '/workspace/runtime/pi-session'}').rglob('*.jsonl'))
assert len(sessions)==1
match=re.fullmatch(r'${executor === 'codex' ? 'rollout-\\d{4}-\\d{2}-\\d{2}T[\\d-]+-' : '\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z_'}([a-f0-9-]{36})[.]jsonl',sessions[0].name)
assert match
evidence['sessionId']=match[1]
content=pathlib.Path('review.md').read_bytes()
pathlib.Path('followup.md').write_bytes(content)
evidence.update(continuity=True,bytes=len(content))`}
print(json.dumps(evidence))
NOTES_HARNESS`;
}

export async function createNotesHarnessUpstream({ onFailure = () => {}, observeSessions = async () => {}, verifyStartup = false, executor = 'pi' } = {}) {
  let arrivals = 0; let accepted = 0; let failure; const evidence = [];
  const model = executor === 'codex' ? 'gpt-5.4' : 'k3';
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
      assert.equal(body.model, model); assert.ok(Array.isArray(body.input));
      const role = roles[Math.floor((ordinal - 1) / 2)]; const callId = `notes_${role}`;
      let item;
      if (ordinal % 2) {
        if (verifyStartup && role !== 'followup') {
          stage = role + '-startup';
          const developer = body.input.filter(item => item.role === 'developer').flatMap(item => typeof item.content === 'string' ? [{ text: item.content }] : item.content);
          const system = typeof developer === 'string' ? developer : developer?.map(item => item.text ?? '').join('');
          const task = role === 'writer' ? 'Read review-input.json and note-request.json' : 'Compare the note text with review-input.json';
          assert.equal(system.match(/<services>/g)?.length, 1);
          assert.ok(system.includes(role === 'writer' ? 'swarm service invoke notes put' : 'swarm service invoke notes get'));
          assert.ok(!system.includes(role === 'writer' ? 'swarm service invoke notes get' : 'swarm service invoke notes put'));
          assert.ok(!system.includes(task) && !system.includes('<added_system_prompt>'));
          const users = body.input.filter(item => item.role === 'user').flatMap(item => item.content);
          assert.ok(users.some(item => (typeof item === 'string' ? item : item.text)?.includes(task)));
        }
        stage = 'tool-dispatch';
        if (role === 'followup') await observeSessions('before-followup');
        item = { type: 'function_call', id: `fc_${callId}`, call_id: callId, name: executor === 'codex' ? 'exec_command' : 'bash',
          arguments: JSON.stringify(executor === 'codex'
            ? { cmd: notesHarnessCommand(role, executor), yield_time_ms: 10000, max_output_tokens: 2048 }
            : { command: notesHarnessCommand(role, executor), timeout: 40 }) };
      } else {
        stage = `${role}-tool-evidence`;
        const output = body.input.filter(item => item.type === 'function_call_output' && item.call_id === callId);
        assert.equal(output.length, 1);
        const text = output[0].output.trim();
        if (executor === 'codex') {
          assert.match(text, /Process exited with code 0/);
          assert.ok(text.includes('Output:'));
        }
        const row = JSON.parse(executor === 'codex' ? text.slice(text.indexOf('Output:') + 'Output:'.length).trim() : text);
        assert.equal(row.role, role); assert.ok(Number.isSafeInteger(row.process?.pid) && row.process.pid > 1); assert.match(row.process.starttime, /^[0-9]+$/); assert.equal(row.cwd, '/workspace/project');
        if (role === 'writer') { assert.ok(row.replay && row.conflict && row.forged && row.permission); assert.equal(typeof row.author, 'string'); }
        if (role === 'reader') { assert.ok(row.read && row.permission); assert.equal(row.author, evidence[0].author); }
        if (role === 'followup') { assert.ok(row.continuity && row.bytes > 0); assert.deepEqual(row.process, evidence[1].process); assert.match(row.sessionId, /^[a-f0-9-]{36}$/); await observeSessions('after-followup', row); assert.equal(row.cwd, evidence[1].cwd); }
        evidence.push(row);
        item = { type: 'message', id: `msg_${callId}`, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: `${role}_OK`, annotations: [] }] };
      }
      assert.ok(!failure); accepted++;
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(streamResponse(model, ordinal, item));
    } catch {
      const first = !failure;
      failure ??= { code: 'CONTROLLED_NOTES_HARNESS_FAILED', stage, ordinal };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const terminal = { type: 'response.failed', response: { id: `notes_rejected_${ordinal}`, object: 'response', model,
        status: 'failed', output: [], error: { code: failure.code, message: failure.code },
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } };
      response.end(`event: response.failed\ndata: ${JSON.stringify(terminal)}\n\n`);
      if (first) onFailure();
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/v1/responses`, receipt: () => ({ arrivals, accepted, failure, evidence }),
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
