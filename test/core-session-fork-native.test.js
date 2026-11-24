import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { snapshotSessionFork, sessionForkText } from '../scripts/core-session-fork.mjs';
import { streamResponse } from './fixtures/core-controlled-upstream.js';

const piCli = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'cli.js');

test('native Pi forks a running Session at a complete boundary and continues independently', { timeout: 20000 }, async () => {
  const directory = await mkdtemp('/tmp/pi-fork-');
  const requests = [];
  const processes = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    const number = requests.length;
    const item = number === 1
      ? { type: 'function_call', id: 'fc_busy', call_id: 'busy', name: 'bash',
        arguments: JSON.stringify({ command: 'sleep 2; echo TOOL_COMPLETE', timeout: 5 }) }
      : { type: 'message', id: `message_${number}`, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: `DONE_${number}`, annotations: [] }] };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(streamResponse('probe', number, item));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const catalog = { providers: { probe: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-responses', apiKey: 'probe-key',
    models: [{ id: 'probe', name: 'probe', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
  } } };

  async function startPi(name, sessionPath) {
    const path = join(directory, name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'models.json'), JSON.stringify(catalog));
    const child = spawn(process.execPath, [piCli, '--mode', 'rpc', '--session-dir', path,
      '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
      '--provider', 'probe', '--model', 'probe', ...(sessionPath ? ['--session', sessionPath] : [])], {
      cwd: path, env: { ...process.env, PI_CODING_AGENT_DIR: path, HOME: path }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    processes.push(child);
    child.stderr.resume();
    let buffer = '';
    const events = [];
    const waiting = new Map();
    child.stdout.on('data', data => {
      buffer += data;
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const event = JSON.parse(line);
        events.push(event);
        waiting.get(event.id)?.(event);
      }
    });
    async function rpc(type, fields = {}) {
      const id = randomUUID();
      let timer;
      const result = new Promise((resolve, reject) => {
        waiting.set(id, resolve);
        timer = setTimeout(() => reject(Error(`RPC timeout ${type}`)), 10000);
      });
      child.stdin.write(JSON.stringify({ type, id, ...fields }) + '\n');
      try { return await result; }
      finally { clearTimeout(timer); waiting.delete(id); }
    }
    async function wait(type) {
      const deadline = Date.now() + 10000;
      while (!events.some(event => event.type === type)) {
        assert.ok(Date.now() < deadline, `${type} timeout`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    await rpc('get_state');
    return { rpc, wait };
  }

  try {
    const parent = await startPi('parent');
    await parent.rpc('prompt', { message: 'FORK_MARKER PARENT_PRIVATE_TOKEN' });
    await parent.wait('tool_execution_start');
    const captured = await parent.rpc('get_entries');
    assert.equal(captured.success, true);
    const entries = captured.data.entries;
    assert.equal(entries.at(-1).message.role, 'assistant');
    assert.ok(entries.at(-1).message.content.some(part => part.type === 'toolCall'));
    const snapshot = snapshotSessionFork(captured.data, ['PARENT_PRIVATE_TOKEN']);
    const sessionPath = join(directory, 'fork.jsonl');
    await writeFile(sessionPath, sessionForkText(snapshot, join(directory, 'child')));
    const child = await startPi('child', sessionPath);
    await child.rpc('prompt', { message: 'CHILD_CONTINUE' });
    await child.wait('agent_end');
    await parent.wait('agent_end');
    const childRequest = requests.find(request => JSON.stringify(request.input).includes('CHILD_CONTINUE'));
    assert.ok(JSON.stringify(childRequest.input).includes('FORK_MARKER'));
    assert.ok(!JSON.stringify(childRequest.input).includes('PARENT_PRIVATE_TOKEN'));
    assert.ok(!childRequest.input.some(entry => entry.type === 'function_call'));
    assert.ok(!JSON.stringify(childRequest.input).includes('TOOL_COMPLETE'));
    const parentRequest = requests.find(request => JSON.stringify(request.input).includes('TOOL_COMPLETE'));
    assert.ok(!JSON.stringify(parentRequest.input).includes('CHILD_CONTINUE'));
    assert.equal(requests.length, 3);
  } finally {
    for (const child of processes) {
      child.kill('SIGTERM');
      if (child.exitCode === null && child.signalCode === null) await once(child, 'close');
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
