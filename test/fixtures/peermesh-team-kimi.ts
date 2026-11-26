import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const liveTeamLimits = Object.freeze({ setupMs: 180_000, workMs: 180_000, cleanupMs: 100_000,
  agents: 2, inputs: 5, maxRequests: 20, maxConcurrent: 2, generationOutputTokens: 768, maxOutputTokens: 1024, maxAggregateOutputTokens: 15_360, maxInputBytes: 128 * 1024, maxAggregateInputBytes: 512 * 1024 });
export const liveMarkers = ['LIVE_T15_A', 'LIVE_T15_B', 'LIVE_T15_NEGOTIATE', 'LIVE_T15_CONFIRM', 'LIVE_T15_USER'];

export const liveCommon = `This is a small real cooperation acceptance. Use actual Bash and swarm tools. Keep the final text brief. Never print credentials, harness dumps or raw configuration. Never merge, change main, create other Agents or send extra messages.
Use your persistent project root and own WORK_BRANCH. Clone RUN_REPOSITORY into the empty root on the first turn, then create WORK_BRANCH; preserve that checkout. All harness names RUN_OWNER, RUN_REPO, RUN_ISSUE, RUN_BOARD, RUN_CHANNEL and WORK_BRANCH are provided. Git author and credential helper are already configured. Use these supplied fields and Service schemas directly; omit optional issue reads, help/schema discovery and exploratory directory/status checks.
Batch the required work. Each kickoff uses one coherent Bash call for clone, branch creation and its role's initial Service writes. In a negotiated turn, first make one actual Board read to obtain the shared CLAIMs and FACT, parse the returned JSON locally and expose the relevant actual values in that tool result. After observing that result, use one coherent Bash call to write and check your file, commit and push only that file, create the real PR, parse its returned head SHA and number, check that head against Git HEAD, and publish PATCH_SUMMARY using those verified values; A sends CONFIRM at the end of that successful batch. Local commands may parse earlier command output in the same Bash call. After a successful batch, finish the turn briefly. If a concrete error occurs, inspect only what is needed to resolve that error within the existing request/time allowance. Preserve its real result and stop on an uncertain write. This sequence is batching guidance; the existing shared model allowance remains the limit.
CLI syntax: swarm <service> <operation> --input <temporary-json-file> --request-id <fresh-operation-id>. Write JSON to a tiny temporary file, invoke the CLI, parse its JSON stdout and remove the file. Bash is the actual tool for executing these commands. Use a unique request ID for every write; do not retry an uncertain write.
CLI output shapes follow the Service output schemas. board_read returns an unwrapped JSON object with a top-level rendered string. board_grep returns an unwrapped JSON object with total and entries. Parse the FACT and CLAIM text from rendered for board_read, or inspect entries for board_grep, and expose those actual values in the tool result before the contribution step. A successful read already provides its returned data for local parsing.
Allowed operations and input fields: peermesh-context board_write {board_id,type,content,detail?}, board_read {board_id}, board_grep {board_id,words?,types?,limit?}; message post_message {channel_id,message}; gitea pull_request_write {owner,repo,method:"create",title,head:WORK_BRANCH,base:"main"}. Peer identity/viewer/thread is host-assigned, never include it. A successful board_write must return status admitted. FACT/CLAIM content must fit 100 characters. A PATCH_SUMMARY must fit 300 and include files=... | idea=... | evidence=... with real completed checks.
Both peers deliberately publish CLAIM content LIVE_T15_SHARED_COMPONENT on the first turn. These soft CLAIMs may overlap. Resolve the overlap with a real targeted message and agreement before contributions. A owns left.txt; B owns right.txt. Only commit your contribution file and push your own branch, then create one real PR. Check its actual returned head matches your actual Git HEAD. Publish one admitted PATCH_SUMMARY of the checked result; its evidence= field must contain the full verified 40-character Git head SHA and actual PR number. Keep all other helper/evidence files untracked and tiny.
The required left.txt bytes are LIVE_T15_LEFT_ACCEPTED followed by one newline. The required right.txt bytes are LIVE_T15_RIGHT_ADOPTED followed by a space, the exact unique seed from A's Board FACT, and one newline. B must obtain the seed via an actual board_read or board_grep tool call. Do not put the seed in channel messages. Check the exact written bytes before committing. A's FACT content is LIVE_T15_SEED=<seed>. Initial turn: do not create files/PRs yet. Later negotiated turns: create the assigned contribution and PR in this same checkout. After A's contribution, A sends exactly one agreement to B containing LIVE_T15_CONFIRM; B then creates the right contribution and sends no further message. Stop after completing the current turn; future events arrive only after settlement.`;
export const liveAInitial = `LIVE_T15_A: You are A. Your initial batch clones the repository, creates your branch, and publishes the overlapping CLAIM and your private seed as an admitted FACT. Do not send a message yet. Return briefly after that batch. Wait for B's targeted LIVE_T15_NEGOTIATE proposal. In that later turn, use the negotiated Board-read and contribution sequence above, agree to the left/right split, publish the checked left.txt PR and PATCH_SUMMARY, then send B the single LIVE_T15_CONFIRM agreement. Never reveal the seed outside the Board.`;
export const liveBInitial = `LIVE_T15_B: You are B. Your initial batch clones the repository, creates your branch, publishes the overlapping CLAIM, and sends exactly one targeted proposal to A containing LIVE_T15_NEGOTIATE, acknowledging the overlap and proposing A take left.txt while you take right.txt. Return briefly after that batch. Your Board read belongs in your negotiated turn after A's LIVE_T15_CONFIRM agreement; obtain A's unique FACT and both CLAIMs through the real Service, then use the contribution sequence above to create/check/commit/push right.txt using that seed, create its PR and publish its PATCH_SUMMARY. Send no final channel message.`;
export const liveAUser = `LIVE_T15_USER: This external comment targets only A. Use one coherent Bash call in your original checkout and Session to create checkpoint.txt with LIVE_T15_PRIVATE plus one newline and make one private unpushed commit of it. Then change left.txt to LIVE_T15_DIRTY plus one newline without committing, and create untracked.bin with the four bytes 0,255,65,10. Check those bytes locally in the same call. Do not push, create another PR, send a message or modify right.txt. If a concrete error occurs, recover only within the existing request/time allowance and stop on an uncertain write. Return briefly.`;

