import assert from 'node:assert/strict';
import { access, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runBenchmarkProject, writeUnavailableProjectReport } from '../src/benchmark/putnam-runner.js';

const problem = { id: 'resume_fixture' };

async function paths(t) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-resume-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const originalReport = join(source, 'reports', problem.id, 'report.json');
  await mkdir(join(source, 'reports', problem.id), { recursive: true });
  await writeFile(originalReport, 'original report');
  return { root, source, originalReport, experimentDir: join(root, 'new-run') };
}

test('resume runner rejects a source report directory before preflight and fallback reporting', async t => {
  const f = await paths(t);
  const options = { resumeFrom: f.source, resumeAt: '2026-11-19T12:00:00Z',
    experimentDir: f.experimentDir, reportDir: join(f.source, 'reports') };
  await assert.rejects(runBenchmarkProject(problem, {}, options), { code: 'REPLAY_DESTINATION_CONFLICT' });
  await assert.rejects(writeUnavailableProjectReport(problem, options, new Error('preflight failed')),
    { code: 'REPLAY_DESTINATION_CONFLICT' });
  assert.equal(await readFile(f.originalReport, 'utf8'), 'original report');
  await assert.rejects(access(f.experimentDir), { code: 'ENOENT' });
});

test('resume runner rejects a hardlinked report below an otherwise separate directory', async t => {
  const f = await paths(t);
  const reportDir = join(f.root, 'reports');
  await mkdir(join(reportDir, problem.id), { recursive: true });
  await link(f.originalReport, join(reportDir, problem.id, 'report.json'));
  const options = { resumeFrom: f.source, resumeAt: '2026-11-19T12:00:00Z',
    experimentDir: f.experimentDir, reportDir };
  await assert.rejects(runBenchmarkProject(problem, {}, options), { code: 'REPLAY_DESTINATION_CONFLICT' });
  await assert.rejects(writeUnavailableProjectReport(problem, options, new Error('preflight failed')),
    { code: 'REPLAY_DESTINATION_CONFLICT' });
  assert.equal(await readFile(f.originalReport, 'utf8'), 'original report');
});

test('resume runner requires fresh private project directories before fixture preflight', async t => {
  const f = await paths(t);
  const logs = join(f.experimentDir, 'logs', 'projects', problem.id);
  await mkdir(logs, { recursive: true });
  const sentinel = join(logs, 'previous.ndjson');
  await writeFile(sentinel, 'previous run');
  await assert.rejects(runBenchmarkProject(problem, {}, { resumeFrom: f.source, resumeAt: '2026-11-19T12:00:00Z',
    experimentDir: f.experimentDir }), { code: 'REPLAY_DESTINATION_CONFLICT' });
  assert.equal(await readFile(sentinel, 'utf8'), 'previous run');
});

test('resume fallback protects its default report path after operator stop', async t => {
  const f = await paths(t);
  await mkdir(join(f.experimentDir, problem.id), { recursive: true });
  await symlink(f.originalReport, join(f.experimentDir, problem.id, 'report.json'));
  await assert.rejects(writeUnavailableProjectReport(problem, { resumeFrom: f.source,
    experimentDir: f.experimentDir }, new Error('operator stop'), { operatorStopped: true }),
  { code: 'REPLAY_DESTINATION_CONFLICT' });
  assert.equal(await readFile(f.originalReport, 'utf8'), 'original report');
});
