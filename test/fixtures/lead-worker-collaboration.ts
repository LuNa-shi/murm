import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fetchOrdersCandidate, withOrdersCandidate } from '../../examples/lead-worker/dynamic-orders.js';
import { httpClient } from '../../src/harnesses/peermesh/http.js';

const sha1 = /^[a-f0-9]{40}$/;
const fileHash = (encoded: string) => createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('hex');

export async function auditCheckerAdoption({ gitea, runId, report, candidate, calls, worker, serviceImage }) {
  const { board, dynamic } = report.result.harness;
  const checker = dynamic.member.agentId;
  const ref = byUsedFeedback();
  function byUsedFeedback() {
    for (const note of board.notes) {
      if (note.actor !== checker || !board.submitted.feedbackIds.includes(note.seq)) continue;
      const task = board.subtasks.find(row => row.id === note.subtask_id && row.owner === checker &&
        row.state === 'complete' && row.delivery?.verified && row.path === 'checker-report.json');
      if (task) return { note, task };
    }
  }
  assert.ok(ref, 'Cited checker feedback requires a verified checker-report.json delivery');
  const { note, task } = ref;
  const service = dynamic.deployment.id;
  const repositoryName = `lead-worker-${runId}`;
  const base = `/api/v1/repos/${encodeURIComponent(gitea.owner)}/${repositoryName}`;
  const repositoryUrl = `${gitea.origin.replace(/\/$/, '')}/${encodeURIComponent(gitea.owner)}/${repositoryName}.git`;
  const request = httpClient(gitea.origin, `token ${gitea.adminToken}`);
  const signal = AbortSignal.timeout(60_000);
  const content = async (path: string, commit: string) => {
    assert.match(commit, sha1);
    const file = await request('GET', `${base}/contents/${path}?ref=${commit}`, undefined, { signal });
    assert.equal(file.type, 'file');
    assert.equal(file.encoding, 'base64');
    assert.equal(file.path, path);
    return Buffer.from(file.content, 'base64');
  };

  const bytes = await content(task.path, task.delivery.commit);
  assert.ok(bytes.length <= 32 * 1024);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), task.delivery.sha256);
  const finding = JSON.parse(bytes.toString('utf8'));
  assert.match(finding.candidateCommit, sha1);
  assert.ok(finding.candidateCommit !== candidate.commit && task.title.includes(finding.candidateCommit));
  assert.ok(typeof finding.feedback === 'string' && finding.feedback.length >= 20);
  assert.ok(note.text.includes(finding.candidateCommit) && note.text.includes(finding.feedback));
  assert.match(finding.recommendedPath, /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.[cm]?js$/);

  // Independently resolve the earlier Git commit, and prove it belongs to the
  // history of the final submission rather than trusting a SHA in the note.
  const visited = new Set<string>();
  const unresolved = [candidate.commit];
  while (!visited.has(finding.candidateCommit) && unresolved.length && visited.size < 64) {
    const revision = unresolved.shift();
    if (visited.has(revision)) continue;
    assert.match(revision, sha1);
    const commit = await request('GET', `${base}/git/commits/${revision}`, undefined, { signal });
    assert.equal(commit.sha, revision);
    visited.add(revision);
    assert.ok(Array.isArray(commit.parents));
    unresolved.push(...commit.parents.map(parent => parent.sha));
  }
  assert.ok(visited.has(finding.candidateCommit), 'The examined commit must be an ancestor of the final commit');

  const probes = ['valid', 'invalid'].map(kind => {
    const expected = finding[kind];
    const receipt = calls.find(row => row.phase === 'settled' && row.caller.agentId === checker &&
      row.service === service && row.operation === 'check_orders' && row.operation_id === expected.requestId && !row.error);
    assert.ok(receipt && typeof receipt.input?.jsonl === 'string' && receipt.input.jsonl !== '');
    assert.ok(receipt.output?.valid?.length);
    assert.ok(kind === 'valid' ? receipt.output.errors?.length === 0 :
      receipt.output.errors?.some(error => ['INVALID_JSON', 'DUPLICATE_ID'].includes(error.code)));
    return { jsonl: receipt.input.jsonl as string, serviceOutput: receipt.output,
      transcript: { status: expected.status, stdout: expected.stdout, stderr: expected.stderr } };
  });
  assert.notEqual(probes[0].jsonl, probes[1].jsonl);
  const initial = await content('orders.mjs', finding.candidateCommit);
  const before = await fetchOrdersCandidate({ repositoryUrl, token: gitea.adminToken, commit: finding.candidateCommit,
    sha256: createHash('sha256').update(initial).digest('hex'), signal });
  await withOrdersCandidate(before, serviceImage, async execute => {
    for (const { jsonl, transcript } of probes) assert.deepEqual(await execute({ stdin: jsonl }), transcript);
  }, signal);
  await withOrdersCandidate(candidate.files, serviceImage, async execute => {
    for (const { jsonl, serviceOutput } of probes) {
      const result = await execute({ stdin: jsonl });
      assert.equal(result.status, serviceOutput.errors.length ? 1 : 0);
      assert.deepEqual(JSON.parse(result.stdout), serviceOutput);
      assert.equal(result.stderr, '');
    }
  }, signal);

  const continued = board.subtasks.find(row => row.owner === worker && row.path === finding.recommendedPath &&
    row.state === 'complete' && row.delivery?.verified && Object.hasOwn(candidate.files, row.path) &&
    fileHash(candidate.files[row.path]) === row.delivery.sha256 &&
    board.history.some(event => event.type === 'claim' && event.subtaskId === row.id && event.seq > note.seq));
  assert.ok(continued, 'The final tree must contain the original Worker’s adopted code or test bytes');
  assert.ok(!Object.values(before).some(encoded => fileHash(encoded) === continued.delivery.sha256),
    'The adopted deliverable must contain new bytes compared with the inspected candidate');
  assert.ok(board.directions.some(row => row.actor === board.team.lead && row.feedback_ids.includes(note.seq) &&
    row.seq > note.seq && row.seq === continued.directionId));
  return { reviewedCommit: finding.candidateCommit, checkerDeliveryCommit: task.delivery.commit,
    feedbackSeq: note.seq, adoptionCommit: continued.delivery.commit, adoptionSha256: continued.delivery.sha256 };
}
