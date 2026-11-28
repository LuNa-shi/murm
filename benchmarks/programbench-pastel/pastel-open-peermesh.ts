import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createPeerMeshDelivery } from '../../dist/examples/peermesh/harness/delivery.js';
import { httpClient } from '../../dist/src/harness/http.js';
import { preparePeerMeshFacilities } from '../../dist/examples/peermesh/harness/provision.js';
import { createPeerMeshTeam } from '../../dist/examples/peermesh/harness/team.js';
import { createLocalPeerMeshStack, facilityImages } from '../../dist/test/fixtures/peermesh-local-stack.js';
import { checkpointSource } from './source-checkpoint.ts';
import { sha256 } from './case.ts';

const peerWork = {
  a: 'Implement a reusable color-input parsing component. Publish a small initial contribution early. Use Python 3 standard library if no language is agreed. Post a Board FACT with its file path, interface and a reference observation. Commit only your component, push it and open a PR from your assigned branch.',
  b: 'Implement an independent color-output formatting or conversion component. Publish a small initial contribution early. Use Python 3 standard library if no language is agreed. Post a Board FACT with its file path, interface and a reference observation. Commit a separate component file, push it and open a PR from your assigned branch.',
  c: 'Read both earlier peers’ Board FACTs and use their components from the current main. Implement the CLI and offline build (compile.sh). Prioritize a runnable subset and verify it with the reference. Commit and push the full candidate and open a PR. Return plain JSON {"adopted_files":["relative file path"],"checks":["reference command and observed result"]}.',
};
const gitSha = /^[a-f0-9]{40}$/;
const encodePath = path => path.split('/').map(encodeURIComponent).join('/');

async function sourceAt(git, repo, commit, signal) {
  if (!gitSha.test(commit)) throw new Error('Gitea source requires a pinned commit');
  const files = {};
  let totalBytes = 0;
  const entries = [''];
  for (let index = 0; index < entries.length; index++) {
    signal.throwIfAborted();
    const base = entries[index];
    const listing = await git('GET', `${repo}/contents${base ? '/' + encodePath(base) : ''}?ref=${commit}`, undefined, { signal });
    if (!Array.isArray(listing)) throw new Error('Invalid pinned Gitea directory');
    for (const entry of listing) {
      if (!/^[A-Za-z0-9_.-]+$/.test(entry.name ?? '') || entry.path !== (base ? `${base}/${entry.name}` : entry.name)) {
        throw new Error('Invalid pinned Gitea path');
      }
      if (['.', '..', '.git', '__pycache__'].includes(entry.name) || entry.path === 'executable') continue;
      if (entries.length + Object.keys(files).length >= 4096) throw new Error('Exceeded source entry limit');
      if (entry.type === 'dir') {
        entries.push(entry.path);
        continue;
      }
      if (entry.type !== 'file' || !Number.isSafeInteger(entry.size) || entry.size < 0 || !gitSha.test(entry.sha) ||
          entry.size > 1_000_000 || (totalBytes += entry.size) > 8 * 1024 ** 2) throw new Error('Invalid pinned Gitea blob');
      const item = await git('GET', `${repo}/contents/${encodePath(entry.path)}?ref=${commit}`, undefined, { signal });
      if (item?.encoding !== 'base64' || item.type !== 'file' || item.sha !== entry.sha ||
          item.path !== entry.path || typeof item.content !== 'string') throw new Error('Invalid pinned Gitea file');
      const bytes = Buffer.from(item.content, 'base64');
      if (bytes.length !== entry.size ||
          createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== entry.sha) {
        throw new Error('Gitea file digest mismatch');
      }
      Object.defineProperty(files, entry.path, { value: bytes, enumerable: true });
    }
  }
  return files;
}

function declaredAdoption(batch) {
  try {
    const output = batch.settled?.output?.trim().replace(/^\x60\x60\x60(?:json)?\s*/, '').replace(/\s*\x60\x60\x60$/, '');
    const files = JSON.parse(output).adopted_files;
    return Array.isArray(files) ? [...new Set(files.filter(file => typeof file === 'string'))] : [];
  } catch {
    return [];
  }
}

const execute = promisify(execFile);

export async function resolvePeerMeshImages() {
  const board = process.env.PROGRAMBENCH_BOARD_IMAGE ?? facilityImages.board;
  if (!/^sha256:[a-f0-9]{64}$/.test(board)) throw new Error('Provide a local Board image ID');
  const references = {
    mysql: `mysql@${facilityImages.mysql}`,
    mattermost: `mattermost/mattermost-team-edition@${facilityImages.mattermost}`,
    gitea: `docker.gitea.com/gitea@${facilityImages.gitea}`,
    board,
  };
  const images = await Promise.all(Object.entries(references).map(async ([name, ref]) => {
    const { stdout } = await execute('docker', ['image', 'inspect', '--format', '{{.Id}}', ref], { timeout: 10_000 });
    return [name, stdout.trim()];
  }));
  return { references, images: Object.fromEntries(images) };
}

