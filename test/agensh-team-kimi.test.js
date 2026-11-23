import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveTeamInputs, liveCommon, liveAInitial, liveBInitial, liveAUser, liveTeamLimits, verifyLiveBudget, verifyLiveCooperation, checkLiveFile, createLiveIngress } from './fixtures/agensh-team-kimi.js';

const seed = 'a'.repeat(24);
function evidence() {
  const peers = ['a', 'b'].map((key, index) => ({ key, branch: `branch-${key}`, gitea: { username: `peer-${key}`, accountId: String(index + 1) },
    message: { accountId: `message-${key}` }, board: { workerId: `worker-${key}` } }));
  const value = { seed, peers,
    boardEntries: [{ type: 'FACT', thread_id: 'worker-a', content: `LIVE_T15_SEED=${seed}`, ts_epoch: 1 },
      ...peers.map(peer => ({ type: 'CLAIM', thread_id: peer.board.workerId, content: 'LIVE_T15_SHARED_COMPONENT', ts_epoch: 1 })),
      ...peers.map(peer => ({ type: 'PATCH_SUMMARY', thread_id: peer.board.workerId, content: `evidence=verified ${peer.key.repeat(40)}`, ts_epoch: 4 }))],
    messages: [{ id: 'proposal', user_id: 'message-b', message: '@peer-a LIVE_T15_NEGOTIATE propose the split', create_at: 2000 },
      { id: 'agreement', user_id: 'message-a', message: '@peer-b LIVE_T15_CONFIRM agreed', create_at: 3000 }],
    services: [{ operationId: 'board-read', seq: 20, confirmationInputId: 'confirmation-input', peerKey: 'b', afterConfirmation: true, operation: 'board_read', state: 'settled', outcome: 'succeeded', at: '1970-01-01T00:00:04.000Z' }],
    pullRequests: peers.map((peer, index) => ({ number: index + 1, user: { id: index + 1 }, head: { ref: peer.branch, sha: peer.key.repeat(40) }, base: { ref: 'main' } })),
    branchHeads: { a: 'a'.repeat(40), b: 'b'.repeat(40) }, mainFiles: { 'left.txt': 'LIVE_T15_LEFT_ACCEPTED\n', 'right.txt': `LIVE_T15_RIGHT_ADOPTED ${seed}\n` } };
  value.boardEntries.forEach((row, index) => { row.id = index + 1; row.label = `G${row.id}`; }); return value;
}

test('live inputs disclose the unique seed only to A and leave actual Bash programs to the model', () => {
  const inputs = liveTeamInputs({ seed, peerNames: { a: 'peer-a', b: 'peer-b' } });
  assert.ok(inputs[0].includes(seed)); assert.ok(!inputs[1].includes(seed)); assert.ok(!inputs[2].includes(seed));
  assert.ok(inputs.slice(0, 2).every(text => text.includes('actual Bash') && text.includes('--input <temporary-json-file>')));
  assert.ok(inputs.every(text => !text.includes('node --input-type=module') && !text.includes('TEAM_CHECK')));
});

test('live phase instructions batch required work while preserving actual Board adoption and the fixed allowance', () => {
  assert.ok(liveCommon.includes('one coherent Bash call'));
  assert.ok(liveCommon.includes('one actual Board read'));
  assert.ok(liveCommon.includes('concrete error'));
  assert.ok(!liveCommon.includes('Read the issue if useful'));
  assert.ok(liveAInitial.includes('initial batch') && liveAInitial.includes('CLAIM') && liveAInitial.includes('FACT'));
  assert.ok(liveBInitial.includes('initial batch') && liveBInitial.includes('proposal') && liveBInitial.includes('Board read belongs in your negotiated turn'));
  assert.ok(liveAUser.includes('one coherent Bash call'));
  assert.deepEqual({ inputs: liveTeamLimits.inputs, requests: liveTeamLimits.maxRequests, output: liveTeamLimits.maxOutputTokens },
    { inputs: 5, requests: 20, output: 768 });
});

test('host checks exact immutable PR bytes before any merge, rejecting model claims and malformed content', () => {
  const expected = `LIVE_T15_RIGHT_ADOPTED ${seed}\n`, bytes = Buffer.from(expected);
  const value = { type: 'file', path: 'right.txt', encoding: 'base64', content: bytes.toString('base64'), size: bytes.length };
  checkLiveFile(value, 'right.txt', expected);
  for (const change of [{ content: '%%%%' }, { content: Buffer.from('wrong').toString('base64') }, { path: 'other.txt' }, { size: 0 }, { type: 'dir' }]) {
    assert.throws(() => checkLiveFile({ ...value, ...change }, 'right.txt', expected));
  }
});

