#!/usr/bin/env node
/**
 * Local Run Viewer: serve the built static Trace Viewer + bundle any local
 * SwarmEnv / murm outputDir/<runtimeId>/ folder so you can inspect it immediately.
 *
 * Usage:
 *   npm run view -- /path/to/runs/<runtimeId>
 */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const distDir = join(root, 'dist');
const runDirArg = process.argv[2];
const port = Number(process.env.PORT ?? 4329);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

async function safeReadJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function safeReadJsonl(path) {
  try {
    const text = await readFile(path, 'utf8');
    return text.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
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
    for (const botId of await readdir(botsDir)) {
      const sessionDir = join(botsDir, botId, 'session');
      if (!existsSync(sessionDir)) continue;
      for (const file of await readdir(sessionDir)) {
        if (file.endsWith('.jsonl')) {
          sessions[botId] = await safeReadJsonl(join(sessionDir, file));
        }
      }
    }
  }
  return { dir: abs, runtime, environmentReport, evidence, serviceCalls, sessions };
}

if (!existsSync(distDir)) {
  console.error('Build the site first: cd website && npm run build');
  process.exit(1);
}

const localRun = runDirArg ? await bundleRunDirectory(runDirArg) : null;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/api/local-run.json') {
    res.writeHead(localRun ? 200 : 404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(localRun ?? { error: 'No run directory supplied' }));
    return;
  }
  let filePath = join(distDir, decodeURIComponent(url.pathname));
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    if (existsSync(`${filePath}.html`)) filePath = `${filePath}.html`;
    else filePath = join(distDir, 'index.html');
  }
  try {
    const bytes = await readFile(filePath);
    res.writeHead(200, { 'content-type': mimeTypes[extname(filePath)] ?? 'application/octet-stream' });
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  const target = localRun ? `http://127.0.0.1:${port}/trace-viewer/?local=1` : `http://127.0.0.1:${port}/trace-viewer/`;
  console.log(`murm Trace Viewer listening at ${target}`);
  if (localRun) console.log(`Loaded local run: ${localRun.dir}`);
});
