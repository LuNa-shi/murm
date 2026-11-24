import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LeanChecker } from '../src/judge/lean-adapter.js';
import { agentCheckResult, normalizeCheckerResult } from '../src/judge/check-result.js';
import { LeanFinalTreeVerifier } from '../src/judge/lean-final-tree-verifier.js';

const comparatorRoot = process.env.SWARMENV_TEST_COMPARATOR_ROOT;
const leanRoot = process.env.SWARMENV_TEST_LEAN_ROOT;
const identity = { checker_ref: 'lean-final-tree', checker_version: 'test', environment_ref: 'lean-test' };

function fixture(fixtureSource = 'theorem toy : True := by sorry\n', options = {}) {
  const exporter = join(comparatorRoot ?? '/unused', '.lake/packages/lean4export/.lake/build');
  return new LeanFinalTreeVerifier({
    identity, allowUnboundedDiagnostics: !process.env.SWARMENV_TEST_CHECKER_CGROUP, leanRoot: leanRoot ?? '/unused', comparatorLibraryRoots: [
      join(comparatorRoot ?? '/unused', '.lake/build/lib/lean'), join(exporter, 'lib/lean'),
    ],
    exporterPath: join(exporter, 'bin/lean4export'), targetPath: 'Toy.lean', declarationName: 'toy',
    fixtureSource, fixtureSha256: createHash('sha256').update(fixtureSource).digest('hex'), ...options,
  });
}

test('final-tree verifier fixes the source identity and rejects missing source before dispatch', async () => {
  assert.throws(() => fixture('theorem toy : True := trivial', { fixtureSha256: 'wrong' }), /locked fixture hash/);
  const missing = await fixture().check({ files: {}, tree: 'fixed-tree' });
  assert.equal(missing.verdict, 'FAIL');
  assert.equal(missing.checked_tree, 'fixed-tree');
});

const lean = { skip: !leanRoot || !comparatorRoot };

test('locked project forwards configured build concurrency and preserves final checking', lean, async () => {
  const verifier = fixture(undefined, { projectChecks: true, projectJobs: 4,
    resources: { memory_bytes: 8 * 1024 ** 3, cpu_percent: 400 } });
  const result = await verifier.check({ files: {
    'Toy.lean': 'import Helper\ntheorem toy : True := helper\n',
    'Helper.lean': 'def checkBuildThreads : IO Unit := do\n  unless (← IO.getEnv "LEAN_NUM_THREADS") == some "4" do\n    throw (IO.userError "build concurrency not propagated")\n#eval checkBuildThreads\ntheorem helper : True := trivial\n',
  }, tree: 'configured-project-build' });
  assert.equal(result.verdict, 'PASS', result.diagnostic);
  assert.throws(() => fixture(undefined, { projectJobs: 0 }), /build concurrency/);
  assert.throws(() => fixture(undefined, { resources: { memory_bytes: -1 } }), /Checker resources/);
});

test('complete-project policy rejects a hole in an unused helper before final dispatch', async () => {
  const verifier = fixture(undefined, { projectChecks: true, requireCompleteProject: true });
  for (const { source, line, word } of [
    { source: 'def marker := r#"\\" -- /-"#\n/- An axiom in prose. -/\ntheorem later : True := by sorry\n', line: 3, word: 'sorry' },
    { source: '/- An axiom in prose. -/\naxiom invented : True\n', line: 2, word: 'axiom' },
    { source: 'def marker : String := s! "{("--", (by sorry : Nat)).1}"\n', line: 1, word: 'sorry' },
  ]) {
    const result = await verifier.check({ files: {
      'Toy.lean': 'theorem toy : True := by trivial\n',
      'Unused.lean': source,
    }, tree: 'unfinished-project' });
    assert.equal(result.verdict, 'FAIL');
    assert.match(result.diagnostic, new RegExp(`Unused\\.lean:${line}:\\d+:.*${word}`));
  }
});

test('complete-project policy accepts Lean comments and still checks the original proof', lean, async () => {
  const verifier = fixture(undefined, { projectChecks: true, requireCompleteProject: true });
  const result = await verifier.check({ files: {
    'Toy.lean': 'import Helper\n/-- The proof uses no axiom. -/\ntheorem toy : True := helper -- no sorry\n',
    'Helper.lean': 'def marker := s!"proof"\n/- No admit. /- Nested sorryAx. -/ -/\ntheorem helper : True := trivial\n',
  }, tree: 'commented-proof' });
  assert.equal(result.verdict, 'PASS', result.diagnostic);
});

