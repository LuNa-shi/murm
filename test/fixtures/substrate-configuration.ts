// Shared exact native configuration and no-Agent assembly preflight. No I/O.
export function substrateBackendConfiguration({ upstreamUrl, host = '172.17.0.1', lifecycleUrl = 'http://127.0.0.1:8080/v1', apiKey }) {
  const url = new URL(upstreamUrl);
  if (url.origin !== `http://127.0.0.1:${url.port}` || url.pathname !== '/v1/responses' || url.search || url.hash || url.username || url.password) throw new TypeError('Controlled Substrate requires its loopback Responses fixture');
  return { sandbox: { lifecycleBaseUrl: lifecycleUrl, apiKey, resourceLimits: { cpu: '1', memory: '1Gi' }, commandTimeoutMs: 20_000 },
    bridge: { host: '0.0.0.0', publicUrl: `http://${host}:{port}` }, modelGateway: { host: '0.0.0.0', advertiseHost: host, requestTimeoutMs: 30_000, maxOutputTokens: 128 },
    models: { default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: url.href, headers: {} } } },
    isolation: { network: 'api' } };
}