export function liveTeamInputs({ seed, peerNames }) {
  assert.match(seed, /^[a-f0-9]{24}$/);
  assert.ok(peerNames.a !== peerNames.b);
  return [`${liveCommon}\n${liveAInitial}\nB username: @${peerNames.b}. Private starting seed for A only: ${seed}`,
    `${liveCommon}\n${liveBInitial}\nA username: @${peerNames.a}.`, liveAUser];
}

export function verifyLiveBudget(receipt) {
  assert.equal(receipt.failure, undefined);
  assert.equal(receipt.maxAggregateInputBytes, 512 * 1024);
  assert.equal(receipt.rejectedArrivals, 0);
  assert.equal(receipt.reservedInputBytes, receipt.requests.reduce((sum, row) => sum + row.inputBytes, 0));
  assert.ok(receipt.reservedInputBytes <= 512 * 1024);
  assert.equal(receipt.maxRequests, 20); assert.equal(receipt.maxInputBytes, 128 * 1024);
  assert.ok(receipt.forwarded > 0 && receipt.forwarded <= liveTeamLimits.maxRequests);
  assert.ok(receipt.peakConcurrent <= 2 && receipt.maxConcurrent === 2);
  assert.equal(receipt.maxOutputTokens, 1024); assert.equal(receipt.generationOutputTokens, 768); assert.equal(receipt.maxAggregateOutputTokens, 15360);
  assert.ok(receipt.committedOutputTokens <= 15360 && !receipt.deadlineReached);
  assert.equal(receipt.outstandingOutputTokens, 0);
  const rawOutputTokens = receipt.requests.reduce((sum, row) => sum + row.usage?.outputTokens, 0);
  assert.equal(receipt.settledOutputTokens, rawOutputTokens);
  assert.equal(receipt.observedOutputTokens, rawOutputTokens);
  assert.equal(receipt.committedOutputTokens, rawOutputTokens);
  assert.equal(receipt.requests.length, receipt.forwarded);
  assert.equal(receipt.reservedOutputTokens, receipt.requests.reduce((sum, row) => sum + row.maxOutputTokens, 0));
  for (const row of receipt.requests) {
    assert.notEqual(row.toolsDisabled, true);
    assert.equal(row.status, 'complete'); assert.equal(row.terminal, 'response.completed');
    assert.equal(row.maxOutputTokens, 1024);
    assert.ok(Number.isSafeInteger(row.generationOutputTokens) && row.generationOutputTokens > 0 && row.generationOutputTokens <= 768);
    assert.equal(row.requestTargetOverrun, row.usage?.outputTokens > row.generationOutputTokens);
    assert.ok(Number.isSafeInteger(row.usage?.inputTokens) && row.usage.inputTokens >= 0);
    assert.ok(Number.isSafeInteger(row.usage?.outputTokens) && row.usage.outputTokens >= 0 && row.usage.outputTokens <= row.maxOutputTokens);
  }
  return { requests: receipt.forwarded, inputTokens: receipt.requests.reduce((sum, row) => sum + row.usage.inputTokens, 0),
    outputTokens: receipt.requests.reduce((sum, row) => sum + row.usage.outputTokens, 0) };
}