test('root-only final checking accepts a new definition and helper import but rejects a changed goal', lean, async () => {
  const verifier = fixture('theorem toy (n : Nat) : n = n := by sorry\n',
    { projectChecks: true, requireCompleteProject: true });
  const files = {
    'Toy.lean': 'import Research.Helpers\ntheorem toy (n : Nat) : n = n := by exact helper n\n',
    'Research/Helpers.lean': 'def identityNat (n : Nat) : Nat := n\ntheorem helper (n : Nat) : identityNat n = n := by rfl\n',
  };
  const accepted = await verifier.check({ files, tree: 'new-definitions-and-import' });
  assert.equal(accepted.verdict, 'PASS', accepted.diagnostic);
  const changed = await verifier.check({ files: { ...files,
    'Toy.lean': 'import Research.Helpers\ntheorem toy (n : Nat) (h : False) : n = n := by exact helper n\n',
  }, tree: 'extra-hypothesis' });
  assert.equal(changed.verdict, 'FAIL', changed.diagnostic);
  const hidden = await verifier.check({ files: { ...files,
    'Toy.lean': 'import P2M.Sol.Hidden\ntheorem toy (n : Nat) : n = n := by rfl\n',
  }, tree: 'hidden-library' });
  assert.equal(hidden.verdict, 'FAIL', hidden.diagnostic);
});

test('production locked source diagnostics compile the full Mathlib import', {
  skip: !leanRoot || !process.env.SWARMENV_TEST_PUTNAM_ROOT || !process.env.SWARMENV_TEST_CHECKER_CGROUP,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarmenv-mathlib-diagnostic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source.lean');
  const root = process.env.SWARMENV_TEST_PUTNAM_ROOT;
  const libraryRoots = ['batteries', 'Qq', 'aesop', 'proofwidgets', 'importGraph', 'LeanSearchClient', 'plausible', 'mathlib']
    .map(pkg => join(root, '.lake/packages', pkg, '.lake/build/lib/lean'));
  const verifier = fixture(undefined, { libraryRoots, allowUnboundedDiagnostics: false });
  const limits = { timeoutMs: 120000, maxOutputBytes: 10000 };
  await writeFile(source, 'import Mathlib\nexample : True := by trivial\n');
  const valid = await verifier.runSourceDiagnostic('lake', ['env', 'lean', source], limits);
  assert.equal(valid.exit_code, 0, JSON.stringify(valid));
  await writeFile(source, 'import Mathlib\nexample : True := (0 : Nat)\n');
  const invalid = await verifier.runSourceDiagnostic('lake', ['env', 'lean', source], limits);
  assert.equal(invalid.exit_code, 1, JSON.stringify(invalid));
  assert.match(invalid.stdout, /\/input\/WorkspaceSource\.lean:\d+:\d+: error/);
});

