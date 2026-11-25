import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFateChecker, loadFateProject } from '../examples/scalemas-environment/fate-checker.js';
import { prepareFate } from '../examples/scalemas-environment/fate-run.js';

const projectRoot = process.env.SWARMENV_FATE_TEST_PROJECT;
const leanRoot = process.env.SWARMENV_FATE_TEST_LEAN;
test('independent FATE-M evaluation checks the original goal and rejects invalid submissions', {
  skip: projectRoot && leanRoot ? false : 'requires the pinned FATE-M project and Lean 4.28',
}, async t => {
  const project = await loadFateProject({ projectRoot, leanRoot });
  const checker = await createFateChecker(project);
  t.after(() => checker.close());
  const check = proof => checker.evaluate(proof, { timeoutMs: 60_000 });
  assert.equal((await check('by\n  simp [Fintype.card_pi]')).status, 'passed');
  const wrong = [
    'by exact True.intro',
    'by sorry',
    'by admit',
    'by\n  exact Classical.choice (by sorry)',
    'by\n  exact True.intro\naxiom wrong : False',
    'theorem prod_card_eq_card_pow : True := by trivial',
  ];
  for (const proof of wrong) assert.equal((await check(proof)).status, 'rejected', proof);
});

test('the independent FATE checker preserves the original namespace and local definitions', {
  skip: projectRoot && leanRoot ? false : 'requires the pinned FATE-M project and Lean 4.28',
}, async t => {
  const project = await loadFateProject({ projectRoot, leanRoot });
  const formal = `import Mathlib

namespace FateNamedFixture

abbrev Product (n : ℕ) := Fin n

theorem card_named_product (n : ℕ) : Fintype.card (Product n) = n := by
  sorry

end FateNamedFixture`;
  const checker = await createFateChecker({
    ...project, formal,
    pins: { ...project.pins, theorem: 'card_named_product', namespace: 'FateNamedFixture' },
  });
  t.after(() => checker.close());
  const check = proof => checker.evaluate(proof, { timeoutMs: 60_000 });
  assert.equal((await check('by simpa [Product] using Fintype.card_fin n')).status, 'passed');
  assert.equal((await check('by exact True.intro')).status, 'rejected');
  assert.equal((await check('by sorry')).status, 'rejected');
});

const hardProjectRoot = process.env.SWARMENV_FATE_H_TEST_PROJECT;
test('FATE-H preparation accepts only the frozen second problem and checks the original goal', {
  skip: hardProjectRoot && leanRoot ? false : 'requires the pinned FATE-H project and Lean 4.28',
}, async () => {
  const options = { projectRoot: hardProjectRoot, leanRoot, benchmark: 'FATE-H' as const };
  const prepared = await prepareFate(options);
  assert.equal(prepared.pins.problemId, 2);
  assert.equal(prepared.pins.theorem, 'not_isSimpleGroup_of_card_eq_56');
  assert.equal(prepared.problemSha256, '0f264f8c2133b071ee0462f59aeed24ac6b00f4403cc3c143d4d47faaf77f417');
  const wrong = { ...options, benchmark: 'FATE-M' as const };
  await assert.rejects(prepareFate(wrong), { code: 'ENOENT' });
});

const expertProjectRoot = process.env.SWARMENV_FATE_X_TEST_PROJECT;
test('FATE-X preparation compiles the frozen namespaced problem and rejects a wrong proof term', {
  skip: expertProjectRoot && leanRoot ? false : 'requires the pinned FATE-X project and Lean 4.28',
}, async () => {
  const options = { projectRoot: expertProjectRoot, leanRoot, benchmark: 'FATE-X' as const };
  const prepared = await prepareFate(options);
  assert.equal(prepared.pins.problemId, 31);
  assert.equal(prepared.pins.namespace, 'Problem31');
  assert.equal(prepared.pins.theorem, 'UFD_of_ge_5');
  assert.equal(prepared.problemSha256, '94d8113d56cbd9162371e02610bbe343c20831c59e4c1f9031a271eb30ad46e7');
});
