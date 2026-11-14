import assert from 'node:assert/strict';
import test from 'node:test';
import { request as httpRequest } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TaskService } from '../src/task/task-service.js';
import { ContextService } from '../src/context/context-service.js';
import { ServicesBridge } from '../src/agent/services-bridge.js';
import { createBuiltinServiceRegistry } from '../src/sdk/builtin-registry.js';
import { makeEnvelope } from '../src/protocol/envelope.js';

async function fixture(t, options = {}) {
  const service = new TaskService();
  const context = new ContextService(service.db);
  service.createMission({ mission_id: 'mission:auth', goal: 'Inspect authenticated Bot lifecycle' }, makeEnvelope({ actorRef: 'operator:test' }));
  const registry = createBuiltinServiceRegistry({ taskService: service, contextService: context });
  const bridge = new ServicesBridge({ taskService: service, contextService: context, runtime: {}, coreId: 'core-1', registry, ...options });
  await bridge.start();
  t.after(async () => { await bridge.stop(); service.close(); });
  const start = id => {
    service.registerBot({ botId: id, missionId: 'mission:auth', coreId: 'core-1', selectionDeadline: new Date(Date.now() + 60_000).toISOString() });
    const env = bridge.startBotIdentity(id);
    service.recordBotSandbox(id, { provider: 'controlled', sandboxId: `sandbox:${id}` });
    service.markBotReady(id);
    return env;
  };
  const close = id => { service.requestBotStop(id, 'test-cleanup'); service.finalizeBotClose(id); };
  return { service, bridge, start, close };
}

test('a request authenticated before rotation cannot execute as the successor Bot', async t => {
  const { service, bridge, start, close } = await fixture(t);
  const env = start('bot:first');
  const body = JSON.stringify({ operation: 'bot_exit', payload: { reason: 'no-work' } });
  let arrived;
  const received = new Promise(resolve => { arrived = resolve; });
  bridge.server.once('request', arrived);
  let req;
  const response = new Promise((resolve, reject) => {
    req = httpRequest(`${env.SWARMENV_BRIDGE_URL}/call`, { method: 'POST', headers: { authorization: `Bearer ${env.SWARMENV_BRIDGE_TOKEN}`, 'content-length': Buffer.byteLength(body) } }, res => {
      let result = '';
      res.on('data', chunk => { result += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(result) }));
    });
    req.on('error', reject);
    req.write(body.slice(0, 1));
  });
  await received;
  close('bot:first');
  start('bot:second');
  req.end(body.slice(1));
  const rejected = await response;
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, 'NOT_ALLOWED');
  assert.equal(service.getBot('bot:second').state, 'UNBOUND');
});

test('a queued Task proposal cannot acquire a successor Bot identity', async t => {
  let entered;
  let resume;
  const queued = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const { service, bridge, start, close } = await fixture(t, { taskCreateMutex: { run: async fn => { entered(); await gate; return fn(); } } });
  start('bot:first');
  const proposal = bridge.call({ operation: 'task_create', payload: { mission_id: 'mission:auth', summary: 'Inspect one independently useful question', expected_output: 'Note', acceptance_conditions: ['Reviewed'] } });
  const rejected = assert.rejects(proposal, /credentials changed/);
  await queued;
  close('bot:first');
  start('bot:second');
  resume();
  await rejected;
  assert.equal(service.listMissionTasks({ mission_id: 'mission:auth' }).length, 0);
});

test('swarm bot exit uses the provisioned Bridge identity without an actor override', async t => {
  const { service, start } = await fixture(t);
  const env = start('bot:cli');
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/swarm.mjs', 'bot', 'exit', '--reason', 'no-work', '--json'], { cwd: process.cwd(), env: { ...process.env, ...env }, timeout: 10_000 });
  const result = JSON.parse(stdout);
  assert.equal(result.bot.bot_id, 'bot:cli');
  assert.equal(service.getBot('bot:cli').state, 'CLOSING');
  assert.equal(service.getBot('bot:cli').execution_id, null);
});
