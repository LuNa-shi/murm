import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { delegationCommand } from './fixtures/subagents-upstream.js';
const execute = promisify(execFile);
import { transport } from './fixtures/core-bot-service-backend.js';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return { url: new URL('./fixtures/core-bot-service-backend.js', import.meta.url).href, shortCircuit: true };
  if (specifier === './run-report.mjs' && context.parentURL?.endsWith('/examples/subagents-environment/main.mjs')) return { url: new URL('../src/environments/shared/run-report.js', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
const { runSubagentsEnvironment, checkDelivery } = await import('../examples/subagents-environment/main.mjs'); hooks.deregister();

test('final text must consume three distinct delivered snapshots from exactly two children', () => {
  const results = [{ childId: 'a', eventSeq: 1, output: 'first' }, { childId: 'b', eventSeq: 2, output: 'second' }, { childId: 'a', eventSeq: 3, output: 'followup' }];
  const deliveries = results.map(result => ({ kind: 'child', state: 'accepted', result: { ...result, outcome: 'completed' } }));
  const final = { summary: 'Combine both reasons with the followup limit.', conclusions: results.map(({ output, ...identity }) => ({ ...identity, quote: output })) };
  assert.deepEqual(checkDelivery(JSON.stringify(final), deliveries), final);
  assert.equal(checkDelivery(JSON.stringify({ ...final, conclusions: [final.conclusions[0], final.conclusions[0], final.conclusions[1]] }), deliveries), null);
  deliveries[2].state = 'unknown'; assert.equal(checkDelivery(JSON.stringify(final), deliveries), null);
});

test('subagents host closes its complete dynamic tree and verifies adoption through public Core snapshots', async t => {
  transport.reset();
  const outputDir = await mkdtemp(join(tmpdir(), 'subagents-')); t.after(() => rm(outputDir, { recursive: true, force: true }));
  const bin = join(outputDir, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'swarm'), `#!/usr/bin/env node\nimport(${JSON.stringify(new URL('../scripts/swarm.mjs', import.meta.url).href)});\n`, { mode: 0o700 });
  const childResults = [];
  let parentId;
  const call = async (operation, payload, operation_id) => {
    const credentials = transport.spawns.get(parentId).credentials;
    const response = await fetch(transport.url + '/call', { method: 'POST', headers: { authorization: `Bearer ${credentials.secretEnvironment.SWARMENV_BRIDGE_TOKEN}` }, body: JSON.stringify({ service_id: 'bot', operation, payload, operation_id }) });
    const result = await response.json(); assert.ok(result.ok, JSON.stringify(result)); return result.result;
  };
  // Only native transport is simulated. Runtime, Bot Service, Bridge, routes and reports are real.
  transport.onSpawn = options => {
    if (!options.options.parentId) parentId = options.botId;
    assert.equal(options.options.bindings, undefined); assert.equal(options.options.secretEnv, undefined);
  };
  let child; let nativeError;
  let sends = 0;
  function arm() { transport.next = async inputId => {
    arm();
    const row = transport.submissions.get(inputId);
    sends++;
    if (row.botId === parentId && row.input.startsWith('Explain two')) {
      const credentials = transport.spawns.get(parentId).credentials;
      const result = JSON.parse((await execute('bash', ['-c', delegationCommand()], { cwd: outputDir, env: { ...process.env, ...credentials.environment, ...credentials.secretEnvironment, PATH: bin + ':' + process.env.PATH }, timeout: 15000 }).catch(error => { nativeError = error.stderr; throw error; })).stdout);
      assert.deepEqual(result.negativeChecks, [true, true, true, true, true]);
      child = result.children[0].id;
      // This text guesses all future quotes before any child result has been
      // dispatched to parent. Later delivery must never rehabilitate this turn.
      transport.spawns.get(parentId).onEvent({ type: 'settled', outcome: 'completed', output: JSON.stringify({ summary: 'Premature unadmitted result.', conclusions: [
        { childId: child, eventSeq: 1, quote: 'SUBAGENTS_CHILD_A' },
        { childId: result.children[1].id, eventSeq: 1, quote: 'SUBAGENTS_CHILD_B' },
        { childId: child, eventSeq: 2, quote: 'followup' },
      ] }) });
    } else if (row.botId !== parentId) {
      transport.spawns.get(row.botId).onEvent({ type: 'settled', outcome: 'completed', output: row.input });
    } else if (row.input === 'USER_SUPPLEMENT') {
      // A second user source is admitted without assigning it a settled event.
    } else {
      const result = JSON.parse(row.input); childResults.push(result);
      if (childResults.length === 2) await call('send', { bot_id: child, input: 'followup', mode: 'followUp' }, 'child-followup');
      if (childResults.length === 3) transport.spawns.get(parentId).onEvent({ type: 'settled', outcome: 'completed', output: JSON.stringify({ summary: 'First and second reasons, refined by the original child.', conclusions: childResults.map(({ childId, eventSeq, output }) => ({ childId, eventSeq, quote: output })) }) });
    }
  }; }
  arm();
  const report = await runSubagentsEnvironment({ backend: { sandbox: { lifecycleBaseUrl: 'http://127.0.0.1:1/v1' }, bridge: { host: '127.0.0.1', publicUrl: 'http://172.17.0.1:{port}' }, modelGateway: { host: '127.0.0.1', advertiseHost: '172.17.0.1' }, models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } }, isolation: { network: 'local-docker', disk: { bytes: 33554432, inodes: 2048 } } }, image: 'test', outputDir, supplements: ['USER_SUPPLEMENT'], workTimeoutMs: 3000, closeTimeoutMs: 1000 });
  assert.equal(report.businessFailure, null, JSON.stringify(report.businessFailure) + String(nativeError ?? '')); assert.equal(report.cleanupFailure, null);
  assert.equal(report.cleanup.bots.length, 3); assert.equal(report.cleanup.cleanup, 'complete');
  assert.equal(report.result.eventSeq, 2, 'The premature first parent final cannot become valid after later dispatches');
  assert.equal(transport.spawns.size, 3); assert.equal(childResults.length, 3); assert.equal(sends, 8);
  assert.equal(new Set(report.result.delivery.conclusions.map(result => result.childId)).size, 2);
  assert.ok(report.routing.deliveries.every(entry => entry.state === 'accepted'));
  assert.equal(report.routing.deliveries.filter(entry => entry.kind === 'user').length, 2);
});