test('locked source diagnostics use bounded Lean without host private files or environment', { skip: !leanRoot }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarmenv-locked-diagnostic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privatePath = join(directory, 'private.txt');
  const source = join(directory, 'proof.lean');
  await writeFile(privatePath, 'operator-local\n');
  await writeFile(source, `import Lean
def verifyIsolation : IO Unit := do
  if (← IO.getEnv "SWARMENV_DIAGNOSTIC_TEST_SECRET").isSome then
    throw (IO.userError "inherited host environment")
  if (← (System.FilePath.mk ${JSON.stringify(privatePath)}).pathExists) then
    throw (IO.userError "host file visible")
  let writable ← try
    IO.FS.writeFile "/input/WorkspaceSource.lean" "changed"
    pure true
  catch _ => pure false
  if writable then throw (IO.userError "input was writable")
#eval verifyIsolation
theorem toy : True := trivial
`);
  const verifier = fixture();
  const limits = { timeoutMs: 10000, maxOutputBytes: 10000 };
  const before = await readFile(source);
  process.env.SWARMENV_DIAGNOSTIC_TEST_SECRET = 'present-in-controller';
  try {
    const version = await verifier.runSourceDiagnostic('lake', ['env', 'lean', '--version'], limits);
    assert.match(version.stdout ?? '', /Lean \(version/);
    const valid = await verifier.runSourceDiagnostic('lake', ['env', 'lean', source], limits);
    assert.equal(valid.exit_code, 0, JSON.stringify(valid));
    assert.deepEqual(await readFile(source), before);
    assert.equal(await readFile(privatePath, 'utf8'), 'operator-local\n');
    await writeFile(source, 'theorem toy : True := 0\n');
    const invalid = await verifier.runSourceDiagnostic('lake', ['env', 'lean', source], limits);
    assert.equal(invalid.exit_code, 1, JSON.stringify(invalid));
  } finally {
    delete process.env.SWARMENV_DIAGNOSTIC_TEST_SECRET;
  }
});
test('real isolated Lean requires the locked named theorem and rejects transitive axioms', lean, async () => {
  const verifier = fixture();
  const check = async source => (await verifier.check({ files: { 'Toy.lean': source }, tree: 'fixed' })).verdict;
  assert.equal(await check('theorem toy : True := True.intro\n'), 'PASS');
  assert.equal(await check('theorem renamed : True := True.intro\n'), 'FAIL');
  assert.equal(await check('theorem toy : Nat := 0\n'), 'FAIL');
  assert.equal(await check('theorem toy : True := 0\n'), 'FAIL');
  assert.equal(await check('theorem toy : 1 = 1 := rfl\n'), 'FAIL');
  assert.equal(await check('theorem toy : True := by sorry\n'), 'FAIL');
  assert.equal(await check('axiom invented : True\ntheorem helper : True := invented\ntheorem toy : True := helper\n'), 'FAIL');
  assert.equal(await check('#eval IO.println "SWARMENV_FINAL_TREE_VERIFIED"\ntheorem toy : True := by sorry\n'), 'FAIL');
});

test('real isolated Lean uses local modules from the complete tree with trusted build order', lean, async () => {
  const verifier = fixture(undefined, { localModules: [{ name: 'Helpers.Basic', path: 'Helpers/Basic.lean' }] });
  const files = {
    'Toy.lean': 'import Helpers.Basic\ntheorem toy : True := helper\n',
    'Helpers/Basic.lean': 'theorem helper : True := True.intro\n',
    'lakefile.lean': 'this is not an executable Lake project\n',
    '.lake/build/lib/lean/Helpers/Basic.olean': Buffer.from('untrusted binary'),
  };
  assert.equal((await verifier.check({ files, tree: 'complete' })).verdict, 'PASS');
  files['Helpers/Basic.lean'] = 'axiom helper : True\n';
  assert.equal((await verifier.check({ files, tree: 'changed' })).verdict, 'FAIL');
  delete files['Helpers/Basic.lean'];
  assert.equal((await verifier.check({ files, tree: 'missing' })).verdict, 'FAIL');
});

test('Lake project input rejects sources outside the module layout and trusted namespace collisions', async () => {
  const verifier = fixture(undefined, { projectChecks: true, targetPath: 'src/Toy.lean' });
  const files = { 'src/Toy.lean': Buffer.from('theorem toy : True := trivial\n') };
  const startProcess = () => assert.fail('invalid project input must not launch a process');
  for (const path of ['Outside.lean', 'src/Bad.Name.lean', 'src/Mathlib/Shadow.lean']) {
    const result = await verifier.checkProject({ files: { ...files, [path]: 'example : True := trivial\n' }, tree: 'invalid', startProcess });
    assert.equal(result.verdict, 'FAIL');
    assert.ok(result.diagnostic.includes(path));
    assert.deepEqual(result.checked_paths, []);
  }
});

