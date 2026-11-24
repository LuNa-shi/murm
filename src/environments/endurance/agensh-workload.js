import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { httpClient } from '../agensh/http.js';
import { createProgrammingContract } from './programming.js';
import { createAgenshDelivery } from '../agensh/delivery.js';

const invalid = () => Object.assign(new Error('HOUR_AGENSH_ARTIFACT_INVALID'), { code: 'HOUR_AGENSH_ARTIFACT_INVALID' });
const requireEvidence = value => { if (!value) throw invalid(); };
const digest = value => createHash('sha256').update(value).digest('hex');
const e = encodeURIComponent;

/** Frozen, independently checkable Git/Board workload. Each phase writes new
 * files; final PRs are pinned, merged once and read back from immutable main.
 * A is stopped before the host's targeted external comment triggers B's final
 * adoption. Every event and business read uses the existing real adapters. */
export function createAgenshArithmeticWorkload({ getFacilities, adminToken, programming }) {
  if (typeof getFacilities !== 'function' || typeof adminToken !== 'string' || !adminToken) throw new TypeError('Agensh hour workload needs owned facilities and host Git credential');
  const program = createProgrammingContract(programming);
  let facilities, git, board, delivery, scope, publisherStop;
  const seen = new Set();
  function initialize() {
    if (facilities) return;
    facilities = getFacilities();
    requireEvidence(facilities?.peers?.length === 8);
    git = httpClient(facilities.endpoints.gitea, `token ${adminToken}`);
    board = httpClient(facilities.endpoints.board);
    scope = `/api/v1/repos/${e(facilities.repository.owner)}/${e(facilities.repository.name)}`;
    delivery = createAgenshDelivery({ facilities, adminToken });
  }
  function input(peer, stage) {
    const index = facilities.peers.indexOf(peer), n = 17 * (index + 1) + stage;
    const path = `hour-${peer.key}-${stage}.json`, fact = `HOUR_${peer.key}_${stage}_${n * n}`;
    return `HOUR_STAGE_${stage}_${peer.key}: Work only on your own WORK_BRANCH. On stage 0 clone RUN_REPOSITORY into the empty project root and create WORK_BRANCH; later stages reuse this exact checkout. Create ${path} with JSON {"peer":"${peer.key}","stage":${stage},"n":${n},"square":${n * n}} and exactly one trailing newline. Check its bytes, commit and push. Publish one admitted FACT with content ${fact} through swarm agensh-context board_write {board_id:RUN_BOARD,type:"FACT",content:"${fact}"}. Never send unsolicited messages or comments. At stage 4, create one real PR from WORK_BRANCH to main through swarm gitea pull_request_write after push, and finish briefly. ${peer.key === 'b' && stage === 4 ? 'Before writing, use actual authenticated Git/Gitea to read hour-a-4.json from main (A has already stopped), parse the original square, and add adoptedSquare and sum to your JSON: adoptedSquare is the read value, sum is your square plus that value. Preserve all other files.' : ''} Use one coherent Bash call per turn for the finite work. Board write fields are board_id,type,content; PR create fields are owner,repo,method:"create",title,head:WORK_BRANCH,base:"main". Use the existing Service schemas and Bash CLI; do not fabricate acknowledgements, addresses or SHAs. Stop the turn after these finite operations.${stage === 0 ? '' : program.prompt(index, stage)}`;
  }
  async function verify(peer, stage, signal) {
    const branch = await git('GET', `${scope}/branches/${e(peer.branch)}`, undefined, { signal });
    const commit = branch?.commit?.id;
    requireEvidence(branch?.name === peer.branch && /^[a-f0-9]{40}$/.test(commit ?? '') && !seen.has(`${peer.key}:${commit}`));
    const path = `hour-${peer.key}-${stage}.json`;
    const file = await git('GET', `${scope}/contents/${path}?ref=${commit}`, undefined, { signal });
    requireEvidence(file?.type === 'file' && file.path === path && file.encoding === 'base64' && typeof file.content === 'string' && file.content.length < 4096);
    const bytes = Buffer.from(file.content.replace(/\s/g, ''), 'base64');
    requireEvidence(bytes.length === file.size && bytes.length < 2048 && bytes.at(-1) === 10);
    let value; try { value = JSON.parse(bytes); } catch { throw invalid(); }
    const n = 17 * (facilities.peers.indexOf(peer) + 1) + stage;
    requireEvidence(value.peer === peer.key && value.stage === stage && value.n === n && value.square === n * n);
    if (stage > 0) await program.verify(facilities.peers.indexOf(peer), stage, value);
    if (peer.key === 'b' && stage === 4) requireEvidence(value.adoptedSquare === 441 && value.sum === n * n + 441);
    const facts = await board('GET', `/board/${e(facilities.boardId)}/grep?viewer=${e(peer.board.workerId)}&types=FACT&limit=50`, undefined, { signal });
    requireEvidence(Array.isArray(facts?.entries) && facts.entries.filter(row => row.thread_id === peer.board.workerId && row.type === 'FACT' && row.content === `HOUR_${peer.key}_${stage}_${n * n}`).length === 1);
    seen.add(`${peer.key}:${commit}`);
    if (stage === 4) {
      const requests = await git('GET', `${scope}/pulls?state=open&limit=16`, undefined, { signal });
      requireEvidence(Array.isArray(requests) && requests.length < 16);
      const matches = requests.filter(row => row.head?.ref === peer.branch && row.head?.sha === commit && String(row.user?.id) === peer.gitea.accountId);
      requireEvidence(matches.length === 1);
      await delivery.merge({ peerKey: peer.key, number: matches[0].number, headSha: commit, signal });
      const main = await delivery.readMainFile(path, { signal, maxBytes: 2048 });
      requireEvidence(main.data.equals(bytes));
    }
    return { reference: `git:${peer.key}:${commit}:${path}`, sha256: digest(bytes) };
  }
  return Object.freeze({
    async phase(team, index, { signal, timeoutMs }) {
      initialize(); const stage = index + 1, contributions = [];
      for (const peer of facilities.peers) {
        signal.throwIfAborted(); let batch;
        if (stage === 4 && peer.key === 'b') {
          requireEvidence(publisherStop?.execution === 'stopped');
          const marker = `HOUR_STAGE_4_b`;
          await git('POST', `${scope}/issues/${facilities.issueNumber}/comments`, { body: `@${peer.gitea.username} ${input(peer, stage)}` }, { signal });
          const end = performance.now() + timeoutMs;
          while (!batch) {
            signal.throwIfAborted(); requireEvidence(performance.now() < end);
            await team.poll();
            const view = team.currentPeers().peers.find(row => row.key === peer.key);
            const matches = view.router.batches.filter(row => row.source === 'gitea' && row.text.includes(marker));
            requireEvidence(matches.length <= 1); batch = matches[0];
            if (!batch) await delay(100, undefined, { signal });
          }
        } else batch = stage === 0 ? team.kickoff(peer.key, input(peer, stage)) : team.ingest(peer.key, {
          source: 'user', kind: 'user', eventId: `hour:${stage}:${peer.key}`, targetWorker: peer.board.workerId, text: input(peer, stage),
        });
        const settled = await team.wait(peer.key, batch.batchId, { timeoutMs, signal });
        requireEvidence(settled.state === 'completed');
        const proof = await verify(peer, stage, signal);
        contributions.push({ peerKey: peer.key, batchId: batch.batchId, proof });
        if (stage === 4 && peer.key === 'a') {
          publisherStop = await team.stopPeer('a', { timeoutMs });
          requireEvidence(publisherStop.botId === team.currentPeers().peers.find(row => row.key === 'a').botId && publisherStop.execution === 'stopped');
        }
      }
      let handoff;
      if (stage === 4) {
        // Re-polling must not create a second batch for the same external event.
        const before = team.currentPeers().peers.find(row => row.key === 'b');
        const target = before.router.batches.filter(row => row.source === 'gitea' && row.text.includes('HOUR_STAGE_4_b'));
        await team.poll();
        const after = team.currentPeers().peers.find(row => row.key === 'b');
        requireEvidence(target.length === 1 && after.router.batches.filter(row => row.batchId === target[0].batchId).length === 1 &&
          after.subscription.records.filter(row => row.batchId === target[0].batchId && row.source === 'gitea').length === 1);
        for (const contribution of contributions) {
          const retained = await delivery.readMainFile(`hour-${contribution.peerKey}-4.json`, { signal, maxBytes: 2048 });
          requireEvidence(digest(retained.data) === contribution.proof.sha256);
        }
        const original = await delivery.readMainFile('hour-a-4.json', { signal, maxBytes: 2048 });
        const successor = await delivery.readMainFile('hour-b-4.json', { signal, maxBytes: 2048 });
        requireEvidence(JSON.parse(original.data).square === JSON.parse(successor.data).adoptedSquare);
        handoff = { kind: 'agensh-stopped-publisher-main-adoption', reference: target[0].batchId,
          sha256: digest(JSON.stringify({ original: digest(original.data), successor: digest(successor.data), inputId: target[0].inputId, stop: publisherStop.execution })) };
      }
      return { contributions, ...(handoff ? { handoff } : {}) };
    },
  });
}
