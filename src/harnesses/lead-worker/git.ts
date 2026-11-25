import { randomBytes, createHash } from 'node:crypto';
import { httpClient } from '../peermesh/http.js';
import { leadWorkerRoles, matchesRoles, matchesTeam } from './team.js';

const e = encodeURIComponent;
const fail = (code: any) => Object.assign(new Error(code), { code });
const requireString = (value: any) => { if (typeof value !== 'string' || !value) throw new TypeError('Incomplete restricted Git identity'); return value; };

/** Agensh's bounded HTTP, restricted accounts/token scopes and cleanup ownership;
 * one retained project with separate account identities for the fixed team. */
export async function prepareLeadWorkerGit({ runId, gitea, resources, signal, helperCount }: any) {
  const roles = leadWorkerRoles(helperCount);
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(runId ?? '')) throw new TypeError('Invalid lead-helper run');
  const raw = httpClient(gitea.origin, `token ${requireString(gitea.adminToken)}`);
  const request = (method: any, path: string, body?: unknown) => raw(method, path, body, { signal });
  const owner = requireString(gitea.owner); const repository: any = { owner, name: `lead-helper-${runId}` };
  if ((await request('GET', '/api/v1/user'))?.login !== owner) throw new TypeError('Git owner must be the provisioner');
  const repo = `/api/v1/repos/${e(owner)}/${e(repository.name)}`;
  resources.own({ kind: 'repository-create-intent', id: `${owner}/${repository.name}`, retained: true });
  await request('POST', `/api/v1/admin/users/${e(owner)}/repos`, { name: repository.name, private: true, auto_init: true, default_branch: 'main' });
  resources.own({ kind: 'repository', id: `${owner}/${repository.name}`, retained: true });
  const actors: any = {};
  for (const role of roles) {
    if (signal?.aborted) throw fail('ENVIRONMENT_START_ABORTED');
    const username = `lh-${role}-${createHash('sha256').update(runId).digest('hex').slice(0, 16)}`; const email = `${username}-${randomBytes(8).toString('hex')}@murm.invalid`;
    const password = randomBytes(32).toString('base64url'); const tokenName = `swarmenv-${runId}-${role}`;
    const accountHttp = httpClient(gitea.origin, `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
    let account: any; let createUnknown = true; let tokenUnknown = false; let revoked = false;
    resources.own({ kind: 'gitea-account', id: username, close: async () => {
      const owned = account ?? await raw('GET', `/api/v1/users/${e(username)}`, undefined, { allow404: true });
      if (!owned) { if (createUnknown) throw fail('ACCOUNT_CREATE_UNKNOWN'); return; }
      if (owned.email !== email) throw fail('ACCOUNT_OWNERSHIP_UNKNOWN');
      if (!revoked) {
        const tokens = await accountHttp('GET', `/api/v1/users/${e(username)}/tokens`);
        if (!Array.isArray(tokens)) throw fail('TOKEN_OWNERSHIP_UNKNOWN');
        const ours = tokens.filter((row: any) => row.name === tokenName); if (tokenUnknown && !ours.length) throw fail('TOKEN_CREATE_UNKNOWN');
        for (const token of ours) await accountHttp('DELETE', `/api/v1/users/${e(username)}/tokens/${e(String(token.id))}`);
        revoked = true;
      }
      await raw('PATCH', `/api/v1/admin/users/${e(username)}`, { login_name: username, email, prohibit_login: true });
    } });
    const result = await request('POST', '/api/v1/admin/users', { username, login_name: username, email, password, must_change_password: false, restricted: true, max_repo_creation: 0, allow_create_organization: false });
    createUnknown = false;
    if (!Number.isSafeInteger(result?.id)) throw fail('ACCOUNT_IDENTITY_INVALID'); account = { ...result, email };
    await request('PUT', `${repo}/collaborators/${e(username)}`, { permission: 'write' });
    tokenUnknown = true;
    const token = await accountHttp('POST', `/api/v1/users/${e(username)}/tokens`, { name: tokenName, scopes: ['read:user', 'write:repository', 'write:issue'] }, { signal }); tokenUnknown = false;
    const secret = requireString(token?.sha1);
    await httpClient(gitea.origin, `token ${secret}`)('GET', repo, undefined, { signal });
    actors[role] = { accountId: String(result.id), username, token: secret, branch: `${role}-${runId}`, binding: `${runId}:git:${role}` };
  }
  return { runId, origin: gitea.origin, repository, repositoryUrl: `${gitea.origin.replace(/\/$/, '')}/${e(owner)}/${e(repository.name)}.git`, actors };
}

/** Tokens remain in the host adapter; native Git receives only its own token. */
export function createLeadWorkerGit(facilities: any, helperCount: any) {
  const roles = leadWorkerRoles(helperCount);
  const value = structuredClone(facilities); const { actors, repository, origin } = value;
  const url: any = new URL(value.repositoryUrl); const base: any = new URL(origin);
  if (url.origin !== base.origin || url.username || url.password || url.search || url.hash || url.pathname !== `/${e(repository.owner)}/${e(repository.name)}.git`) throw new TypeError('Git URL must identify the retained scoped project');
  const accounts = Object.values((actors ?? {}) as Record<string, any>);
  if (!matchesRoles(roles, actors) || ['accountId', 'username', 'token', 'branch', 'binding'].some((key: any) => accounts.some((account: any) => typeof account?.[key] !== 'string' || !account[key]) || new Set(accounts.map((account: any) => account[key])).size !== roles.length)) throw new TypeError('Distinct restricted Git identities required for the fixed team');
  for (const actor of accounts) httpClient(origin, `token ${actor.token}`);
  let team: any; let runtimeId: any;
  const resolve = (botId: any) => { const role = Object.keys(team ?? {}).find((role: any) => team[role] === botId); if (!role) throw fail('NOT_ALLOWED'); return actors[role]; };
  const scope = `/api/v1/repos/${e(repository.owner)}/${e(repository.name)}`;
  const registration: any = { manifest: { id: 'gitea', title: 'Run Git pull requests', purpose: 'Publish own run branch only', provider_version: 'lead-helper-git-1', contract_version: '2', endpoint: { transport: 'in-process' }, capabilities: [{ name: 'pull_request_write', operation: 'pull_request_write', description: 'Create own branch pull request', help: { when: 'After committing and pushing your own WORK_BRANCH' }, side_effect: 'write', idempotent: false,
    input_schema: { type: 'object', properties: { owner: { const: repository.owner }, repo: { const: repository.name }, method: { const: 'create' }, head: { type: 'string', maxLength: 128 }, base: { const: 'main' }, title: { type: 'string', minLength: 1, maxLength: 1024 }, body: { type: 'string', maxLength: 4096 } }, required: ['owner', 'repo', 'method', 'head', 'base', 'title'], additionalProperties: false },
    output_schema: { type: 'object', properties: { number: { type: 'integer', minimum: 1 } }, required: ['number'], additionalProperties: true }, errors: ['NOT_ALLOWED', 'FACILITY_REQUEST_UNKNOWN'].map((code: any) => ({ code, retryable: false })) }] }, adapter: { async invoke({ caller, input, signal }: any) {
      const actor = resolve(caller.botId); const profile = Object.keys(team).find((role: any) => team[role] === caller.botId);
      if (caller.runtimeId !== runtimeId || caller.profile !== profile || caller.binding !== actor.binding || input.head !== actor.branch) throw fail('NOT_ALLOWED');
      return httpClient(origin, `token ${actor.token}`)('POST', `${scope}/pulls`, { title: input.title, head: actor.branch, base: 'main', ...(input.body === undefined ? {} : { body: input.body }) }, { signal });
    } } };
  async function verifyDelivery({ actor: botId, delivery, direction, requireDirectionText = false, signal }: any, checkHead: any) {
    const actor = resolve(botId); const request = httpClient(origin, `token ${actor.token}`);
    if (checkHead) {
      const ref = await request('GET', `${scope}/branches/${e(actor.branch)}`, undefined, { signal });
      if (ref?.commit?.id !== delivery.commit) throw fail('DELIVERY_INVALID');
    }
    const file = await request('GET', `${scope}/contents/${delivery.path.split('/').map(e).join('/')}?ref=${delivery.commit}`, undefined, { signal });
    if (file?.type !== 'file' || file.encoding !== 'base64' || file.path !== delivery.path || typeof file.content !== 'string' || file.content.length > 1_500_000) throw fail('DELIVERY_INVALID');
    const bytes = Buffer.from(file.content.replace(/\s/g, ''), 'base64'); const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== delivery.bytes || file.size !== bytes.length || bytes.length > 1048576 || sha256 !== delivery.sha256) throw fail('DELIVERY_INVALID');
    if (requireDirectionText && (!direction || !bytes.toString('utf8').includes(direction.text))) throw fail('DELIVERY_INVALID');
    return { ...delivery, ...(requireDirectionText ? { directionEvidence: { directionId: direction.seq, textSha256: createHash('sha256').update(direction.text).digest('hex') } } : {}), verified: true, accountId: actor.accountId, branch: actor.branch };
  }
  return Object.freeze({
    register(services: any) { services.registerService(registration); },
    bindTeam(id: any, identities: any) { if (team || typeof id !== 'string' || !id || !matchesTeam(roles, identities)) throw fail('NOT_ALLOWED'); runtimeId = id; team = structuredClone(identities); },
    verifyDelivery: (value: any) => verifyDelivery(value, true),
    verifyPinnedDelivery: (value: any) => verifyDelivery(value, false),
    identities() { return Object.fromEntries(Object.entries((actors as Record<string, any>)).map(([role, { token, ...identity }]: any) => [role, identity])); },
  });
}