test('Lake diagnostics distinguish source names from late split resource diagnostics and worker exits', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarmenv-project-diagnostic-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = { 'src/Killed.lean': 'theorem toy : True := trivial\n' };
  for (const [name, resourceMessage] of [
    ['source-failure', 'error: Lean exited with code 1'],
    ['out-of-memory', 'error: out of memory'],
    ['killed-worker', 'error: Lean exited with code 137'],
    ['unknown-worker', 'error: Lean exited with code 2'],
    ['heartbeat', 'error: source/Killed.lean:3:1: (deterministic) timeout at `isDefEq`, maximum number of heartbeats (1) has been reached'],
    ['kernel-heartbeat', 'error: source/Killed.lean:3:1: (kernel) deterministic timeout, maximum number of heartbeats (1) has been reached'],
    ['panic', 'error: source/Killed.lean:3:1: PANIC at test: internal checker error'],
    ['recursion-depth', 'error: source/Killed.lean:3:1: maximum recursion depth has been reached'],
    ['nested-recursion', 'error: source/Killed.lean:3:1: Tactic `simp` failed with a nested error:\nmaximum recursion depth has been reached'],
    ['nested-heartbeat', 'error: source/Killed.lean:3:1: Tactic `simp` failed with a nested error:\n(deterministic) timeout at `isDefEq`, maximum number of heartbeats (1) has been reached'],
    ['double-nested', 'error: source/Killed.lean:3:1: Tactic `first` failed with a nested error:\nTactic `simp` failed with a nested error:\nmaximum recursion depth has been reached'],
    ['goal-resource-words', 'error: source/Killed.lean:3:1: unsolved goals\nTactic `simp` failed with a nested error:\nmaximum recursion depth has been reached'],
    ['kernel-memory', 'error: source/Killed.lean:3:1: (kernel) excessive memory consumption detected'],
  ]) {
    const resourceFailure = !['source-failure', 'goal-resource-words'].includes(name);
    const leanLimit = ['heartbeat', 'kernel-heartbeat', 'recursion-depth', 'panic', 'nested-recursion', 'nested-heartbeat', 'double-nested'].includes(name);
    const bubblewrap = join(directory, name);
    await writeFile(bubblewrap, `#!${process.execPath}
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      async function run() {
        if (!process.argv.includes('/project')) {
          process.stdout.write('{}\\n');
          return;
        }
        process.stderr.write('begin ' + 'a'.repeat(24_000) + '\\nerror: source/Killed.le');
        await delay(40);
        process.stderr.write('an:2:1: unsolved goals\\nheartbeats : Nat\\nkilled : True\\n⊢ False\\n');
        if (${JSON.stringify(name)} === 'heartbeat') {
          for (let i = 0; i < 8; i++) process.stderr.write('error: source/Killed.lean:2:1: earlier source error\\n');
        }
        process.stderr.write(${JSON.stringify(resourceMessage.slice(0, -3))});
        await delay(40);
        process.stderr.write(${JSON.stringify(resourceMessage.slice(-3) + '\n')});
        process.exitCode = 21;
      }
      void run();
    `, { mode: 0o700 });
    const verifier = fixture(undefined, { projectChecks: true, targetPath: 'src/Killed.lean', bubblewrap, allowUnboundedDiagnostics: true });
    const checker = new LeanChecker({ projectChecker: verifier.checkProject.bind(verifier) });
    const adapted = normalizeCheckerResult(await checker.checkProject({ files, tree: 'fixed', startProcess: launch => launch() }));
    const feedback = agentCheckResult({ ...adapted, evidence: { ...adapted.evidence, workspace_input: { check_mode: 'lean-project' } } });
    const project = await verifier.checkProject({ files, tree: 'fixed' });
    const final = await verifier.check({ files, tree: 'fixed' });
    for (const result of [project, final]) {
      assert.equal(result.verdict, resourceFailure ? 'ERROR' : 'FAIL', result.diagnostic);
      if (leanLimit) {
        assert.equal(result.diagnostic_code, name === 'panic' ? 'lean_panic' : 'lean_resource_limit');
        assert.equal(feedback.diagnostic_code, result.diagnostic_code);
        assert.equal(feedback.verdict, 'ERROR');
        assert.equal(feedback.mathematical_outcome, 'unassessed');
        assert.equal(feedback.retryable, false);
        assert.equal(feedback.diagnostic_location.file, 'src/Killed.lean');
        assert.equal(result.retryable, false);
        assert.match(result.diagnostic, /src\/Killed\.lean:3:1:/);
      }
      if (['out-of-memory', 'kernel-memory'].includes(name)) assert.equal(result.diagnostic_code, 'checker_memory_limit');
      if (!resourceFailure) {
        assert.match(result.diagnostic, /src\/Killed\.lean:2:1: unsolved goals/);
        if (!['source-failure', 'goal-resource-words'].includes(name)) assert.ok(result.diagnostic.includes(resourceMessage.replace('error: source/', 'src/')));
      }
      assert.doesNotMatch(result.diagnostic, /a{64}/);
    }
  }
});

