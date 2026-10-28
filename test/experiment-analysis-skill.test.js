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
  const evidenceMap = await readFile(path.join(skillRoot, 'references', 'evidence-map.md'), 'utf8');

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
  assert.match(skill, /expected result/);
  assert.match(skill, /actual result/);
  assert.match(skill, /Task window/);
  assert.match(skill, /Material window/);
  assert.match(skill, /schema unavailable/);
  assert.match(skill, /reusable-Core/);
  assert.match(skill, /closed at child scope/);
  assert.match(skill, /diagnostic-only/);
  assert.match(skill, /source-verified only/);
  assert.match(skill, /For every recorded request\/response pair/);
  assert.match(template, /every recorded request\/response pair/);
  assert.match(skill, /stable .*ID|stable IDs/i);
  assert.match(skill, /unknown/);
  assert.match(template, /relative evidence references/);
  assert.match(evidenceMap, /<external>\/<basename>/);
  assert.match(template, /stdout\/stderr/);
  assert.match(template, /credentials/);

  assert.deepEqual(
    [...skill.matchAll(/^### ([1-4])\./gm)].map((match) => match[1]),
    ['1', '2', '3', '4'],
  );
  assert.deepEqual(
    [...template.matchAll(/^## ([1-6])\./gm)].map((match) => match[1]),
    ['1', '2', '3', '4', '5', '6'],
  );
  assert.match(evidenceMap, /summary fields only locate records/);
  assert.doesNotMatch(skill, /npm run analyze:experiment/);
  assert.doesNotMatch(skill, /semantic-review/i);
  assert.doesNotMatch(template, /semantic-review/i);
});
