import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { ObservationStore } from '../src/observability/observation-store.js';
import { ObservabilityServer } from '../src/observability/observability-server.js';

const dashboardSource = await readFile(new URL('../src/observability/public/app.js', import.meta.url), 'utf8');

function browserHarness(baseUrl) {
  const elements = new Map();
  const windowListeners = new Map();
  let latestEventSource = null;
  function element(selector) {
    if (!elements.has(selector)) {
      elements.set(selector, {
        innerHTML: '', textContent: '', value: '', dataset: {}, className: '', hidden: false,
        classList: { toggle() {}, add() {}, remove() {} },
        addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
      });
    }
    return elements.get(selector);
  }
  const document = { querySelector: element, querySelectorAll: () => [], addEventListener() {} };
  const window = { addEventListener(name, listener) { windowListeners.set(name, listener); } };
  class FakeEventSource {
    constructor(url) { this.url = url; this.listeners = new Map(); latestEventSource = this; }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    close() {}
  }
  const location = { hash: '' };
  const context = {
    document, window, location, EventSource: FakeEventSource,
    fetch: (path, options) => fetch(new URL(path, baseUrl), options),
    setInterval() { return 0; }, clearInterval() {}, setTimeout, clearTimeout,
    console, Date, Number, String, Math, JSON, Object, Array, Set, Map, Promise, structuredClone, URL,
  };
  vm.createContext(context);
  return {
    elements, windowListeners, location, context,
    get eventSource() { return latestEventSource; },
    start() { vm.runInContext(dashboardSource, context, { filename: 'observability-dashboard.js' }); },
  };
}

async function waitFor(predicate, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('dashboard harness timed out');
}

test('dashboard renders fixture routes, nested service state, redacted payloads, and live timeline updates', async () => {
  const store = new ObservationStore();
  const experimentId = 'dashboard-browser-fixture';
  store.registerExperiment({ experimentId, rootTaskId: 'task-root', status: 'RUNNING', metadata: { problem_id: 'fixture' } });
  const append = (event) => store.append({ experimentId, ...event });
  append({ source: 'runtime', kind: 'execution_assigned', coreId: 'core-1', taskId: 'task-root', executionId: 'exec-root', sessionId: 'session-1', payload: { state: 'RUNNING' } });
  append({ source: 'runtime', kind: 'core_state_changed', coreId: 'core-1', taskId: 'task-root', executionId: 'exec-root', payload: { state: 'RUNNING', ended_at_ms: Date.now() + 1_000 } });
  append({ source: 'task-service', kind: 'dispatch.complete', taskId: 'task-root', executionId: 'exec-root', payload: {
    result: {
      task: { task_id: 'task-root', task_type: 'root', goal: 'Coordinate fixture', state: 'SUCCEEDED' },
      execution: { execution_id: 'exec-root', task_id: 'task-root', state: 'SUCCEEDED' },
    },
  } });
  append({ source: 'context-service', kind: 'dispatch.complete', taskId: 'task-root', executionId: 'exec-root', payload: {
    result: { material: { material_id: 'material-1', kind: 'proof', evidence_state: 'checked', source_task: 'task-root', source_execution: 'exec-root', content: { token: 'private-secret' } } },
  } });
  const server = new ObservabilityServer({ observationStore: store });
  const { url } = await server.start();
  try {
    const harness = browserHarness(url);
    harness.start();
    await waitFor(() => harness.elements.get('#main-view')?.innerHTML.includes('Core activity'));
    assert.match(harness.elements.get('#timeline').innerHTML, /exec-root/);
    assert.match(harness.eventSource.url, /view=agent/);

    const navigate = async (path) => {
      harness.location.hash = `#${path}`;
      harness.windowListeners.get('hashchange')();
      await new Promise((resolve) => setTimeout(resolve, 25));
      return harness.elements.get('#main-view').innerHTML;
    };
    assert.match(await navigate('execution/exec-root'), /SUCCEEDED/);
    assert.match(await navigate('task/task-root'), /TASK FLOW/);
    assert.match(await navigate('material/material-1'), /Redacted browser projection/);
    assert.doesNotMatch(harness.elements.get('#main-view').innerHTML, /private-secret/);

    await navigate('home');
    const liveEvent = append({ source: 'runtime', kind: 'core_state_changed', coreId: 'core-2', taskId: 'task-root', executionId: 'exec-root', payload: { state: 'RUNNING' } });
    harness.eventSource.listeners.get('observation')({ data: JSON.stringify(liveEvent) });
    await waitFor(() => harness.elements.get('#timeline').innerHTML.includes('core-2'));
  } finally {
    await server.stop();
    store.close();
  }
});