test('locked raw and JSON Lean diagnostics keep source limits and goal words separate from runtime failures', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarmenv-source-limit-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const messages = [
    '(deterministic) timeout at `isDefEq`, maximum number of heartbeats (1) has been reached',
    '(kernel) deterministic timeout, maximum number of heartbeats (1) has been reached',
    'maximum recursion depth has been reached',
    'Tactic `simp` failed with a nested error:\nmaximum recursion depth has been reached',
    'Tactic `first` failed with a nested error:\nTactic `simp` failed with a nested error:\n(deterministic) timeout at `isDefEq`, maximum number of heartbeats (1) has been reached',
    'unsolved goals\nTactic `simp` failed with a nested error:\nmaximum recursion depth has been reached',
    'unsolved goals\nheartbeats : Nat\nkilled : True\nout_of_memory : True\n⊢ False',
    'PANIC at test: internal checker error',
    'out of memory',
  ];
  for (const [index, message] of messages.entries()) {
    const bubblewrap = join(directory, String(index));
    await writeFile(bubblewrap, `#!${process.execPath}
      const args = process.argv.slice(2);
      if (args.some(arg => arg.includes('/original'))) { process.stdout.write('{}\\n'); }
      else if (args.includes('/bin/sh')) {
        process.stderr.write(${JSON.stringify(JSON.stringify({ severity: 'error', data: message, fileName: 'Toy.lean', pos: { line: 3, column: 1 } }) + '\n')});
        process.exitCode = 21;
      } else {
        process.stdout.write(${JSON.stringify('/input/WorkspaceSource.lean:3:1: error: ' + message + '\n')});
        process.exitCode = 1;
      }
    `, { mode: 0o700 });
    const verifier = fixture(undefined, { bubblewrap, allowUnboundedDiagnostics: true });
    const raw = await verifier.runSourceDiagnostic('lake', ['env', 'lean', '/unused/source.lean'],
      { timeoutMs: 5000, maxOutputBytes: 10000 });
    const final = await verifier.check({ files: { 'Toy.lean': 'theorem toy : True := trivial' }, tree: 'fixed' });
    const failedCheck = !message.startsWith('unsolved goals');
    assert.equal(raw.exit_code, 1, JSON.stringify(raw));
    assert.ok(raw.stdout.includes(message));
    assert.equal(final.verdict, failedCheck ? 'ERROR' : 'FAIL', final.diagnostic);
    if (failedCheck) {
      assert.equal(raw.retryable, false);
      assert.equal(final.retryable, false);
      assert.equal(raw.diagnostic_code, final.diagnostic_code);
      assert.match(final.diagnostic, /^Toy\.lean:3:1:/);
    }
  }
});

test('real nested tactic limits stay unassessed in local, project and final checks', lean, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarmenv-nested-resource-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = 'set_option maxRecDepth 32\nexample (n : Nat) : n + 0 = n := by\n  simp only [← Nat.add_zero]\ntheorem toy : True := trivial\n';
  const file = join(directory, 'Nested.lean');
  await writeFile(file, source);
  const verifier = fixture(undefined, { projectChecks: true });
  const raw = await verifier.runSourceDiagnostic('lake', ['env', 'lean', file], { timeoutMs: 30000 });
  assert.equal(raw.diagnostic_code, 'lean_resource_limit', JSON.stringify(raw));
  assert.equal(raw.retryable, false);
  for (const checkMode of ['lean-module', 'lean-project']) {
    const checker = new LeanChecker({ projectChecker: verifier.checkProject.bind(verifier), timeoutMs: 30000 });
    const result = normalizeCheckerResult(await checker.checkProject({ files: { 'Toy.lean': source }, tree: checkMode,
      path: 'Toy.lean', checkMode, missionId: 'nested-resource', startProcess: launch => launch() }));
    const feedback = agentCheckResult(result);
    assert.equal(result.verdict, 'ERROR', JSON.stringify(result));
    assert.equal(feedback.diagnostic_code, 'lean_resource_limit');
    assert.equal(feedback.mathematical_outcome, 'unassessed');
    assert.equal(feedback.retryable, false);
    assert.equal(feedback.checker_process_status, 'completed');
    assert.match(feedback.diagnostic_excerpt, /maximum recursion depth/);
  }
  const final = await verifier.check({ files: { 'Toy.lean': source }, tree: 'nested-final' });
  assert.equal(final.verdict, 'ERROR', JSON.stringify(final));
  assert.equal(final.diagnostic_code, 'lean_resource_limit');
});

