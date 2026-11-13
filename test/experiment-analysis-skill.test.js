import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillRoot = path.join(repositoryRoot, '.codex', 'skills', 'experiment-analysis');

test('experiment-analysis skill documents the current evidence workflow', async () => {
  const skill = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
  const template = await readFile(path.join(skillRoot, 'references', 'report-template.md'), 'utf8');
  const evidenceMap = await readFile(path.join(skillRoot, 'references', 'evidence-map.md'), 'utf8');

  for (const question of ['Orchestration', 'Coordination', 'Execution', 'Tools/Judge']) {
    assert.match(skill, new RegExp(question));
    assert.match(template, new RegExp(question));
  }
  assert.match(skill, /schema unavailable/);
  assert.match(skill, /diagnostic-only/);
  assert.match(skill, /stable .*ID|stable IDs/i);
  assert.match(skill, /unknown/);
  assert.match(evidenceMap, /<external>\/\<basename>/);
  assert.match(template, /stdout\/stderr/);
  assert.match(template, /credentials/);
  assert.doesNotMatch(skill, /npm run analyze:experiment/);
  assert.doesNotMatch(skill, /semantic-review/i);
  assert.doesNotMatch(template, /semantic-review/i);
});
