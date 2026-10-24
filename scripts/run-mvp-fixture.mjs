#!/usr/bin/env node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createScriptFixtureEnvironment, ScriptExecutor, runRealAgentPath } from '../src/index.js';

const args = new Set(process.argv.slice(2));
const keep = args.has('--keep');
const realAgent = args.has('--real-agent');

async function loadDotEnv(path = '.env') {
  try {
    const content = await readFile(path, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator < 1) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

await loadDotEnv();
const fixturePath = resolve('fixtures/putnam-1966-a1/fixture-manifest.json');
const fixtureManifest = JSON.parse(await readFile(fixturePath, 'utf8'));
const [firstCandidate, fixedCandidate] = await Promise.all([
  readFile(resolve('fixtures/putnam-1966-a1/invalid-candidate.lean'), 'utf8'),
  readFile(resolve('fixtures/putnam-1966-a1/valid-candidate.lean'), 'utf8'),
]);

function controlledRealAgentFailure(source) {
  // Keep the first real-Agent submission close to a valid proof so the
  // acceptance run tests diagnostic consumption and repair, rather than
  // asking the model to reconstruct the entire fixture from a placeholder.
  // Replacing the first `ring` with `rfl` is a genuine Lean source failure
  // whose location and message are returned by submit_candidate.
  const marker = '    ring';
  const offset = source.indexOf(marker);
  if (offset < 0) throw new Error('valid fixture has no controlled ring failure marker');
  return `${source.slice(0, offset)}    rfl${source.slice(offset + marker.length)}`;
}

const rootDir = await mkdtemp(join(tmpdir(), 'swarmenv-mvp-'));
let report;

try {
  if (realAgent) {
    report = await runRealAgentPath({
      rootDir,
      fixtureManifest,
      firstCandidate: controlledRealAgentFailure(fixedCandidate),
    });
  } else {
    const environment = createScriptFixtureEnvironment({
      rootDir,
      fixtureManifest,
      checker: async ({ candidate }) => candidate.content.includes('this_is_not_a_proof')
        ? { verdict: 'FAIL', evidence: { exit_code: 1, stdout: '', stderr: 'type mismatch', diagnostic: 'deterministic script failure' } }
        : { verdict: 'PASS', evidence: { exit_code: 0, stdout: 'compiled', stderr: '', diagnostic: 'deterministic script success' } },
    });
    try {
      report = await new ScriptExecutor({ environment, fixtureManifest, firstCandidate, fixedCandidate }).run();
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