export async function runOpenPeerMesh({ state, task, window, start, deadline, image, runtimeSettings, outputDir, durationMs, peerMeshImages }) {
  state.stage = 'peermesh-startup';
  const { images } = peerMeshImages ?? await resolvePeerMeshImages();
  const stack = await createLocalPeerMeshStack({ directory: join(outputDir, 'facilities'), setupMs: 120_000,
    advertiseHost: process.env.MURM_CORE_TEST_ADVERTISE_HOST, images });
  const runId = `pastel-${randomBytes(6).toString('hex')}`;
  let team, facilities;
  try {
    const configuration = await stack.start();
    const git = httpClient(configuration.gitea.origin, `token ${configuration.gitea.adminToken}`);
    const repo = () => `/api/v1/repos/${encodeURIComponent(facilities.repository.owner)}/${encodeURIComponent(facilities.repository.name)}`;
    team = await createPeerMeshTeam({ ...configuration, runId, image, outputDir, ...runtimeSettings, signal: window.signal,
      peerKeys: ['a', 'b', 'c'],
      router: { workTimeoutMs: durationMs + 120_000, turnTimeoutMs: durationMs, maxBatches: 32,
        maxNudges: 0, events: { pollIntervalMs: 2500, maxPolls: Math.ceil((durationMs + 120_000) / 2500) } },
      prepare: async options => {
        facilities = await preparePeerMeshFacilities(options);
        await git('PATCH', `${repo()}/issues/${facilities.issueNumber}`, { title: 'Rebuild Pastel', body: task });
        return facilities;
      },
    });
    state.runtimeId = team.id;
    const initialCommit = (await git('GET', `${repo()}/branches/main`)).commit.id;
    const peers = team.snapshot().peers;
    const delivery = createPeerMeshDelivery({ facilities, adminToken: configuration.gitea.adminToken });
    const signal = window.signal;
    const initial = await sourceAt(git, repo(), initialCommit, signal);
    state.stage = 'peermesh-work';
    state.peerIds = Object.fromEntries(peers.map(({ key, agentId }) => [key, agentId]));
    state.pinnedPullRequests = [];
    start();
    const components = new Map();
    let previous = initial;
    const kickoff = key => team.kickoff(key, `${task}\n\n${peerWork[key]}`);
    const batches = { a: kickoff('a'), b: kickoff('b') };
    for (const key of ['a', 'b', 'c']) {
      signal.throwIfAborted();
      const batch = batches[key] ?? kickoff(key);
      const turn = await team.wait(key, batch.batchId, { timeoutMs: Math.max(1, Math.ceil(window.remainingMs())), signal });
      if (turn.state !== 'completed') throw Object.assign(new Error('PeerMesh work failed'), { code: turn.code ?? 'PEERMESH_WORK_FAILED' });
      const peer = facilities.peers.find(row => row.key === key);
      const pulls = await git('GET', `${repo()}/pulls?state=open`, undefined, { signal });
      const own = pulls.filter(pr => String(pr.user?.id) === peer.gitea.accountId &&
        pr.head?.ref === peer.branch && pr.base?.ref === 'main');
      if (own.length !== 1) throw Object.assign(new Error('Expected one open authored pull request'), { code: 'PEERMESH_PR_MISSING' });
      const pin = await delivery.merge({ peerKey: key, number: own[0].number, headSha: own[0].head.sha, signal });
      state.pinnedPullRequests.push({ ...pin, agentId: state.peerIds[key], inputId: turn.inputId });
      const files = await sourceAt(git, repo(), pin.mergeSha, signal);
      if (key !== 'c') components.set(key, { commit: pin.mergeSha,
        files: Object.fromEntries(Object.entries(files).filter(([name, bytes]) => !previous[name]?.equals(bytes))) });
      previous = files;
      if (!Object.hasOwn(files, 'compile.sh')) continue;
      const adopted = [];
      if (key === 'c') {
        const evidenceRaw = await readFile(join(outputDir, team.id, 'evidence.jsonl'), 'utf8');
        const services = evidenceRaw.trim().split('\n').map(line => JSON.parse(line)).filter(row =>
          row.type === 'service' && row.state === 'settled' && row.outcome === 'succeeded');
        for (const [author, contribution] of components) {
          const write = services.find(row => row.agentId === state.peerIds[author] && row.operation === 'board_write');
          const board = services.find(row => row.agentId === state.peerIds.c && row.operation === 'board_read' && row.seq > write?.seq);
          if (write && board) for (const name of declaredAdoption(turn)) {
            if (Object.hasOwn(contribution.files, name) && files[name]?.equals(contribution.files[name])) adopted.push({
              agentId: state.peerIds[author], consumedBy: state.peerIds.c, commit: contribution.commit, file: name, sha256: sha256(files[name]),
              boardWriteSeq: write.seq, boardReadSeq: board.seq, boardReadOperationId: board.operationId,
            });
          }
        }
      }
      const checkpoint = await checkpointSource({ window, outputDir, files, sourceRevision: `git:${pin.mergeSha}` });
      state.evidence.push({ candidateSha256: checkpoint.sha256, by: state.peerIds[key], commit: pin.mergeSha, adopted });
    }
    await deadline;
  } finally {
    try {
      if (team) state.cleanup = (await team.close({ timeoutMs: 35_000 })).cleanup;
    } finally {
      const result = await stack.close();
      state.facilityCleanup = result.cleanup;
      state.remainingFacilities = result.remaining;
    }
  }
}
