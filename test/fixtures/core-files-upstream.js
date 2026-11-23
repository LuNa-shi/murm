import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { streamResponse } from './core-controlled-upstream.js';

export const seededFiles = {
  'payload.bin': { encoding: 'base64', data: 'AP8KDYAA', mode: 0o644 },
  'hello.txt': { encoding: 'utf8', data: 'seeded λ\n' },
  'tool.sh': { encoding: 'utf8', data: '#!/bin/sh\nprintf seeded-tool\\n\n', mode: 0o755 },
};
export const preparedFiles = {
  'payload.bin': { encoding: 'base64', data: 'AQIDAP8=', mode: 0o644 },
  'hello.txt': { encoding: 'utf8', data: 'prepared β\n' },
  'tool.sh': { encoding: 'utf8', data: '#!/bin/sh\nprintf prepared-tool\\n\n', mode: 0o755 },
};

export function filesCommand(stage) {
  assert.ok(['seeded', 'readonly', 'prepared', 'granted', 'sibling'].includes(stage));
  const script = `import os,json,stat,errno
stage=${JSON.stringify(stage)}
checks={}
def denied(path):
 try:
  with open(path,'w') as f: f.write('FORBIDDEN')
  return False
 except PermissionError: return True
checks['workdir']=os.getcwd()=='/workspace/project'
if stage=='readonly':
 checks['empty']=os.listdir('.')==[]
 checks['model_write_denied']=denied('must-not-exist.txt')
 checks['remains_empty']=os.listdir('.')==[]
else:
 seeded=stage in ['seeded','sibling']
 checks['binary_bytes']=open('payload.bin','rb').read().hex()==('00ff0a0d8000' if seeded else '01020300ff')
 checks['utf8_bytes']=open('hello.txt','rb').read()==('seeded λ\\n' if seeded else 'prepared β\\n').encode('utf8')
 checks['default_mode']=stat.S_IMODE(os.stat('hello.txt').st_mode)==0o644
 checks['binary_mode']=stat.S_IMODE(os.stat('payload.bin').st_mode)==0o644
 checks['executable_mode']=stat.S_IMODE(os.stat('tool.sh').st_mode)==0o755
 if stage=='seeded':
  open('private-a.txt','w').write('A_PRIVATE\\n')
  checks['native_write']=open('private-a.txt').read()=='A_PRIVATE\\n'
 elif stage=='prepared':
  checks['model_write_denied']=denied('must-not-exist.txt')
  checks['seed_overwrite_denied']=denied('hello.txt')
 elif stage=='granted':
  open('granted.txt','w').write('GRANTED_ONLY\\n')
  checks['native_write']=open('granted.txt').read()=='GRANTED_ONLY\\n'
 elif stage=='sibling':
  checks['private_retained']=open('private-a.txt').read()=='A_PRIVATE\\n'
  checks['no_peer_write']=not os.path.exists('granted.txt')
print(json.dumps(checks))
`;
  return `python3 - <<'CORE_FILES_CHECK'\n${script}CORE_FILES_CHECK`;
}

export const stages = new Map([
  ['F06_A1', { stage: 'seeded', keys: ['workdir', 'binary_bytes', 'utf8_bytes', 'default_mode', 'binary_mode', 'executable_mode', 'native_write'] }],
  ['F06_B1', { stage: 'readonly', keys: ['workdir', 'empty', 'model_write_denied', 'remains_empty'] }],
  ['F06_B2', { stage: 'prepared', keys: ['workdir', 'binary_bytes', 'utf8_bytes', 'default_mode', 'binary_mode', 'executable_mode', 'model_write_denied', 'seed_overwrite_denied'] }],
  ['F06_B3', { stage: 'granted', keys: ['workdir', 'binary_bytes', 'utf8_bytes', 'default_mode', 'binary_mode', 'executable_mode', 'native_write'] }],
  ['F06_A2', { stage: 'sibling', keys: ['workdir', 'binary_bytes', 'utf8_bytes', 'default_mode', 'binary_mode', 'executable_mode', 'private_retained', 'no_peer_write'] }],
]);

export async function createFilesUpstream() {
  const receipts = [];
  const turns = new Map();
  const evidence = {};
  let arrivals = 0;
  let failure;
  const deadlineAt = Date.now() + 180_000;
  const server = createServer(async (request, response) => {
    const arrival = ++arrivals;
    try {
      assert.ok(Date.now() < deadlineAt && arrival <= 10 && !failure, 'Fixed workload bound');
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      let bytes = 0; const chunks = [];
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 2 * 1024 ** 2); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.model, 'k3'); assert.ok(Array.isArray(body.input));
      const user = body.input.filter(item => item.role === 'user').at(-1);
      const id = typeof user?.content === 'string' ? user.content : user?.content?.map(item => item.text ?? '').join('');
      const step = stages.get(id); assert.ok(step, 'Only registered fixed inputs may execute');
      const ordinal = (turns.get(id) ?? 0) + 1; assert.ok(ordinal <= 2); turns.set(id, ordinal);
      let item;
      if (ordinal === 1) item = { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: 'bash', arguments: JSON.stringify({ command: filesCommand(step.stage), timeout: 15 }) };
      else {
        const result = body.input.find(item => item.type === 'function_call_output' && item.call_id === `call_${id}`);
        assert.equal(typeof result?.output, 'string');
        const checks = JSON.parse(result.output.trim());
        assert.deepEqual(Object.keys(checks).sort(), [...step.keys].sort());
        assert.ok(Object.values(checks).every(value => value === true));
        evidence[id] = checks;
        item = { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `${id}_OK`, annotations: [] }] };
      }
      assert.ok(!failure && Date.now() < deadlineAt, 'Fixed workload bound');
      receipts.push({ id, ordinal, verified: ordinal === 2 });
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(streamResponse('k3', receipts.length, item));
    } catch { failure = 'CONTROLLED_FILES_FAILED'; response.writeHead(400); response.end(JSON.stringify({ error: { message: failure } })); }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/v1/responses`, receipt: () => ({ arrivals, receipts, evidence, failure }),
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
