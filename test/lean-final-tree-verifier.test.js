import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
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
    [21, '{"severity":"error","data":"excessive memory consumption"}'],
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
