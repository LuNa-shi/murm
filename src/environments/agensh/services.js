import { ServiceRegistry } from '../../core/services.js';

const text = { type: 'string', minLength: 1, maxLength: 16383 };
const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const fixed = value => ({ type: 'string', enum: [value] });
const failure = code => Object.assign(new Error('Agensh upstream operation failed'), { code });

/** One run, one peer. Credentials and the trusted upstream identities stay here. */
export function createAgenshServices(configuration) {
  const { runId, repository, channelId, boardId } = structuredClone(configuration);
  const peer = structuredClone(configuration.peer);
  const endpoints = { ...configuration.endpoints };
  for (const endpoint of Object.values(endpoints)) {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new TypeError('Agensh endpoints must be credential-free HTTP(S) origins');
  }
  if (![runId, repository?.owner, repository?.name, channelId, boardId, peer.gitea?.accountId, peer.message?.accountId, peer.board?.workerId,
    peer.gitea?.token, peer.message?.token, peer.gitea?.binding, peer.message?.binding, peer.board?.binding].every(value => typeof value === 'string' && value.length > 0)) {
    throw new TypeError('Agensh Services require complete run and peer identities');
  }
  let bot;
  const bindings = Object.freeze({ gitea: peer.gitea.binding, message: peer.message.binding, 'agensh-context': peer.board.binding });
  const services = new ServiceRegistry();
  const repo = { owner: fixed(repository.owner), repo: fixed(repository.name) };
  const scope = `/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  const operations = {
    gitea: {
      issue_read: { schema: object({ ...repo, method: fixed('get'), index: { type: 'integer', minimum: 1 } }, ['owner', 'repo', 'method', 'index']),
        route: input => ['GET', `${scope}/issues/${input.index}`] },
      issue_write: { schema: object({ ...repo, method: { type: 'string', enum: ['create', 'update'] }, index: { type: 'integer', minimum: 1 }, title: text, body: { type: 'string', maxLength: 16383 } }, ['owner', 'repo', 'method', 'title']),
        route: ({ method, index, title, body }) => {
          if (method === 'update' && !index) throw failure('INVALID_CONTRACT');
          return [method === 'create' ? 'POST' : 'PATCH', `${scope}/issues${method === 'create' ? '' : '/' + index}`, { title, ...(body === undefined ? {} : { body }) }];
        } },
      pull_request_write: { schema: object({ ...repo, method: fixed('create'), title: text, head: text, base: fixed('main'), body: { type: 'string', maxLength: 16383 } }, ['owner', 'repo', 'method', 'title', 'head', 'base']),
        route: ({ title, head, base, body }) => ['POST', `${scope}/pulls`, { title, head, base, ...(body === undefined ? {} : { body }) }] },
    },
    message: {
      post_message: { schema: object({ channel_id: fixed(channelId), message: text, root_id: text }, ['channel_id', 'message']),
        route: input => ['POST', '/api/v4/posts', input] },
    },
    'agensh-context': {
      board_read: { schema: object({ board_id: fixed(boardId) }, ['board_id']), route: () => ['GET', boardRoute('read')] },
      board_write: { schema: object({ board_id: fixed(boardId), type: { type: 'string', enum: ['FACT', 'OBSERVED', 'FAIL', 'PATCH_SUMMARY', 'CLAIM'] }, content: text, detail: text, delegation_id: text }, ['board_id', 'type', 'content']),
        route: ({ type, content, detail, delegation_id }) => ['POST', `/board/${encodeURIComponent(boardId)}/note`, { thread_id: peer.board.workerId, type, content, detail: detail ?? null, delegation_id: delegation_id ?? null }] },
      board_grep: { schema: object({ board_id: fixed(boardId), words: text, types: text, limit: { type: 'integer', minimum: 1, maximum: 500 } }, ['board_id']),
        route: ({ words, types, limit }) => {
          if (!words && !types) throw failure('INVALID_CONTRACT');
          return ['GET', boardRoute('grep', { words, types, limit })];
        } },
      board_unfold: { schema: object({ board_id: fixed(boardId), labels: { type: 'array', minItems: 1, maxItems: 100, items: text } }, ['board_id', 'labels']),
        route: ({ labels }) => ['GET', boardRoute('unfold', { labels: labels.join(',') })] },
    },
  };
  function boardRoute(operation, values = {}) {
    const query = new URLSearchParams({ viewer: peer.board.workerId });
    for (const [key, value] of Object.entries(values)) if (value !== undefined) query.set(key, value);
    return `/board/${encodeURIComponent(boardId)}/${operation}?${query}`;
  }
  const outputs = {
    issue_read: { type: 'object', properties: { number: { type: 'integer', minimum: 1 } }, required: ['number'], additionalProperties: true },
    issue_write: { type: 'object', properties: { number: { type: 'integer', minimum: 1 } }, required: ['number'], additionalProperties: true },
    pull_request_write: { type: 'object', properties: { number: { type: 'integer', minimum: 1 }, head: { type: 'object', properties: { sha: { type: 'string', pattern: '^[a-f0-9]{40}$' } }, required: ['sha'], additionalProperties: true } }, required: ['number', 'head'], additionalProperties: true },
    post_message: { type: 'object', properties: { id: text, user_id: text, channel_id: text }, required: ['id', 'user_id', 'channel_id'], additionalProperties: true },
    board_read: { type: 'object', properties: { rendered: { type: 'string' } }, required: ['rendered'], additionalProperties: true },
    board_write: { type: 'object', properties: { status: { type: 'string', enum: ['admitted', 'rejected'] } }, required: ['status'], additionalProperties: true },
    board_grep: { type: 'object', properties: { total: { type: 'integer', minimum: 0 }, entries: { type: 'array', items: { type: 'object', additionalProperties: true } } }, required: ['total', 'entries'], additionalProperties: true },
    board_unfold: { type: 'object', properties: { rendered: { type: 'string' } }, required: ['rendered'], additionalProperties: true },
  };
  for (const [id, rules] of Object.entries(operations)) {
    services.registerService({
      manifest: { id, title: id, purpose: 'One run Agensh peer access', provider_version: 'agensh-2dae4e14-rest-1', contract_version: '2', endpoint: { transport: 'in-process' },
        capabilities: Object.entries(rules).map(([operation, rule]) => ({ name: operation, operation, description: `Run-scoped ${operation}`, help: { when: `Use ${operation} for this run's shared data` },
          side_effect: /read|grep|unfold/.test(operation) ? 'read' : 'write', idempotent: /read|grep|unfold/.test(operation), input_schema: rule.schema,
          output_schema: outputs[operation], errors: ['NOT_ALLOWED', 'INVALID_CONTRACT', 'SERVICE_UNAVAILABLE'].map(code => ({ code, retryable: false })) })) },
      adapter: { async invoke({ capability, input, caller, signal }) {
        if (!bot || caller.runtimeId !== bot.runtimeId || caller.botId !== bot.botId || caller.profile !== 'peer' || caller.binding !== bindings[id]) throw failure('NOT_ALLOWED');
        const [method, path, body] = rules[capability.operation].route(input);
        const endpoint = id === 'agensh-context' ? endpoints.board : endpoints[id];
        const credential = id === 'gitea' ? `token ${peer.gitea.token}` : id === 'message' ? `Bearer ${peer.message.token}` : undefined;
        try {
          const response = await fetch(new URL(path, endpoint), { method, signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]), redirect: 'error',
            headers: { accept: 'application/json', 'content-type': 'application/json', ...(credential ? { authorization: credential } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
          if (!response.ok) { await response.body?.cancel(); throw failure(response.status === 401 || response.status === 403 ? 'NOT_ALLOWED' : 'SERVICE_UNAVAILABLE'); }
          const chunks = []; let bytes = 0;
          for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 2 * 1024 ** 2) throw failure('SERVICE_UNAVAILABLE'); chunks.push(chunk); }
          const result = JSON.parse(Buffer.concat(chunks).toString());
          if (!result || typeof result !== 'object' || Array.isArray(result)) throw failure('SERVICE_UNAVAILABLE');
          return result;
        } catch (error) { throw failure(error?.code === 'NOT_ALLOWED' ? 'NOT_ALLOWED' : 'SERVICE_UNAVAILABLE'); }
      } },
    });
  }
  return Object.freeze({ services, bindings,
    bindBot(identity) {
      if (bot || !identity || ![identity.runtimeId, identity.botId].every(value => typeof value === 'string' && value)) throw failure('NOT_ALLOWED');
      bot = Object.freeze({ runtimeId: identity.runtimeId, botId: identity.botId });
    },
    identities() { return { runId, ...(bot ?? {}), gitea: { binding: peer.gitea.binding, accountId: peer.gitea.accountId, repository },
      message: { binding: peer.message.binding, accountId: peer.message.accountId, channelId }, board: { binding: peer.board.binding, workerId: peer.board.workerId, boardId } }; },
  });
}
