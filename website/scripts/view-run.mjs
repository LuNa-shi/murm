#!/usr/bin/env node
/**
 * murm Trace Server (DSH-style Server Web UI)
 *
 * Run on a remote server (or locally) against a runs root directory or a single run directory,
 * then open from your laptop browser via SSH port forwarding or LAN/Tailscale.
 *
 * Examples:
 *   # On remote server (scan all runs in ./runs)
 *   node website/scripts/view-run.mjs --dir ./runs --host 127.0.0.1 --port 4329
 *
 *   # On your laptop:
 *   ssh -L 4329:127.0.0.1:4329 user@your-server
 *   # Open http://127.0.0.1:4329/ in your browser
 *
 *   # Or scan a single run directory:
 *   npm run view -- /path/to/runs/<runId>
 */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const distDir = join(root, 'dist');

function parseArgs(argv) {
  const opts = {
    dir: process.env.MURM_RUNS_DIR || '',
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 4329),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir' || arg === '-d') {
      opts.dir = argv[++i] || '';
    } else if (arg === '--host' || arg === '-H') {
      opts.host = argv[++i] || '127.0.0.1';
    } else if (arg === '--port' || arg === '-p') {
      opts.port = Number(argv[++i] || 4329);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`murm Trace Server — DSH-style server-hosted Web UI for SwarmEnv / murm runs

Usage:
  node website/scripts/view-run.mjs --dir <runs-dir-or-single-run> [--host 127.0.0.1] [--port 4329]
  npm run view -- <runs-dir-or-single-run>

Remote access from laptop (recommended):
  Server: node website/scripts/view-run.mjs --dir ./runs --host 127.0.0.1 --port 4329
  Laptop: ssh -L 4329:127.0.0.1:4329 <user>@<server>
  Browser: http://127.0.0.1:4329/`);
      process.exit(0);
    } else if (!arg.startsWith('-') && !opts.dir) {
      opts.dir = arg;
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const runsRoot = opts.dir ? resolve(opts.dir) : resolve(root, '..');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

async function safeReadJson(p) {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

async function safeReadText(p, maxBytes = 256 * 1024) {
  try {
    const buf = await readFile(p);
    if (buf.length <= maxBytes) return buf.toString('utf8');
    return `${buf.subarray(0, maxBytes).toString('utf8')}\n\n... [truncated ${buf.length - maxBytes} bytes]`;
  } catch {
    return null;
  }
}

async function safeReadJsonl(p) {
  try {
    const text = await readFile(p, 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isRunDirectory(dir) {
  return (
    existsSync(join(dir, 'runtime.json')) ||
    existsSync(join(dir, 'evidence.jsonl')) ||
    existsSync(join(dir, 'service-calls.jsonl'))
  );
}

async function discoverRuns(rootDir) {
  if (!existsSync(rootDir)) return [];
  const found = [];

  if (isRunDirectory(rootDir)) {
    found.push(rootDir);
  } else {
    const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = join(rootDir, entry.name);
      if (isRunDirectory(full)) {
        found.push(full);
      } else {
        // Also check one level deeper (e.g. ./subagents-runs/<runId> when pointing at repo root)
        const subEntries = await readdir(full, { withFileTypes: true }).catch(() => []);
        for (const sub of subEntries) {
          if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
          const subFull = join(full, sub.name);
          if (isRunDirectory(subFull)) found.push(subFull);
        }
      }
    }
  }

  const summaries = [];
  for (const dir of found) {
    const info = await stat(dir).catch(() => null);
    const runtime = await safeReadJson(join(dir, 'runtime.json'));
    const report = await safeReadJson(join(dir, 'environment-report.json'));
    const evidence = await safeReadJsonl(join(dir, 'evidence.jsonl'));
    const serviceCalls = await safeReadJsonl(join(dir, 'service-calls.jsonl'));
    const modelTraceDir = join(dir, 'model-trace');
    const modelTraceCount = existsSync(modelTraceDir)
      ? (await readdir(modelTraceDir).catch(() => [])).length
      : 0;

    const runId = String(runtime?.runtimeId || report?.runtimeId || basename(dir));
    const botIds = new Set([
      ...evidence.map((e) => e.botId).filter(Boolean),
      ...serviceCalls.map((s) => s.caller?.botId).filter(Boolean),
      ...(Array.isArray(runtime?.bots) ? runtime.bots.map((b) => b.botId).filter(Boolean) : []),
    ]);

    const firstAt = evidence[0]?.at || serviceCalls[0]?.startedAt || info?.birthtime?.toISOString() || null;
    const lastAt =
      evidence[evidence.length - 1]?.at ||
      serviceCalls[serviceCalls.length - 1]?.endedAt ||
      info?.mtime?.toISOString() ||
      null;

    summaries.push({
      runId,
      dirName: basename(dir),
      dirPath: dir,
      startedAt: firstAt,
      updatedAt: lastAt,
      mtimeMs: info?.mtimeMs || 0,
      agentCount: botIds.size,
      evidenceCount: evidence.length,
      serviceCallCount: serviceCalls.filter((s) => !s.phase || s.phase === 'settled').length,
      modelTraceCount,
      cleanup: runtime?.cleanup || report?.cleanup?.cleanup || 'running/unknown',
      hasReport: Boolean(report),
    });
  }

  summaries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return summaries;
}

async function bundleRunDirectory(dir) {
  const abs = resolve(dir);
  const runtime = await safeReadJson(join(abs, 'runtime.json'));
  const environmentReport = await safeReadJson(join(abs, 'environment-report.json'));
  const evidence = await safeReadJsonl(join(abs, 'evidence.jsonl'));
  const serviceCalls = await safeReadJsonl(join(abs, 'service-calls.jsonl'));

  const sessions = {};
  const botsDir = join(abs, 'bots');
  if (existsSync(botsDir)) {
    for (const botId of await readdir(botsDir).catch(() => [])) {
      const sessionDir = join(botsDir, botId, 'session');
      if (!existsSync(sessionDir)) continue;
      for (const file of await readdir(sessionDir).catch(() => [])) {
        if (file.endsWith('.jsonl')) {
          sessions[botId] = [...(sessions[botId] || []), ...(await safeReadJsonl(join(sessionDir, file)))];
        }
      }
    }
  }

  const modelTraces = [];
  const traceDir = join(abs, 'model-trace');
  if (existsSync(traceDir)) {
    const attemptDirs = (await readdir(traceDir).catch(() => [])).sort();
    for (const attemptId of attemptDirs) {
      const resMeta = await safeReadJson(join(traceDir, attemptId, 'result.json'));
      if (resMeta) {
        modelTraces.push({ attemptId, ...resMeta });
      } else {
        modelTraces.push({ attemptId });
      }
    }
  }

  return {
    dir: abs,
    runId: String(runtime?.runtimeId || environmentReport?.runtimeId || basename(abs)),
    runtime,
    environmentReport,
    evidence,
    serviceCalls,
    sessions,
    modelTraces,
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'Content-Type',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

if (!existsSync(distDir)) {
  console.error('Static site not built yet. Run: cd website && npm run build');
  process.exit(1);
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://${opts.host}:${opts.port}`);
  const pathname = decodeURIComponent(url.pathname);

  // API: server metadata
  if (pathname === '/api/info') {
    const runs = await discoverRuns(runsRoot);
    sendJson(res, 200, {
      mode: 'server',
      rootDir: runsRoot,
      host: opts.host,
      port: opts.port,
      runCount: runs.length,
    });
    return;
  }

  // API: list all runs
  if (pathname === '/api/runs') {
    const runs = await discoverRuns(runsRoot);
    sendJson(res, 200, {
      rootDir: runsRoot,
      runs: runs.map(({ dirPath, mtimeMs, ...pub }) => pub),
    });
    return;
  }

  // API: fetch single run bundle
  const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch) {
    const targetId = runMatch[1];
    const runs = await discoverRuns(runsRoot);
    const hit = runs.find((r) => r.runId === targetId || r.dirName === targetId);
    if (!hit) {
      sendJson(res, 404, { error: `Run not found: ${targetId}` });
      return;
    }
    const bundle = await bundleRunDirectory(hit.dirPath);
    sendJson(res, 200, bundle);
    return;
  }

  // API: fetch specific model-trace payload on demand
  const traceMatch = pathname.match(/^\/api\/runs\/([^/]+)\/model-trace\/([^/]+)$/);
  if (traceMatch) {
    const [, targetId, attemptId] = traceMatch;
    if (attemptId.includes('..') || attemptId.includes('/')) {
      sendJson(res, 400, { error: 'Invalid attemptId' });
      return;
    }
    const runs = await discoverRuns(runsRoot);
    const hit = runs.find((r) => r.runId === targetId || r.dirName === targetId);
    if (!hit) {
      sendJson(res, 404, { error: `Run not found: ${targetId}` });
      return;
    }
    const attemptDir = join(hit.dirPath, 'model-trace', attemptId);
    const request = await safeReadJson(join(attemptDir, 'request.json'));
    const result = await safeReadJson(join(attemptDir, 'result.json'));
    const responseText = await safeReadText(join(attemptDir, 'response.txt'));
    sendJson(res, 200, { attemptId, request, result, responseText });
    return;
  }

  // Backwards-compatible single-run endpoint
  if (pathname === '/api/local-run.json') {
    const runs = await discoverRuns(runsRoot);
    if (!runs.length) {
      sendJson(res, 404, { error: `No runs found under ${runsRoot}` });
      return;
    }
    const bundle = await bundleRunDirectory(runs[0].dirPath);
    sendJson(res, 200, bundle);
    return;
  }

  // Redirect bare root directly into Trace Viewer when running as trace server
  if (pathname === '/') {
    res.writeHead(302, { location: '/trace-viewer/' });
    res.end();
    return;
  }

  // Serve static site assets (strip /SwarmEnv base prefix seamlessly if dist was built for GH Pages)
  const stripped = pathname.replace(/^\/SwarmEnv(?=\/|$)/, '') || '/';
  let filePath = join(distDir, stripped);
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    if (existsSync(`${filePath}.html`)) filePath = `${filePath}.html`;
    else filePath = join(distDir, 'trace-viewer', 'index.html');
  }

  try {
    const bytes = await readFile(filePath);
    res.writeHead(200, {
      'content-type': mimeTypes[extname(filePath)] ?? 'application/octet-stream',
    });
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(opts.port, opts.host, async () => {
  const runs = await discoverRuns(runsRoot);
  console.log('');
  console.log('  murm Trace Server');
  console.log(`  ├─ URL:      http://${opts.host}:${opts.port}/trace-viewer/`);
  console.log(`  ├─ Runs dir: ${runsRoot}`);
  console.log(`  └─ Discovered runs: ${runs.length}`);
  if (opts.host === '127.0.0.1' || opts.host === 'localhost') {
    console.log('');
    console.log('  From your laptop over SSH:');
    console.log(`    ssh -L ${opts.port}:127.0.0.1:${opts.port} <user>@<server>`);
    console.log(`    Open http://127.0.0.1:${opts.port}/trace-viewer/`);
  }
  console.log('');
});
