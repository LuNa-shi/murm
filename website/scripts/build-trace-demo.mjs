#!/usr/bin/env node
/**
 * Builds the static interactive Trace Viewer demo bundle under website/public/trace-demo/
 * directly from src/trace-viewer/public/ and a Run root directory.
 *
 * Usage:
 *   node website/scripts/build-trace-demo.mjs
 *   node website/scripts/build-trace-demo.mjs --root /path/to/substrate-or-peermesh-runs --sanitize
 *
 * Supports both full standalone mode (/trace-demo/index.html?run=<id>) and
 * clean zero-chrome docs embed mode (?run=<id>&embed=1) controlled by outer tabs.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const websiteDir = resolve(scriptDir, '..');
const repoDir = resolve(websiteDir, '..');
const viewerPublicDir = resolve(repoDir, 'src/trace-viewer/public');
const outDir = resolve(websiteDir, 'public/trace-demo');

function parseCliArgs(argv) {
  let root = process.env.TRACE_DEMO_ROOT || resolve(repoDir, 'test/fixtures/trace-viewer/runs');
  let sanitize = Boolean(process.env.TRACE_DEMO_ROOT);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root' && argv[i + 1]) {
      root = resolve(argv[++i]);
      sanitize = true;
    } else if (arg === '--sanitize') {
      sanitize = true;
    } else if (arg === '--no-sanitize') {
      sanitize = false;
    }
  }
  return { root, sanitize };
}

const SENSITIVE_KEYS = /^(authorization|api[_-]?key|x-api-key|token|secret|password|cookie)$/i;

function sanitizeText(text) {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,})\b/g, '[REDACTED_KEY]')
    .replace(/\/(Users|home)\/[^/\s"'`]+/g, '/$1/demo')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'demo@example.com');
}

function sanitizeValue(value) {
  if (typeof value === 'string') return sanitizeText(value);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEYS.test(k) && typeof v === 'string') {
      out[k] = '[REDACTED]';
    } else {
      out[k] = sanitizeValue(v);
    }
  }
  return out;
}

const cli = parseCliArgs(process.argv.slice(2));
const fixtureRoot = cli.root;

async function loadTraceReader() {
  const readerPath = resolve(repoDir, 'src/trace-viewer/reader.mjs');
  if (process.platform === 'linux') {
    const mod = await import(pathToFileURL(readerPath).href);
    return mod.createTraceReader;
  }
  const source = await readFile(readerPath, 'utf8');
  const patched = source.replace(
    'await realpath(`/proc/self/fd/${handle.fd}`)',
    'await realpath(target)',
  );
  const dataUrl = `data:text/javascript;base64,${Buffer.from(patched, 'utf8').toString('base64')}`;
  const mod = await import(dataUrl);
  return mod.createTraceReader;
}

function collectRecordIds(value, out) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectRecordIds(item, out);
    return;
  }
  for (const [key, val] of Object.entries(value)) {
    if (key === 'evidenceIds' && Array.isArray(val)) {
      for (const id of val) {
        if (typeof id === 'string' && id.length >= 8) out.add(id);
      }
      continue;
    }
    if (
      typeof val === 'string' &&
      val.length >= 8 &&
      (key === 'id' || key === 'recordId' || key.endsWith('RecordId') || key === 'modelRecordId')
    ) {
      out.add(val);
    } else if (val && typeof val === 'object') {
      collectRecordIds(val, out);
    }
  }
}

function stripVolatileFsFields(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripVolatileFsFields);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'inode' || k === 'device' || k === 'modifiedAt') continue;
    out[k] = stripVolatileFsFields(v);
  }
  return out;
}

async function exportDemoData() {
  const createTraceReader = await loadTraceReader();
  const reader = await createTraceReader({ root: fixtureRoot });
  const runs = await reader.listRuns();
  if (!runs.length) {
    throw new Error(`No demo runs discovered under ${fixtureRoot}`);
  }

  const summaries = {};
  const eventsByRun = {};
  const recordsByRun = {};
  const filesByRun = {};

  for (const runMeta of runs) {
    const runId = runMeta.id;
    const summary = await reader.summary(runId);
    if (!summary) continue;
    summaries[runId] = summary;

    const allEvents = [];
    let cursor = undefined;
    while (true) {
      const page = await reader.events(runId, { cursor, limit: 1000 });
      if (!page) break;
      allEvents.push(...page.events);
      if (!page.hasMore || !page.cursor || page.cursor === cursor) break;
      cursor = page.cursor;
    }
    eventsByRun[runId] = allEvents;

    const recordIds = new Set();
    collectRecordIds(summary.spans, recordIds);
    collectRecordIds(summary.relations, recordIds);
    collectRecordIds(allEvents, recordIds);

    const records = {};
    const queue = [...recordIds];
    const visited = new Set();
    while (queue.length) {
      const id = queue.shift();
      if (!id || visited.has(id)) continue;
      visited.add(id);
      try {
        const detail = await reader.detail(runId, id);
        if (detail) {
          records[id] = detail;
          const nested = new Set();
          collectRecordIds(detail.contextMatches, nested);
          for (const nextId of nested) {
            if (!visited.has(nextId)) queue.push(nextId);
          }
        }
      } catch {
        // Non-record string IDs (e.g. agent UUIDs) are safely skipped.
      }
    }
    recordsByRun[runId] = records;

    const files = {};
    for (const fileEntry of summary.files ?? []) {
      const filePath = typeof fileEntry === 'string' ? fileEntry : fileEntry?.path;
      if (!filePath) continue;
      try {
        const content = await reader.file(runId, filePath, { offset: 0, limit: 256 * 1024 });
        if (content) files[filePath] = content;
      } catch {
        // Skip unreadable entries if any.
      }
    }
    filesByRun[runId] = files;
  }

  const payload = stripVolatileFsFields({
    runs,
    summaries,
    events: eventsByRun,
    records: recordsByRun,
    files: filesByRun,
  });
  return cli.sanitize ? sanitizeValue(payload) : payload;
}

const DEMO_SHIM_JS = `(() => {
  const params = new URLSearchParams(window.location.search);
  const requestedRun = params.get('run');
  const isEmbed = params.get('embed') === '1';

  if (requestedRun && !window.location.hash) {
    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search + '#run=' + encodeURIComponent(requestedRun),
    );
  }
  if (isEmbed) {
    document.documentElement.classList.add('embed-mode');
  }

  function postHeight() {
    if (!isEmbed || window.parent === window) return;
    const main = document.getElementById('run-view') || document.body;
    const inspector = document.getElementById('inspector');
    const mainH = Math.ceil(main.scrollHeight + 24);
    const minH = inspector && !inspector.hidden ? 560 : 440;
    const height = Math.max(minH, Math.min(920, mainH));
    window.parent.postMessage({ type: 'murm:trace-height', height }, window.location.origin);
  }

  // Receive theme sync and external view-tab switches from parent documentation frame.
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    if (!event.data || typeof event.data !== 'object') return;
    if (event.data.type === 'murm:theme' && (event.data.theme === 'light' || event.data.theme === 'dark')) {
      document.documentElement.dataset.theme = event.data.theme;
    }
    if (event.data.type === 'murm:trace-view' && typeof event.data.view === 'string') {
      const btn = document.querySelector('[data-view="' + event.data.view + '"]');
      if (btn) {
        btn.click();
        setTimeout(postHeight, 60);
      }
    }
  });

  let dataPromise = null;
  function loadData() {
    if (!dataPromise) {
      dataPromise = fetch('./demo-data.json').then((res) => {
        if (!res.ok) throw new Error('Failed to load Trace Viewer demo data (' + res.status + ')');
        return res.json();
      });
    }
    return dataPromise;
  }

  function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  const LIFECYCLE_KINDS = new Set(['spawn', 'stop', 'event', 'runtime', 'session-archive', 'lifecycle']);

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const rawUrl = typeof input === 'string' ? input : input?.url || '';
    const parsed = new URL(rawUrl, window.location.href);
    if (!parsed.pathname.startsWith('/api/')) {
      return nativeFetch(input, init);
    }

    const data = await loadData();
    if (parsed.pathname === '/api/runs') {
      return jsonResponse({ runs: data.runs });
    }

    const match = /^\\/api\\/runs\\/([^/]+)(?:\\/(events|records|files)(?:\\/([^/]+))?)?$/.exec(parsed.pathname);
    if (!match) return jsonResponse({ error: 'Route not found' }, 404);

    const runId = decodeURIComponent(match[1]);
    const resource = match[2];
    const encodedRecord = match[3];

    if (!resource) {
      const summary = data.summaries[runId];
      return summary ? jsonResponse(summary) : jsonResponse({ error: 'Run not found' }, 404);
    }

    if (resource === 'events') {
      const all = data.events[runId] || [];
      const agentId = parsed.searchParams.get('agentId') || '';
      const type = parsed.searchParams.get('type') || '';
      const filtered = all.filter((ev) => {
        if (agentId && ev.agentId !== agentId) return false;
        if (type) {
          if (type === 'lifecycle') {
            if (!LIFECYCLE_KINDS.has(ev.kind) && !LIFECYCLE_KINDS.has(ev.type)) return false;
          } else if (ev.kind !== type && ev.type !== type) {
            return false;
          }
        }
        return true;
      });
      const cursor = Math.max(0, Number(parsed.searchParams.get('cursor') || 0) || 0);
      const limit = Math.min(1000, Math.max(1, Number(parsed.searchParams.get('limit') || 100) || 100));
      const slice = filtered.slice(cursor, cursor + limit);
      const nextCursor = cursor + slice.length;
      return jsonResponse({
        events: slice,
        cursor: String(nextCursor),
        hasMore: nextCursor < filtered.length,
        total: filtered.length,
      });
    }

    if (resource === 'records' && encodedRecord) {
      const recordId = decodeURIComponent(encodedRecord);
      const detail = data.records[runId]?.[recordId];
      return detail ? jsonResponse(detail) : jsonResponse({ error: 'Evidence not found' }, 404);
    }

    if (resource === 'files') {
      const filePath = parsed.searchParams.get('path') || '';
      const file = data.files[runId]?.[filePath];
      if (!file) return jsonResponse({ error: 'File not found' }, 404);
      const offset = Math.max(0, Number(parsed.searchParams.get('offset') || 0) || 0);
      const limit = Math.max(1, Number(parsed.searchParams.get('limit') || 65536) || 65536);
      const fullText = file.text || '';
      const chunk = fullText.slice(offset, offset + limit);
      const nextOffset = offset + chunk.length;
      return jsonResponse({
        ...file,
        text: chunk,
        offset,
        nextOffset,
        truncated: nextOffset < fullText.length,
      });
    }

    return jsonResponse({ error: 'Evidence not found' }, 404);
  };

  const NativeEventSource = window.EventSource;
  window.EventSource = function DemoEventSource(url) {
    if (!String(url).includes('/api/runs/')) {
      return new NativeEventSource(url);
    }
    const stub = {
      readyState: 1,
      onopen: null,
      onerror: null,
      addEventListener() {},
      removeEventListener() {},
      close() {
        this.readyState = 2;
      },
    };
    setTimeout(() => {
      if (typeof stub.onopen === 'function') stub.onopen(new Event('open'));
      const badge = document.getElementById('live-state');
      if (badge) {
        badge.textContent = 'Interactive demo';
        badge.classList.add('connected');
      }
      const followBtn = document.getElementById('follow');
      if (followBtn) followBtn.hidden = true;
      postHeight();
    }, 40);
    return stub;
  };

  if (isEmbed) {
    document.addEventListener('DOMContentLoaded', () => {
      const toggle = document.getElementById('toggle-sidebar');
      const sidebar = document.getElementById('run-sidebar');
      if (toggle && sidebar && !sidebar.hidden) {
        toggle.click();
      }
      const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => postHeight()) : null;
      const runView = document.getElementById('run-view');
      const inspector = document.getElementById('inspector');
      if (ro && runView) ro.observe(runView);
      if (inspector) {
        const mo = new MutationObserver(() => postHeight());
        mo.observe(inspector, { attributes: true, attributeFilter: ['hidden'] });
      }
      setTimeout(postHeight, 120);
      setTimeout(postHeight, 350);
    });
  }
})();
`;

const EMBED_CSS_ADDON = `
/* Focused zero-scroll embed mode: keeps ONLY core interactive swimlane + active view */
html.embed-mode,
html.embed-mode body {
  height: auto !important;
  min-height: 0 !important;
  overflow: hidden !important;
  background: var(--surface, var(--bg)) !important;
}
html.embed-mode .app-header,
html.embed-mode .run-sidebar,
html.embed-mode .run-heading,
html.embed-mode .status-strip,
html.embed-mode .gaps,
html.embed-mode .view-toolbar,
html.embed-mode .trajectory-bar,
html.embed-mode #timeline-events,
html.embed-mode #traj-more-wrap,
html.embed-mode #timeline-note {
  display: none !important;
}
html.embed-mode .workspace {
  display: block !important;
  height: auto !important;
  min-height: 0 !important;
}
html.embed-mode .main-content {
  padding: 0 !important;
  height: auto !important;
  overflow: visible !important;
}
html.embed-mode .run-container {
  gap: 0 !important;
}
html.embed-mode .view-panel.blueprint-frame {
  border: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}
