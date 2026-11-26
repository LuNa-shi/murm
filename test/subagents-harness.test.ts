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
import { transport } from './fixtures/core-agent-service-backend.js';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) return { url: new URL('./fixtures/core-agent-service-backend.js', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
const { runSubagentsHarness, checkDelivery } = await import('../test-support/subagents/communication-fixture.js'); hooks.deregister();

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
  await writeFile(join(bin, 'swarm'), `#!/usr/bin/env node\nimport(${JSON.stringify(new URL('../scripts/swarm.js', import.meta.url).href)});\n`, { mode: 0o700 });
  const childResults = [];
  let parentId;
  const call = async (operation, payload, operation_id) => {
    const credentials = transport.spawns.get(parentId).credentials;
    const response = await fetch(transport.url + '/call', { method: 'POST', headers: { authorization: `Bearer ${credentials.secretEnvironment.MURM_BRIDGE_TOKEN}` }, body: JSON.stringify({ service_id: 'agent', operation, payload, operation_id }) });
    const result = await response.json(); assert.ok(result.ok, JSON.stringify(result)); return result.result;
  };
  // Only native transport is simulated. Runtime, Agent Service, Bridge, routes and reports are real.
  transport.onSpawn = options => {
    if (!options.options.parentId) parentId = options.agentId;
    assert.equal(options.options.bindings, undefined); assert.equal(options.options.secretEnv, undefined);
  };
  let child; let nativeError;
  let sends = 0;
  function arm() { transport.next = async inputId => {
    arm();
    const row = transport.submissions.get(inputId);
    sends++;
    if (row.agentId === parentId && row.input.startsWith('Explain two')) {
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
    } else if (row.agentId !== parentId) {
      transport.spawns.get(row.agentId).onEvent({ type: 'settled', outcome: 'completed', output: row.input });
    } else if (row.input === 'USER_SUPPLEMENT') {
      // A second user source is admitted without assigning it a settled event.
    } else {
      const result = JSON.parse(row.input); childResults.push(result);
      if (childResults.length === 2) await call('send', { agent_id: child, input: 'followup', mode: 'followUp' }, 'child-followup');
      if (childResults.length === 3) transport.spawns.get(parentId).onEvent({ type: 'settled', outcome: 'completed', output: JSON.stringify({ summary: 'First and second reasons, refined by the original child.', conclusions: childResults.map(({ childId, eventSeq, output }) => ({ childId, eventSeq, quote: output })) }) });
    }
  }; }
  arm();
  const report = await runSubagentsHarness({ backend: { sandbox: { lifecycleBaseUrl: 'http://127.0.0.1:1/v1' }, bridge: { host: '127.0.0.1', publicUrl: 'http://172.17.0.1:{port}' }, modelGateway: { host: '127.0.0.1', advertiseHost: '172.17.0.1' }, models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } }, isolation: { network: 'local-docker', disk: { bytes: 33554432, inodes: 2048 } } }, image: 'test', outputDir, supplements: ['USER_SUPPLEMENT'], workTimeoutMs: 3000, closeTimeoutMs: 1000 });
  assert.equal(report.businessFailure, null, JSON.stringify(report.businessFailure) + String(nativeError ?? '')); assert.equal(report.cleanupFailure, null);
  assert.equal(report.cleanup.agents.length, 3); assert.equal(report.cleanup.cleanup, 'complete');
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
  test(`${childCount + 1}-Agent subagents retain every original child and followup with ${pending ? 'pending' : 'complete'} cleanup`, async t => {
    transport.reset(); transport.collectable = true;
    if (pending) transport.onStop = async () => { throw Object.assign(new Error('Fixed stop uncertainty'), { code: 'STOP_UNCONFIRMED' }); };
    const outputDir = await mkdtemp(join(tmpdir(), 'subagents-capacity-')); t.after(() => rm(outputDir, { recursive: true, force: true }));
    let parentId; const children = [], results = [];
    transport.onSpawn = options => { if (!options.options.parentId) parentId = options.agentId; };
    const call = async (operation, payload, operation_id) => {
      const credentials = transport.spawns.get(parentId).credentials;
      const response = await fetch(transport.url + '/call', { method: 'POST', headers: { authorization: `Bearer ${credentials.secretEnvironment.MURM_BRIDGE_TOKEN}` },
        body: JSON.stringify({ service_id: 'agent', operation, payload, operation_id }) });
      return response.json();
    };
    function arm() { transport.next = async inputId => {
      arm(); const row = transport.submissions.get(inputId);
      if (row.agentId !== parentId) {
        transport.spawns.get(row.agentId).onEvent({ type: 'settled', outcome: 'completed', output: row.input });
      } else if (row.input.startsWith(`Explain ${childCount}`)) {
        for (let index = 0; index < childCount; index++) {
          const result = await call('spawn', { profile: 'child', input: `original-${index}`, mode: 'followUp' }, `child-${index}`);
          assert.equal(result.ok, true); children.push(result.result.agent.id);
          assert.equal(result.result.initialInput.status, 'accepted');
        }
        const full = await call('spawn', { profile: 'child' }, 'beyond-capacity');
        assert.equal(full.ok, false); assert.equal(full.error.code, 'CONFLICT');
      } else {
        results.push(JSON.parse(row.input));
        if (results.length === childCount) {
          const result = await call('send', { agent_id: children[0], input: 'same-child-followup', mode: 'followUp' }, 'followup');
          assert.equal(result.ok, true);
        }
        if (results.length === childCount + 1) transport.spawns.get(parentId).onEvent({ type: 'settled', outcome: 'completed', output: JSON.stringify({
          summary: 'Distinct original children with one reused child.', conclusions: results.map(({ childId, eventSeq, output }) => ({ childId, eventSeq, quote: output })),
        }) });
      }
    }; }
    arm();
    const report = await runSubagentsHarness({ childCount, backend: { sandbox: { lifecycleBaseUrl: 'http://127.0.0.1:1/v1' },
      bridge: { host: '127.0.0.1', publicUrl: 'http://172.17.0.1:{port}' }, modelGateway: { host: '127.0.0.1', advertiseHost: '172.17.0.1' },
      models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: 'http://127.0.0.1:1/v1/responses', headers: {} } } },
      isolation: { network: 'local-docker', disk: { bytes: 33554432, inodes: 2048 } } }, image: 'test', outputDir, workTimeoutMs: 3000, closeTimeoutMs: 1000 });
    assert.equal(report.businessFailure, null, JSON.stringify(report.businessFailure));
    assert.equal(report.result.childCount, childCount);
    assert.equal(transport.spawns.size, childCount + 1); assert.equal(report.cleanup.agents.length, childCount + 1);
    assert.ok(children.every(id => transport.spawns.get(id).options.parentId === parentId));
    assert.equal(new Set(report.result.delivery.conclusions.map(row => row.childId)).size, childCount);
    assert.equal(report.routing.maxChildren, childCount);
    assert.equal(results.filter(row => row.childId === children[0]).length, 2);
    assert.ok(report.routing.deliveries.every(row => row.state === 'accepted'));
    assert.equal(report.cleanup.cleanup, pending ? 'pending' : 'complete');
    assert.equal(report.cleanupFailure?.code ?? null, pending ? 'CLEANUP_PENDING' : null);
    if (pending) assert.ok(report.cleanup.agents.every(row => row.execution === 'unknown' && row.cleanup === 'pending'));
  });
}