test('project process signals, wallclock deadlines and unknown exits remain infrastructure errors', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarmenv-project-runtime-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const mode of ['signal', 'deadline', 'unknown', 'spawn']) {
    const bubblewrap = join(directory, mode);
    if (mode !== 'spawn') await writeFile(bubblewrap, `#!${process.execPath}
      process.stderr.write('error: source/Toy.lean:3:1: unsolved goals\\n');
      if (${JSON.stringify(mode)} === 'signal') process.kill(process.pid, 'SIGTERM');
      else if (${JSON.stringify(mode)} === 'deadline') setInterval(() => {}, 1000);
      else process.exitCode = 23;
    `, { mode: 0o700 });
    const verifier = fixture(undefined, { projectChecks: true, bubblewrap, allowUnboundedDiagnostics: true,
      timeoutMs: mode === 'deadline' ? 200 : 5000 });
    const result = await verifier.checkProject({ files: { 'Toy.lean': 'theorem toy : True := trivial' }, tree: 'fixed' });
    assert.equal(result.verdict, 'ERROR', mode);
    if (mode === 'deadline') assert.equal(result.timed_out, true);
  }
});

test('isolated Lake compiles offline Mathlib and all project modules before independent proof checking', {
  skip: !leanRoot || !comparatorRoot || !process.env.SWARMENV_TEST_PUTNAM_ROOT || !process.env.SWARMENV_TEST_CHECKER_CGROUP,
}, async () => {
  const libraryRoots = ['batteries', 'Qq', 'aesop', 'proofwidgets', 'importGraph', 'LeanSearchClient', 'plausible', 'mathlib']
    .map(pkg => join(process.env.SWARMENV_TEST_PUTNAM_ROOT, '.lake/packages', pkg, '.lake/build/lib/lean'));
  const verifier = fixture(undefined, { projectChecks: true, targetPath: 'src/Toy.lean', libraryRoots });
  const files = {
    'src/Toy.lean': Buffer.from('import Helpers.Counting\ntheorem toy : True := counting\n'),
    'src/Helpers/Counting.lean': 'import Helpers.Geometry\ntheorem counting : True := geometry\n',
    'src/Helpers/Geometry.lean': 'import Mathlib\ntheorem geometry : True := trivial\n',
    'lakefile.lean': 'this candidate configuration must never execute\n',
    'lake-manifest.json': 'this candidate manifest must never load\n',
    '.lake/build/lib/lean/Helpers/Geometry.olean': Buffer.from('also untrusted'),
  };
  let launches = 0;
  const complete = await verifier.checkProject({ files, tree: 'fixed', startProcess: launch => { launches++; return launch(); } });
  assert.equal(complete.verdict, 'PASS', complete.diagnostic);
  assert.equal(launches, 1);
  assert.equal(complete.checked_tree, 'fixed');
  assert.deepEqual(complete.checked_paths, ['src/Helpers/Counting.lean', 'src/Helpers/Geometry.lean', 'src/Toy.lean']);
  const broken = await verifier.checkProject({ files: { ...files, 'src/Unreferenced.lean': 'theorem broken : True := 0\n' }, tree: 'broken' });
  assert.equal(broken.verdict, 'FAIL', broken.diagnostic);
  assert.match(broken.diagnostic, /src\/Unreferenced\.lean/);
  const missing = { ...files };
  delete missing['src/Helpers/Geometry.lean'];
  const missedDependency = await verifier.checkProject({ files: missing, tree: 'missing' });
  assert.equal(missedDependency.verdict, 'FAIL', missedDependency.diagnostic);
  assert.match(missedDependency.diagnostic, /Helpers\.Geometry/);
  const cyclic = await verifier.checkProject({ files: { ...files,
    'src/Helpers/Geometry.lean': 'import Helpers.Counting\ntheorem geometry : True := trivial\n' }, tree: 'cycle' });
  assert.equal(cyclic.verdict, 'FAIL', cyclic.diagnostic);
  assert.match(cyclic.diagnostic, /cycle/);
  const accepted = await verifier.check({ files, tree: 'fixed' });
  assert.equal(accepted.verdict, 'PASS', accepted.diagnostic);
  const sorry = { ...files, 'src/Helpers/Geometry.lean': 'theorem geometry : True := by sorry\n' };
  const tentative = await verifier.checkProject({ files: sorry, tree: 'sorry' });
  assert.equal(tentative.verdict, 'PASS', tentative.diagnostic);
  assert.match(tentative.warnings.join('\n'), /Geometry\.lean.*sorry/);
  const rejected = await verifier.check({ files: sorry, tree: 'sorry' });
  assert.equal(rejected.verdict, 'FAIL', rejected.diagnostic);
  assert.match(rejected.diagnostic, /axiom policy/);
});