export function recordLiveBudget(report, receipt) {
  try {
    report.modelUsage = verifyLiveBudget(receipt);
  } catch (error) {
    if (error.code !== 'ERR_ASSERTION') throw error;
    const code = receipt.failure?.code ?? 'LIVE_BUDGET_INVALID';
    report.budgetFailure = { code };
    report.businessFailure ??= { stage: 'usage', code };
    report.failure = true;
  }
}

// Only authenticated facility observations and exact main bytes enter this proof.
// Model final text and model-supplied PR/head JSON are deliberately absent.
export function verifyLiveCooperation({ seed, peers, boardEntries, messages, pullRequests, branchHeads, mainFiles, services }) {
  const fact = boardEntries.find(row => row.type === 'FACT' && row.thread_id === peers[0].board.workerId && row.content === `LIVE_T15_SEED=${seed}`);
  assert.ok(fact, 'A must publish the exact private FACT');
  const claims = peers.map(peer => boardEntries.find(row => row.type === 'CLAIM' && row.thread_id === peer.board.workerId && row.content === 'LIVE_T15_SHARED_COMPONENT'));
  assert.ok(claims.every(Boolean));
  const ordinary = messages.filter(row => !row.type);
  const proposal = ordinary.find(row => row.user_id === peers[1].message.accountId && row.message.includes(`@${peers[0].gitea.username}`) && row.message.includes(liveMarkers[2]));
  const agreement = ordinary.find(row => row.user_id === peers[0].message.accountId && row.message.includes(`@${peers[1].gitea.username}`) && row.message.includes(liveMarkers[3]));
  assert.ok(proposal && agreement && proposal.create_at <= agreement.create_at);
  assert.ok(claims.every(row => Number.isFinite(row.ts_epoch) && row.ts_epoch * 1000 <= agreement.create_at));
  for (const peer of peers) assert.equal(ordinary.filter(row => row.user_id === peer.message.accountId).length, 1);
  assert.ok(messages.every(row => !row.message.includes(seed)), 'The seed travels only through Board');
  const read = services.find(row => row.peerKey === 'b' && row.afterConfirmation === true && ['board_read', 'board_grep'].includes(row.operation) && row.state === 'settled' && row.outcome === 'succeeded' &&
    Number.isFinite(fact.ts_epoch) && Date.parse(row.at) >= fact.ts_epoch * 1000);
  assert.ok(read);
  const pins = deriveLivePins({ peers, pullRequests, branchHeads });
  const summaries = peers.map((peer, index) => boardEntries.find(row => row.type === 'PATCH_SUMMARY' && row.thread_id === peer.board.workerId && row.content.includes(pins[index].headSha)));
  assert.ok(summaries.every(Boolean));
  for (const row of [fact, ...claims, ...summaries]) assert.ok(Number.isSafeInteger(row.id) && row.id > 0 && row.label === `G${row.id}` && Number.isFinite(row.ts_epoch));
  assert.ok(typeof proposal.id === 'string' && proposal.id && typeof agreement.id === 'string' && agreement.id);
  assert.ok(typeof read.operationId === 'string' && read.operationId && Number.isSafeInteger(read.seq) && read.seq > 0 && typeof read.confirmationInputId === 'string' && read.confirmationInputId);
  assert.equal(mainFiles['left.txt'], 'LIVE_T15_LEFT_ACCEPTED\n');
  assert.equal(mainFiles['right.txt'], `LIVE_T15_RIGHT_ADOPTED ${seed}\n`);
  const boardRow = row => ({ id: row.id, label: row.label, type: row.type, workerId: row.thread_id, content: row.content, at: row.ts_epoch });
  const messageRow = row => ({ id: row.id, accountId: row.user_id, at: row.create_at });
  return { pins, fact: boardRow(fact), claims: claims.map(boardRow), summaries: summaries.map(boardRow),
    proposal: messageRow(proposal), agreement: messageRow(agreement),
    read: { operationId: read.operationId, seq: read.seq, at: read.at, confirmationInputId: read.confirmationInputId },
    main: Object.fromEntries(Object.entries(mainFiles).map(([path, bytes]) => [path, { bytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') }])) };
}

export function createLiveIngress(peers) {
  const limits = { a: 2, b: 1 }, counts = { a: 0, b: 0 }, records = []; let rejected = 0;
  assert.deepEqual(peers.map(peer => peer.key), ['a', 'b']);
  return {
    ingest(key, event, deliver) {
      const peer = peers.find(peer => peer.key === key);
      if (!peer || event.targetWorker !== peer.board.workerId || counts[key] >= limits[key]) {
        rejected++; throw Object.assign(new Error('LIVE_INPUT_ALLOWANCE_REJECTED'), { code: 'LIVE_INPUT_ALLOWANCE_REJECTED' });
      }
      counts[key]++;
      records.push({ key, source: event.source, eventId: event.eventId, targetWorker: event.targetWorker });
      return deliver(event);
    },
    snapshot: () => structuredClone({ limits, counts, rejected, records }),
  };
}

export function deriveLivePins({ peers, pullRequests, branchHeads }) {
  assert.equal(peers.length, 2); assert.equal(pullRequests.length, 2);
  return peers.map(peer => {
    const own = pullRequests.filter(pr => String(pr.user?.id) === peer.gitea.accountId && pr.head?.ref === peer.branch && pr.base?.ref === 'main');
    assert.equal(own.length, 1); const pr = own[0];
    assert.ok(Number.isSafeInteger(pr.number) && pr.number > 0); assert.match(pr.head.sha, /^[a-f0-9]{40}$/);
    assert.equal(pr.head.sha, branchHeads[peer.key]);
    return { peerKey: peer.key, number: pr.number, headSha: pr.head.sha };
  });
}

export function checkLiveFile(value, path, expected) {
  assert.equal(value?.type, 'file'); assert.equal(value.path, path); assert.equal(value.encoding, 'base64');
  assert.ok(typeof value.content === 'string' && value.content.length <= 4096);
  const compact = value.content.replace(/\s/g, '');
  const bytes = Buffer.from(compact, 'base64'); assert.equal(bytes.toString('base64'), compact);
  assert.equal(bytes.length, value.size); assert.equal(bytes.toString(), expected);
}