test('invalid subagents child counts fail before Agent creation', async () => {
  transport.reset();
  for (const childCount of [1, 8, 2.5, '3']) {
    await assert.rejects(runSubagentsHarness({ childCount, backend: {}, outputDir: 'unused' }), TypeError);
  }
  assert.equal(transport.spawns.size, 0);
});

test('four staged groups use real Core and parent Agent Service inputs without ending at the first integration', async t => {
  const { createRuntime } = await import('@murm/core');
  const { ServiceRegistry } = await import('@murm/core/services');
  const { runInput } = await import('../src/harnesses/shared/run-input.js');
  const { createSubagentsStages } = await import('../test-support/subagents/stages.js');
  transport.reset(); transport.collectable = true;
  const outputDir = await mkdtemp(join(tmpdir(), 'subagents-stages-'));
  const common = { prompt: 'Controlled stage contract.', model: 'default', image: 'test', writable: true, services: {} };
  const runtime = await createRuntime({ backend: {}, outputDir, maxAgents: 4, services: new ServiceRegistry(), profiles: {
    parent: { ...common, services: { agent: ['spawn', 'get', 'send', 'stop'] }, spawnProfiles: ['child'] }, child: common,
  } });
  let stages;
  t.after(async () => { stages?.stop(); assert.equal((await runtime.close()).cleanup, 'complete'); await stages?.drain(); stages?.dispose(); await rm(outputDir, { recursive: true, force: true }); });
  const parent = await runtime.spawn({ profile: 'parent', requestId: 'parent' });
  const childIds = []; const conclusions = []; let stageResults = 0; let currentStage;
  const call = async (operation, payload, operation_id) => {
    const credentials = transport.spawns.get(parent.id).credentials;
    const response = await fetch(transport.url + '/call', { method: 'POST', headers: { authorization: `Bearer ${credentials.secretEnvironment.MURM_BRIDGE_TOKEN}` }, body: JSON.stringify({ service_id: 'agent', operation, operation_id, payload }) });
    const result = await response.json(); assert.equal(result.ok, true, JSON.stringify(result)); return result.result;
  };
  function arm() { transport.next = async inputId => {
    arm(); const row = transport.submissions.get(inputId);
    if (row.agentId !== parent.id) {
      transport.spawns.get(row.agentId).onEvent({ type: 'settled', outcome: 'completed', output: row.input });
    } else if (row.input === 'prepare') {
      for (let index = 0; index < 3; index++) {
        const result = await call('spawn', { profile: 'child' }, `child-${index}`);
        assert.equal(result.initialInput, null); childIds.push(result.agent.id);
      }
      transport.spawns.get(parent.id).onEvent({ type: 'settled', outcome: 'completed', output: 'Ready without child work.' });
    } else if (row.input.startsWith('group-')) {
      currentStage = Number(row.input.slice(6)); stageResults = 0;
      for (const [index, childId] of childIds.entries()) {
        const receipt = await call('send', { agent_id: childId, input: `result-${currentStage}-${index}`, mode: 'followUp' }, `work-${currentStage}-${index}`);
        assert.equal(receipt.status, 'accepted');
      }
    } else {
      const result = JSON.parse(row.input);
      conclusions.push({ childId: result.childId, eventSeq: result.eventSeq, quote: result.output }); stageResults++;
      if (stageResults === 3) transport.spawns.get(parent.id).onEvent({ type: 'settled', outcome: 'completed', output: JSON.stringify({ stage: currentStage, summary: 'Cumulative adoption of original child outputs.', conclusions }) });
    }
  }; }
  arm();
  await runInput(runtime, parent.id, 'prepare', { requestId: 'prepare', timeoutMs: 2000 });
  assert.equal(transport.submissions.size, 1);
  stages = await createSubagentsStages(runtime, parent.id, { childIds });
  for (let stage = 0; stage < 4; stage++) {
    const result = await stages.runStage({ stage, input: `group-${stage}`, expected: [0, 1, 2].map(index => `result-${stage}-${index}`), timeoutMs: 2000 });
    assert.equal(result.children.length, 3); assert.equal(result.conclusions.length, (stage + 1) * 3);
    assert.equal(result.parent.settled.agentId, parent.id);
    assert.deepEqual(result.children.map(row => row.result.childId), childIds);
    for (const id of [parent.id, ...childIds]) assert.equal((await runtime.get(id)).status, 'idle');
  }
  assert.equal(transport.spawns.size, 4); assert.equal(stages.report().deliveries.length, 16);
  assert.equal(stages.report().stages.at(-1).conclusions.length, 12);
});
