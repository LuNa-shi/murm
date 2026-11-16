import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadBenchmarkConfig } from '../src/benchmark/putnam-runner.js';
import { readBenchmarkContext } from '../src/benchmark/benchmark-context.js';
import { createLockedFinalTreeVerifier } from '../src/judge/final-tree-deployment.js';
import { stableStringify } from '../src/protocol/envelope.js';

const [configPath, fixtureRoot, problemId, witnessDirectory, visibilityPath, outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error('Usage: node scripts/validate-benchmark-witness.mjs <deployment.json> <fixture-root> <problem-id> <private-witness-dir> <visibility-audit.json> <new-receipt.json>');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const config = await loadBenchmarkConfig(configPath, { putnamBenchRoot: fixtureRoot, verifyPinnedCheckout: true });
const problem = config.problems.find(item => item.id === problemId);
if (!problem) throw new Error('Unknown benchmark problem');
await readBenchmarkContext(problem, config);
const auditBytes = await readFile(visibilityPath);
const audit = JSON.parse(auditBytes);
if (audit.verdict !== 'PASS' || audit.target_sha256 !== problem.source_hash || audit.context_sha256 !== problem.context_sha256 ||
    audit.initial_compilation !== true || audit.statement_identity !== true || audit.visibility_audit !== true) {
  throw new Error('Visibility/initial-state audit must attest this exact target and public context');
}
const root = await realpath(resolve(witnessDirectory));
const files = {};
let total = 0;
async function visit(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) throw new Error('Witness contains hidden state or a symlink');
    const path = prefix + entry.name;
    if (entry.isDirectory()) await visit(join(directory, entry.name), path + '/');
    else if (entry.isFile() && path.endsWith('.lean')) {
      const bytes = await readFile(join(directory, entry.name));
      total += bytes.length;
      if (bytes.length > 2 * 1024 * 1024 || total > 16 * 1024 * 1024) throw new Error('Witness exceeds the submitted Workspace byte limits');
      files[path] = bytes;
    }
  }
}
await visit(root);
if (!Object.hasOwn(files, problem.problem_file)) throw new Error('Witness lacks the actual target path');
const manifest = Object.fromEntries(Object.keys(files).sort().map(path => [path, { sha256: hash(files[path]), bytes: files[path].length }]));
const tree = hash(stableStringify(manifest));
const { adapter, evidence } = await createLockedFinalTreeVerifier({ configuration: config.final_tree_checker, problem });
const result = await adapter.check({ files, tree: `sha256:${tree}` });
if (result.verdict !== 'PASS' || result.checked_tree !== `sha256:${tree}`) {
  // A failure is diagnostic output, never a launch-enabling certificate.
  process.stderr.write(JSON.stringify({ result, checker_lock_sha256: evidence.artifact_lock_sha256 }) + '\n');
  process.exitCode = 1;
} else {
  const receipt = { version: 1, scope: 'complete-target', verdict: 'PASS', initial_compilation: true,
    statement_identity: true, visibility_audit: true, target_sha256: problem.source_hash,
    context_sha256: problem.context_sha256, checker_lock_sha256: evidence.artifact_lock_sha256,
    witness_tree_sha256: tree, check_result: result, visibility_receipt_sha256: hash(auditBytes),
    witness_file_count: Object.keys(files).length, witness_bytes: total };
  await writeFile(outputPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ verdict: 'PASS', receipt_sha256: hash(await readFile(outputPath)), check_result_id: result.check_result_id }) + '\n');
}
