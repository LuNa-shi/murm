import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildModel } from '@/lib/observation';

async function getJson(path, options = {}) {
  const response = await fetch(path, { headers: { accept: 'application/json' }, ...options });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
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
  const sourceRef = useRef(null);
  const timelineTimer = useRef(null);
  const selectedRef = useRef(null);

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
    timelineTimer.current = setTimeout(() => void refreshTimeline(id), 100);
  }, [refreshTimeline]);

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
        setEvents((current) => current.some((event) => event.sequence === incoming.sequence) ? current : [...current, incoming].sort((a, b) => a.sequence - b.sequence));
        setLastUpdated(new Date());
        if (/execution_assigned|execution_released|core_state_changed|core_capacity_released|execution_started/.test(incoming.kind || '')) scheduleTimeline(id);
      } catch {
        // Ignore keepalive comments and malformed frames from a closing stream.
      }
    };
    source.addEventListener('observation', handleMessage);
    source.onmessage = handleMessage;
  }, [scheduleTimeline]);

  const selectExperiment = useCallback(async (id) => {
    if (!id) return;
    selectedRef.current = id;
    setConnection('Loading');
    setError(null);
    try {
      const [nextExperiment, overview] = await Promise.all([
        getJson(`/api/experiments/${encodeURIComponent(id)}`),
        getJson(`/api/experiments/${encodeURIComponent(id)}/overview?view=agent`),
      ]);
      if (selectedRef.current !== id) return;
      setExperiment(nextExperiment);
      setEvents(overview.events || []);
      setTimeline(overview.timeline || { lanes: [] });
      setToolCounts(overview.tool_counts || {});
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

  const refreshExperiments = useCallback(async (initial = false) => {
    try {
      const result = await getJson('/api/experiments?limit=100');
      const next = result.experiments || [];
      setExperiments(next);
      const selected = selectedRef.current && next.find((item) => item.experiment_id === selectedRef.current);
      const target = selected?.experiment_id || (initial || !selectedRef.current ? next.find((item) => item.status === 'RUNNING')?.experiment_id || next[0]?.experiment_id : null);
      if (target && target !== selectedRef.current) await selectExperiment(target);
      else if (selected && experiment) setExperiment((current) => ({ ...current, ...selected }));
      else if (!target && !selectedRef.current) setConnection('Waiting for data');
    } catch (cause) {
      if (!experiment) { setConnection('Unavailable'); setError(cause); }
    }
  }, [experiment, selectExperiment]);

  useEffect(() => {
    void refreshExperiments(true);
    const timer = setInterval(() => void refreshExperiments(false), 4_000);
    return () => clearInterval(timer);
  }, []); // Registry polling intentionally keeps one stable stream owner.

  useEffect(() => () => {
    sourceRef.current?.close();
    clearTimeout(timelineTimer.current);
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
    selectExperiment,
    refresh: () => (experiment?.experiment_id ? selectExperiment(experiment.experiment_id) : refreshExperiments(true)),
    refreshExperiments,
    loadDetail,
  };
}
