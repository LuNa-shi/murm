import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { LeanFinalTreeVerifier } from '../src/judge/lean-final-tree-verifier.js';
import { LeanChecker } from '../src/judge/lean-adapter.js';
import { agentCheckResult, normalizeCheckerResult } from '../src/judge/check-result.js';

const leanRoot = process.env.SWARMENV_TEST_LEAN_ROOT;
const real = { skip: !leanRoot };
function fixture(options = {}) {
  const fixtureSource = 'theorem target : True := by sorry\n';
  return new LeanFinalTreeVerifier({ identity: { checker_ref: 'module-test', checker_version: '1', environment_ref: 'real-lean' },
    leanRoot: leanRoot ?? '/unused', libraryRoots: [], comparatorLibraryRoots: ['/unused', '/unused'], exporterPath: '/unused/export',
    targetPath: 'src/Target.lean', declarationName: 'target', fixtureSource,
    fixtureSha256: createHash('sha256').update(fixtureSource).digest('hex'), projectChecks: true,
    allowUnboundedDiagnostics: true, timeoutMs: 30000, ...options });
}
const files = () => ({
  'src/Target.lean': 'import Helpers.Middle\ntheorem target : True := middle\n',
  'src/Helpers/Middle.lean': 'import /- nested /- comment -/ -/ Helpers.Basic\ntheorem middle : True := basic\n',
  'src/Helpers/Basic.lean': 'theorem basic : True := trivial\n',
  'src/Unrelated.lean': 'import\ninvalid header and invalid proof\n',
});
const check = (verifier, sources, extra = {}) => verifier.checkProject({ files: sources, tree: 'tree:fixed', path: 'src/Target.lean',
  checkMode: 'lean-module', missionId: 'mission:A', ...extra });

test('real Lean module checks exact dependency closure and reuses immutable artifacts by Mission and transitive inputs', real, async () => {
  const verifier = fixture();
  const sources = files();
  // Candidate precompiled inputs must remain inert, even at plausible cache paths.
  sources['.lake/build/lib/lean/Helpers/Basic.olean'] = Buffer.from('poison');
  sources['src/Helpers/Basic.olean.private'] = Buffer.from('poison');
  const cold = await check(verifier, sources);
  assert.equal(cold.verdict, 'PASS', cold.diagnostic);
  assert.deepEqual(cold.checked_paths, ['src/Helpers/Basic.lean', 'src/Helpers/Middle.lean', 'src/Target.lean']);
  assert.equal(cold.scope, 'module');
  assert.equal(cold.cache.misses, 3);
  const warm = await check(verifier, sources, { tree: 'tree:same-source-new-revision' });
  assert.equal(warm.verdict, 'PASS', warm.diagnostic);
  assert.equal(warm.checked_tree, 'tree:same-source-new-revision');
  assert.equal(warm.cache.hits, 3);
  assert.equal(warm.cache.misses, 0);
  const leaf = await check(verifier, { ...sources, 'src/Target.lean': sources['src/Target.lean'] + '-- leaf change\n' });
  assert.equal(leaf.verdict, 'PASS', leaf.diagnostic);
  assert.equal(leaf.cache.hits, 2);
  assert.equal(leaf.cache.misses, 1);
  const dependency = await check(verifier, { ...sources, 'src/Helpers/Basic.lean': 'theorem basic : True := by constructor\n' });
  assert.equal(dependency.verdict, 'PASS', dependency.diagnostic);
  assert.equal(dependency.cache.hits, 0);
  assert.equal(dependency.cache.misses, 3);
  const otherMission = await check(verifier, sources, { missionId: 'mission:B' });
  assert.equal(otherMission.cache.hits, 0);
  assert.equal(otherMission.cache.misses, 3);
  const broken = await check(verifier, { ...sources, 'src/Helpers/Basic.lean': 'theorem basic : True := nope\n' });
  assert.equal(broken.verdict, 'FAIL', broken.diagnostic);
  assert.match(broken.diagnostic, /src\/Helpers\/Basic.lean/);
  const brokenAgain = await check(verifier, { ...sources, 'src/Helpers/Basic.lean': 'theorem basic : True := nope\n' });
  assert.equal(brokenAgain.verdict, 'FAIL');
  assert.equal(brokenAgain.cache.hits, 0);
});

