import {
  ConnectionConfig, SandboxApiException, createDefaultAdapterFactory,
  type AdapterFactory, type ConnectionConfigOptions, type Sandboxes,
} from '@alibaba-group/opensandbox';
import { createEgressClient } from '@alibaba-group/opensandbox/internal';
import { ERROR_CODES, MurmError } from '../../errors.js';

/** All SDK paths reject redirects before replaying endpoint credentials to another origin. */
class RedirectRejectingConnection extends ConnectionConfig {
  private readonly httpFetch: typeof fetch;
  private readonly streamFetch: typeof fetch;
  private readonly fileFetch: typeof fetch;
  private readonly owner: ConnectionConfig | null;
  constructor(options: ConnectionConfigOptions, owner: ConnectionConfig | null, transport: typeof fetch) {
    super(options);
    this.owner = owner;
    const rejectRedirects = (baseFetch: typeof fetch): typeof fetch =>
      (input, init) => baseFetch(input, { ...init, redirect: 'error' });
    this.httpFetch = rejectRedirects(owner?.fetch ?? transport);
    this.streamFetch = rejectRedirects(owner?.sseFetch ?? transport);
    this.fileFetch = rejectRedirects(owner?.uploadFetch ?? transport);
  }
  override get fetch() { return this.httpFetch; }
  override get sseFetch() { return this.streamFetch; }
  override get uploadFetch() { return this.fileFetch; }
  override closeTransport() { return this.owner?.closeTransport() ?? Promise.resolve(); }
}

export class OpenSandboxSdk {
  readonly connection: ConnectionConfig;
  readonly factory: AdapterFactory;
  readonly sandboxes: Sandboxes;

  constructor({ lifecycleBaseUrl, apiKey, useServerProxy, fetchImpl, adapterFactory }: {
    lifecycleBaseUrl: string;
    apiKey?: string | null;
    useServerProxy: boolean;
    fetchImpl: typeof fetch;
    adapterFactory?: AdapterFactory;
  }) {
    const options: ConnectionConfigOptions = {
      domain: lifecycleBaseUrl, apiKey: apiKey ?? '', useServerProxy,
      disableMetrics: true, requestTimeoutSeconds: 60, wakeRetryEnabled: false,
    };
    const owner = fetchImpl === globalThis.fetch ? new ConnectionConfig(options).withTransportIfMissing() : null;
    this.connection = new RedirectRejectingConnection(options, owner, fetchImpl);
    this.factory = adapterFactory ?? createDefaultAdapterFactory();
    this.sandboxes = this.factory.createLifecycleStack({
      connectionConfig: this.connection, lifecycleBaseUrl,
    }).sandboxes;
  }

  execd(endpoint: { url: string; headers: Record<string, string> }): ReturnType<AdapterFactory['createExecdStack']> {
    return this.factory.createExecdStack({
      connectionConfig: this.connection, execdBaseUrl: endpoint.url, endpointHeaders: endpoint.headers,
    });
  }

  async readEgressPolicy(endpoint: { url: string; headers: Record<string, string> }) {
    // The public Egress adapter returns only policy. The SDK's typed client
    // also exposes the sidecar's enforcementMode, which must be checked.
    const client = createEgressClient({ baseUrl: endpoint.url, headers: endpoint.headers, fetch: this.connection.fetch });
    const { data, response } = await client.GET('/policy', { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new MurmError(ERROR_CODES.START_FAILED, 'OpenSandbox could not verify the Sandbox egress policy', { status: response.status });
    return data;
  }

  close() { return this.connection.closeTransport(); }
}

/** Only a finite SDK Date can be used as an observed resource expiry. */
export function sdkExpiry(value: unknown): string | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

/** Keep SDK status and request identity while preventing upstream bodies or credentials from entering Run records. */
export async function sdkOperation<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof MurmError) throw error;
    const status = error instanceof SandboxApiException ? error.statusCode : undefined;
    const timedOut = error instanceof Error && /timeout|timed out|abort/i.test(error.message);
    throw new MurmError(timedOut ? ERROR_CODES.SERVICE_TIMEOUT : status && status < 500 && status !== 429
      ? ERROR_CODES.INVALID_CONTRACT : ERROR_CODES.SERVICE_UNAVAILABLE,
    `OpenSandbox ${stage} ${status ? `failed with HTTP ${status}` : timedOut ? 'timed out' : 'could not be confirmed'}`,
    { stage, ...(status ? { status } : {}), ...(error instanceof SandboxApiException && error.requestId ? { request_id: error.requestId } : {}) },
    { retryable: !status || status >= 500 || status === 429 });
  }
}
