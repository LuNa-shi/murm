import { spawn } from 'node:child_process';
import { hostname, userInfo } from 'node:os';
import { parseArgs } from 'node:util';

export const traceUsage = [
  'Usage: murm trace --root <runs-dir> [--port 8787] [--open]',
  '       murm trace <runs-dir> [--port 8787] [--open]',
].join('\n');

function openBrowser(url) {
  const command = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(command[0], command[1], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* Headless environments may have no browser opener. */
  }
}

export function formatSshHint(port, env = process.env) {
  const sshConn = env.SSH_CONNECTION || env.SSH_CLIENT;
  if (!sshConn) return null;
  let user = env.USER || env.LOGNAME;
  if (!user) {
    try {
      user = userInfo().username;
    } catch {
      user = '<user>';
    }
  }
  const host = env.SSH_CONNECTION?.trim().split(/\s+/)[2] || hostname() || '<server>';
  return [
    'Remote SSH session detected. Forward from your local machine:',
    `  ssh -N -L ${port}:127.0.0.1:${port} ${user}@${host}`,
  ].join('\n');
}

/** Launch the optional trace subcommand after the host dispatches it. */
export async function runTraceCommand(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      port: { type: 'string', default: '8787' },
      open: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(traceUsage);
    return null;
  }
  const root = values.root ?? positionals[0];
  if (!root) throw new Error('--root is required');
  if (positionals.length > 1) {
    throw new Error('Unexpected positional argument: ' + positionals[1]);
  }
  const port = Number(values.port);
  if (!/^\d+$/.test(values.port) || port > 65535) {
    throw new Error('--port must be an integer from 0 to 65535');
  }

  const { startTraceServer } = await import('./server.mjs');
  let viewer;
  try {
    viewer = await startTraceServer({ root, port });
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      throw new Error(`Port ${port} is already in use on 127.0.0.1. Retry with --port 0 or another port.`);
    }
    throw error;
  }
  console.log('murm Trace Viewer listening at ' + viewer.url);
  const actualPort = new URL(viewer.url).port;
  const sshHint = formatSshHint(actualPort);
  if (sshHint) console.log(sshHint);
  if (values.open && !sshHint) openBrowser(viewer.url);
  return viewer;
}