test('real Lean cache dependencies are read-only during candidate elaboration, and module PASS stays scoped', real, async () => {
  const verifier = fixture();
  const sources = files();
  sources['src/Target.lean'] = `import Helpers.Middle
import Lean
#eval do
  let wrote ← try
    IO.FS.writeFile "/cache/Helpers/Basic.olean" "poison"
    pure true
  catch _ => pure false
  if wrote then throw (IO.userError "dependency cache was writable")
theorem target : True := middle
`;
  const checker = new LeanChecker({ projectChecker: verifier.checkProject.bind(verifier) });
  const adapted = normalizeCheckerResult(await checker.checkProject({ files: sources, tree: 'tree:fixed', path: 'src/Target.lean',
    checkMode: 'lean-module', missionId: 'mission:A', startProcess: launch => launch() }));
  assert.equal(adapted.verdict, 'PASS', adapted.evidence.diagnostic);
  const feedback = agentCheckResult({ ...adapted, evidence: { ...adapted.evidence, workspace_input: { check_mode: 'lean-module' } } });
  assert.equal(feedback.mathematical_outcome, 'unassessed');
  assert.equal(feedback.build.scope, 'module');
  assert.equal(feedback.build.requested_path, 'src/Target.lean');
  assert.equal(feedback.build.checked_count, 3);
  assert.equal(feedback.build.cache.misses, 3);
});

test('real Lean cache eviction, concurrent jobs and cancellation do not publish partial artifacts', real, async () => {
  const noCache = fixture({ moduleCacheBytes: 1 });
  const sources = files();
  for (let i = 0; i < 2; i++) {
    const result = await check(noCache, sources);
    assert.equal(result.verdict, 'PASS', result.diagnostic);
    assert.equal(result.cache.hits, 0);
    assert.equal(result.cache.stored_bytes, 0);
  }
  const verifier = fixture();
  const controller = new AbortController();
  controller.abort();
  const [cancelled, first, second] = await Promise.all([
    check(verifier, sources, { signal: controller.signal }), check(verifier, sources), check(verifier, sources),
  ]);
  assert.equal(cancelled.verdict, 'ERROR');
  assert.equal(first.verdict, 'PASS', first.diagnostic);
  assert.equal(second.verdict, 'PASS', second.diagnostic);
  assert.equal((await check(verifier, sources)).cache.hits, 3);
});

test('module scope rejects cycles, traversal, module shadows and missing path', real, async () => {
  const verifier = fixture();
  for (const sources of [
    { ...files(), 'src/Helpers/Basic.lean': 'import Helpers.Middle\n' },
    { ...files(), 'src/../Escape.lean': 'theorem e : True := trivial' },
    { ...files(), 'src/Lean/Shadow.lean': 'theorem e : True := trivial' },
  ]) assert.equal((await check(verifier, sources)).verdict, 'FAIL');
  assert.equal((await check(verifier, files(), { path: undefined })).verdict, 'FAIL');
  assert.throws(() => fixture({ moduleCacheBytes: -1 }), /cache byte limit/);
});

test('candidate forged output and early successful exit cannot enter a trusted cache', real, async () => {
  const verifier = fixture();
  const sources = files();
  sources['src/Target.lean'] = `import Helpers.Middle
#eval IO.FS.writeFile "/output/Target.olean" "forged artifact"
#eval (IO.Process.exit 0 : IO Unit)
theorem target : False := by trivial
`;
  const result = await check(verifier, sources);
  assert.equal(result.verdict, 'ERROR', JSON.stringify(result));
  assert.notEqual((await check(verifier, sources)).cache?.hits, 3);
});

