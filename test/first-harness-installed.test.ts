import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { streamResponse } from '../scripts/local-setup-upstream.js';

const directory = process.env.MURM_FIRST_HARNESS_DIRECTORY;

test('the installed first Harness recovers from bad Service input, accepts a reply and exports verified bytes', {
  skip: !directory && 'Set MURM_FIRST_HARNESS_DIRECTORY to a compiled consumer with local infrastructure prepared',
  timeout: 180_000,
}, async t => {
  const model = 'gpt-5-mini';
  const channel = 'verified-ci';
  let reference;
  let step = 0;
  let upstreamError;
  const publisher = `python3 - <<'PYTHON'
import json, pathlib, subprocess
command = ['swarm', 'service', 'invoke', 'handoff', 'publish']
bad = subprocess.run(command+['--reference=123', '--question=Which channel?', '--request-id=invalid-reference'], capture_output=True, text=True)
assert bad.returncode == 2, bad.stderr
diagnostic = json.loads(bad.stderr)
assert diagnostic['code'] == 'SERVICE_INPUT_INVALID'
assert diagnostic['details']['request_outcome'] == 'not_executed'
assert diagnostic['details']['validation'] == [{'pointer':'/reference','expected':'string','actual':'number'}]
ref = pathlib.Path('release-data.txt').read_text().strip()
good = subprocess.check_output(command+['--reference='+ref, '--question=Which channel?', '--request-id=publish-release'], text=True)
print(json.loads(good)['reference'])
PYTHON`;
  const writer = `python3 - <<'PYTHON'
import json, pathlib, subprocess
result = subprocess.check_output(['swarm','service','invoke','handoff','take','--stdin','--request-id=take-release'], input='{}', text=True)
ref = json.loads(result)['reference']
pathlib.Path('delivery.txt').write_text('reference='+ref+'\\nchannel=${channel}\\n')
print(ref)
PYTHON`;
  const tool = (id: string, command: string) => ({
    type: 'function_call', id: `fc_${id}`, call_id: id, name: 'bash',
    arguments: JSON.stringify({ command, timeout: 30 }),
  });
  const finish = (id: string) => ({
    type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'Done.', annotations: [] }],
  });
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/responses');
      let content = '';
      for await (const chunk of request) {
        content += chunk;
        assert.ok(content.length < 2 * 1024 * 1024);
      }
      const body = JSON.parse(content);
      assert.equal(body.model, model);
      const ordinal = ++step;
      const result = (id: string) => body.input.find(row => row.type === 'function_call_output' && row.call_id === id)?.output.trim();
      let item;
      if (ordinal === 1) item = tool('publish', publisher);
      else if (ordinal === 2) {
        reference = result('publish');
        assert.match(reference, /^[0-9a-f]{12}$/);
        item = finish('publish');
      } else if (ordinal === 3) {
        assert.ok(body.input.some(row => row.role === 'user' && JSON.stringify(row.content).includes(`The user chose channel ${channel}`)));
        item = tool('take', writer);
      } else {
        assert.equal(ordinal, 4);
        assert.equal(result('take'), reference);
        item = finish('take');
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(streamResponse(model, ordinal, item));
    } catch (error) {
      upstreamError ??= error;
      response.writeHead(400);
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: directory, stdio: 'pipe', signal: AbortSignal.timeout(160_000),
    env: { ...process.env, MURM_MODEL_URL: `http://127.0.0.1:${address.port}/v1/responses`, MURM_MODEL_ID: model, MURM_MODEL_PROTOCOL: 'responses' },
  });
  const closed = once(child, 'close');
  let output = '';
  let errors = '';
  let replied = false;
  child.stdout.setEncoding('utf8').on('data', chunk => {
    output += chunk;
    if (!replied && output.includes('Publisher asks: Which channel?')) {
      replied = true;
      child.stdin.end(channel + '\n');
    }
  });
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
  child.stdin.on('error', () => {});
  const [code] = await closed;
  assert.ifError(upstreamError);
  assert.equal(code, 0, output + errors);
  assert.equal(step, 4);
  assert.ok(replied);
  const summary = JSON.parse(output.slice(output.indexOf('\n{\n') + 1));
  assert.equal(summary.business.ok, true);
  assert.equal(summary.cleanup.status, 'complete');
  assert.deepEqual(summary.cleanup.pending, []);
  assert.notEqual(summary.handoff.author, summary.handoff.reader);
  assert.equal(summary.handoff.publishRequestId, 'publish-release');
  assert.equal(summary.handoff.requestId, 'take-release');
  const artifact = await readFile(summary.verification.file);
  assert.deepEqual(artifact, Buffer.from(`reference=${reference}\nchannel=${channel}\n`));
  assert.equal(summary.verification.sha256, createHash('sha256').update(artifact).digest('hex'));
});
