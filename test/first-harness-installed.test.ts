import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ownedContainers } from './fixtures/core-runtime-containers.js';
import { createServer } from 'node:http';
import test from 'node:test';
import { streamResponse } from '../scripts/local-setup-upstream.js';

for (const mode of ['released', 'sdk', 'rpc', 'foreground', 'foreground-questions'] as const) {
  const directory = mode === 'released' ? process.env.MURM_FIRST_HARNESS_DIRECTORY : process.env.MURM_FIRST_HARNESS_CANDIDATE_DIRECTORY;
  test(`the installed first Harness verifies real Service handoff and exports exact bytes via ${mode}`, {
  skip: !directory && 'Set the installed first Harness directory for this mode',
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
        const userInput = body.input.filter(row => row.role === 'user')
          .flatMap(row => typeof row.content === 'string' ? [row.content] : row.content.map(part => part.text ?? ''))
          .find(text => text.startsWith(`The user chose channel ${channel}.`));
        assert.ok(userInput);
        const command = userInput.split('\n').find(line => line.startsWith('swarm service invoke handoff take --request-id take-release | '));
        assert.ok(command);
        item = tool('take', `set -e -o pipefail\n${command}\ncat delivery.txt`);
      } else {
        assert.equal(ordinal, 4);
        assert.equal(result('take'), `reference=${reference}\nchannel=${channel}`);
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

  const inputDirectory = join(directory, 'input');
  await mkdir(inputDirectory, { recursive: true });
  const foreground = mode === 'foreground' || mode === 'foreground-questions';
  const args = mode === 'released' ? ['dist/main.js'] : foreground ? [
    'node_modules/.bin/murm', '--harness', './dist/harness.js', '--cwd', inputDirectory, '--prompt', 'Prepare a release handoff.',
    ...(mode === 'foreground-questions' ? ['--interaction', 'questions'] : []),
  ] : ['dist/session.js', ...(mode === 'rpc' ? ['--rpc'] : []), inputDirectory, 'Prepare a release handoff.'];
  const child = spawn(process.execPath, args, {
    cwd: directory, stdio: 'pipe', signal: AbortSignal.timeout(160_000),
    env: { ...process.env, PATH: join(directory, 'node_modules/.bin') + ':' + process.env.PATH,
      MURM_FIRST_CHANNEL: channel, MURM_MODEL_URL: `http://127.0.0.1:${address.port}/v1/responses`, MURM_MODEL_ID: model, MURM_MODEL_PROTOCOL: 'responses' },
  });
  const closed = once(child, 'close');
  let output = '';
  let errors = '';
  let replied = false;
  const records: any[] = [];
  if (foreground) {
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try {
        const frame = JSON.parse(line);
        records.push(frame);
        const event = frame.sessionEvent;
        if (!replied && event?.type === 'question' && event.question.status === 'pending') {
          replied = true;
          child.stdin.write(JSON.stringify({ id: 'answer', operation: 'answer',
            input: { questionId: event.question.questionId, answer: channel } }) + '\n');
        }
      } catch (error) { upstreamError ??= error; }
    });
  }
  child.stdout.setEncoding('utf8').on('data', chunk => {
    output += chunk;
    if (!replied && output.includes('Publisher asks: Which channel?')) {
      replied = true;
      child.stdin.end(channel + '\n');
    }
  });
  child.stderr.setEncoding('utf8').on('data', chunk => {
    errors += chunk;
    if (!replied && (mode === 'sdk' || mode === 'rpc') && errors.includes('Which channel?')) {
      replied = true;
      child.stdin.write(channel + '\n');
    }
  });
  child.stdin.on('error', () => {});
  const [code] = await closed;
  assert.ifError(upstreamError);
  assert.equal(code, 0, output + errors);
  assert.equal(step, 4);
  if (mode === 'released') {
    assert.ok(replied);
    const receiptStart = output.lastIndexOf('{\n  "runtimeId":');
    assert.ok(receiptStart >= 0, output);
    const summary = JSON.parse(output.slice(receiptStart));
    assert.equal(summary.business.ok, true);
    assert.equal(summary.cleanup.status, 'complete');
    assert.deepEqual(summary.cleanup.pending, []);
    assert.notEqual(summary.handoff.author, summary.handoff.reader);
    assert.equal(summary.handoff.publishRequestId, 'publish-release');
    assert.equal(summary.handoff.requestId, 'take-release');
    const artifact = await readFile(summary.verification.file);
    assert.deepEqual(artifact, Buffer.from(`reference=${reference}\nchannel=${channel}\n`));
    assert.equal(summary.verification.sha256, createHash('sha256').update(artifact).digest('hex'));
    return;
  }

  assert.equal(replied, mode !== 'foreground');
  if (mode === 'foreground-questions') {
    assert.equal(records[0].type, 'ready');
    assert.ok(records.some(frame => frame.type === 'reply' && frame.id === 'answer' && frame.result.status === 'answered'));
  }
  const result = foreground ? records.find(frame => frame.type === 'result')?.result : JSON.parse(output);
  assert.ok(result, output);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.export.status, 'complete');
  assert.equal(result.cleanup.status, 'complete');
  assert.equal(result.acceptance.status, 'verified');
  assert.equal(result.reportSaveFailure, null);
  assert.equal(result.result.handoff.channel, channel);
  assert.notEqual(result.result.handoff.author, result.result.handoff.read.reader);
  assert.equal(result.result.handoff.publishRequestId, 'publish-release');
  assert.equal(result.result.handoff.read.requestId, 'take-release');
  if (replied) assert.equal(result.questions[0].answer, channel);
  const artifact = await readFile(result.acceptance.file);
  assert.deepEqual(artifact, Buffer.from(`reference=${reference}\nchannel=${channel}\n`));
  assert.equal(result.acceptance.sha256, createHash('sha256').update(artifact).digest('hex'));
  const saved = JSON.parse(await readFile(result.reportPath, 'utf8'));
  assert.equal(saved.runId, result.runId);
  assert.deepEqual(saved.acceptance, result.acceptance);
  assert.deepEqual(await ownedContainers(result.result.runtimeId), []);
});
}