test('cooperation proof uses actual author, shared Board read, negotiation, PR head and main bytes', () => {
  const proof = verifyLiveCooperation(evidence());
  assert.deepEqual(proof.pins, [{ peerKey: 'a', number: 1, headSha: 'a'.repeat(40) }, { peerKey: 'b', number: 2, headSha: 'b'.repeat(40) }]);
  assert.equal(proof.fact.label, 'G1'); assert.equal(proof.agreement.id, 'agreement'); assert.equal(proof.read.confirmationInputId, 'confirmation-input');
  assert.match(proof.main['right.txt'].sha256, /^[a-f0-9]{64}$/); assert.ok(!JSON.stringify(proof).includes('propose the split'));
  for (const alter of [
    value => { value.boardEntries[0].thread_id = 'worker-b'; },
    value => { value.boardEntries = value.boardEntries.filter(row => row.type !== 'CLAIM'); },
    value => { value.services = []; },
    value => { value.services[0].afterConfirmation = false; },
    value => { value.services[0].at = '1970-01-01T00:00:00.000Z'; },
    value => { value.messages[1].user_id = 'message-b'; },
    value => { value.messages[1].message += seed; },
    value => { value.messages[1].create_at = 500; },
    value => { value.pullRequests[1].user.id = 1; },
    value => { value.pullRequests[1].head.sha = 'c'.repeat(40); },
    value => { value.pullRequests = []; value.modelClaim = { number: 2, head: 'b'.repeat(40) }; },
    value => { value.mainFiles['right.txt'] = 'LIVE_T15_RIGHT_ADOPTED guessed\n'; },
    value => { value.boardEntries = value.boardEntries.filter(row => row.type !== 'PATCH_SUMMARY'); },
  ]) { const value = evidence(); alter(value); assert.throws(() => verifyLiveCooperation(value)); }
});

test('unfiltered trusted event ingress hard bounds the whole native run to two kickoffs plus three events', () => {
  const peers = evidence().peers, ingress = createLiveIngress(peers); let delivered = 0;
  const send = key => ingress.ingest(key, { source: 'mattermost', eventId: `arbitrary-${delivered}`, targetWorker: `worker-${key}`, text: 'No marker filtering is permitted' }, () => ++delivered);
  send('a'); send('b'); send('a');
  assert.throws(() => send('b'), { code: 'LIVE_INPUT_ALLOWANCE_REJECTED' });
  assert.throws(() => send('a'), { code: 'LIVE_INPUT_ALLOWANCE_REJECTED' });
  assert.equal(delivered, 3); assert.deepEqual(ingress.snapshot().counts, { a: 2, b: 1 }); assert.equal(ingress.snapshot().rejected, 2);
  const wrong = createLiveIngress(peers);
  assert.throws(() => wrong.ingest('a', { targetWorker: 'worker-b' }, () => ++delivered), { code: 'LIVE_INPUT_ALLOWANCE_REJECTED' });
  assert.equal(delivered, 3);
});

function budget() {
  return { forwarded: 20, maxRequests: 20, peakConcurrent: 2, maxConcurrent: 2, maxOutputTokens: 768, maxAggregateOutputTokens: 15360,
    maxInputBytes: 128 * 1024, maxAggregateInputBytes: 512 * 1024, reservedInputBytes: 2000, rejectedArrivals: 0, reservedOutputTokens: 15360, deadlineReached: false,
    requests: Array.from({ length: 20 }, () => ({ inputBytes: 100, status: 'complete', terminal: 'response.completed', maxOutputTokens: 768, usage: { inputTokens: 100, outputTokens: 25 } })) };
}
test('live acceptance requires exact hard budgets and actual bounded provider usage', () => {
  assert.deepEqual(verifyLiveBudget(budget()), { requests: 20, inputTokens: 2000, outputTokens: 500 });
  for (const alter of [value => { value.forwarded = 21; }, value => { value.peakConcurrent = 3; }, value => { value.reservedOutputTokens++; },
    value => { value.requests[0].usage = undefined; }, value => { value.requests[0].usage.outputTokens = 769; },
    value => { value.requests[0].maxOutputTokens = 769; }, value => { value.requests[0].toolsDisabled = true; },
    value => { value.requests[0].terminal = 'response.failed'; }]) {
    const value = budget(); alter(value); assert.throws(() => verifyLiveBudget(value));
  }
});
