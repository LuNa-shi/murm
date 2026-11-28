/** Adapt legacy in-process Lifecycle fixtures to the official SDK's Fetch boundary.
 * Fixed fixture timestamps model the mandatory Lifecycle schema without relying on wall time.
 */
export function sdkFixtureFetch(fetchFixture: (url: string, options: any) => Promise<any>): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const headers = Object.fromEntries(request.headers);
    const options = { ...init, method: request.method, headers,
      ...(!['GET', 'HEAD'].includes(request.method) ? { body: await request.text() } : {}) };
    const response = await fetchFixture(request.url, options);
    const lifecycle = /\/sandboxes(?:\?|\/|$)/.test(request.url);
    if (response instanceof Response && !lifecycle) return response;
    let contentType = response.headers?.get?.('content-type') ?? 'application/json';
    let text = await response.text();
    if (response.ok && lifecycle && text.startsWith('{')) {
      contentType = 'application/json';
      const body = JSON.parse(text);
      const resource = (value: any) => ({ createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', ...value });
      if (request.url.includes('/endpoints/')) {
        if (body.url && !body.endpoint) body.endpoint = body.url;
      } else if (Array.isArray(body.items)) body.items = body.items.map(resource);
      else if (body.id || /\/sandboxes\/[^/?]+$/.test(request.url)) Object.assign(body, resource(body));
      text = JSON.stringify(body);
    }
    return new Response([204, 205, 304].includes(response.status) ? null : text,
      { status: response.status, headers: { 'content-type': contentType } });
  };
}
