import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillRoot = path.join(repositoryRoot, '.codex', 'skills', 'experiment-analysis');

test('experiment-analysis skill uses the four-question workflow', async () => {
  const skill = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
  const template = await readFile(path.join(skillRoot, 'references', 'report-template.md'), 'utf8');

  for (const question of [
    'Orchestration',
    'Coordination',
    'Execution',
    'Tool contract',
  ]) {
    assert.match(skill, new RegExp(question));
    assert.match(template, new RegExp(question));
  }

  assert.match(skill, /raw Agent JSONL/);
  assert.match(skill, /expected.*actual|actual.*expected/i);
  assert.match(skill, /Task window/);
  assert.match(skill, /Material window/);
  assert.doesNotMatch(skill, /npm run analyze:experiment/);
  assert.doesNotMatch(skill, /semantic-review/i);
  assert.doesNotMatch(template, /semantic-review/i);
});
