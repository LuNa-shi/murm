import { httpClient } from './http.js';
import { ServiceRegistry } from '../../core/services.js';

const text: any = { type: 'string', minLength: 1, maxLength: 16383 };
const object = (properties: any, required: any) => ({ type: 'object', properties, required, additionalProperties: false });
const index = { type: 'integer', minimum: 1 };
const page = { type: 'integer', minimum: 1, maximum: 1000 };
const gitSha = { type: 'string', pattern: '^[a-f0-9]{40}$' };
const fixed = (value: any) => ({ type: 'string', enum: [value] });
const failure = (code: any) => Object.assign(new Error('Agensh upstream operation failed'), { code });

interface BoardEntry {
  workerId: string;
  gistId: number;
  type: string;
  content: string;
  detail?: string;
}

/** One run, trusted peer identities. Credentials and the trusted upstream identities stay here. */
export function createPeerMeshServices(configuration: any, delivery?: { merge(input: any): Promise<unknown> }, onBoardEntry?: (entry: BoardEntry) => void) {
  const { runId, repository, channelId, boardId } = structuredClone(configuration);
  const peers = structuredClone(configuration.peers ?? [{ ...configuration.peer, key: 'peer' }]);
  if (!Array.isArray(peers) || peers.length < 1 || peers.length > 8 || new Set(peers.map((peer: any) => peer.key)).size !== peers.length) throw new TypeError('PeerMesh requires a bounded distinct peer list');
  const peer = peers[0];
  for (const field of ['gitea', 'message', 'board']) for (const identity of ['binding', field === 'board' ? 'workerId' : 'accountId']) {
    if (new Set(peers.map((peer: any) => peer[field]?.[identity])).size !== peers.length) throw new TypeError('PeerMesh peer identities must be distinct');
  }
  const endpoints: any = { ...configuration.endpoints };
  for (const endpoint of Object.values((endpoints as Record<string, any>))) {
    const url: any = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new TypeError('PeerMesh endpoints must be credential-free HTTP(S) origins');
  }
  for (const peer of peers) if (![runId, repository?.owner, repository?.name, channelId, boardId, peer.gitea?.accountId, peer.message?.accountId, peer.board?.workerId,
    peer.gitea?.token, peer.message?.token, peer.gitea?.binding, peer.message?.binding, peer.board?.binding].every((value: any) => typeof value === 'string' && value.length > 0)) {
    throw new TypeError('PeerMesh Services require complete run and peer identities');
  }
  const agents: any = new Map();
  const bindings = Object.freeze({ gitea: peer.gitea.binding, message: peer.message.binding, 'peermesh-context': peer.board.binding });
  for (const field of ['gitea', 'message']) if (new Set(peers.map((peer: any) => peer[field].token)).size !== peers.length) throw new TypeError('PeerMesh peers require separate credentials');
  const services: any = new ServiceRegistry();
  const repo: any = { owner: fixed(repository.owner), repo: fixed(repository.name) };
  const scope = `/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  const operations: any = {
    gitea: {
      issue_read: { schema: object({ ...repo, method: fixed('get'), index: { type: 'integer', minimum: 1 } }, ['owner', 'repo', 'method', 'index']),
        route: (input: any) => ['GET', `${scope}/issues/${input.index}`] },
      issue_write: { schema: object({ ...repo, method: { type: 'string', enum: ['create', 'update'] }, index: { type: 'integer', minimum: 1 }, title: text, body: { type: 'string', maxLength: 16383 } }, ['owner', 'repo', 'method', 'title']),
        route: ({ method, index, title, body }: any) => {
          if (method === 'update' && !index) throw failure('INVALID_CONTRACT');
          return [method === 'create' ? 'POST' : 'PATCH', `${scope}/issues${method === 'create' ? '' : '/' + index}`, { title, ...(body === undefined ? {} : { body }) }];
        } },
      pull_request_write: { schema: object({ ...repo, method: fixed('create'), title: text, head: text, base: fixed('main'), body: { type: 'string', maxLength: 16383 } }, ['owner', 'repo', 'method', 'title', 'head', 'base']),
        route: ({ title, head, base, body }: any, peer: any) => {
          if (configuration.project ? head === 'main' || head.includes(':') : peer.branch && head !== peer.branch) throw failure('NOT_ALLOWED');
          return ['POST', `${scope}/pulls`, { title, head, base, ...(body === undefined ? {} : { body }) }];
        } },
    },
    message: {
      post_message: { schema: object({ channel_id: fixed(channelId), message: text, root_id: text }, ['channel_id', 'message']),
        route: (input: any) => ['POST', '/api/v4/posts', input] },
    },
    'peermesh-context': {
      board_read: { schema: object({ board_id: fixed(boardId) }, ['board_id']), route: (_: any, peer: any) => ['GET', boardRoute(peer, 'read')] },
      board_write: { schema: object({ board_id: fixed(boardId), type: { type: 'string', enum: ['FACT', 'OBSERVED', 'FAIL', 'PATCH_SUMMARY', 'CLAIM'] }, content: text, detail: text, delegation_id: text }, ['board_id', 'type', 'content']),
        route: ({ type, content, detail, delegation_id }: any, peer: any) => ['POST', `/board/${encodeURIComponent(boardId)}/note`, { thread_id: peer.board.workerId, type, content, detail: detail ?? null, delegation_id: delegation_id ?? null }] },
      board_grep: { schema: object({ board_id: fixed(boardId), words: text, types: text, limit: { type: 'integer', minimum: 1, maximum: 500 } }, ['board_id']),
        route: ({ words, types, limit }: any, peer: any) => {
          if (!words && !types) throw failure('INVALID_CONTRACT');
          return ['GET', boardRoute(peer, 'grep', { words, types, limit })];
        } },
      board_unfold: { schema: object({ board_id: fixed(boardId), labels: { type: 'array', minItems: 1, maxItems: 100, items: text } }, ['board_id', 'labels']),
        route: ({ labels }: any, peer: any) => ['GET', boardRoute(peer, 'unfold', { labels: labels.join(',') })] },
    },
  };
  function boardRoute(peer: any, operation: any, values: any = {}) {
    const query: any = new URLSearchParams({ viewer: peer.board.workerId });
    for (const [key, value] of Object.entries((values as Record<string, any>))) if (value !== undefined) query.set(key, value);
    return `/board/${encodeURIComponent(boardId)}/${operation}?${query}`;
  }
  if (configuration.project) {
    const listing = object({ ...repo, page, state: { enum: ['open', 'closed', 'all'] } }, ['owner', 'repo']);
    const commentInput = { ...repo, index };
    Object.assign(operations.gitea, {
      issue_list: { schema: listing, route: ({ page = 1, state = 'open' }) => ['GET', `${scope}/issues?type=issues&state=${state}&limit=30&page=${page}`] },
      pull_request_list: { schema: listing, route: ({ page = 1, state = 'open' }) => ['GET', `${scope}/pulls?state=${state}&limit=30&page=${page}`] },
      pull_request_read: { schema: object(commentInput, ['owner', 'repo', 'index']), route: (input: { index: number }) => ['GET', `${scope}/pulls/${input.index}`] },
      comment_list: { schema: object({ ...commentInput, page }, ['owner', 'repo', 'index']),
        route: ({ index, page = 1 }: { index: number; page?: number }) => ['GET', `${scope}/issues/${index}/comments?limit=30&page=${page}`] },
      comment_write: { schema: object({ ...commentInput, body: text }, ['owner', 'repo', 'index', 'body']),
        route: ({ index, body }: { index: number; body: string }) => ['POST', `${scope}/issues/${index}/comments`, { body }] },
      pull_request_merge: { schema: object({ ...commentInput, head_sha: gitSha }, ['owner', 'repo', 'index', 'head_sha']) },
    });
    Object.assign(operations.message, {
      peer_list: { schema: object({}, []) },
      send_dm: { schema: object({ peer: { enum: peers.map(item => item.key) }, message: text }, ['peer', 'message']),
        route: ({ peer: recipient, message }: { peer: string; message: string }, peer: { key: string }) => {
          const channel_id = configuration.directChannels?.[peer.key]?.[recipient];
          if (typeof channel_id !== 'string' || peer.key === recipient) throw failure('NOT_ALLOWED');
          return ['POST', '/api/v4/posts', { channel_id, message }];
        } },
    });
  }
  const outputs: any = {
    issue_read: { type: 'object', properties: { number: { type: 'integer', minimum: 1 } }, required: ['number'], additionalProperties: true },
    issue_write: { type: 'object', properties: { number: { type: 'integer', minimum: 1 } }, required: ['number'], additionalProperties: true },
    pull_request_write: { type: 'object', properties: { number: { type: 'integer', minimum: 1 }, head: { type: 'object', properties: { sha: { type: 'string', pattern: '^[a-f0-9]{40}$' } }, required: ['sha'], additionalProperties: true } }, required: ['number', 'head'], additionalProperties: true },
    post_message: { type: 'object', properties: { id: text, user_id: text, channel_id: text }, required: ['id', 'user_id', 'channel_id'], additionalProperties: true },
    board_read: { type: 'object', properties: { rendered: { type: 'string' } }, required: ['rendered'], additionalProperties: true },
    board_write: { type: 'object', properties: { status: { type: 'string', enum: ['admitted', 'rejected'] } }, required: ['status'], additionalProperties: true },
    board_grep: { type: 'object', properties: { total: { type: 'integer', minimum: 0 }, entries: { type: 'array', items: { type: 'object', additionalProperties: true } } }, required: ['total', 'entries'], additionalProperties: true },
    board_unfold: { type: 'object', properties: { rendered: { type: 'string' } }, required: ['rendered'], additionalProperties: true },
  };
  Object.assign(outputs, {
    issue_list: { type: 'array', items: outputs.issue_read },
    pull_request_list: { type: 'array', items: outputs.pull_request_write },
    pull_request_read: outputs.pull_request_write,
    comment_list: { type: 'array', items: { type: 'object' } },
    comment_write: { type: 'object', properties: { id: index }, required: ['id'], additionalProperties: true },
    pull_request_merge: { type: 'object', properties: { peerKey: text, number: index, headSha: gitSha, mergeSha: gitSha },
      required: ['peerKey', 'number', 'headSha', 'mergeSha'], additionalProperties: false },
    peer_list: { type: 'array', items: object({ key: text, username: text }, ['key', 'username']) },
    send_dm: outputs.post_message,
  });
  const readOperation = (operation: string) => /read|list|grep|unfold/.test(operation);
  for (const [id, rules] of Object.entries((operations as Record<string, any>))) {
    services.registerService({
      manifest: { id, title: id, purpose: 'One run PeerMesh peer access', provider_version: 'peermesh-rest-1', contract_version: '2', endpoint: { transport: 'in-process' },
        capabilities: Object.entries((rules as Record<string, any>)).map(([operation, rule]: any) => ({ name: operation, operation, description: `Run-scoped ${operation}`, help: { when: `Use ${operation} for this run's shared data` },
          side_effect: readOperation(operation) ? 'read' : 'write', idempotent: readOperation(operation) || operation === 'pull_request_merge', input_schema: rule.schema,
          output_schema: outputs[operation], errors: ['NOT_ALLOWED', 'INVALID_CONTRACT', 'SERVICE_UNAVAILABLE',
            ...(operation === 'pull_request_merge' ? ['DELIVERY_INVALID', 'DELIVERY_CONFLICT', 'DELIVERY_NOT_READY', 'DELIVERY_MERGE_UNKNOWN', 'DELIVERY_STOPPING'] : [])]
            .map(code => ({ code, retryable: false })) })) },
      adapter: { async invoke({ capability, input, caller, envelope, signal }: any) {
        const agent = agents.get(caller.agentId);
        const peer = agent?.peer;
        const binding = id === 'gitea' ? peer?.gitea.binding : id === 'message' ? peer?.message.binding : peer?.board.binding;
        if (!agent || caller.runtimeId !== agent.runtimeId || caller.agentId !== agent.agentId || caller.profile !== agent.profile || caller.binding !== binding) throw failure('NOT_ALLOWED');
        if (capability.operation === 'pull_request_merge') {
          if (!delivery) throw failure('NOT_ALLOWED');
          return delivery.merge({ peerKey: peer.key, number: input.index, headSha: input.head_sha, requestId: envelope.operation_id, signal });
        }
        if (capability.operation === 'peer_list') return peers.map(item => ({ key: item.key, username: item.gitea.username }));
        const [method, path, body] = rules[capability.operation].route(input, peer);
        const endpoint = id === 'peermesh-context' ? endpoints.board : endpoints[id];
        const credential = id === 'gitea' ? `token ${peer.gitea.token}` : id === 'message' ? `Bearer ${peer.message.token}` : undefined;
        try {
          const result = await httpClient(endpoint, credential)(method, path, body, { signal });
          if (!result || typeof result !== 'object' || Array.isArray(result) !== (outputs[capability.operation].type === 'array')) throw failure('SERVICE_UNAVAILABLE');
          if (capability.operation === 'send_dm' && (result.user_id !== peer.message.accountId || result.channel_id !== body.channel_id)) throw failure('SERVICE_UNAVAILABLE');
          if (onBoardEntry && capability.operation === 'board_write' && result.status === 'admitted' &&
              Number.isSafeInteger(result.gist_id) && result.gist_id > 0) {
            onBoardEntry({ workerId: peer.board.workerId, gistId: result.gist_id, type: input.type, content: input.content, detail: input.detail });
          }
          return result;
        } catch (error: any) {
          throw failure(error?.status === 401 || error?.status === 403 ? 'NOT_ALLOWED' : 'SERVICE_UNAVAILABLE');
        }
      } },
    });
  }
  const identities = (peer: any, agent: any) => ({ runId, ...(agent ? { runtimeId: agent.runtimeId, agentId: agent.agentId } : {}), gitea: { binding: peer.gitea.binding, accountId: peer.gitea.accountId, repository },
    message: { binding: peer.message.binding, accountId: peer.message.accountId, channelId }, board: { binding: peer.board.binding, workerId: peer.board.workerId, boardId } });
  return Object.freeze({ services, bindings,
    bindingsFor(key: any) {
      const peer = peers.find((peer: any) => peer.key === key);
      if (!peer) throw failure('NOT_ALLOWED');
      return { gitea: peer.gitea.binding, message: peer.message.binding, 'peermesh-context': peer.board.binding };
    },
    bindAgent(identity: any) {
      const peer = peers.find((peer: any) => peer.key === (identity?.peerKey ?? peers[0].key));
      if (!peer || !identity || ![identity.runtimeId, identity.agentId].every((value: any) => typeof value === 'string' && value) ||
          agents.has(identity.agentId) || [...agents.values()].some((agent: any) => agent.peer.key === peer.key || agent.runtimeId !== identity.runtimeId)) throw failure('NOT_ALLOWED');
      agents.set(identity.agentId, Object.freeze({ runtimeId: identity.runtimeId, agentId: identity.agentId, profile: identity.profile ?? 'peer', peer }));
    },
    identities() {
      if (configuration.peers) return peers.map((peer: any) => ({ key: peer.key, ...identities(peer, [...agents.values()].find((agent: any) => agent.peer.key === peer.key)) }));
      return identities(peer, [...agents.values()][0]);
    },
  });
}
