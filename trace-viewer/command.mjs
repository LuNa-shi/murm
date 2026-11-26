import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { hostname, userInfo } from 'node:os';
import { parseArgs } from 'node:util';

export const traceUsage = [
  'Usage: murm trace --root <runs-dir> [--port 8787] [--open]',
  '       murm trace <runs-dir> [--port 8787] [--open]',
  '       murm trace --ssh <user@host> --root <remote-runs-dir> [--port 8787] [--remote-bin <cmd>] [--open]',
].join('\n');

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

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
  const host = sshConn.trim().split(/\s+/)[2] || hostname() || '<server>';
  return [
    'Remote SSH session detected. Forward from your local machine:',
    `  ssh -N -L ${port}:127.0.0.1:${port} ${user}@${host}`,
    'VS Code / Cursor Remote-SSH forwards this loopback port automatically.',
  ].join('\n');
}

async function pickLocalPort(preferred) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(preferred, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function startSshTunnel({ target, root, port, remoteBin }) {
  if (!target || target.startsWith('-')) {
    throw new Error('--ssh must be a valid host or user@host destination');
  }
  if (!remoteBin || /[;&|`$<>\n\r]/.test(remoteBin)) {
    throw new Error('--remote-bin must not contain shell metacharacters');
  }
  const localPort = await pickLocalPort(port).catch((error) => {
    if (error.code === 'EADDRINUSE') {
      throw new Error(`Local port ${port} is already in use on 127.0.0.1. Retry with --port 0 or another port.`);
    }
    throw error;
  });
  const remotePort = localPort;
  const remoteCommand = `${remoteBin} trace --root ${shellQuote(root)} --port ${remotePort}`;
  const child = spawn(
    'ssh',
    [
      '-T',
      '-o', 'ExitOnForwardFailure=yes',
      '-L', `${localPort}:127.0.0.1:${remotePort}`,
      '--',
      target,
      remoteCommand,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const stderrChunks = [];
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

  const exited = once(child, 'exit');
  const ready = new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        child.stdout.off('data', onData);
        resolve(`http://127.0.0.1:${localPort}`);
      }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    exited.then(([code]) => {
      child.stdout.off('data', onData);
      const errText = Buffer.concat(stderrChunks).toString().trim();
      reject(new Error(`SSH trace tunnel exited (${code})${errText ? ': ' + errText : ''}`));
    });
  });

  const url = await ready;
  return {
    url,
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
    },
  };
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
      ssh: { type: 'string' },
      'remote-bin': { type: 'string', default: 'murm' },
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

  if (values.ssh) {
    const tunnel = await startSshTunnel({
      target: values.ssh,
      root,
      port,
      remoteBin: values['remote-bin'],
    });
    console.log(`murm Trace Viewer (SSH tunnel via ${values.ssh}) listening at ${tunnel.url}`);
    if (values.open) openBrowser(tunnel.url);
    return tunnel;
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
