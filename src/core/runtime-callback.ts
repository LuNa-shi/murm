import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';

// Callback mounting is an internal transport boundary. The public SDK's
// declaration graph also reaches it through the trusted Provider types.
export interface RuntimeCallback {
  close(): Promise<void>;
  mount(path: string, handler: (request: any, response: any) => void): {
    url: string;
    remove(): void;
  };
}

export async function openRuntimeCallback({ host, port, publicUrl }: {
  host: string; port: number; publicUrl: string;
}, own: (owner: { close(): Promise<void> }) => void): Promise<RuntimeCallback> {
  const routes = new Map<string, RequestListener>();
  const base = new URL(publicUrl.replaceAll('{port}', '1')).pathname.replace(/\/$/, '');
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    for (const [prefix, handle] of routes) {
      if (url.startsWith(prefix + '/')) {
        request.url = url.slice(prefix.length);
        handle(request, response);
        return;
      }
    }
    response.writeHead(404).end();
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  server.timeout = 0;

  const close = () => {
    routes.clear();
    return new Promise<void>((resolve, reject) => {
      server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
      server.closeAllConnections();
    });
  };
  own({ close });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once('error', failed);
    server.listen({ host, port }, () => {
      server.removeListener('error', failed);
      resolve();
    });
  });

  const effectiveUrl = publicUrl.replaceAll('{port}', String((server.address() as AddressInfo).port));
  return {
    close,
    mount(path: string, handler: RequestListener) {
      const prefix = base + path;
      if (routes.has(prefix)) throw new Error('Runtime callback route already mounted');
      routes.set(prefix, handler);
      return { url: effectiveUrl + path, remove: () => { routes.delete(prefix); } };
    },
  };
}
