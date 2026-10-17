#!/usr/bin/env node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createScriptFixtureEnvironment, ScriptExecutor, runRealAgentPath } from '../src/index.js';

const args = new Set(process.argv.slice(2));
const keep = args.has('--keep');
const realAgent = args.has('--real-agent');
const fixturePath = resolve('fixtures/putnam-1966-a1/fixture-manifest.json');
const fixtureManifest = JSON.parse(await readFile(fixturePath, 'utf8'));
const rootDir = await mkdtemp(join(tmpdir(), 'swarmenv-mvp-'));
let report;

try {
  if (realAgent) {
    report = await runRealAgentPath({ rootDir, fixtureManifest });
  } else {
    const environment = createScriptFixtureEnvironment({
      rootDir,
      fixtureManifest,
      checker: async ({ candidate }) => candidate.content.includes('this_is_not_a_proof')
        ? { verdict: 'FAIL', evidence: { exit_code: 1, stdout: '', stderr: 'type mismatch', diagnostic: 'deterministic script failure' } }
        : { verdict: 'PASS', evidence: { exit_code: 0, stdout: 'compiled', stderr: '', diagnostic: 'deterministic script success' } },
    });
    try {
      report = await new ScriptExecutor({ environment, fixtureManifest }).run();
    } finally {
      environment.taskService.close();
    }
  }
  if (keep) report.workspace_root = rootDir;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.completed === false || ['BLOCKED', 'FAILED_TO_LAUNCH'].includes(report.status)) process.exitCode = 1;
} finally {
  if (!keep) await rm(rootDir, { recursive: true, force: true });
}
