// Host-only HTTP, with no redirect/retry and constant errors: an unknown write
// must be reconciled by its owner rather than replayed under a different ID.
export function httpClient(origin: string, authorization?: string) {
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new TypeError('Expected credential-free upstream origin');
  return async function request(method: string, path: string, body?: unknown, { allow404 = false, signal, recognizedRejection }: {
    allow404?: boolean; signal?: AbortSignal;
    recognizedRejection?: { status: number; message: string; code: string };
  } = {}): Promise<any> {
    let status: number | undefined;
    let code = 'FACILITY_REQUEST_UNKNOWN';
    try {
      const response = await fetch(new URL(path, base), { method, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
        headers: { accept: 'application/json', 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      status = response.status;
      if (allow404 && response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok && status !== recognizedRejection?.status) { await response.body?.cancel(); throw new Error('upstream rejected'); }
      const chunks: Uint8Array[] = []; let bytes = 0;
      for await (const chunk of response.body ?? []) { bytes += chunk.length; if (bytes > 2 * 1024 ** 2) throw new Error('limit'); chunks.push(chunk); }
      const result = bytes ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      if (!response.ok) {
        if (recognizedRejection && result?.message === recognizedRejection.message) code = recognizedRejection.code;
        throw new Error('upstream rejected');
      }
      return result;
    } catch { throw Object.assign(new Error('PeerMesh facility request failed'), { code, ...(status === undefined ? {} : { status }) }); }
  };
}
