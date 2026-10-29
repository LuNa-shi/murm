import { cn } from '@/lib/utils';
import { formatDuration, formatTime, shortId } from '@/lib/format';
import { StateBadge } from './badge';

export function Trace({ traces = [], selectedExecution, onExecution }) {
  const allSpans = traces.flatMap((trace) => [...trace.executions, ...trace.tools, ...trace.checks, ...trace.markers, ...trace.turns, ...trace.session_turns]);
  const timestamps = allSpans.flatMap((span) => [new Date(span.start || 0).getTime(), new Date(span.end || span.start || 0).getTime()]).filter(Number.isFinite);
  const min = Math.min(...timestamps, Date.now() - 60_000);
  const max = Math.max(...timestamps, Date.now());
  const span = Math.max(1, max - min);
  const pos = (value) => Math.max(0, Math.min(100, ((new Date(value || min).getTime() - min) / span) * 100));
  const width = (start, end) => Math.max(1.4, pos(end || new Date(new Date(start).getTime() + Math.max(span * 0.015, 1000))) - pos(start));
  if (!traces.length) return <div className="flex min-h-48 items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 text-sm text-muted-foreground">No Core trace has been observed yet.</div>;
  const ticks = [0, 25, 50, 75, 100];
  return <div className="overflow-x-auto rounded-xl border border-border/70 bg-muted/15">
    <div className="min-w-[720px] p-4">
      <div className="relative ml-[128px] h-7 border-b border-border/70 text-[10px] text-muted-foreground">
        {ticks.map((tick) => <span key={tick} className="absolute -translate-x-1/2" style={{ left: `${tick}%` }}>{formatTime(min + (max - min) * tick / 100)}</span>)}
      </div>
      <div className="space-y-3 pt-3">
        {traces.map((trace) => <TraceLane key={trace.core_id} trace={trace} selectedExecution={selectedExecution} onExecution={onExecution} pos={pos} width={width} />)}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-border/60 pt-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><i className="legend-swatch bg-sky-500" />Execution</span>
        <span className="inline-flex items-center gap-1.5"><i className="legend-swatch bg-violet-500" />Tool</span>
        <span className="inline-flex items-center gap-1.5"><i className="legend-swatch bg-amber-500" />Check / wait</span>
        <span>Click an Execution bar to inspect its bounded trace.</span>
      </div>
    </div>
  </div>;
}

function TraceLane({ trace, selectedExecution, onExecution, pos, width }) {
  const rows = [
    { label: 'STATE', spans: trace.states, color: 'state-span' },
    { label: 'EXECUTION', spans: trace.executions, color: 'execution-span' },
    { label: 'OBSERVED', spans: [...trace.tools, ...trace.checks, ...trace.markers], color: 'observed-span' },
  ];
  const active = rows.some((row) => row.spans.some((item) => !item.end)) || /RUNNING|ASSIGNED/i.test(trace.last_state || '');
  const observedCount = rows.reduce((total, row) => total + row.spans.length, 0);
  return <div className={cn('trace-lane rounded-xl border border-border/60 bg-background p-3', active && 'trace-lane-active')} style={{ contentVisibility: 'auto', containIntrinsicSize: '0 180px' }}>
    <div className="mb-2 flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2"><span className={cn('trace-lane-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-bold text-foreground', active && 'trace-lane-icon-active')}>{String(trace.core_id).replace(/^core[-_]?/i, '')}</span><div className="min-w-0"><p className="truncate text-xs font-semibold">{trace.core_id}</p><p className="truncate text-[10px] text-muted-foreground">{trace.active_execution ? `Execution ${shortId(trace.active_execution, 14)}` : 'capacity available'} · {trace.agent_turn_count || 0} turns · {observedCount} facts</p></div></div><div className="flex items-center gap-2">{active && <span className="live-dot" aria-label="Core active" />}<StateBadge value={trace.last_state} /></div>
    </div>
    <div className="space-y-1.5">
      {rows.map((row) => <div key={row.label} className="flex items-center gap-2"><span className="w-20 shrink-0 text-[9px] font-semibold tracking-[0.14em] text-muted-foreground">{row.label}</span><div className="relative h-7 flex-1 overflow-hidden rounded-md bg-muted/70"><div className="absolute inset-y-0 left-0 right-0 opacity-50" style={{ backgroundImage: 'linear-gradient(to right, transparent 24.8%, hsl(var(--border)) 25%, transparent 25.2%, transparent 49.8%, hsl(var(--border)) 50%, transparent 50.2%, transparent 74.8%, hsl(var(--border)) 75%, transparent 75.2%)' }} />{row.spans.slice(-160).map((item, index) => <TraceSpan key={`${item.id || item.execution_id || item.start}-${index}`} item={item} color={row.color} selected={item.execution_id && item.execution_id === selectedExecution} onClick={() => item.execution_id && onExecution?.(item.execution_id)} pos={pos} width={width} />)}</div></div>)}
    </div>
  </div>;
}

function TraceSpan({ item, color, selected, onClick, pos, width }) {
  const interactive = Boolean(item.execution_id && onClick);
  const Component = interactive ? 'button' : 'span';
  const duration = item.end ? formatDuration(new Date(item.end).getTime() - new Date(item.start).getTime()) : 'active';
  return <Component type={interactive ? 'button' : undefined} onClick={interactive ? onClick : undefined} aria-label={`${item.label || item.kind || 'span'} · ${duration}`} title={`${item.label || item.kind || 'span'} · ${formatTime(item.start, true)} · ${duration}`} className={cn('trace-span absolute top-1/2 flex h-4 -translate-y-1/2 items-center overflow-hidden rounded-[4px] px-1 text-left text-[9px] font-semibold text-white transition hover:brightness-110', color, !item.end && 'trace-span-active', selected && 'trace-span-selected')} style={{ left: `${pos(item.start)}%`, width: `${width(item.start, item.end)}%` }}>{item.execution_id ? shortId(item.execution_id, 10) : ''}</Component>;
}