test('scaled delivery requires every configured child and one original child followup', () => {
  for (const childCount of [3, 7]) {
    const results = Array.from({ length: childCount }, (_, index) => ({ childId: `child-${index}`, eventSeq: 1, output: `fixed-${index}` }));
    results.push({ childId: 'child-0', eventSeq: 2, output: 'followup' });
    const deliveries = results.map(result => ({ kind: 'child', state: 'accepted', result: { ...result, outcome: 'completed' } }));
    const final = { summary: 'All distinct original children and followup.', conclusions: results.map(({ output, ...identity }) => ({ ...identity, quote: output })) };
    assert.deepEqual(checkDelivery(JSON.stringify(final), deliveries, childCount), final);
    assert.equal(checkDelivery(JSON.stringify({ ...final, conclusions: final.conclusions.slice(1) }), deliveries, childCount), null);
    deliveries.at(-1).state = 'unknown';
    assert.equal(checkDelivery(JSON.stringify(final), deliveries, childCount), null);
  }
});

for (const [childCount, pending] of [[3, false], [7, false], [3, true]]) {
  test(`${childCount + 1}-Bot subagents retain every original child and followup with ${pending ? 'pending' : 'complete'} cleanup`, async t => {
    transport.reset(); transport.collectable = true;
    if (pending) transport.onStop = async () => { throw Object.assign(new Error('Fixed stop uncertainty'), { code: 'STOP_UNCONFIRMED' }); };
    const outputDir = await mkdtemp(join(tmpdir(), 'subagents-capacity-')); t.after(() => rm(outputDir, { recursive: true, force: true }));
    let parentId; const children = [], results = [];
    transport.onSpawn = options => { if (!options.options.parentId) parentId = options.botId; };
    const call = async (operation, payload, operation_id) => {
      const credentials = transport.spawns.get(parentId).credentials;
      const response = await fetch(transport.url + '/call', { method: 'POST', headers: { authorization: `Bearer ${credentials.secretEnvironment.SWARMENV_BRIDGE_TOKEN}` },
        body: JSON.stringify({ service_id: 'bot', operation, payload, operation_id }) });
      return response.json();
    };
    function arm() { transport.next = async inputId => {
      arm(); const row = transport.submissions.get(inputId);
      if (row.botId !== parentId) {
        transport.spawns.get(row.botId).onEvent({ type: 'settled', outcome: 'completed', output: row.input });
      } else if (row.input.startsWith(`Explain ${childCount}`)) {
        for (let index = 0; index < childCount; index++) {
          const result = await call('spawn', { profile: 'child', input: `original-${index}`, mode: 'followUp' }, `child-${index}`);
          assert.equal(result.ok, true); children.push(result.result.bot.id);
          assert.equal(result.result.initialInput.status, 'accepted');
        }
        const full = await call('spawn', { profile: 'child' }, 'beyond-capacity');
        assert.equal(full.ok, false); assert.equal(full.error.code, 'CONFLICT');
      } else {
        results.push(JSON.parse(row.input));
        if (results.length === childCount) {
          const result = await call('send', { bot_id: children[0], input: 'same-child-followup', mode: 'followUp' }, 'followup');
          assert.equal(result.ok, true);
        }
        if (results.length === childCount + 1) transport.spawns.get(parentId).onEvent({ type: 'settled', outcome: 'completed', output: JSON.stringify({
          summary: 'Distinct original children with one reused child.', conclusions: results.map(({ childId, eventSeq, output }) => ({ childId, eventSeq, quote: output })),
        }) });
      }
    }; }
    arm();
    const report = await runSubagentsEnvironment({ childCount, backend: { sandbox: { lifecycleBaseUrl: 'http://127.0.0.1:1/v1' },
      bridge: { host: '127.0.0.1', publicUrl: 'http://172.17.0.1:{port}' }, modelGateway: { host: '127.0.0.1', advertiseHost: '172.17.0.1' },
      models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } },
      isolation: { network: 'local-docker', disk: { bytes: 33554432, inodes: 2048 } } }, image: 'test', outputDir, workTimeoutMs: 3000, closeTimeoutMs: 1000 });
    assert.equal(report.businessFailure, null, JSON.stringify(report.businessFailure));
    assert.equal(report.result.childCount, childCount);
    assert.equal(transport.spawns.size, childCount + 1); assert.equal(report.cleanup.bots.length, childCount + 1);
    assert.ok(children.every(id => transport.spawns.get(id).options.parentId === parentId));
    assert.equal(new Set(report.result.delivery.conclusions.map(row => row.childId)).size, childCount);
    assert.equal(report.routing.maxChildren, childCount);
    assert.equal(results.filter(row => row.childId === children[0]).length, 2);
    assert.ok(report.routing.deliveries.every(row => row.state === 'accepted'));
    assert.equal(report.cleanup.cleanup, pending ? 'pending' : 'complete');
    assert.equal(report.cleanupFailure?.code ?? null, pending ? 'CLEANUP_PENDING' : null);
    if (pending) assert.ok(report.cleanup.bots.every(row => row.execution === 'unknown' && row.cleanup === 'pending'));
  });
}

test('invalid subagents child counts fail before Bot creation', async () => {
  transport.reset();
  for (const childCount of [1, 8, 2.5, '3']) {
    await assert.rejects(runSubagentsEnvironment({ childCount, backend: {}, outputDir: 'unused' }), TypeError);
  }
  assert.equal(transport.spawns.size, 0);
});
