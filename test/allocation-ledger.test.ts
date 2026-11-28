import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AllocationLedger } from '../src/core/allocation-ledger.js';

const intent = {
  agentId: 'agent', resourceKey: 'allocation', requestId: 'spawn', parameterFingerprint: 'parameters-v1',
  providerId: 'opensandbox', connectionFingerprint: 'deployment-a', executionGeneration: 1,
  profile: 'worker', executor: 'pi', image: 'worker@sha256:fixed', timeoutSeconds: 60,
};

async function fixture(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'murm-allocation-ledger-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { directory, runtimeId: 'runtime', configFingerprint: 'config-v1', maxAgents: 1, hostIdentity: 'machine-a', ...extra };
  const ledger = AllocationLedger.open(options);
  t.after(() => ledger.close());
  return { ledger, options, directory };
}

function ready(ledger) {
  ledger.reserveIntent(intent);
  ledger.dispatched(intent.resourceKey);
  ledger.observeResource(intent.resourceKey, { sandboxId: 'sandbox', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  ledger.starting(intent.resourceKey);
  ledger.ready(intent.resourceKey, { workerInstanceId: 'instance', streamEpoch: 'stream' });
}

test('an intent reserves one slot durably and request replay cannot change its parameters', async t => {
  const { ledger, options } = await fixture(t);
  const first = ledger.reserveIntent(intent);
  assert.deepEqual(ledger.reserveIntent({ ...intent, agentId: 'unused-new-agent' }), first);
  assert.equal(ledger.occupied, 1);
  assert.throws(() => ledger.reserveIntent({ ...intent, parameterFingerprint: 'different' }), { code: 'CONFLICT' });
  assert.throws(() => ledger.reserveIntent({ ...intent, agentId: 'second', resourceKey: 'second', requestId: 'second' }), { code: 'CONFLICT' });
  ledger.close();
  const recovered = AllocationLedger.open(options); t.after(() => recovered.close());
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.controllerEpoch, 2);
  assert.equal(recovered.occupied, 1);
  assert.equal(recovered.get(intent.resourceKey).state, 'intent');
});

test('a second process cannot take the SQLite writer lock and closing releases it', async t => {
  const { ledger, options } = await fixture(t);
  const module = new URL('../src/core/allocation-ledger.js', import.meta.url).href;
  const probe = () => spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { AllocationLedger } from ${JSON.stringify(module)};
    try { const ledger = AllocationLedger.open(${JSON.stringify(options)}); ledger.close(); }
    catch (error) { process.stdout.write(error.code); process.exitCode = 7; }
  `], { encoding: 'utf8' });
  const blocked = probe();
  assert.equal(blocked.status, 7);
  assert.equal(blocked.stdout, 'LEDGER_UNAVAILABLE');
  ledger.close();
  assert.equal(probe().status, 0);
});

for (const phase of ['before-intent', 'intent', 'dispatched', 'starting', 'closing']) {
  test(`SIGKILL after ${phase} retains its last committed intent and capacity`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'murm-ledger-crash-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const options = { directory, runtimeId: 'crash-runtime', configFingerprint: 'config', maxAgents: 1, hostIdentity: 'same-machine' };
    const module = new URL('../src/core/allocation-ledger.js', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { AllocationLedger } from ${JSON.stringify(module)};
      const ledger = AllocationLedger.open(${JSON.stringify(options)});
      const intent = ${JSON.stringify(intent)};
      if (${JSON.stringify(phase)} !== 'before-intent') ledger.reserveIntent(intent);
      if (['dispatched', 'starting', 'closing'].includes(${JSON.stringify(phase)})) ledger.dispatched(intent.resourceKey);
      if (${JSON.stringify(phase)} === 'starting') { ledger.observeResource(intent.resourceKey, { sandboxId: 'sandbox' }); ledger.starting(intent.resourceKey); }
      if (${JSON.stringify(phase)} === 'closing') ledger.beginClose();
      process.stdout.write('committed');
      setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => assert.fail('crash fixture exited before commit'))]);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const recovered = AllocationLedger.open(options); t.after(() => recovered.close());
    assert.equal(recovered.occupied, phase === 'before-intent' ? 0 : 1);
    assert.equal(recovered.controllerEpoch, 2);
    if (['dispatched', 'starting', 'closing'].includes(phase)) {
      assert.equal(recovered.get(intent.resourceKey).state, 'unknown');
      assert.throws(() => recovered.dispatched(intent.resourceKey), { code: phase === 'closing' ? 'NOT_ALLOWED' : 'CONFLICT' });
    }
    if (phase === 'closing') {
      assert.equal(recovered.run.state, 'closing');
      recovered.observeResource(intent.resourceKey, { sandboxId: 'late-sandbox' });
      assert.equal(recovered.get(intent.resourceKey).state, 'stopping');
      assert.throws(() => recovered.ready(intent.resourceKey, { workerInstanceId: 'instance', streamEpoch: 'stream' }), { code: 'NOT_ALLOWED' });
    }
  });
}

test('management 404 preserves unknown capacity until execution stop is independently confirmed', async t => {
  const { ledger } = await fixture(t); ready(ledger);
  ledger.transition(intent.resourceKey, 'stopping');
  const absent = ledger.recordDeletion(intent.resourceKey, 'sandbox', 'original-authorized-api-404');
  assert.equal(absent.state, 'unknown'); assert.equal(absent.managementAbsent, true); assert.equal(absent.stopConfirmed, false);
  assert.equal(ledger.occupied, 1);
  assert.throws(() => ledger.completeClose(), { code: 'CONFLICT' });
  assert.equal(ledger.recordStop(intent.resourceKey, 'sandbox', 'verified-worker-process-stop').state, 'deleted');
  assert.equal(ledger.occupied, 0);
});

test('every duplicate resource needs separate stop and deletion evidence before its slot is released', async t => {
  const { ledger } = await fixture(t); ready(ledger);
  ledger.observeResource(intent.resourceKey, { sandboxId: 'duplicate' });
  assert.equal(ledger.get(intent.resourceKey).state, 'unknown');
  assert.throws(() => ledger.ready(intent.resourceKey, { workerInstanceId: 'instance', streamEpoch: 'stream' }), { code: 'NOT_ALLOWED' });
  ledger.recordStop(intent.resourceKey, 'sandbox', 'worker-stopped'); ledger.recordDeletion(intent.resourceKey, 'sandbox', 'original-api-absent');
  assert.equal(ledger.occupied, 1);
  ledger.recordStop(intent.resourceKey, 'duplicate', 'infrastructure-fenced'); ledger.recordDeletion(intent.resourceKey, 'duplicate', 'original-api-absent');
  assert.equal(ledger.occupied, 0);
});

test('closing intent, retention reason, actual expiry and export checkpoints survive owner exit', async t => {
  const { ledger, options } = await fixture(t); ready(ledger);
  const expiresAt = new Date(Date.now() + 300_000).toISOString();
  ledger.checkpoint(intent.resourceKey, { publicState: { parentId: 'parent', writable: true, grants: { notes: ['get'] }, collect: { required: true } },
    privateState: { workerToken: 'private-worker-token', bridgeToken: 'private-bridge-token' }, archive: { status: 'complete', digest: 'archive-sha256' } });
  ledger.lease(intent.resourceKey, { requestedExpiresAt: expiresAt, confirmedExpiresAt: expiresAt });
  ledger.transition(intent.resourceKey, 'stopping');
  ledger.recordStop(intent.resourceKey, 'sandbox', 'worker-confirmed-stop');
  ledger.retain(intent.resourceKey, { reason: 'required-export-failed', deadline: expiresAt, owner: 'operator' });
  ledger.beginClose(); ledger.close();
  const recovered = AllocationLedger.open(options); t.after(() => recovered.close());
  const record = recovered.get(intent.resourceKey);
  assert.equal(recovered.run.state, 'closing'); assert.equal(record.expiresAt, expiresAt);
  assert.equal(record.retention.reason, 'required-export-failed'); assert.equal(record.archive.digest, 'archive-sha256');
  assert.equal(record.privateState.workerToken, 'private-worker-token');
  assert.equal(record.publicState.collect.required, true); assert.equal(recovered.occupied, 1);
  assert.throws(() => recovered.reserveIntent({ ...intent, requestId: 'new' }), { code: 'NOT_ALLOWED' });
});

test('input receipts and events commit before their cursor and survive recovery without re-dispatch', async t => {
  const { ledger, options } = await fixture(t); ready(ledger);
  const input = { resourceKey: intent.resourceKey, caller: 'host', requestId: 'send', inputId: 'native-input', parameterFingerprint: 'send-parameters', parameters: { input: 'private prompt' } };
  ledger.reserveInput(input); ledger.recordInput(intent.resourceKey, 'host', 'send', 'dispatched');
  const page = { workerInstanceId: 'instance', streamEpoch: 'stream', events: [{ sequence: 1, event: { type: 'accepted', inputId: 'native-input' } },
    { sequence: 2, event: { type: 'core_session_ready', resources: [{ path: 'session-resource' }] } }],
    sessionResources: [{ path: 'session-resource' }], inputs: [{ caller: 'host', requestId: 'send', state: 'accepted', receipt: { inputId: 'native-input', status: 'accepted' } }] };
  ledger.commitEvents(intent.resourceKey, page);
  assert.equal(ledger.commitEvents(intent.resourceKey, page).afterSequence, 2);
  assert.equal(ledger.events(intent.resourceKey).length, 2);
  ledger.close();
  const recovered = AllocationLedger.open(options); t.after(() => recovered.close());
  assert.equal(recovered.get(intent.resourceKey).afterSequence, 2);
  assert.deepEqual(recovered.get(intent.resourceKey).privateState.sessionResources, [{ path: 'session-resource' }]);
  assert.equal(recovered.inputs(intent.resourceKey)[0].state, 'accepted');
  assert.equal(recovered.reserveInput({ ...input, inputId: 'unused' }).inputId, 'native-input');
  assert.throws(() => recovered.reserveInput({ ...input, requestId: 'new' }), { code: 'NOT_ALLOWED' });
  assert.throws(() => recovered.recordInput(intent.resourceKey, 'host', 'send', 'unknown'), { code: 'CONFLICT' });
  assert.throws(() => recovered.ready(intent.resourceKey, { workerInstanceId: 'new-instance', streamEpoch: 'stream' }), { code: 'CONFLICT' });
  recovered.ready(intent.resourceKey, { workerInstanceId: 'instance', streamEpoch: 'stream' });
  assert.equal(recovered.reserveInput({ ...input, requestId: 'next', inputId: 'next-input' }).state, 'reserved');
});

test('a history gap persists a frozen resource without advancing the cursor past unseen events', async t => {
  const { ledger, options } = await fixture(t); ready(ledger);
  assert.throws(() => ledger.commitEvents(intent.resourceKey, { workerInstanceId: 'instance', streamEpoch: 'stream', events: [{ sequence: 1, event: { type: 'output' } }, { sequence: 3, event: { type: 'settled' } }] }), { code: 'EVENT_GAP' });
  assert.equal(ledger.get(intent.resourceKey).state, 'unknown'); assert.equal(ledger.get(intent.resourceKey).afterSequence, 0); assert.equal(ledger.events(intent.resourceKey).length, 0);
  ledger.close();
  const recovered = AllocationLedger.open(options); t.after(() => recovered.close());
  assert.equal(recovered.get(intent.resourceKey).state, 'unknown'); assert.equal(recovered.get(intent.resourceKey).afterSequence, 0);
  assert.throws(() => recovered.ready(intent.resourceKey, { workerInstanceId: 'instance', streamEpoch: 'stream' }), { code: 'NOT_ALLOWED' });
});

test('a durable write failure fences future mutations without exposing the underlying error', async t => {
  const { ledger } = await fixture(t);
  const original = DatabaseSync.prototype.exec;
  let fail = true;
  const fault = t.mock.method(DatabaseSync.prototype, 'exec', function (statement) {
    if (statement === 'COMMIT' && fail) { fail = false; throw new Error('SQLITE_FULL private-storage-path'); }
    return Reflect.apply(original, this, [statement]);
  });
  assert.throws(() => ledger.reserveIntent(intent), error => error.code === 'LEDGER_UNAVAILABLE' && !error.message.includes('private-storage-path'));
  fault.mock.restore();
  assert.throws(() => ledger.reserveIntent(intent), { code: 'LEDGER_UNAVAILABLE' });
});

test('private storage rejects permissive directories and symbolic links and protects recovered credentials', async t => {
  const { ledger, options, directory } = await fixture(t);
  ledger.putRuntimeState({ publicState: { callback: 'https://runtime.example.test' }, privateState: { bridgeToken: 'private-bridge-token' } });
  assert.equal((await stat(ledger.path)).mode & 0o777, 0o600);
  ledger.close();
  assert.equal('privateState' in AllocationLedger.inspect(directory), false);
  await chmod(directory, 0o755);
  assert.throws(() => AllocationLedger.open(options), { code: 'NOT_ALLOWED' });
  await chmod(directory, 0o700);
  const linked = directory + '-link'; await symlink(directory, linked); t.after(() => rm(linked, { force: true }));
  assert.throws(() => AllocationLedger.open({ ...options, directory: linked }), { code: 'NOT_ALLOWED' });
});

test('another host, changed configuration and a final closed run cannot acquire control', async t => {
  const { ledger, options } = await fixture(t);
  ledger.close();
  assert.throws(() => AllocationLedger.open({ ...options, hostIdentity: 'machine-b' }), { code: 'NOT_ALLOWED' });
  assert.throws(() => AllocationLedger.open({ ...options, configFingerprint: 'config-v2' }), { code: 'CONFLICT' });
  const resumed = AllocationLedger.open(options); t.after(() => resumed.close());
  resumed.beginClose(); resumed.completeClose(); resumed.close();
  assert.equal(AllocationLedger.inspect(options.directory).state, 'closed');
  assert.throws(() => AllocationLedger.open(options), { code: 'NOT_ALLOWED' });
});
