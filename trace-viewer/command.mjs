import { parseArgs } from 'node:util';

export const traceUsage = 'Usage: murm trace --root <runs-dir> [--port 8787]';

/** Launch the optional trace subcommand after the host dispatches it. */
export async function runTraceCommand(args) {
  const { values } = parseArgs({
    args,
    options: {
      root: { type: 'string' },
      port: { type: 'string', default: '8787' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(traceUsage);
    return null;
  }
  if (!values.root) throw new Error('--root is required');
  const port = Number(values.port);
  if (!/^\d+$/.test(values.port) || port > 65535) {
    throw new Error('--port must be an integer from 0 to 65535');
  }
  const { startTraceServer } = await import('./server.mjs');
  const viewer = await startTraceServer({ root: values.root, port });
  console.log('murm Trace Viewer listening at ' + viewer.url);
  return viewer;
}