test('real Lean module-system private companion artifacts survive cold and warm dependency imports', real, async () => {
  const verifier = fixture();
  const sources = {
    'src/Helpers/Basic.lean': 'module\nprivate theorem hidden : True := trivial\npublic theorem basic : True := hidden\n',
    'src/Helpers/Middle.lean': 'module\npublic import Helpers.Basic\nimport all Helpers.Basic\npublic theorem middle : True := basic\n',
    'src/Target.lean': 'module\nimport all Helpers.Middle\npublic theorem target : True := middle\n',
  };
  for (let index = 0; index < 2; index++) {
    const result = await check(verifier, sources);
    assert.equal(result.verdict, 'PASS', result.diagnostic);
    assert.equal(index ? result.cache.hits : result.cache.misses, 3);
  }
});

test('local frontend completion is required for ordinary early exit and copied valid dependency output', real, async () => {
  for (const action of [
    '#eval (IO.Process.exit 0 : IO Unit)',
    '#eval IO.FS.writeBinFile "/output/Target.olean" (← IO.FS.readBinFile "/cache/Helpers/Basic.olean")\n#eval (IO.Process.exit 0 : IO Unit)',
  ]) {
    const verifier = fixture({ moduleCacheBytes: 0 });
    const sources = files();
    sources['src/Target.lean'] = `import Helpers.Middle\n${action}\ntheorem target : False := by trivial\n`;
    const result = await check(verifier, sources);
    assert.equal(result.verdict, 'ERROR', JSON.stringify(result));
    assert.equal(result.cache.stored_bytes, 0);
  }
});

test('independent module verification rejects old valid output for a different fixed source', real, async () => {
  const verifier = fixture({ moduleCacheBytes: 0 });
  const execute = verifier.moduleChecker.execute;
  let previousOutput;
  let replace = false;
  verifier.moduleChecker.execute = async (args, options) => {
    const result = await execute(args, options);
    if (args.includes('/driver/Build.lean') && args.includes('Target')) {
      if (replace) return { ...result, output: previousOutput };
      previousOutput = Buffer.from(result.output);
    }
    return result;
  };
  assert.equal((await check(verifier, files())).verdict, 'PASS');
  assert.ok(previousOutput.length);
  replace = true;
  const result = await check(verifier, { ...files(), 'src/Target.lean': 'import Helpers.Middle\ntheorem target : True := by constructor\n' });
  assert.equal(result.verdict, 'ERROR', JSON.stringify(result));
  assert.equal(result.diagnostic_code, 'module_verification_failed');
});

test('independent verifier rejects prefixed stdout instead of relaxing its JSON receipt', real, async () => {
  const verifier = fixture({ moduleCacheBytes: 0 });
  const execute = verifier.moduleChecker.execute;
  verifier.moduleChecker.execute = async (args, options) => {
    const result = await execute(args, options);
    return args.includes('/driver/Verify.lean')
      ? { ...result, output: Buffer.concat([Buffer.from('unexpected compiler warning\n'), result.output]) }
      : result;
  };
  const result = await check(verifier, { 'src/Target.lean': 'theorem target : True := trivial\n' });
  assert.equal(result.verdict, 'ERROR');
  assert.equal(result.diagnostic_code, 'module_verification_failed');
  assert.equal(result.cache.stored_bytes, 0);
});

