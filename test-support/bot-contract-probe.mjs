// Controlled Pi transport probe. Network-disabled container; its only model
// endpoint is an in-container scripted HTTP server. No provider/model spend.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { BOT_SYSTEM_PROMPT, BOT_SYSTEM_RESOURCE, BOT_SKILLS, BOT_TOOL_NAMES, BOT_RESOURCES, BOT_PROTOCOL_VERSION } from '../src/agent/bot-contract.js';

const token = 'controlled-contract-worker';
const run = promisify(execFile);
const docker = args => run('docker', args, { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
if (!process.argv.includes('--inside')) {
  const name = `swarm-contract-${randomUUID()}`;
  const root = fileURLToPath(new URL('../', import.meta.url));
  const image = process.env.SWARMENV_BOT_CONTRACT_TEST_IMAGE ?? 'swarmenv/agent:issue122';
  // Explicit input for the retained registered Worker contract, independent of
  // the retired host adapter. Current Core uses agentMode=core and Profile text;
  // this probe verifies the Worker's separate pinned Bot-resource contract.
  const launchArgs = ['--mode', 'rpc', '--session-dir', '/workspace/runtime/pi-session', '--session-id', randomUUID(),
    '--tools', BOT_TOOL_NAMES.join(','), '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
    ...BOT_SKILLS.flatMap(skill => ['--skill', skill.path]), '--append-system-prompt', BOT_SYSTEM_RESOURCE.path,
    '--provider', 'openai', '--model', 'fixture'];
  try {
    await docker(['run', '--detach', '--name', name, '--network', 'none', '--cpus', '1', '--memory', '512m', '--pids-limit', '128',
      '--env', `SWARMENV_WORKER_TOKEN=${token}`, '--tmpfs', '/workspace:rw,nosuid,nodev,size=64m',
      '--mount', `type=bind,source=${root}scripts/opensandbox-agent-worker.mjs,target=/opt/swarmenv/agent-worker.mjs,readonly`,
      '--mount', `type=bind,source=${root}scripts/sandbox-project.mjs,target=/opt/swarmenv/sandbox-project.mjs,readonly`,
      ...['project-install.mjs', 'project-processes.mjs'].flatMap(file => ['--mount', `type=bind,source=${root}scripts/${file},target=/opt/swarmenv/${file},readonly`]),
      '--entrypoint', 'node', image, '/opt/swarmenv/agent-worker.mjs']);
    await docker(['exec', name, 'mkdir', '-p', '/opt/swarmenv/test-support']);
    for (const path of ['src/agent/bot-contract', 'src/agent/bot-contract.js', 'src/cli/swarm-cli.js', 'test-support/bot-contract-probe.mjs']) {
      await docker(['cp', `${root}${path}`, `${name}:/opt/swarmenv/${path}`]);
    }
    await docker(['exec', name, 'chown', '-R', '0:0', '/opt/swarmenv/src/agent/bot-contract']);
    await docker(['exec', name, 'chmod', '-R', 'u=rwX,go=rX', '/opt/swarmenv/src/agent/bot-contract']);
    const result = await docker(['exec', name, 'node', '/opt/swarmenv/test-support/bot-contract-probe.mjs', '--inside',
      ...(process.argv.includes('--unreadable') ? ['--unreadable'] : []),
      ...(process.argv.includes('--missing-resource') ? ['--missing-resource'] : []),
      JSON.stringify(launchArgs)]);
    process.stdout.write(result.stdout);
  } finally { await docker(['rm', '--force', name]).catch(() => undefined); }
} else {
  const calls = [];
  const catalogCalls = [];
  const steps = [...BOT_SKILLS.map(skill => ({ name: 'read', arguments: { path: skill.path } })),
    { name: 'bash', arguments: { command: 'swarm service list --json && swarm mission view --json', timeout: 5 } }];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (request.url === '/call') {
      assert.equal(request.headers.authorization, 'Bearer controlled-bridge');
      catalogCalls.push(input.operation);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, result: input.operation === 'list_services' ? { services: [{ service_id: 'task' }] } : { mission_id: 'controlled-mission' } }));
      return;
    }
    assert.equal(request.url, '/v1/chat/completions');
    calls.push(input);
    const step = steps[calls.length - 1];
    const delta = step ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_${calls.length}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.arguments) } }] }
      : { role: 'assistant', content: 'controlled complete' };
    response.setHeader('content-type', 'text/event-stream');
    const chunk = { id: `chat_${calls.length}`, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] };
    response.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: step ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const worker = async (path, input) => {
    const response = await fetch(`http://127.0.0.1:44100${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(10_000) });
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body.result;
  };
  try {
    await writeFile('/opt/swarmenv/pi-agent/models.json', JSON.stringify({ providers: { openai: { baseUrl: `${base}/v1`, api: 'openai-completions', apiKey: 'controlled-key', models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 2048 }] } } }));
    const startInput = { contract_version: BOT_PROTOCOL_VERSION, command: '/opt/swarmenv/node_modules/.bin/pi', args: JSON.parse(process.argv.at(-1)), cwd: '/workspace/project',
      resources: [BOT_SYSTEM_RESOURCE, ...BOT_SKILLS.map(({ path, sha256 }) => ({ path, sha256 }))],
      env: { SWARMENV_BRIDGE_URL: base, SWARMENV_BRIDGE_TOKEN: 'controlled-bridge' } };
    if (process.argv.includes('--unreadable')) await run('chmod', ['0400', BOT_SYSTEM_RESOURCE.path]);
    if (process.argv.includes('--missing-resource')) startInput.resources.pop();
    const starts = await Promise.all([0, 1].map(() => fetch('http://127.0.0.1:44100/start', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(startInput) }).then(async response => ({ status: response.status, body: await response.json() }))));
    if (process.argv.includes('--unreadable') || process.argv.includes('--missing-resource')) {
      assert.deepEqual(starts.map(item => item.status), [400, 400]);
      assert.equal(calls.length, 0);
      console.log('PASS: incomplete or unreadable Bot contract rejects before Pi starts.');
    } else {
    assert.deepEqual(starts.map(item => item.status).sort(), [200, 400], JSON.stringify(starts));
    assert.deepEqual(starts.find(item => item.status === 200).body.result.contract, { version: BOT_PROTOCOL_VERSION, resources: BOT_RESOURCES });
    await worker('/rpc', { message: { id: 'controlled-prompt', type: 'prompt', message: 'Controlled transport verification; execute the scripted tool requests.' }, timeout_ms: 5000 });
    let records = [];
    for (let index = 0; index < 200; index += 1) {
      const history = await worker('/rpc', { message: { type: 'get_state', since: 0 } });
      records = history.records ?? [];
      if (calls.length === steps.length + 1 && records.some(record => record.type === 'agent_end' || record.type === 'agent_settled')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(calls.length, 6, JSON.stringify(records.filter(record => record.type === 'worker_error' || record.type === 'message_end')));
    assert.deepEqual(calls[0].tools.map(tool => tool.function.name).sort(), [...BOT_TOOL_NAMES].sort());
    const system = calls[0].messages.filter(message => ['system', 'developer'].includes(message.role)).map(message => message.content).join('\n');
    assert.ok(system.includes(BOT_SYSTEM_PROMPT), 'complete approved system contract reaches model input');
    const toolMessages = calls.at(-1).messages.filter(message => message.role === 'tool');
    for (const skill of BOT_SKILLS) {
      const source = await readFile(skill.path, 'utf8');
      assert.ok(toolMessages.some(message => (typeof message.content === 'string' ? message.content : message.content.map(part => part.text ?? '').join('\n')).includes(source.trimEnd())), `${skill.name} actual read output reaches next model input`);
    }
    assert.deepEqual(catalogCalls, ['list_services', 'mission_get']);
    const uid = await run('setpriv', ['--reuid', '10001', '--regid', '10001', '--clear-groups', 'node', '-e',
      "try { require('fs').writeFileSync(process.argv[1], 'changed'); process.exit(1); } catch(e) { if (!['EACCES','EROFS'].includes(e.code)) throw e; }", BOT_SKILLS[0].path]);
    assert.equal(uid.stderr, '');
    console.log('PASS: actual Pi four tool definitions, full system addendum, four skill reads, Bash -> swarm -> authenticated Bridge; network disabled, scripted local model endpoint only.');
    }
  } finally { await worker('/stop', {}).catch(() => undefined); server.closeAllConnections(); server.close(); }
}
