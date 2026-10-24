import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createScriptFixtureEnvironment,
  ScriptExecutor,
  probeRealAgentConfig,
  summarizeFeedbackTrace,
} from '../src/index.js';

async function fixtureManifest() {
  return JSON.parse(await readFile(resolve('fixtures/putnam-1966-a1/fixture-manifest.json'), 'utf8'));
}

test('ScriptExecutor runs the locked root proof golden path through FAIL, recovery, and PASS', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'swarmenv-e2e-'));
  const fixture = await fixtureManifest();
  const environment = createScriptFixtureEnvironment({
    rootDir,
    fixtureManifest: fixture,
    checker: async ({ candidate }) => candidate.content.includes('this_is_not_a_proof')
      ? { verdict: 'FAIL', evidence: { exit_code: 1, stderr: 'type mismatch', diagnostic: 'deterministic script failure' } }
      : { verdict: 'PASS', evidence: { exit_code: 0, stdout: 'compiled', diagnostic: 'deterministic script success' } },
  });
  try {
    const report = await new ScriptExecutor({ environment, fixtureManifest: fixture }).run();
    assert.equal(report.completed, true);
    assert.equal(report.task.state, 'SATISFIED');
    assert.equal(report.execution.state, 'SUCCEEDED');
    assert.deepEqual(report.check_results.map((result) => result.verdict), ['FAIL', 'PASS']);
    assert.deepEqual(report.check_results.map((result) => result.status), ['APPLIED', 'APPLIED']);
    assert.equal(report.failure_evidence.exit_code, 1);
    assert.equal(report.materials.length, 2);
    assert.equal(report.materials[0].kind, 'artifact');
    assert.equal(report.materials[1].supersedes, report.materials[0].material_id);
    assert.equal(report.materials[0].source_execution, report.execution_id);
    assert.equal(report.materials[1].source_execution, report.execution_id);
    assert.equal(report.workspace.same_lineage, true);
    assert.equal(report.workspace.first_wait, report.workspace.second_wait);
    assert.equal(report.checkpoints.length, 2);
    assert.equal(report.process_sessions, 2);
  assert.equal(report.workspace.input_snapshot_hash, report.check_results[0].input_snapshot_hash);
  assert.equal(report.workspace.input_snapshot_hash, report.check_results[1].input_snapshot_hash);
    assert.equal(environment.taskService.listActiveExecutions().length, 0);
    assert.equal(environment.taskService.db.prepare('SELECT COUNT(*) AS count FROM executions WHERE task_id = ?').get(report.task_id).count, 1);
  } finally {
    environment.taskService.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('real-agent probe reports missing local configuration without exposing secrets', async () => {
  const probe = await probeRealAgentConfig({ env: {} });
  assert.equal(probe.status, 'BLOCKED');
  assert.deepEqual(probe.missing, [
    'NUROUTER_PI_PROVIDER', 'NUROUTER_PI_MODEL',
  ]);
  assert.equal(probe.secret_values_recorded, false);
});

test('real-agent probe rejects conflicting OpenAI route selectors before launch', async () => {
  const probe = await probeRealAgentConfig({
    env: {
      NUROUTER_PI_PROVIDER: 'openai',
      NUROUTER_PI_MODEL: 'gpt-6.1-sol',
      NUROUTER_PI_ACCOUNT: '1',
      NUROUTER_PI_GROUP: 'research',
    },
  });
  assert.equal(probe.status, 'BLOCKED');
  assert.ok(probe.blockers.some((reason) => reason.includes('both account and group')));
  assert.equal(probe.secret_values_recorded, false);
});

test('real-agent feedback trace proves the revision submission follows the delivered source failure', () => {
  const trace = summarizeFeedbackTrace([
    { type: 'tool_call', toolName: 'swarmenv_submit_candidate', args: { candidate_material_id: 'candidate-1' } },
    { type: 'tool_result', toolName: 'swarmenv_submit_candidate', result: { check_result: { check_result_id: 'check-1', result_class: 'source_failure', checker_process_status: 'completed' } } },
    { type: 'tool_call', toolName: 'swarmenv_publish_material', args: { scope: 'proof_relevant' } },
    { type: 'tool_call', toolName: 'swarmenv_submit_candidate', args: { candidate_material_id: 'candidate-2' } },
  ]);
  assert.equal(trace.first_source_failure_result_delivered, true);
  assert.equal(trace.revision_submission_after_feedback, true);
  assert.ok(trace.revision_submission_event_index > trace.first_failure_event_index);
});
