import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { makeEnvelope, stableStringify } from '../src/protocol/envelope.js';
import { createFlatTaskStores } from './fixtures/flat-task-stores.js';
import { transport, controls } from './fixtures/flat-controller-backend.js';

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './pi-opensandbox-backend.js' && context.parentURL?.endsWith('/src/core/index.js')) {
    return { url: new URL('./fixtures/flat-controller-backend.js', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { runFlatEnvironment } = await import('../src/environments/flat/environment.js');
hooks.deregister();
const execute = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');

for (const capacity of [2, 4]) test(`${capacity} flat Slots contribute distinct public results, continue and receive feedback, then replace only a retired owner and adopt its public result`, { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'flat-closed-loop-harness-'));
  const stores = await createFlatTaskStores(root);
  t.after(async () => { stores.close(); await rm(root, { recursive: true, force: true }); });
  transport.reset(); controls.credentials.clear(); controls.preparedFiles.clear(); controls.stopError = null; controls.destroyError = null;
  const accept = id => { transport.confirm(id, 'started'); transport.next = accept; };
  transport.next = accept;
  const createTask = (summary, extra = {}) => stores.tasks.createTask({ mission_id: stores.missionId, gap: summary,
    priority: 'medium', summary, expected_output: 'Checked public result', acceptance_conditions: ['Exact public bytes'], ...extra }, makeEnvelope({ actorRef: 'host' })).task;
  const secondTask = createTask('Independent feedback result');
  const auditTasks = capacity === 4 ? [createTask('Audit published Material bytes'), createTask('Audit pinned Workspace binary bytes')] : [];
  const audits = [];
  const directories = new Map(), captures = [], publications = [];
  let firstOwner, secondOwner, replacement, adoptedTask, firstExecution, firstRevision, feedback;
  const directoryFor = async botId => {
    if (!directories.has(botId)) {
      const directory = join(root, 'fixture-workdirs', botId);
      await mkdir(directory, { recursive: true }); directories.set(botId, directory);
    }
    return directories.get(botId);
  };
  controls.onPrepare = async (botId, entries) => {
    const directory = await directoryFor(botId);
    for (const { path, bytes, mode } of entries) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), bytes, { mode });
    }
  };
  t.after(() => { controls.onPrepare = null; });
  const cli = async (botId, ...args) => {
    const credentials = controls.credentials.get(botId); assert.ok(credentials);
    const env = { ...process.env, ...credentials.environment, ...credentials.secretEnvironment };
    const bridge = new URL(env.SWARMENV_BRIDGE_URL); bridge.hostname = '127.0.0.1'; env.SWARMENV_BRIDGE_URL = bridge.href.replace(/\/$/, '');
    const { stdout } = await execute(process.execPath, [new URL('../scripts/swarm.js', import.meta.url).pathname, ...args],
      { cwd: await directoryFor(botId), env, timeout: 5000 });
    return JSON.parse(stdout);
  };
  const settle = botId => transport.listeners.get(botId)({ type: 'settled', outcome: 'completed' });
  const finish = async (controller, botId, materialId, requestId) => {
    const taskId = stores.tasks.getExecution(stores.tasks.getBot(botId).execution_id).task_id;
    await cli(botId, 'task', 'link', '--task-id', taskId, '--material-id', materialId, '--role', 'experience',
      '--receiving-task-id', taskId, '--request-id', `${requestId}-link`);
    try { await cli(botId, 'task', 'finish', '--outcome', 'done', '--material-ids', JSON.stringify([materialId]), '--request-id', requestId); }
    catch (error) {
      const execution = stores.tasks.getExecution(stores.tasks.getBot(botId).execution_id);
      assert.ok(execution.finish, `A reply lost during retirement still needs a durable accepted finish: ${error.stderr ?? error.message}`);
    }
    await controller.tick();
  };
  const report = await runFlatEnvironment({ ...stores, taskService: stores.tasks, contextService: stores.context,
    missionWorkspace: stores.workspace, workspaceManager: stores.manager, outputDir: root, deadlineAt: Date.now() + 25_000,
    backend: {}, image: 'fixture', model: 'default', capacity,
    // Explicit test-only trusted dependency. These are host fixture directories,
    // not native WorkDirs and not a supported production Core snapshot API.
    async snapshotProject({ botId, executionId, fencingVersion }) {
      const directory = directories.get(botId); assert.ok(directory);
      const files = {}, manifest = {};
      for (const path of (await readdir(directory)).sort()) {
        const bytes = await readFile(join(directory, path));
        files[path] = bytes.toString('base64'); manifest[path] = { bytes: bytes.length, content_hash: hash(bytes) };
      }
      captures.push({ botId, executionId, fencingVersion });
      return { execution_id: executionId, binding_version: fencingVersion, state: 'ACTIVE', files, manifest, content_hash: hash(stableStringify(manifest)) };
    },
    async drive(controller) {
      const initial = controller.snapshot(); assert.equal(initial.bots.length, capacity);
      [firstOwner, secondOwner] = initial.bots;
      assert.equal(new Set(initial.bots.map(row => row.slot)).size, capacity);
      assert.ok(initial.bots.every(row => stores.tasks.getBot(row.botId).state === 'UNBOUND'));
      const listed = await cli(firstOwner.botId, 'task', 'list', '--state', 'ready');
      assert.ok(listed.tasks.some(row => row.task_id === stores.task.task_id));
      const taken = await cli(firstOwner.botId, 'task', 'take', stores.task.task_id, '--request-id', 'first-take');
      firstExecution = taken.execution.execution_id;
      await cli(secondOwner.botId, 'task', 'take', secondTask.task_id, '--request-id', 'second-take');
      for (const [index, task] of auditTasks.entries()) {
        const owner = initial.bots[index + 2];
        const taken = await cli(owner.botId, 'task', 'take', task.task_id, '--request-id', `audit-${index}-take`);
        audits.push({ owner, task, executionId: taken.execution.execution_id });
      }
      assert.ok(initial.bots.every(row => stores.tasks.getExecution(stores.tasks.getBot(row.botId).execution_id).state === 'RUNNING'));
      await writeFile(join(await directoryFor(firstOwner.botId), 'result.txt'), 'partial result\n');
      settle(firstOwner.botId); await controller.flush();
      assert.equal(stores.tasks.getTask(stores.task.task_id).state, 'RUNNING');
      assert.equal(stores.tasks.getBot(firstOwner.botId).execution_id, firstExecution);
      const continuation = controller.snapshot().inputs.filter(row => row.source === 'continuation');
      assert.equal(continuation.length, 1); assert.equal(continuation[0].botId, firstOwner.botId);
      assert.equal(continuation[0].executionId, firstExecution); assert.equal(continuation[0].mode, 'followUp');
      feedback = await controller.feedback({ taskId: secondTask.task_id, input: 'Include the fixed feedback evidence.', requestId: 'fixed-feedback', mode: 'followUp' });
      assert.equal(feedback.status, 'accepted'); assert.equal(feedback.botId, secondOwner.botId);
      assert.deepEqual(await controller.feedback({ taskId: secondTask.task_id, input: 'Include the fixed feedback evidence.', requestId: 'fixed-feedback', mode: 'followUp' }), feedback);
      assert.equal([...transport.submissions.values()].filter(row => row.input === 'Include the fixed feedback evidence.').length, 1);
      const resultBytes = Buffer.from('Checked public result λ\n');
      await writeFile(join(await directoryFor(firstOwner.botId), 'result.txt'), resultBytes);
      await writeFile(join(await directoryFor(firstOwner.botId), 'binary.dat'), Buffer.from([0, 255, 65, 10]));
      const published = await cli(firstOwner.botId, 'material', 'publish', '--content', resultBytes.toString(), '--request-id', 'first-publish');
      const materialId = published.material.material_id; publications.push(materialId);
      const saved = await cli(firstOwner.botId, 'workspace', 'save', '--request-id', 'first-save'); firstRevision = saved.revision;
      assert.deepEqual(await cli(firstOwner.botId, 'workspace', 'save', '--request-id', 'first-save'), saved);
      assert.equal(captures.length, 1);
      adoptedTask = createTask('Adopt the retired producer public result', { input_material_refs: [materialId], workspace: { workspace_id: stores.workspaceId, revision: firstRevision } });
      await finish(controller, firstOwner.botId, materialId, 'first-finish');
      const retired = controller.snapshot().bots.find(row => row.botId === firstOwner.botId);
      assert.equal(retired.lastStop.execution, 'stopped'); assert.equal(retired.lastStop.cleanup, 'complete'); assert.equal(retired.released, true);
      assert.equal(stores.tasks.getBot(firstOwner.botId).state, 'CLOSED');
      replacement = controller.snapshot().bots.find(row => !initial.bots.some(initialRow => initialRow.botId === row.botId)); assert.ok(replacement);
      assert.equal(replacement.slot, firstOwner.slot); assert.notEqual(replacement.botId, firstOwner.botId);
      assert.equal(stores.tasks.getBot(replacement.botId).state, 'UNBOUND');
      assert.equal(controller.snapshot().decisions.findIndex(row => row.reason === 'slot-released' && row.botId === firstOwner.botId) <
        controller.snapshot().decisions.findIndex(row => row.reason === 'spawn-readonly-discovery' && row.botId === replacement.botId), true);
      const lateCount = transport.submissions.size;
      const late = await controller.feedback({ taskId: stores.task.task_id, input: 'Too late', requestId: 'finished-feedback' });
      assert.equal(late.status, 'not_submitted'); assert.equal(late.reason, 'task-not-running'); assert.equal(transport.submissions.size, lateCount);
      const adopted = await cli(replacement.botId, 'task', 'take', adoptedTask.task_id, '--request-id', 'adopt-take');
      assert.equal(adopted.workspace.revision, firstRevision); assert.equal(adopted.materials[0].material_id, materialId);
      assert.deepEqual(controls.preparedFiles.get(replacement.botId).find(row => row.path === 'binary.dat').bytes, Buffer.from([0, 255, 65, 10]));
      const fixedTree = stores.tasks.getExecution(adopted.execution.execution_id).workspace_ref;
      assert.deepEqual(await readFile(join(fixedTree, 'binary.dat')), Buffer.from([0, 255, 65, 10]));
      const receivedBinary = await readFile(join(await directoryFor(replacement.botId), 'binary.dat'));
      assert.deepEqual(receivedBinary, Buffer.from([0, 255, 65, 10]));
      const material = await cli(replacement.botId, 'material', 'view', materialId);
      assert.equal(material.material.content, 'Checked public result λ\n');
      const publicFile = await cli(replacement.botId, 'workspace', 'read', '--path', 'result.txt', '--revision', firstRevision);
      assert.equal(publicFile.content, 'Checked public result λ\n');
      const adoptedBytes = Buffer.from(`Adopted: ${publicFile.content}Binary: ${receivedBinary.toString('base64')}\n`);
      await writeFile(join(await directoryFor(replacement.botId), 'adopted.txt'), adoptedBytes);
      const adoptedMaterial = await cli(replacement.botId, 'material', 'publish', '--content', adoptedBytes.toString(), '--request-id', 'adopt-publish');
      publications.push(adoptedMaterial.material.material_id);
      await cli(replacement.botId, 'workspace', 'save', '--request-id', 'adopt-save');
      const received = [...transport.submissions.values()].find(row => row.botId === secondOwner.botId && row.input === 'Include the fixed feedback evidence.');
      assert.ok(received); await writeFile(join(await directoryFor(secondOwner.botId), 'feedback.txt'), received.input);
      const secondMaterial = await cli(secondOwner.botId, 'material', 'publish', '--content', await readFile(join(directories.get(secondOwner.botId), 'feedback.txt'), 'utf8'), '--request-id', 'second-publish');
      publications.push(secondMaterial.material.material_id);
      // Both additional initial owners perform business work through the authenticated
      // CLI after producer retirement, rather than merely occupying discovery Slots.
      for (const [index, audit] of audits.entries()) {
        let content;
        if (index === 0) {
          const result = await cli(audit.owner.botId, 'material', 'view', materialId);
          assert.equal(result.material.content, 'Checked public result λ\n');
          content = `Material audit: ${result.material.content}`;
        } else {
          const result = await cli(audit.owner.botId, 'workspace', 'read', '--path', 'binary.dat', '--revision', firstRevision);
          assert.equal(result.encoding, 'base64');
          assert.equal(result.content, 'AP9BCg==');
          content = `Binary audit: ${result.content}\n`;
        }
        const published = await cli(audit.owner.botId, 'material', 'publish', '--content', content, '--request-id', `audit-${index}-publish`);
        audit.materialId = published.material.material_id;
        await finish(controller, audit.owner.botId, audit.materialId, `audit-${index}-finish`);
      }
      await finish(controller, secondOwner.botId, secondMaterial.material.material_id, 'second-finish');
      await finish(controller, replacement.botId, adoptedMaterial.material.material_id, 'adopt-finish');
    },
  });
  assert.equal(report.businessFailure, null, JSON.stringify(report.businessFailure)); assert.equal(report.cleanupFailure, null);
  assert.equal(report.result.completion, 'all-tasks-terminal'); assert.equal(report.cleanup.cleanup, 'complete');
  assert.ok(report.cleanup.bots.every(row => row.execution === 'stopped' && row.cleanup === 'complete'));
  const idle = report.result.bots.filter(row => ![firstOwner.botId, secondOwner.botId, replacement.botId, ...audits.map(audit => audit.owner.botId)].includes(row.botId));
  assert.equal(idle.length, capacity - 1, 'Each completed owner can refill its Slot while another Task remains active');
  for (const bot of idle) {
    assert.equal(stores.tasks.getBot(bot.botId).execution_id, null);
    assert.equal(stores.tasks.getBot(bot.botId).state, 'CLOSED');
    assert.equal(bot.released, true); assert.equal(bot.lastStop.execution, 'stopped'); assert.equal(bot.lastStop.cleanup, 'complete');
  }
  for (const [index, audit] of audits.entries()) {
    assert.equal(stores.tasks.getTask(audit.task.task_id).state, 'DONE');
    assert.equal(stores.tasks.getExecution(audit.executionId).state, 'SUCCEEDED');
    const material = stores.context.getMaterial(audit.materialId);
    assert.equal(material.producer_bot_id, audit.owner.botId);
    assert.equal(material.producer_task_id, audit.task.task_id);
    assert.equal(material.producer_execution_id, audit.executionId);
    assert.equal(material.content, index === 0 ? 'Material audit: Checked public result λ\n' : 'Binary audit: AP9BCg==\n');
  }
  for (const task of [stores.task, secondTask, adoptedTask]) assert.equal(stores.tasks.getTask(task.task_id).state, 'DONE');
  assert.equal(stores.tasks.getExecution(firstExecution).state, 'SUCCEEDED');
  assert.equal(captures.length, 2); assert.equal(new Set(captures.map(row => row.botId)).size, 2);
  assert.equal(stores.context.getMaterial(publications[2]).content, 'Include the fixed feedback evidence.');
  assert.equal(stores.context.getMaterial(publications[1]).content, 'Adopted: Checked public result λ\nBinary: AP9BCg==\n');
  const revision = await stores.workspace.exportRevision({ workspaceId: stores.workspaceId, revision: firstRevision });
  assert.deepEqual(Buffer.from(revision.files['binary.dat']), Buffer.from([0, 255, 65, 10]));
  assert.equal(Buffer.from(revision.files['result.txt']).toString(), 'Checked public result λ\n');
  const savedReport = JSON.parse(await readFile(report.reportPath, 'utf8'));
  assert.ok(savedReport.result.inputs.some(row => row.source === 'user' && row.requestId === 'fixed-feedback' && row.botId === secondOwner.botId));
});
