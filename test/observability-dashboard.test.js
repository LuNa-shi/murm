import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import test from 'node:test';
import { ObservationStore } from '../src/observability/observation-store.js';

const dashboardSource = await readFile(new URL('../src/observability/public/app.js', import.meta.url), 'utf8');

function browserHarness(baseUrl) {
  const elements = new Map();
  const windowListeners = new Map();
  const fetchCalls = [];
  let latestEventSource = null;
  function element(selector) {
    if (!elements.has(selector)) {
      elements.set(selector, {
        innerHTML: '', textContent: '', value: '', dataset: {}, className: '', hidden: false,
        classList: { toggle() {}, add() {}, remove() {} },
        addEventListener() {}, querySelector() { return null; },
        querySelectorAll(childSelector) {
          if (childSelector !== '.timeline-segment') return [];
          if (this.timelineNodes) return this.timelineNodes;
          this.timelineNodes = [...this.innerHTML.matchAll(/data-execution-id="([^"]*)"/g)].map((match) => {
            const node = { dataset: { executionId: match[1] }, addEventListener(name, listener) { if (name === 'click') node.click = listener; } };
            return node;
          });
          return this.timelineNodes;
        },
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
  let hashValue = '';
  const location = { get hash() { return hashValue; }, set hash(value) { hashValue = String(value).startsWith('#') ? String(value) : `#${value}`; } };
  const context = {
    document, window, location, EventSource: FakeEventSource,
    fetch: (path, options) => { fetchCalls.push(String(path)); return fetch(new URL(path, baseUrl), options); },
    setInterval() { return 0; }, clearInterval() {}, setTimeout, clearTimeout,
    console, Date, Number, String, Math, JSON, Object, Array, Set, Map, Promise, structuredClone, URL,
  };
  vm.createContext(context);
  return {
    elements, windowListeners, fetchCalls, location, context,
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
  const root = await mkdtemp(join(tmpdir(), 'swarmenv-dashboard-test-'));
  await mkdir(join(root, '.observability'), { recursive: true });
  const database = join(root, '.observability', 'observability.sqlite');
  const store = new ObservationStore(database);
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
  append({ source: 'context-service', kind: 'dispatch.complete', taskId: 'task-wait', executionId: 'exec-wait', payload: { operation: 'read_materials', result: { materials: [{ material_id: 'material-1' }] } } });
  append({ source: 'task-service', kind: 'dispatch.complete', taskId: 'task-wait', executionId: 'exec-wait', payload: {
    result: { task: { task_id: 'task-wait', parent_id: 'task-root', goal: 'Wait for parent review', state: 'WAITING' }, execution: { execution_id: 'exec-wait', task_id: 'task-wait', state: 'WAITING', wait_condition: { type: 'parent_review' } } },
  } });
  append({ source: 'context-service', kind: 'dispatch.complete', taskId: 'task-wait', executionId: 'exec-wait', payload: { ok: false, error: { code: 'CONTEXT_UNAVAILABLE', message: 'synthetic fixture failure' } } });
  append({ source: 'agent', kind: 'agent_turn_started', coreId: 'core-1', taskId: 'task-root', executionId: 'exec-root', payload: { state: 'RUNNING' } });
  append({ source: 'agent', kind: 'rpc_record', coreId: 'core-1', taskId: 'task-root', executionId: 'exec-root', payload: { record: { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'swarmenv_task_list', args: { available_only: true } } } });
  append({ source: 'agent', kind: 'rpc_record', coreId: 'core-1', taskId: 'task-root', executionId: 'exec-root', payload: { record: { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'swarmenv_task_list', result: { tasks: [] }, isError: false } } });
  append({ source: 'agent', kind: 'agent_turn_finished', coreId: 'core-1', taskId: 'task-root', executionId: 'exec-root', payload: { state: 'RUNNING' } });
  store.close();
  const writer = new ObservationStore(database);
  const child = spawn(process.execPath, ['scripts/serve-observability.mjs', '--root', root, '--host', '127.0.0.1', '--port', '0'], { cwd: process.cwd() });
  const startup = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const line = output.split('\n').find(Boolean);
      if (!line) return;
      try { resolve(JSON.parse(line)); } catch { /* wait for the complete JSON line */ }
    });
    child.stderr.on('data', () => {});
    child.once('error', reject);
    child.once('exit', (code) => { if (code !== 0) reject(new Error(`observability server exited with ${code}`)); });
  });
  try {
    const harness = browserHarness(startup.url);
    harness.start();
    await waitFor(() => harness.elements.get('#main-view')?.innerHTML.includes('Core activity'));
    assert.match(harness.elements.get('#timeline').innerHTML, /exec-root/);
    assert.match(harness.elements.get('#timeline').innerHTML, /waterfall-row state-row/);
    assert.match(harness.elements.get('#timeline').innerHTML, /waterfall-span turn-span/);
    assert.match(harness.elements.get('#timeline').innerHTML, /waterfall-span tool-span/);
    assert.match(harness.elements.get('#timeline').innerHTML, /Task task-root/);
    assert.match(harness.elements.get('#timeline').innerHTML, /Session session-1/);
    assert.match(harness.eventSource.url, /view=agent/);
    const timelineSegment = harness.elements.get('#timeline').querySelectorAll('.timeline-segment')[0];
    assert.ok(timelineSegment, 'timeline segment should be queryable');
    assert.equal(typeof timelineSegment.click, 'function', 'timeline segment should be wired to navigation');
    timelineSegment.click();
    assert.equal(harness.location.hash, '#execution/exec-root');
    harness.windowListeners.get('hashchange')();

    const navigate = async (path) => {
      harness.location.hash = `#${path}`;
      harness.windowListeners.get('hashchange')();
      await new Promise((resolve) => setTimeout(resolve, 25));
      return harness.elements.get('#main-view').innerHTML;
    };
    assert.match(await navigate('execution/exec-root'), /SUCCEEDED/);
    await waitFor(() => harness.fetchCalls.some((path) => path.includes('/execution-detail?execution_id=exec-root')));
    await waitFor(() => harness.fetchCalls.some((path) => path.includes('/execution-insight?execution_id=exec-root')));
    assert.match(harness.elements.get('#main-view').innerHTML, /STARTING CONTEXT/);
    assert.match(harness.elements.get('#main-view').innerHTML, /Click a row to expand/);
    assert.match(await navigate('task/task-root'), /TASK FLOW/);
    assert.match(await navigate('task/task-wait'), /parent_review/);
    assert.match(harness.elements.get('#main-view').innerHTML, /0s/);
    assert.match(await navigate('material/material-1'), /Redacted browser projection/);
    await waitFor(() => harness.fetchCalls.some((path) => path.includes('/materials/material-1')));
    assert.match(harness.elements.get('#main-view').innerHTML, /MATERIAL CONTENT/);
    assert.match(harness.elements.get('#main-view').innerHTML, /Raw Material payload/);
    assert.doesNotMatch(harness.elements.get('#main-view').innerHTML, /private-secret/);
    assert.match(harness.elements.get('#main-view').innerHTML, /exec-wait/);
    assert.doesNotMatch(harness.elements.get('#main-view').innerHTML, /private-secret/);
    await navigate('execution/exec-root');
    const executionViewBeforeLiveEvent = harness.elements.get('#main-view').innerHTML;
    const liveDetailEvent = writer.append({ experimentId, source: 'runtime', kind: 'core_state_changed', coreId: 'core-2', taskId: 'task-root', executionId: 'exec-root', payload: { state: 'RUNNING' } });
    harness.eventSource.listeners.get('observation')({ data: JSON.stringify(liveDetailEvent) });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(harness.elements.get('#main-view').innerHTML, executionViewBeforeLiveEvent, 'live events should not rebuild an open detail route');
    assert.match(await navigate('diagnostics'), /wait boundaries/);
    assert.match(harness.elements.get('#main-view').innerHTML, /error signals/);

    await navigate('home');
    const liveEvent = writer.append({ experimentId, source: 'runtime', kind: 'core_state_changed', coreId: 'core-2', taskId: 'task-root', executionId: 'exec-root', payload: { state: 'RUNNING' } });
    harness.eventSource.listeners.get('observation')({ data: JSON.stringify(liveEvent) });
    await waitFor(() => harness.elements.get('#timeline').innerHTML.includes('core-2'));
  } finally {
    writer?.close();
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await rm(root, { recursive: true, force: true });
  }
});