test('partial proofs and new axioms stay diagnostic with warnings while verification skips candidate initializers', real, async () => {
  const verifier = fixture();
  const execute = verifier.moduleChecker.execute;
  const validationOutputs = [];
  verifier.moduleChecker.execute = async (args, options) => {
    const result = await execute(args, options);
    if (args.includes('/driver/Verify.lean')) validationOutputs.push(result.output.toString());
    return result;
  };
  const sources = { 'src/Target.lean': 'initialize IO.println "CANDIDATE_INITIALIZER_RAN"\naxiom helper : True\ntheorem target : True := by sorry\n' };
  const result = await check(verifier, sources);
  assert.equal(result.verdict, 'PASS', result.diagnostic);
  assert.ok(result.warnings.some(warning => /sorry/.test(warning)), JSON.stringify(result));
  assert.ok(result.warnings.some(warning => /axiom helper/.test(warning)), JSON.stringify(result));
  assert.ok(validationOutputs.length > 0);
  assert.ok(validationOutputs.every(output => !output.includes('CANDIDATE_INITIALIZER_RAN')));
});

test('independent verification rejects corrupted module companion data before caching', real, async () => {
  const verifier = fixture({ moduleCacheBytes: 0 });
  const execute = verifier.moduleChecker.execute;
  let corrupted = false;
  verifier.moduleChecker.execute = async (args, options) => {
    const result = await execute(args, options);
    if (args.includes('/driver/Build.lean') && args.includes('Target') && result.code === 0) {
      const lines = result.output.toString().trimEnd().split('\n');
      const companion = lines.indexOf('olean.private');
      assert.ok(companion >= 0, 'module-system fixture should serialize private data');
      lines[companion + 1] = Buffer.from('corrupted private module data').toString('base64');
      corrupted = true;
      return { ...result, output: Buffer.from(lines.join('\n') + '\n') };
    }
    return result;
  };
  const result = await check(verifier, { 'src/Target.lean': 'module\nprivate theorem hidden : True := trivial\npublic theorem target : True := hidden\n' });
  assert.equal(corrupted, true);
  assert.equal(result.verdict, 'ERROR', JSON.stringify(result));
  assert.equal(result.cache.stored_bytes, 0);
});

test('cross-module custom tactics and macros remain executable after verified cache reuse and invalidation', real, async () => {
  const verifier = fixture();
  const sources = {
    'src/Helpers/Basic.lean': 'import Lean\nopen Lean Elab Tactic\nmacro "finish_trivial" : tactic => `(tactic| exact True.intro)\nelab "finish_custom" : tactic => do evalTactic (← `(tactic| finish_trivial))\n',
    'src/Helpers/Middle.lean': 'import Helpers.Basic\ntheorem middle : True := by finish_custom\n',
    'src/Target.lean': 'import Helpers.Middle\ntheorem target : True := by finish_trivial\n',
  };
  const cold = await check(verifier, sources);
  assert.equal(cold.verdict, 'PASS', cold.diagnostic);
  const warm = await check(verifier, sources);
  assert.equal(warm.verdict, 'PASS', warm.diagnostic);
  assert.equal(warm.cache.hits, 3);
  sources['src/Helpers/Basic.lean'] += '-- changed tactic module source\n';
  const changed = await check(verifier, sources);
  assert.equal(changed.verdict, 'PASS', changed.diagnostic);
  assert.equal(changed.cache.misses, 3);
});

test('independent replay rejects invalid safe declarations inserted by a candidate metaprogram', real, async () => {
  const verifier = fixture();
  const sources = { 'src/Target.lean': `import Lean
open Lean Elab Command
elab "inject_invalid_safe_theorem" : command => do
  modifyEnv fun env =>
    match env.addDeclCore 0 0 (.thmDecl {
      name := \`badFalse
      levelParams := []
      type := mkConst \`\`False
      value := mkConst \`\`True.intro
    }) none (doCheck := false) with
    | .ok env => env
    | .error _ => env
inject_invalid_safe_theorem
#check badFalse
` };
  const result = await check(verifier, sources);
  assert.equal(result.verdict, 'ERROR', JSON.stringify(result));
  assert.equal(result.diagnostic_code, 'module_verification_failed');
  assert.equal(result.cache.stored_bytes, 0);
});
