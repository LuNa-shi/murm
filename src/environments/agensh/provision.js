import { randomBytes } from 'node:crypto';
import { httpClient } from './http.js';

export const initialFile = 'INITIAL\n';
export const initialIssue = 'Apply the fixed acceptance change on your private branch; preserve the second-turn private checkpoint.';
const e = encodeURIComponent;
const requireString = value => { if (typeof value !== 'string' || !value) throw new TypeError('Incomplete Agensh facility configuration'); return value; };

/** Prepare only new run resources. Shared Git/channel/board data is retained. */
export async function prepareAgenshFacilities({ runId, gitea, mattermost, startBoard, resources }) {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(runId) || typeof startBoard !== 'function') throw new TypeError('Invalid Agensh run or board launcher');
  const git = httpClient(gitea.origin, `token ${requireString(gitea.adminToken)}`);
  const mm = httpClient(mattermost.origin, `Bearer ${requireString(mattermost.adminToken)}`);
  const owner = requireString(gitea.owner); const teamId = requireString(mattermost.teamId);
  const username = `peer-${runId}`; const email = `${username}-${randomBytes(8).toString('hex')}@swarmenv.invalid`;
  const password = randomBytes(32).toString('base64url');
  const accountGit = httpClient(gitea.origin, `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
  const tokenName = `swarmenv-${runId}`;
  const repository = { owner, name: `run-${runId}` };
  const repo = `/api/v1/repos/${e(owner)}/${e(repository.name)}`;
  const boardId = `board-${runId}`; const workerId = `worker-${runId}`;
  await Promise.all([git('GET', '/api/v1/version'), mm('GET', '/api/v4/system/ping'), mm('GET', `/api/v4/teams/${e(teamId)}`)]);
  const admin = await git('GET', '/api/v1/user');
  if (admin?.login !== owner) throw new TypeError('Gitea owner must be the configured provisioning account');
  // Intent precedes the remote write. Unknown outcomes remain reconcilable by
  // the unique email instead of deleting an unrelated pre-existing account.
  let gitUser; let gitTokensRevoked = false;
  resources.own({ kind: 'gitea-account', id: username, close: async () => {
    const account = gitUser ?? await git('GET', `/api/v1/users/${e(username)}`, undefined, { allow404: true });
    if (!account) return;
    if (account.email !== email) throw new Error('unconfirmed owner');
    if (!gitTokensRevoked) {
      const tokens = await accountGit('GET', `/api/v1/users/${e(username)}/tokens`);
      if (!Array.isArray(tokens)) throw new Error('unconfirmed tokens');
      for (const token of tokens.filter(item => item.name === tokenName)) await accountGit('DELETE', `/api/v1/users/${e(username)}/tokens/${e(String(token.id))}`);
      gitTokensRevoked = true;
    }
    await git('PATCH', `/api/v1/admin/users/${e(username)}`, { login_name: username, email, prohibit_login: true });
  } });
  gitUser = await git('POST', '/api/v1/admin/users', { username, login_name: username, email, password, must_change_password: false,
    restricted: true, max_repo_creation: 0, allow_create_organization: false });
  if (!Number.isSafeInteger(gitUser?.id)) throw new TypeError('Gitea did not return account identity');
  gitUser = { ...gitUser, email };
  resources.own({ kind: 'repository-create-intent', id: `${owner}/${repository.name}`, retained: true });
  await git('POST', `/api/v1/admin/users/${e(owner)}/repos`, { name: repository.name, private: true, auto_init: true, default_branch: 'main' });
  resources.own({ kind: 'repository', id: `${owner}/${repository.name}`, retained: true });
  await git('PUT', `${repo}/collaborators/${e(username)}`, { permission: 'write' });
  await git('POST', `${repo}/contents/acceptance.txt`, { branch: 'main', message: 'Seed fixed acceptance input', content: Buffer.from(initialFile).toString('base64') });
  const issue = await git('POST', `${repo}/issues`, { title: 'Fixed single-peer acceptance', body: initialIssue });
  if (!Number.isSafeInteger(issue?.number)) throw new TypeError('Gitea did not return issue identity');
  const gitToken = await accountGit('POST', `/api/v1/users/${e(username)}/tokens`, { name: tokenName, scopes: ['read:user', 'write:repository', 'write:issue'] });
  requireString(gitToken?.sha1);
  let mmUser;
  resources.own({ kind: 'mattermost-account', id: username, close: async () => {
    const account = mmUser ?? await mm('GET', `/api/v4/users/username/${e(username)}`, undefined, { allow404: true });
    if (!account) return;
    if (account.email !== email) throw new Error('unconfirmed owner');
    await mm('PUT', `/api/v4/users/${e(account.id)}/active`, { active: false });
  } });
  mmUser = await mm('POST', '/api/v4/users', { username, email, password, email_verified: true });
  requireString(mmUser?.id);
  // Keep the email for ownership reconciliation even if an upstream minimizes
  // the create response. A successful creation is the authoritative ownership.
  mmUser = { ...mmUser, email };
  await mm('POST', `/api/v4/teams/${e(teamId)}/members`, { team_id: teamId, user_id: mmUser.id });
  resources.own({ kind: 'channel-create-intent', id: `${teamId}/run-${runId}`, retained: true });
  const channel = await mm('POST', '/api/v4/channels', { team_id: teamId, name: `run-${runId}`, display_name: `Run ${runId}`, type: 'P' });
  requireString(channel?.id);
  resources.own({ kind: 'channel', id: channel.id, retained: true });
  await mm('POST', `/api/v4/channels/${e(channel.id)}/members`, { user_id: mmUser.id });
  const mmTokenName = `swarmenv-${runId}`;
  resources.own({ kind: 'mattermost-token', id: mmTokenName, close: async () => {
    const tokens = await mm('GET', `/api/v4/users/${e(mmUser.id)}/tokens?page=0&per_page=200`);
    if (!Array.isArray(tokens)) throw new Error('unconfirmed tokens');
    for (const token of tokens.filter(item => item.description === mmTokenName)) await mm('POST', '/api/v4/users/tokens/revoke', { token_id: token.id });
  } });
  const mmToken = await mm('POST', `/api/v4/users/${e(mmUser.id)}/tokens`, { description: mmTokenName });
  requireString(mmToken?.token);
  resources.own({ kind: 'board-create-intent', id: boardId, retained: true });
  const board = await startBoard({ boardId, workerId, own: resource => resources.own(resource) });
  const boardHttp = httpClient(board.origin);
  await boardHttp('GET', `/board/${e(boardId)}/read?viewer=${e(workerId)}`);
  resources.own({ kind: 'board-data', id: boardId, retained: true });
  // Verify the issued account tokens before any Bot is admitted.
  await Promise.all([httpClient(gitea.origin, `token ${gitToken.sha1}`)('GET', `${repo}/issues/${issue.number}`),
    httpClient(mattermost.origin, `Bearer ${mmToken.token}`)('GET', `/api/v4/channels/${e(channel.id)}`)]);
  return { runId, repository, repositoryUrl: `${gitea.origin.replace(/\/$/, '')}/${e(owner)}/${e(repository.name)}.git`, channelId: channel.id, boardId,
    endpoints: { gitea: gitea.origin, message: mattermost.origin, board: board.origin }, issueNumber: issue.number,
    peer: { gitea: { binding: `${runId}:gitea`, accountId: String(gitUser.id), username, token: gitToken.sha1 },
      message: { binding: `${runId}:message`, accountId: mmUser.id, token: mmToken.token }, board: { binding: `${runId}:board`, workerId } } };
}