test('real isolated Lean does not expose the host home, environment, or project write access', lean, async () => {
  const result = await fixture().check({ files: { 'Toy.lean': `
def inspectSandbox : IO Unit := do
  if (← IO.getEnv "SWARMENV_TEST_LEAN_ROOT").isSome then
    throw (IO.userError "host environment leaked")
  if ← (System.FilePath.mk "/home/ubuntu").pathExists then
    throw (IO.userError "host home leaked")
  let wrote ← try
    IO.FS.writeFile "/input/Toy.lean" "modified"
    pure true
  catch _ => pure false
  if wrote then throw (IO.userError "candidate tree was writable")
#eval inspectSandbox
theorem toy : True := True.intro
` }, tree: 'sandbox' });
  assert.equal(result.verdict, 'PASS', result.diagnostic);
});

test('real Lean rejects the original B1 placeholder at its locked declaration', {
  skip: !leanRoot || !comparatorRoot || !process.env.SWARMENV_TEST_PUTNAM_ROOT,
}, async () => {
  const root = process.env.SWARMENV_TEST_PUTNAM_ROOT;
  const targetPath = 'src/putnam_2025_b1.lean';
  const fixtureSource = await readFile(join(root, targetPath));
  const libraryRoots = ['batteries', 'Qq', 'aesop', 'proofwidgets', 'importGraph', 'LeanSearchClient', 'plausible', 'mathlib']
    .map(pkg => join(root, '.lake/packages', pkg, '.lake/build/lib/lean'));
  const verifier = fixture(fixtureSource, { targetPath, declarationName: 'putnam_2025_b1', libraryRoots });
  const result = await verifier.check({ files: { [targetPath]: fixtureSource }, tree: 'original-b1' });
  assert.equal(result.verdict, 'FAIL', result.diagnostic);
});

test('aborted or expired work prevents materialization and subprocess launch', async () => {
  const verifier = fixture();
  const files = { 'Toy.lean': 'theorem toy : True := trivial' };
  const aborted = await verifier.check({ files, tree: 'aborted', signal: AbortSignal.abort() });
  assert.equal(aborted.verdict, 'ERROR');
  assert.match(aborted.diagnostic, /aborted/i);
  const expired = await verifier.check({ files, tree: 'expired', deadline: Date.now() - 1 });
  assert.equal(expired.verdict, 'ERROR');
  assert.match(expired.diagnostic, /deadline/i);

  const controller = new AbortController();
  const stagedFiles = {
    ...files,
    get 'extra.txt'() {
      controller.abort(new Error('Abort while materializing final tree'));
      return 'extra input';
    },
  };
  const staged = await verifier.check({ files: stagedFiles, tree: 'staged', signal: controller.signal });
  assert.equal(staged.verdict, 'ERROR');
  assert.match(staged.diagnostic, /while materializing/);
});

test('candidate launcher, signal, OOM, and malformed export never become cacheable FAIL', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarmenv-checker-status-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [code, diagnostic] of [
    [126, ''], [127, ''], [137, ''],

    [0, ''],
  ]) {
    const bubblewrap = join(directory, `test-launcher-${code}`);
    const script = `#!/bin/sh
case "$*" in
  *original*/input*) printf '%s\n' fixture ;;
  *) printf '%s\n' '${diagnostic}' >&2; exit ${code} ;;
esac
`;
    await writeFile(bubblewrap, script, { mode: 0o700, flag: 'wx' });
    const verifier = fixture(undefined, { bubblewrap, allowUnboundedDiagnostics: true });
    const result = await verifier.check({ files: { 'Toy.lean': 'theorem toy : True := trivial' }, tree: 'operational' });
    assert.equal(result.verdict, 'ERROR', `status ${code}: ${result.diagnostic}`);
    assert.equal(result.diagnostic, 'Final-tree proof export did not complete');
  }
});
