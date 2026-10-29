import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildModel } from '@/lib/observation';

const MAX_CLIENT_EVENTS = 4_000;
const EVENT_BATCH_MS = 300;
const REQUEST_TIMEOUT_MS = 15_000;

async function getJson(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(path, { headers: { accept: 'application/json' }, ...options, signal: options.signal || controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${path}`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function mergeEvents(current, incoming) {
  const bySequence = new Map(current.map((event) => [event.sequence, event]));
  for (const event of incoming) if (Number.isInteger(event?.sequence)) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence).slice(-MAX_CLIENT_EVENTS);
}

export function useObservation() {
  const [experiments, setExperiments] = useState([]);
  const [experiment, setExperiment] = useState(null);
  const [events, setEvents] = useState([]);
  const [timeline, setTimeline] = useState({ lanes: [] });
  const [toolCounts, setToolCounts] = useState({});
  const [connection, setConnection] = useState('Connecting');
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [details, setDetails] = useState({});
  const [projectionMeta, setProjectionMeta] = useState(null);
  const sourceRef = useRef(null);
  const registrySourceRef = useRef(null);
  const registryFallbackRef = useRef(false);
  const registryFallbackTimer = useRef(null);
  const registryInitialTimer = useRef(null);
  const registryRevisionRef = useRef('');
  const timelineTimer = useRef(null);
  const selectedRef = useRef(null);
  const pendingEventsRef = useRef(new Map());
  const eventBatchTimer = useRef(null);

  const model = useMemo(() => buildModel(events, timeline, toolCounts), [events, timeline, toolCounts]);

  const refreshTimeline = useCallback(async (id) => {
    if (!id) return;
    try {
      const next = await getJson(`/api/experiments/${encodeURIComponent(id)}/timeline?limit=1000&view=agent`);
      if (selectedRef.current === id) setTimeline(next);
    } catch {
      // The next live event or registry refresh will retry this bounded query.
    }
  }, []);

  const scheduleTimeline = useCallback((id) => {
    clearTimeout(timelineTimer.current);
    timelineTimer.current = setTimeout(() => void refreshTimeline(id), 450);
  }, [refreshTimeline]);

  const flushEvents = useCallback(() => {
    eventBatchTimer.current = null;
    const pending = [...pendingEventsRef.current.values()];
    pendingEventsRef.current.clear();
    if (!pending.length) return;
    setEvents((current) => mergeEvents(current, pending));
    setLastUpdated(new Date());
  }, []);

  const queueEvent = useCallback((event) => {
    if (!Number.isInteger(event?.sequence)) return;
    pendingEventsRef.current.set(event.sequence, event);
    if (eventBatchTimer.current === null) eventBatchTimer.current = setTimeout(flushEvents, EVENT_BATCH_MS);
  }, [flushEvents]);

  const openStream = useCallback((id, cursor) => {
    sourceRef.current?.close();
    const source = new EventSource(`/api/experiments/${encodeURIComponent(id)}/stream?after_sequence=${cursor || 0}&view=agent&overview=1`);
    sourceRef.current = source;
    source.onopen = () => setConnection('Live');
    source.onerror = () => setConnection('Reconnecting');
    const handleMessage = (message) => {
      try {
        const parsed = JSON.parse(message.data);
        const incoming = parsed.event || parsed;
        if (!incoming || selectedRef.current !== id) return;
        queueEvent(incoming);
        if (/execution_assigned|execution_released|core_state_changed|core_capacity_released|execution_started/.test(incoming.kind || '')) scheduleTimeline(id);
      } catch {
        // Ignore keepalive comments and malformed frames from a closing stream.
      }
    };
    source.addEventListener('observation', handleMessage);
    source.onmessage = handleMessage;
  }, [queueEvent, scheduleTimeline]);

  const selectExperiment = useCallback(async (id) => {
    if (!id) return;
    selectedRef.current = id;
    setConnection('Loading');
    setError(null);
    try {
      const overviewPromise = getJson(`/api/experiments/${encodeURIComponent(id)}/overview?view=agent`);
      const nextExperiment = await getJson(`/api/experiments/${encodeURIComponent(id)}`);
      if (selectedRef.current !== id) return;
      setExperiment(nextExperiment);
      setEvents([]);
      setTimeline({ lanes: [] });
      setToolCounts({});
      setProjectionMeta(null);
      setConnection('Loading projection');
      const overview = await overviewPromise;
      if (selectedRef.current !== id) return;
      setEvents(mergeEvents([], overview.events || []));
      setTimeline(overview.timeline || { lanes: [] });
      setToolCounts(overview.tool_counts || {});
      setProjectionMeta({
        historyTruncated: Boolean(overview.overview_history_truncated),
        eventCount: overview.events?.length || 0,
        startSequence: overview.overview_start_sequence || 0,
        endSequence: overview.overview_end_sequence || 0,
        toolCountsWindowed: Boolean(overview.tool_counts_windowed),
      });
      setDetails({});
      setLastUpdated(new Date());
      setConnection('Live');
      openStream(id, overview.events?.at(-1)?.sequence || 0);
    } catch (cause) {
      if (selectedRef.current === id) {
        setConnection('Unavailable');
        setError(cause);
      }
    }
  }, [openStream]);

  const applyRegistry = useCallback(async (result, initial = false) => {
    const next = result?.experiments || [];
    if (result?.revision) registryRevisionRef.current = result.revision;
    setExperiments(next);
    const selected = selectedRef.current && next.find((item) => item.experiment_id === selectedRef.current);
    if (!selected && selectedRef.current) {
      selectedRef.current = null;
      sourceRef.current?.close();
      setExperiment(null);
      setEvents([]);
      setTimeline({ lanes: [] });
      setToolCounts({});
      setProjectionMeta(null);
      setDetails({});
      setError(null);
    }
    const target = selected?.experiment_id
      || (initial || !selectedRef.current || !selected ? next.find((item) => item.status === 'RUNNING')?.experiment_id || next[0]?.experiment_id : null);
    if (target && target !== selectedRef.current) await selectExperiment(target);
    else if (selected) setExperiment((current) => current ? { ...current, ...selected } : current);
    else if (!target && !selectedRef.current) setConnection('Waiting for data');
  }, [selectExperiment]);

  const refreshExperiments = useCallback(async (initial = false) => {
    try {
      const result = await getJson('/api/experiments?limit=100');
      await applyRegistry(result, initial);
    } catch (cause) {
      setConnection('Unavailable');
      setError(cause);
    }
  }, [applyRegistry]);

  const startRegistryFallback = useCallback(() => {
    if (registryFallbackRef.current) return;
    registryFallbackRef.current = true;
    registrySourceRef.current?.close();
    const wait = (milliseconds) => new Promise((resolve) => {
      clearTimeout(registryFallbackTimer.current);
      registryFallbackTimer.current = setTimeout(resolve, milliseconds);
    });
    const run = async () => {
      while (registryFallbackRef.current) {
        try {
          const since = registryRevisionRef.current;
          const suffix = since ? `?since=${encodeURIComponent(since)}` : '';
          const result = await getJson(`/api/experiments/changes${suffix}`);
          if (!registryFallbackRef.current) return;
          await applyRegistry(result);
        } catch {
          if (!registryFallbackRef.current) return;
          await wait(2_000);
        }
      }
    };
    void run();
  }, [applyRegistry]);

  const openRegistryStream = useCallback(() => {
    registrySourceRef.current?.close();
    clearTimeout(registryInitialTimer.current);
    const source = new EventSource('/api/experiments/stream');
    registrySourceRef.current = source;
    let received = false;
    const handleRegistry = (message) => {
      try {
        const result = JSON.parse(message.data);
        received = true;
        clearTimeout(registryInitialTimer.current);
        void applyRegistry(result);
      } catch {
        // Ignore malformed frames while the edge connection is closing.
      }
    };
    source.addEventListener('experiments', handleRegistry);
    source.onmessage = handleRegistry;
    source.onerror = () => {
      source.close();
      clearTimeout(registryInitialTimer.current);
      registryInitialTimer.current = setTimeout(startRegistryFallback, received ? 1_000 : 250);
    };
    // Some edge proxies deliver the SSE headers but buffer the first event.
    // Switch to the server-side long request instead of polling the registry.
    registryInitialTimer.current = setTimeout(() => {
      if (!received) startRegistryFallback();
    }, 8_000);
  }, [applyRegistry, startRegistryFallback]);

  useEffect(() => {
    void refreshExperiments(true);
    openRegistryStream();
    return () => {
      registryFallbackRef.current = false;
      registrySourceRef.current?.close();
      clearTimeout(registryInitialTimer.current);
      clearTimeout(registryFallbackTimer.current);
    };
  }, [openRegistryStream, refreshExperiments]);

  useEffect(() => () => {
    sourceRef.current?.close();
    clearTimeout(timelineTimer.current);
    clearTimeout(eventBatchTimer.current);
    pendingEventsRef.current.clear();
  }, []);

  const loadDetail = useCallback(async (kind, id) => {
    if (!experiment?.experiment_id || !id) return null;
    const key = `${kind}:${id}`;
    if (details[key]) return details[key];
    const paths = {
      execution: `/api/experiments/${encodeURIComponent(experiment.experiment_id)}/execution-detail?execution_id=${encodeURIComponent(id)}`,
      insight: `/api/experiments/${encodeURIComponent(experiment.experiment_id)}/execution-insight?execution_id=${encodeURIComponent(id)}`,
      task: `/api/experiments/${encodeURIComponent(experiment.experiment_id)}/tasks/${encodeURIComponent(id)}`,
      material: `/api/experiments/${encodeURIComponent(experiment.experiment_id)}/materials/${encodeURIComponent(id)}`,
      report: `/api/experiments/${encodeURIComponent(experiment.experiment_id)}/report`,
    };
    try {
      const value = await getJson(paths[kind]);
      setDetails((current) => ({ ...current, [key]: value }));
      return value;
    } catch (cause) {
      const value = { error: cause.message };
      setDetails((current) => ({ ...current, [key]: value }));
      return value;
    }
  }, [details, experiment]);

  return {
    experiments,
    experiment,
    events,
    timeline,
    model,
    connection,
    error,
    lastUpdated,
    details,
    projectionMeta,
    selectExperiment,
    refresh: () => (experiment?.experiment_id ? selectExperiment(experiment.experiment_id) : refreshExperiments(true)),
    refreshExperiments,
    loadDetail,
  };
}