html.embed-mode .timeline-toolbar {
  padding: 8px 12px !important;
}
html.embed-mode .minimap-section {
  padding: 6px 12px 8px !important;
}
html.embed-mode .relations-grid {
  padding: 12px !important;
}
html.embed-mode #artifacts-panel {
  padding: 12px !important;
  gap: 12px !important;
}
html.embed-mode .inspector {
  top: 0 !important;
  height: 100% !important;
  max-height: 100% !important;
}
`;

async function main() {
  const demoData = await exportDemoData();

  await rm(outDir, { recursive: true, force: true });
  await mkdir(resolve(outDir, 'fonts'), { recursive: true });

  const rawHtml = await readFile(resolve(viewerPublicDir, 'index.html'), 'utf8');
  const demoHtml = rawHtml
    .replace('href="/style.css"', 'href="./style.css"')
    .replace(
      '<script type="module" src="/app.js"></script>',
      '<script src="./demo-shim.js"></script>\n    <script type="module" src="./app.js"></script>',
    )
    .replace('class="brand" href="/"', 'class="brand" href="./index.html"');

  const rawCss = await readFile(resolve(viewerPublicDir, 'style.css'), 'utf8');
  const demoCss = rawCss.replaceAll('url("/fonts/', 'url("./fonts/') + '\n' + EMBED_CSS_ADDON;

  const rawJs = await readFile(resolve(viewerPublicDir, 'app.js'), 'utf8');

  await Promise.all([
    writeFile(resolve(outDir, 'index.html'), demoHtml, 'utf8'),
    writeFile(resolve(outDir, 'style.css'), demoCss, 'utf8'),
    writeFile(resolve(outDir, 'app.js'), rawJs, 'utf8'),
    writeFile(resolve(outDir, 'demo-shim.js'), DEMO_SHIM_JS, 'utf8'),
    writeFile(resolve(outDir, 'demo-data.json'), JSON.stringify(demoData), 'utf8'),
    cp(resolve(viewerPublicDir, 'fonts'), resolve(outDir, 'fonts'), { recursive: true }),
  ]);

  const runCount = demoData.runs.length;
  const firstRun = demoData.runs[0]?.id;
  const spanCount = demoData.summaries[firstRun]?.spans?.length ?? 0;
  const recordCount = Object.keys(demoData.records[firstRun] ?? {}).length;
  const fileCount = Object.keys(demoData.files[firstRun] ?? {}).length;
  console.log(
    `Built static Trace Viewer demo in website/public/trace-demo/ (${runCount} run: ${firstRun}, ${spanCount} spans, ${recordCount} records, ${fileCount} files).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
