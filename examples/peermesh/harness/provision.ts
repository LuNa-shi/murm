import { randomBytes } from 'node:crypto';
import { seedTeamRepository } from '../../../src/harness/project-git.js';
import { httpClient } from '../../../src/harness/http.js';

export const initialFile = 'INITIAL\n';
export const initialIssue = 'Apply the fixed acceptance change on your private branch; preserve the second-turn private checkpoint.';
const e = encodeURIComponent;
const requireString = (value: any) => { if (typeof value !== 'string' || !value) throw new TypeError('Incomplete PeerMesh facility configuration'); return value; };

/** Prepare only new run resources. Shared Git/channel/board data is retained. */
export async function preparePeerMeshFacilities({ runId, gitea, mattermost, startBoard, resources, signal, peerKeys, project, projectFiles }: any) {
  if (typeof runId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(runId) || typeof startBoard !== 'function') throw new TypeError('Invalid PeerMesh run or board launcher');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('PeerMesh startup signal must be an AbortSignal');
  const check = () => { if (signal?.aborted) throw Object.assign(new Error('PeerMesh startup aborted'), { code: 'HARNESS_START_ABORTED' }); };
  check();
  const rawGit = httpClient(gitea.origin, `token ${requireString(gitea.adminToken)}`);
  const rawMm = httpClient(mattermost.origin, `Bearer ${requireString(mattermost.adminToken)}`);
  const startup = (request: any) => async (method: any, path: any, body?: unknown, options?: { allow404?: boolean; signal?: AbortSignal }) => {
    check();
    try {
      const result = await request(method, path, body, { ...options, signal });
      check(); return result;
    } catch (error: any) { check(); throw error; }
  };
  const git = startup(rawGit), mm = startup(rawMm);
  const owner = requireString(gitea.owner); const teamId = requireString(mattermost.teamId);
  const keys = peerKeys ?? ['peer'];
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 8 || new Set(keys).size !== keys.length ||
      keys.some((key: any) => typeof key !== 'string' || !/^[a-z][a-z0-9-]{0,15}$/.test(key))) throw new TypeError('Invalid PeerMesh peer keys');
  if (project !== undefined && (!project || typeof project.title !== 'string' || !project.title.trim() || project.title.length > 255 ||
      typeof project.body !== 'string' || !project.body.trim() || Buffer.byteLength(project.body) > 16_000 ||
      (project.seed !== undefined && (!project.seed || typeof project.seed !== 'object' || Array.isArray(project.seed) ||
        Object.keys(project.seed).length > 64 || Object.entries(project.seed).some(([path, data]) =>
          !path.split('/').every(part => /^(?!\.\.?$)(?!\.git$)[a-z0-9_.-]+$/i.test(part)) ||
          typeof data !== 'string' || Buffer.byteLength(data) > 64 * 1024))))) throw new TypeError('Invalid PeerMesh project goal or seed');
  const repository: any = { owner, name: `run-${runId}` };
  const repo = `/api/v1/repos/${e(owner)}/${e(repository.name)}`;
  const repositoryUrl = `${gitea.origin.replace(/\/$/, '')}/${e(owner)}/${e(repository.name)}.git`;
  let initialCommit: string | undefined;
  const boardId = `board-${runId}`;
  await Promise.all([git('GET', '/api/v1/version'), mm('GET', '/api/v4/system/ping'), mm('GET', `/api/v4/teams/${e(teamId)}`)]);
  const admin = await git('GET', '/api/v1/user');
  if (admin?.login !== owner) throw new TypeError('Gitea owner must be the configured provisioning account');
  let issue: any, channel: any;
  const peers: any[] = [];
  for (const key of keys) {
    const suffix = peerKeys ? `${runId}-${key}` : runId;
    const username = `peer-${suffix}`; const email = `${username}-${randomBytes(8).toString('hex')}@murm.invalid`;
    const password = randomBytes(32).toString('base64url');
    const rawAccountGit = httpClient(gitea.origin, `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
    const accountGit = startup(rawAccountGit);
    const tokenName = `murm-${suffix}`;
    // Intent precedes the remote write. Unknown outcomes remain reconcilable by
    // the unique email instead of deleting an unrelated pre-existing account.
    let gitUser: any; let gitAccountCreateUnknown = false; let gitTokenCreateUnknown = false; let gitTokensRevoked = false;
    resources.own({ kind: 'gitea-account', id: username, close: async () => {
      const account = gitUser ?? await rawGit('GET', `/api/v1/users/${e(username)}`, undefined, { allow404: true });
      if (!account) { if (gitAccountCreateUnknown) throw new Error('Account create remains unknown'); return; }
      if (account.email !== email) throw new Error('unconfirmed owner');
      if (!gitTokensRevoked) {
        const tokens = await rawAccountGit('GET', `/api/v1/users/${e(username)}/tokens`);
        if (!Array.isArray(tokens)) throw new Error('unconfirmed tokens');
        const owned = tokens.filter((item: any) => item.name === tokenName);
        if (gitTokenCreateUnknown && !owned.length) throw new Error('Token create remains unknown');
        for (const token of owned) await rawAccountGit('DELETE', `/api/v1/users/${e(username)}/tokens/${e(String(token.id))}`);
        gitTokensRevoked = true;
      }
      await rawGit('PATCH', `/api/v1/admin/users/${e(username)}`, { login_name: username, email, prohibit_login: true });
    } });
    gitAccountCreateUnknown = true;
    gitUser = await git('POST', '/api/v1/admin/users', { username, login_name: username, email, password, must_change_password: false,
      restricted: true, max_repo_creation: 0, allow_create_organization: false });
    gitAccountCreateUnknown = false;
    if (!Number.isSafeInteger(gitUser?.id)) throw new TypeError('Gitea did not return account identity');
    gitUser = { ...gitUser, email };
    if (!issue) {
      resources.own({ kind: 'repository-create-intent', id: `${owner}/${repository.name}`, retained: true });
      await git('POST', `/api/v1/admin/users/${e(owner)}/repos`, { name: repository.name, private: true, auto_init: projectFiles === undefined, default_branch: 'main' });
      resources.own({ kind: 'repository', id: `${owner}/${repository.name}`, retained: true });
      if (project) {
        if (projectFiles !== undefined) initialCommit = await seedTeamRepository({ files: projectFiles, url: repositoryUrl, owner, token: gitea.adminToken, signal });
        else for (const [path, data] of Object.entries(project.seed ?? {})) {
          await git('POST', `${repo}/contents/${path.split('/').map(e).join('/')}`, {
            branch: 'main', message: 'Seed project input', content: Buffer.from(data as string).toString('base64'),
          });
        }
        await git('POST', `${repo}/branch_protections`, { rule_name: 'main', enable_push: false, enable_force_push: false,
          enable_merge_whitelist: true, merge_whitelist_usernames: [owner], required_approvals: 0 });
      } else {
        await git('POST', `${repo}/contents/acceptance.txt`, { branch: 'main', message: 'Seed fixed acceptance input', content: Buffer.from(initialFile).toString('base64') });
      }
      issue = await git('POST', `${repo}/issues`, project ? { title: project.title, body: project.body }
        : { title: peerKeys ? 'Fixed peer collaboration acceptance' : 'Fixed single-peer acceptance', body: initialIssue });
      if (!Number.isSafeInteger(issue?.number)) throw new TypeError('Gitea did not return issue identity');
    }
    await git('PUT', `${repo}/collaborators/${e(username)}`, { permission: 'write' });
    gitTokenCreateUnknown = true;
    const gitToken = await accountGit('POST', `/api/v1/users/${e(username)}/tokens`, { name: tokenName, scopes: ['read:user', 'write:repository', 'write:issue'] });
    gitTokenCreateUnknown = false;
    requireString(gitToken?.sha1);
    let mmUser: any; let mmAccountCreateUnknown = false; let mmTokenCreateUnknown = false;
    resources.own({ kind: 'mattermost-account', id: username, close: async () => {
      const account = mmUser ?? await rawMm('GET', `/api/v4/users/username/${e(username)}`, undefined, { allow404: true });
      if (!account) { if (mmAccountCreateUnknown) throw new Error('Account create remains unknown'); return; }
      if (account.email !== email) throw new Error('unconfirmed owner');
      await rawMm('PUT', `/api/v4/users/${e(account.id)}/active`, { active: false });
    } });
    mmAccountCreateUnknown = true;
    mmUser = await mm('POST', '/api/v4/users', { username, email, password, email_verified: true });
    mmAccountCreateUnknown = false;
    requireString(mmUser?.id);
    // Keep the email for ownership reconciliation even if an upstream minimizes
    // the create response. A successful creation is the authoritative ownership.
    mmUser = { ...mmUser, email };
    await mm('POST', `/api/v4/teams/${e(teamId)}/members`, { team_id: teamId, user_id: mmUser.id });
    if (!channel) {
      resources.own({ kind: 'channel-create-intent', id: `${teamId}/run-${runId}`, retained: true });
      channel = await mm('POST', '/api/v4/channels', { team_id: teamId, name: `run-${runId}`, display_name: `Run ${runId}`, type: 'P' });
      requireString(channel?.id);
      resources.own({ kind: 'channel', id: channel.id, retained: true });
    }
    await mm('POST', `/api/v4/channels/${e(channel.id)}/members`, { user_id: mmUser.id });
    const mmTokenName = `murm-${suffix}`;
    resources.own({ kind: 'mattermost-token', id: mmTokenName, close: async () => {
      const tokens = await rawMm('GET', `/api/v4/users/${e(mmUser.id)}/tokens?page=0&per_page=200`);
      if (!Array.isArray(tokens)) throw new Error('unconfirmed tokens');
      const owned = tokens.filter((item: any) => item.description === mmTokenName);
      if (mmTokenCreateUnknown && !owned.length) throw new Error('Token create remains unknown');
      for (const token of owned) await rawMm('POST', '/api/v4/users/tokens/revoke', { token_id: token.id });
    } });
    mmTokenCreateUnknown = true;
    const mmToken = await mm('POST', `/api/v4/users/${e(mmUser.id)}/tokens`, { description: mmTokenName });
    mmTokenCreateUnknown = false;
    requireString(mmToken?.token);
    const workerId = `worker-${suffix}`;
    const binding = peerKeys ? `${runId}:${key}` : runId;
    peers.push({ key, branch: `peer-${suffix}`,
      gitea: { binding: `${binding}:gitea`, accountId: String(gitUser.id), username, token: gitToken.sha1 },
      message: { binding: `${binding}:message`, accountId: mmUser.id, token: mmToken.token },
      board: { binding: `${binding}:board`, workerId } });
    await Promise.all([startup(httpClient(gitea.origin, `token ${gitToken.sha1}`))('GET', `${repo}/issues/${issue.number}`),
      startup(httpClient(mattermost.origin, `Bearer ${mmToken.token}`))('GET', `/api/v4/channels/${e(channel.id)}`)]);
  }
  const directChannels: Record<string, Record<string, string>> = Object.fromEntries(peers.map(peer => [peer.key, {}]));
  if (project) {
    for (const [index, sender] of peers.entries()) {
      const send = startup(httpClient(mattermost.origin, `Bearer ${sender.message.token}`));
      for (const recipient of peers.slice(index + 1)) {
        const ids = [sender.message.accountId, recipient.message.accountId];
        const dm = await send('POST', '/api/v4/channels/direct', ids);
        if (dm?.type !== 'D' || dm.name?.split('__').sort().join('__') !== ids.sort().join('__')) throw new TypeError('Unexpected direct channel membership');
        requireString(dm.id);
        directChannels[sender.key][recipient.key] = dm.id;
        directChannels[recipient.key][sender.key] = dm.id;
        resources.own({ kind: 'direct-channel', id: dm.id, retained: true });
      }
    }
  }
  resources.own({ kind: 'board-create-intent', id: boardId, retained: true });
  check();
  const board = await startBoard({ boardId, workerId: peers[0].board.workerId, workerIds: peers.map((peer: any) => peer.board.workerId), own: (resource: any) => resources.own(resource), signal });
  check();
  const boardHttp = startup(httpClient(board.origin));
  for (const peer of peers) await boardHttp('GET', `/board/${e(boardId)}/read?viewer=${e(peer.board.workerId)}`);
  resources.own({ kind: 'board-data', id: boardId, retained: true });
  return { runId, repository, repositoryUrl, initialCommit, channelId: channel.id, boardId,
    endpoints: { gitea: gitea.origin, message: mattermost.origin, board: board.origin }, issueNumber: issue.number,
    peer: peers[0], ...(peerKeys ? { peers } : {}), ...(project ? { project: true, directChannels } : {}) };
}
