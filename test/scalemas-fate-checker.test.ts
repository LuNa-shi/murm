import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFateChecker, loadFateProject } from '../examples/scalemas-environment/fate-checker.js';

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
