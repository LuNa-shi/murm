// Host-only HTTP, with no redirect/retry and constant errors: an unknown write
// must be reconciled by its owner rather than replayed under a different ID.
export function httpClient(origin: string, authorization?: string) {
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new TypeError('Expected credential-free upstream origin');
  return async function request(method: string, path: string, body?: unknown, { allow404 = false, signal }: { allow404?: boolean; signal?: AbortSignal } = {}): Promise<any> {
    let status: number | undefined;
    try {
      const response = await fetch(new URL(path, base), { method, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
        headers: { accept: 'application/json', 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      status = response.status;
      if (allow404 && response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) { await response.body?.cancel(); throw new Error('upstream rejected'); }
      const chunks: Uint8Array[] = []; let bytes = 0;
      for await (const chunk of response.body ?? []) { bytes += chunk.length; if (bytes > 2 * 1024 ** 2) throw new Error('limit'); chunks.push(chunk); }
      return bytes ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    } catch { throw Object.assign(new Error('Agensh facility request failed'), { code: 'FACILITY_REQUEST_UNKNOWN', ...(status === undefined ? {} : { status }) }); }
  };
}
