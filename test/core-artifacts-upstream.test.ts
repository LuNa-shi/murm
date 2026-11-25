import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createArtifactsUpstream } from './fixtures/core-artifacts-upstream.js';

test('controlled artifact fixture requires correlated physical file and Git evidence', async t => {
  const upstream = await createArtifactsUpstream(); t.after(() => upstream.close());
  const input = [{ role: 'user', content: 'FIXED_ARTIFACT_CAPTURE' }];
  const send = items => fetch(upstream.url, { method: 'POST', body: JSON.stringify({ model: 'k3', input: items }) });
  assert.match(await (await send(input)).text(), /git init/);
  const proof = { tracked: true, uncommitted: true, untracked: true, noRemote: true, commit: '1'.repeat(40) };
  const final = await send([...input, { type: 'function_call_output', call_id: 'call_artifact', output: JSON.stringify(proof) }]);
  assert.match(await final.text(), /T07_ARTIFACTS_READY/);
  assert.deepEqual(upstream.receipt(), { arrivals: 2, receipts: [{ ordinal: 1, verified: false }, { ordinal: 2, verified: true }], evidence: proof, failure: undefined });
});

test('malformed and rejected arrivals spend the same two-request budget', async t => {
  const upstream = await createArtifactsUpstream(); t.after(() => upstream.close());
  for (let count = 1; count <= 3; count++) {
    const response = await fetch(upstream.url, { method: 'POST', body: '{broken' });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: { message: 'CONTROLLED_ARTIFACTS_FAILED' } });
    assert.equal(upstream.receipt().arrivals, count);
  }
  assert.deepEqual(upstream.receipt().receipts, []);
});

test('fixed native artifact command has valid shell syntax without executing its file or Git operations', async () => {
  const { execFileSync } = await import('node:child_process');
  const { artifactCommand } = await import('./fixtures/core-artifacts-upstream.js');
  execFileSync('bash', ['-n'], { input: artifactCommand, timeout: 3000 });
});
