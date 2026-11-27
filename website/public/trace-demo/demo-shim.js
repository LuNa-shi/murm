(() => {
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

    const match = /^\/api\/runs\/([^/]+)(?:\/(events|records|files)(?:\/([^/]+))?)?$/.exec(parsed.pathname);
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
