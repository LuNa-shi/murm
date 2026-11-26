import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectCoreWorkDir } from '../scripts/core-collection.js';
import { saveAgentArtifacts } from '../src/core/artifact-collection.js';
import { createRedactor } from '../src/core/run-records.js';

test('native Session archive retains uncompacted history in private files with credential-redacted verified bytes', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'session-archive-'));
  const sourceDir = join(outputDir, 'source'); await mkdir(sourceDir);
  const records = [
    { type: 'session', id: 'native-session', timestamp: '2026-11-24T00:00:00.000Z' },
    { type: 'message', message: { role: 'user', content: 'original history credential-marker and "' } },
    { type: 'compaction', summary: 'short summary' },
    { type: 'message', message: { role: 'assistant', content: 'continued' } },
  ];
  const history = records.map(row => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(join(sourceDir, 'native.jsonl'), history);
  const collect = { paths: ['.'], includeGit: false, required: true, maxBytes: 1000000 };
  const paths = await saveAgentArtifacts({ outputDir, agentId: 'agent-one', collect,
    records: () => collectCoreWorkDir(sourceDir, collect), bounds: { bytes: Number.MAX_SAFE_INTEGER, inodes: 1000 },
    destination: 'session', privateFiles: true,
    redactStream: createRedactor(['credential-marker', '"']).jsonl,
  });
  assert.equal(paths[0], join(outputDir, 'agent-one', 'session', 'manifest.json'));
  const archive = await readFile(join(paths[1], 'native.jsonl'), 'utf8');
  const archivedRecords = archive.trimEnd().split('\n').map(line => JSON.parse(line));
  records[1].message.content = 'original history [redacted] and [redacted]';
  assert.deepEqual(archivedRecords, records);
  assert.equal(archive.includes('credential-marker'), false);
  const manifest = JSON.parse(await readFile(paths[0], 'utf8'));
  assert.equal(manifest.files[0].bytes, Buffer.byteLength(archive));
  assert.equal((await stat(join(paths[1], 'native.jsonl'))).mode & 0o777, 0o600);
});
