import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { TaskService } from '../src/task/task-service.js';
import { MissionWorkspace } from '../src/runtime/mission-workspace.js';
import { MissionSubmissionStore } from '../src/runtime/mission-submission.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../scripts/review-mission.js', import.meta.url));
const identity = { checker_ref: 'manual-operator', checker_version: 'review-1', environment_ref: 'owner-review' };
const input = { missionId: 'mission', workspaceId: 'workspace', actorRef: 'agent:author', materialIds: [], requestId: 'submission' };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'replay-manual-review-'));
  const source = join(directory, 'source.sqlite');
  // WAL sidecars inherit the private main-file mode required by the owner CLI.
  await writeFile(source, '', { mode: 0o600 });
  const tasks = new TaskService(source);
  tasks.createMission({ mission_id: input.missionId, goal: 'Prove a fixed claim' });
  const workspace = new MissionWorkspace({ rootDir: join(directory, 'workspaces') });
  await workspace.create({ missionId: input.missionId, workspaceId: input.workspaceId, initialFiles: { proof: 'fixed candidate' } });
  const store = new MissionSubmissionStore({ database: tasks.db, workspace,
    authorize: () => ({ acceptance: { required_check: identity } }), validateCompletion: () => true,
    manualReview: { checkerVersion: identity.checker_version, environmentRef: identity.environment_ref, timeoutMs: 10_000 } });
  let closed = false;
  const close = async () => {
    if (closed) return;
    await store.shutdown(); tasks.close(); closed = true;
  };
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  const submitted = await store.submit(input);
  const run = async (command, ...args) => JSON.parse((await exec(process.execPath,
    [cli, command, source, input.missionId, input.requestId, ...args])).stdout);
  return { tasks, store, submitted, run, close, source };
}

test('manual review from a separate writer is absent before its commit and present afterwards', async t => {
  const { tasks, store, submitted, run } = await fixture(t);
  assert.ok(tasks.db.prepare("SELECT 1 FROM replay_tables WHERE table_name = 'mission_manual_reviews'").get());
  assert.equal(tasks.db.prepare("SELECT COUNT(*) AS n FROM replay_events WHERE table_name = 'mission_manual_reviews'").get().n, 0);
  await delay(5);
  const beforeDecision = new Date().toISOString();
  await delay(5);
  const decision = await run('decide', submitted.snapshot_fingerprint, 'PASS', 'review', 'Verified the final argument');
  await store.waitForIdle();
  assert.equal((await store.get({ missionId: input.missionId, submissionId: input.requestId })).state, 'accepted');
  await store.shutdown();
  const committed = tasks.db.prepare(`SELECT e.transaction_id, t.committed_at FROM replay_events e
    JOIN replay_transactions t USING (transaction_id) WHERE e.table_name = 'mission_manual_reviews'`).get();
  assert.ok(committed?.transaction_id, 'the independent writer must record the decision transaction');
  assert.ok(Date.parse(committed.committed_at) > Date.parse(beforeDecision));

  const history = tasks.db.prepare("SELECT before_json, after_json FROM replay_events WHERE table_name = 'mission_manual_reviews'").all();
  assert.equal(history.length, 1);
  assert.equal(history[0].before_json, null);
  assert.deepEqual(JSON.parse(JSON.parse(history[0].after_json).document[1]), decision);
  assert.deepEqual(tasks.db.prepare('SELECT document FROM mission_manual_reviews').all().map(row => JSON.parse(row.document)), [decision]);
});

test('review CLI show stays read-only while decide installs capture on an unjournaled database', async t => {
  const { submitted, run, close, source } = await fixture(t);
  await close();
  // Prepare an unjournaled owner-local file independently of the live service.
  const setup = new DatabaseSync(source);
  const objects = setup.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'table')").all();
  const quote = value => `"${value.replaceAll('"', '""')}"`;
  for (const object of objects.filter(row => row.type === 'trigger' && row.name.startsWith('replay_capture_'))) setup.exec(`DROP TRIGGER ${quote(object.name)}`);
  for (const object of objects.filter(row => row.type === 'table' && row.name.startsWith('replay_'))) setup.exec(`DROP TABLE ${quote(object.name)}`);
  setup.close();
  const shown = await run('show');
  assert.equal(shown.snapshot_fingerprint, submitted.snapshot_fingerprint);
  const before = new DatabaseSync(source, { readOnly: true });
  assert.equal(before.prepare("SELECT 1 FROM sqlite_master WHERE name = 'replay_tables'").get(), undefined);
  before.close();
  const decision = await run('decide', submitted.snapshot_fingerprint, 'PASS', 'review', 'An owner-local audit decision');
  const after = new DatabaseSync(source, { readOnly: true });
  try {
    assert.equal(after.prepare("SELECT domain FROM replay_domains WHERE domain = 'task'").get().domain, 'task');
    const event = after.prepare(`SELECT e.before_json, e.after_json, t.committed_at FROM replay_events e
      JOIN replay_transactions t USING (transaction_id) WHERE e.table_name = 'mission_manual_reviews'`).get();
    assert.equal(event.before_json, null);
    assert.deepEqual(JSON.parse(JSON.parse(event.after_json).document[1]), decision);
    assert.ok(Number.isFinite(Date.parse(event.committed_at)));
  } finally { after.close(); }
});
