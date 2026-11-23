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
import { dropReplayHistory, restoreServiceDatabaseAt } from '../src/replay/service-history.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../scripts/review-mission.mjs', import.meta.url));
const identity = { checker_ref: 'manual-operator', checker_version: 'review-1', environment_ref: 'owner-review' };
const input = { missionId: 'mission', workspaceId: 'workspace', actorRef: 'bot:author', materialIds: [], requestId: 'submission' };

async function fixture(t, { legacy = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'replay-manual-review-'));
  const source = join(directory, 'source.sqlite');
  // WAL sidecars inherit the private main-file mode required by the owner CLI.
  await writeFile(source, '', { mode: 0o600 });
  const tasks = new TaskService(source);
  if (legacy) dropReplayHistory(tasks.db);
  tasks.createMission({ mission_id: input.missionId, goal: 'Prove a fixed claim' });
  const workspace = new MissionWorkspace({ rootDir: join(directory, 'workspaces') });
  await workspace.create({ missionId: input.missionId, workspaceId: input.workspaceId, initialFiles: { proof: 'fixed candidate' } });
  const store = new MissionSubmissionStore({ database: tasks.db, workspace,
    authorize: () => ({ acceptance: { required_check: identity } }), validateCompletion: () => true,
    manualReview: { checkerVersion: identity.checker_version, environmentRef: identity.environment_ref, timeoutMs: 10_000 } });
  t.after(async () => { await store.shutdown(); tasks.close(); await rm(directory, { recursive: true, force: true }); });
  const submitted = await store.submit(input);
  const run = async (command, ...args) => JSON.parse((await exec(process.execPath,
    [cli, command, source, input.missionId, input.requestId, ...args])).stdout);
  const restore = async (name, at) => {
    const destination = join(directory, `${name}.sqlite`);
    const history = await restoreServiceDatabaseAt({ sourcePath: source, destinationPath: destination, domain: 'task', at });
    const db = new DatabaseSync(destination, { readOnly: true });
    try {
      return { history, submission: JSON.parse(db.prepare('SELECT document FROM mission_submissions').get().document),
        reviews: db.prepare('SELECT document FROM mission_manual_reviews').all().map(row => JSON.parse(row.document)) };
    } finally { db.close(); }
  };
  return { tasks, store, submitted, run, restore };
}

test('manual review from a separate writer is absent before its commit and present afterwards', async t => {
  const { tasks, store, submitted, run, restore } = await fixture(t);
  assert.ok(tasks.db.prepare("SELECT 1 FROM replay_tables WHERE table_name = 'mission_manual_reviews'").get());
  await delay(5);
  const beforeDecision = new Date().toISOString();
  await delay(5);
  const decision = await run('decide', submitted.snapshot_fingerprint, 'PASS', 'review', 'Verified the final argument');
  await store.waitForIdle();
  assert.equal((await store.get({ missionId: input.missionId, submissionId: input.requestId })).state, 'accepted');
  await store.shutdown();
  const afterDecision = new Date().toISOString();
  const committed = tasks.db.prepare(`SELECT e.transaction_id, t.committed_at FROM replay_events e
    JOIN replay_transactions t USING (transaction_id) WHERE e.table_name = 'mission_manual_reviews'`).get();
  assert.ok(committed?.transaction_id, 'the independent writer must record the decision transaction');
  assert.ok(Date.parse(committed.committed_at) > Date.parse(beforeDecision));

  const before = await restore('before', beforeDecision);
  assert.equal(before.history.mode, 'journal');
  assert.equal(before.submission.state, 'pending');
  assert.deepEqual(before.reviews, []);
  const after = await restore('after', afterDecision);
  assert.equal(after.history.mode, 'journal');
  assert.equal(after.submission.state, 'accepted');
  assert.deepEqual(after.reviews, [decision]);
});

test('review CLI starts capture on an unjournaled database without claiming earlier coverage', async t => {
  const { tasks, store, submitted, run, restore } = await fixture(t, { legacy: true });
  const shown = await run('show');
  assert.equal(shown.snapshot_fingerprint, submitted.snapshot_fingerprint);
  assert.equal(tasks.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'replay_tables'").get(), undefined,
    'read-only review must not install history');
  await delay(5);
  const beforeDecision = new Date().toISOString();
  await delay(5);
  await run('decide', submitted.snapshot_fingerprint, 'PASS', 'review', 'A later manual result');
  await store.waitForIdle();
  await store.shutdown();
  await assert.rejects(restore('before-capture', beforeDecision), { code: 'REPLAY_HISTORY_MISSING' });
  const after = await restore('after-capture', new Date().toISOString());
  assert.equal(after.history.mode, 'journal');
  assert.equal(after.submission.state, 'accepted');
  assert.equal(after.reviews.length, 1);
});
