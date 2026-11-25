import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';

// Internal service endpoints are direct HTTP(S) URLs. Keep the caller's abort
// deadline across headers and body without fetch's separate five-minute limit.
export interface HttpRequestOptions {
  method?: string;
  headers?: OutgoingHttpHeaders;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number | undefined;
  ok: boolean;
  text: string;
}

export function requestHttp(url: string | URL, { method = 'GET', headers, body, signal }: HttpRequestOptions = {}): Promise<HttpResponse> {
  return new Promise((resolve: any, reject: any) => {
    const failed = (error: unknown) => reject(new TypeError('HTTP service transport failed', { cause: error }));
    const endpoint = new URL(url);
    const request = endpoint.protocol === 'https:' ? httpsRequest : endpoint.protocol === 'http:' ? httpRequest : null;
    if (!request) throw new TypeError('Service endpoint must use HTTP or HTTPS');
    const pending = request(endpoint, { method, headers, signal }, (response: any) => {
      response.setEncoding('utf8');
      let text = '';
      response.on('data', (chunk: any) => { text += chunk; });
      response.on('error', failed);
      response.on('end', () => resolve({ status: response.statusCode,
        ok: response.statusCode! >= 200 && response.statusCode! < 300, text }));
    });
    pending.on('error', failed);
    pending.end(body);
  });
}
