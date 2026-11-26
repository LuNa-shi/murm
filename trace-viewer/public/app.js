const $ = (selector) => document.querySelector(selector);
const SVG_NS = "http://www.w3.org/2000/svg";

const AGENT_COLORS = [
  "var(--accent)",
  "var(--teal)",
  "var(--purple)",
  "var(--amber)",
];

const TRACK_DEFS = [
  { key: "input", label: "Input", color: "var(--accent)" },
  { key: "model", label: "Model", color: "var(--purple)" },
  { key: "tool", label: "Tools", color: "var(--amber)" },
  { key: "service", label: "Service", color: "var(--teal)" },
];

const state = {
  runs: [],
  run: null,
  timelineItems: [],
  domainStart: 0,
  domainEnd: 1000,
  winStart: 0,
  winEnd: 1000,
  scale: "duration", // "duration" | "sequence"
  agentFilter: "",
  trackFilter: "all",
  timelineSearch: "",
  showSpawn: true,
  trajLimit: 60,
  events: [],
  cursor: 0,
  nextCursor: 0,
  history: [],
  hasMore: false,
  total: 0,
  view: "timeline",
  selected: null,
  hovered: null,
  inspectorMode: "struct",
  lastDetail: null,
  follow: true,
  stream: null,
  generation: 0,
  inspectorGeneration: 0,
  pageGeneration: 0,
  sidebarOpen: true,
};

let mmBuiltKey = "";
let mmWidth = 0;
let rafPending = false;
let trajDebounce = null;
let swimlaneDragged = false;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgEl(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) node.setAttribute(k, String(v));
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, className, onClick) {
  const node = element("button", className, text);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function shortId(value) {
  return String(value ?? "Unknown").slice(0, 12);
}

function dateValue(value) {
  if (typeof value === "number") return value;
  return value ? Date.parse(value) : NaN;
}

function clock(value) {
  const time = dateValue(value);
  return Number.isFinite(time)
    ? new Date(time).toISOString().slice(11, 23)
    : "No time";
}

function duration(value) {
  if (!Number.isFinite(value)) return "Unknown";
  if (value < 1) return "<1 ms";
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(2)}s`;
  return `${Math.floor(value / 60000)}m ${Math.floor((value % 60000) / 1000)}s`;
}

function formatRel(ms) {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
}

function pretty(value) {
  if (value === undefined || value === null) return "Not recorded";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function statusLabel(value) {
  if (value === undefined || value === null) return "Unknown";
  if (typeof value === "object")
    return String(value.status ?? value.state ?? value.result ?? "Recorded");
  return String(value);
}

function isErrorStatus(value) {
  return /fail|error|reject|interrupt|abort/i.test(statusLabel(value));
}

function statusClass(value) {
  const text = statusLabel(value).toLowerCase();
  if (/fail|error|rejected|interrupted|aborted/.test(text)) return "bad";
  if (/pending|unknown|gap|incomplete|open/.test(text)) return "warning";
  if (/closed|complete|clean|success|pass|settled|returned|recorded/.test(text))
    return "good";
  return "";
}

function showError(error) {
  $("#error").hidden = false;
  $("#error").textContent = error.message ?? String(error);
}

async function api(path) {
  const response = await fetch(path, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      message = body.error?.message ?? body.error ?? message;
    } catch {
      /* Keep HTTP status for non-JSON errors. */
    }
    throw new Error(message);
  }
  return response.json();
}

function runPath(suffix = "") {
  return `/api/runs/${encodeURIComponent(state.run.id)}${suffix}`;
}

function agentLabel(id) {
  const agent = state.run?.agents?.find((item) => item.id === id);
  return agent?.label ?? shortId(id);
}

function agentColor(id) {
  const index = (state.run?.agents ?? []).findIndex((item) => item.id === id);
  return AGENT_COLORS[Math.max(0, index) % AGENT_COLORS.length];
}

// ============================================================================
// RUN LIST & LOADING
// ============================================================================
async function loadRuns() {
  try {
    const result = await api("/api/runs");
    state.runs = result.runs ?? result;
    renderRuns();
    const requested = new URLSearchParams(location.hash.slice(1)).get("run");
    if (!state.run) {
      if (requested && state.runs.some((run) => run.id === requested)) {
        await openRun(requested);
      } else if (state.runs.length === 1) {
        await openRun(state.runs[0].id);
      }
    }
    if (!state.runs.length) {
      $("#empty-help").textContent =
        "No Runs found in the configured root. Add a recorded Run directory, then refresh.";
    }
    $("#error").hidden = true;
  } catch (error) {
    showError(error);
  }
}

function renderRuns() {
  const query = $("#run-search").value.trim().toLowerCase();
  const runs = state.runs.filter((run) =>
    `${run.label ?? ""} ${run.id} ${run.runtimeId ?? ""}`
      .toLowerCase()
      .includes(query),
  );
  $("#run-count").textContent = `RUNS (${runs.length})`;
  $("#runs").replaceChildren();
  for (const run of runs) {
    const card = button(
      "",
      `run-card${state.run?.id === run.id ? " selected" : ""}`,
      () => openRun(run.id).catch(showError),
    );
    card.setAttribute(
      "aria-current",
      state.run?.id === run.id ? "page" : "false",
    );
    const top = element("div", "run-card-top");
    const statusText = statusLabel(run.status);
    const dotClass =
      statusClass(run.status) ||
      (/running|active|open/i.test(statusText) ? "active" : "");
    const statusWrap = element("span", "muted");
    statusWrap.style.display = "inline-flex";
    statusWrap.style.alignItems = "center";
    statusWrap.style.gap = "5px";
    statusWrap.style.fontSize = "10px";
    statusWrap.append(
      element("span", `status-dot ${dotClass}`),
      document.createTextNode(statusText),
    );
    top.append(
      element("span", "muted", `${run.agentCount ?? 0} agents`),
      statusWrap,
    );
    const title = element("div", "run-card-title", run.label ?? shortId(run.id));
    const meta = element("div", "run-card-meta");
    const counts =
      run.modelCount != null
        ? `${run.modelCount} model · ${run.evidenceCount ?? 0} ev`
        : shortId(run.runtimeId ?? run.id);
    meta.append(
      element("span", "", run.id === run.label ? shortId(run.runtimeId) : run.id),
      element("span", "", counts),
    );
    card.append(top, title, meta);
    $("#runs").append(card);
  }
  if (!runs.length) {
    $("#runs").append(element("p", "empty-state", "No matching Runs."));
  }
}

async function openRun(id) {
  const generation = ++state.generation;
  ++state.inspectorGeneration;
  ++state.pageGeneration;
  state.stream?.close();
  const run = await api(`/api/runs/${encodeURIComponent(id)}`);
  if (generation !== state.generation) return;
  state.run = run;
  state.cursor = 0;
  state.history = [];
  state.selected = null;
  state.hovered = null;
  state.agentFilter = "";
  state.trackFilter = "all";
  state.timelineSearch = "";
  state.trajLimit = 60;
  state.lastDetail = null;
  mmBuiltKey = "";
  $("#inspector").hidden = true;
  $("#welcome").hidden = true;
  $("#run-view").hidden = false;
  $("#error").hidden = true;
  location.hash = new URLSearchParams({ run: id }).toString();
  $("#agent-filter").value = "";
  $("#type-filter").value = "";
  $("#event-search").value = "";
  $("#timeline-search").value = "";
  rebuildTimelineModel(true);
  renderSummary();
  renderRuns();
  await loadPage(0);
  if (generation === state.generation) connectLive(run.cursor ?? 0);
}

// ============================================================================
// TIMELINE DATA MODEL (100% Real-Time Spans + Point Observations)
// ============================================================================
function rebuildTimelineModel(resetWindow = false) {
  const run = state.run;
  if (!run) return;
  const items = [];
  let modelSeq = 0;
  for (const span of run.spans ?? []) {
    if (span.kind === "execution") continue;
    const s = dateValue(span.startedAt);
    if (!Number.isFinite(s)) continue;
    const e = Number.isFinite(dateValue(span.endedAt))
      ? Math.max(s, dateValue(span.endedAt))
      : s;
    const isModel = span.kind === "model";
    if (isModel) modelSeq++;
    let detail = span.detail ?? "";
    if (isModel) {
      const tok =
        span.usage && (span.usage.inputTokens || span.usage.outputTokens)
          ? `${span.usage.inputTokens.toLocaleString()} in / ${span.usage.outputTokens.toLocaleString()} out tok`
          : "";
      detail = [tok, span.model, span.status !== "completed" ? span.status : ""]
        .filter(Boolean)
        .join(" · ");
    } else if (!detail) {
      detail = statusLabel(span.status);
    }
    items.push({
      id: span.id,
      evidenceId: span.evidenceIds?.[0] ?? span.id,
      evidenceIds: span.evidenceIds ?? [span.id],
      agentId: span.agentId,
      kind: span.kind,
      label: isModel ? `Model #${modelSeq}` : span.label ?? span.kind,
      startedAt: s,
      endedAt: e,
      isPoint: !Number.isFinite(dateValue(span.endedAt)),
      status: statusLabel(span.status),
      isError: isErrorStatus(span.status),
      detail,
      usage: span.usage,
    });
  }
  for (const pt of run.points ?? []) {
    const t = dateValue(pt.time);
    if (!Number.isFinite(t)) continue;
    items.push({
      id: pt.id,
      evidenceId: pt.evidenceIds?.[0] ?? pt.id,
      evidenceIds: pt.evidenceIds ?? [pt.id],
      agentId: pt.agentId,
      kind: pt.kind,
      label: pt.label ?? pt.kind,
      startedAt: t,
      endedAt: t,
      isPoint: true,
      status: statusLabel(pt.status),
      isError: isErrorStatus(pt.status),
      detail:
        pt.detail ??
        (pt.sourceKind === "session"
          ? `session toolResult · ${statusLabel(pt.status)}`
          : statusLabel(pt.status)),
    });
  }
  items.sort((a, b) => a.startedAt - b.startedAt || a.endedAt - b.endedAt);

  const times = items.flatMap((it) => [it.startedAt, it.endedAt]);
  for (const span of run.spans ?? []) {
    const s = dateValue(span.startedAt);
    const e = dateValue(span.endedAt);
    if (Number.isFinite(s)) times.push(s);
    if (Number.isFinite(e)) times.push(e);
  }
  const runStart = dateValue(run.startedAt);
  const runEnd = dateValue(run.endedAt);
  const minT = Number.isFinite(runStart)
    ? runStart
    : times.length
      ? Math.min(...times)
      : 0;
  const maxT = Math.max(
    Number.isFinite(runEnd) ? runEnd : minT,
    times.length ? Math.max(...times) : minT,
    minT + 1000,
  );
  const prevDur = Math.max(1000, state.domainEnd - state.domainStart);
  const wasFull =
    resetWindow ||
    state.winEnd - state.winStart >= prevDur * 0.99 ||
    state.winEnd === 0;

  state.timelineItems = items;
  state.domainStart = minT;
  state.domainEnd = maxT;
  if (wasFull) {
    state.winStart = 0;
    state.winEnd = maxT - minT;
  } else {
    const dur = maxT - minT;
    state.winStart = Math.max(0, Math.min(state.winStart, dur));
    state.winEnd = Math.max(state.winStart + 1000, Math.min(state.winEnd, dur));
  }
}

function totalDurationMs() {
  return Math.max(1000, state.domainEnd - state.domainStart);
}

function setWindow(s, e, immediateTraj = false) {
  const dur = totalDurationMs();
  const minSpan = Math.min(dur, 250);
  const span = Math.max(minSpan, Math.min(dur, e - s));
  const a = Math.max(0, Math.min(s, dur - span));
  state.winStart = a;
  state.winEnd = a + span;
  state.trajLimit = 60;
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      syncMinimapSelection();
      renderSwimlane();
    });
  }
  clearTimeout(trajDebounce);
  if (immediateTraj) {
    renderTrajectory();
  } else {
    trajDebounce = setTimeout(renderTrajectory, 80);
  }
}

function zoomAround(anchorMs, scaleFactor) {
  const dur = totalDurationMs();
  const curSpan = state.winEnd - state.winStart;
  const frac = Math.max(
    0,
    Math.min(1, (anchorMs - state.winStart) / Math.max(1, curSpan)),
  );
  const nextSpan = Math.max(
    Math.min(dur, 250),
    Math.min(dur, curSpan * scaleFactor),
  );
  setWindow(anchorMs - frac * nextSpan, anchorMs + (1 - frac) * nextSpan);
}

function panByFraction(fracDelta) {
  const dur = totalDurationMs();
  const span = state.winEnd - state.winStart;
  if (span >= dur * 0.999) return;
  const ns = Math.max(0, Math.min(dur - span, state.winStart + span * fracDelta));
  setWindow(ns, ns + span);
}

// ============================================================================
// SUMMARY, TABS & CONTROLS
// ============================================================================
function renderSummary() {
  const run = state.run;
  if (!run) return;
  $("#run-title").textContent = run.label ?? "Run trace";
  $("#run-harness").textContent = run.harness ?? "Trace";
  $("#run-subtitle").textContent =
    `RUNTIME ${run.runtimeId ?? run.id} · ${
      Number.isFinite(dateValue(run.startedAt))
        ? new Date(dateValue(run.startedAt))
            .toISOString()
            .replace("T", " ")
            .replace("Z", " UTC")
        : "Start time unavailable"
    }`;

  const start = dateValue(run.startedAt);
  const end = dateValue(run.endedAt);
  const modelCnt = state.timelineItems.filter((i) => i.kind === "model").length;
  const svcCnt = state.timelineItems.filter((i) => i.kind === "service").length;
  const toolCnt = state.timelineItems.filter((i) => i.kind === "tool").length;

  const cells = [
    ["Run", run.status],
    ["Agents", run.agents?.length ?? 0],
    [
      "Duration",
      Number.isFinite(end) && Number.isFinite(start)
        ? duration(end - start)
        : "Open boundary",
    ],
    ["Model / Service / Tool", `${modelCnt} / ${svcCnt} / ${toolCnt}`],
    ["Cleanup", run.cleanup],
  ];
  $("#status-strip").replaceChildren(
    ...cells.map(([label, value]) => {
      const cell = element("div", "status-cell");
      cell.append(
        element("div", "status-label", label),
        element(
          "div",
          `status-value ${statusClass(value)}`,
          statusLabel(value),
        ),
      );
      cell.title = pretty(value);
      return cell;
    }),
  );

  // Sync Events tab select
  const prevSelect = $("#agent-filter").value;
  $("#agent-filter").replaceChildren(new Option("All Agents", ""));
  for (const agent of run.agents ?? []) {
    $("#agent-filter").append(
      new Option(agent.label ?? shortId(agent.id), agent.id),
    );
  }
  $("#agent-filter").value = prevSelect;

  // Timeline Agent pills
  const pills = $("#agent-pills");
  pills.replaceChildren();
  const addAgentPill = (id, label) => {
    const b = button(
      label,
      `seg-button${state.agentFilter === id ? " active" : ""}`,
      () => {
        state.agentFilter = id;
        renderSummary();
      },
    );
    pills.append(b);
  };
  addAgentPill("", "All");
  for (const agent of run.agents ?? []) {
    addAgentPill(agent.id, agent.label ?? shortId(agent.id));
  }

  const hasSpawns = (run.relations ?? []).some((r) => r.kind === "spawn");
  $("#spawn-wrap").hidden = !hasSpawns;

  $("#gaps").replaceChildren(
    ...(run.gaps ?? []).map((gap) =>
      element("div", "gap", `Trace gap · ${gap.message ?? pretty(gap)}`),
    ),
  );
  $("#relation-count").textContent = String(run.relations?.length ?? 0);
  $("#event-total-count").textContent = String(run.total ?? 0);

  renderTimelineArea();
  renderRelations();
  renderFiles();
}

// ============================================================================
// PERSISTENT 60FPS OVERVIEW MINIMAP NAVIGATOR
// ============================================================================
function buildMinimapBase() {
  const run = state.run;
  const sec = $("#minimap-section");
  const show = state.scale === "duration" && state.timelineItems.length > 0;
  sec.hidden = !show;
  if (!show || !run) return;

  const wrap = $("#minimap-wrap");
  const W = Math.max(520, wrap.clientWidth || 960);
  const H = 46;
  const dur = totalDurationMs();
  const buildKey = `${run.id}:${state.timelineItems.length}:${Math.round(W)}`;
  if (mmBuiltKey === buildKey && $("#mm-svg")) {
    syncMinimapSelection();
    return;
  }
  mmBuiltKey = buildKey;
  mmWidth = W;

  const agents = run.agents ?? [];
  const laneH = (H - 8) / Math.max(1, agents.length);
  const xFull = (relMs) => (relMs / dur) * W;

  const svg = svgEl("svg", {
    id: "mm-svg",
    viewBox: `0 0 ${W} ${H}`,
    width: "100%",
    height: H,
    style: "display:block; cursor:pointer;",
  });
  svg.append(svgEl("rect", { x: 0, y: 0, width: W, height: H, fill: "var(--bg)" }));

  const barsG = svgEl("g", { style: "pointer-events:none;" });
  agents.forEach((ag, ai) => {
    const y = 4 + ai * laneH;
    const h = Math.max(3, laneH - 2.5);
    const col = AGENT_COLORS[ai % AGENT_COLORS.length];
    barsG.append(
      svgEl("line", {
        x1: 0,
        y1: y + h / 2,
        x2: W,
        y2: y + h / 2,
        stroke: "var(--border)",
        "stroke-width": 0.6,
      }),
    );
    for (const it of state.timelineItems) {
      if (it.agentId !== ag.id || (it.kind !== "model" && !it.isError)) continue;
      const x1 = xFull(it.startedAt - state.domainStart);
      const x2 = xFull(it.endedAt - state.domainStart);
      barsG.append(
        svgEl("rect", {
          x: x1.toFixed(1),
          y: y.toFixed(1),
          width: Math.max(1.2, x2 - x1).toFixed(1),
          height: h.toFixed(1),
          rx: 1,
          fill: it.isError ? "var(--red)" : col,
          opacity: it.isError ? 0.95 : 0.65,
        }),
      );
    }
  });
  svg.append(barsG);

  svg.append(
    svgEl("rect", {
      id: "mm-mask-l",
      x: 0,
      y: 0,
      width: 0,
      height: H,
      fill: "var(--brush-mask)",
      style: "pointer-events:none;",
    }),
    svgEl("rect", {
      id: "mm-mask-r",
      x: W,
      y: 0,
      width: 0,
      height: H,
      fill: "var(--brush-mask)",
      style: "pointer-events:none;",
    }),
    svgEl("rect", {
      id: "mm-win",
      x: 0,
      y: 2,
      width: W,
      height: H - 4,
      rx: 3,
      fill: "var(--accent)",
      "fill-opacity": 0.1,
      stroke: "var(--accent)",
      "stroke-width": 1.6,
      style: "cursor:grab;",
    }),
  );

  for (const id of ["mm-left", "mm-right"]) {
    const g = svgEl("g", { id, style: "cursor:ew-resize;" });
    g.append(
      svgEl("rect", { x: -7, y: 1, width: 14, height: H - 2, fill: "transparent" }),
      svgEl("rect", { x: -4, y: 2, width: 8, height: H - 4, rx: 2.5, fill: "var(--accent)" }),
      svgEl("line", { x1: -1.2, y1: 15, x2: -1.2, y2: H - 15, stroke: "#ffffff", "stroke-width": 1.2, "stroke-linecap": "round" }),
      svgEl("line", { x1: 1.2, y1: 15, x2: 1.2, y2: H - 15, stroke: "#ffffff", "stroke-width": 1.2, "stroke-linecap": "round" }),
    );
    svg.append(g);
  }

  wrap.replaceChildren(svg);

  const toMs = (clientX) => {
    const rect = svg.getBoundingClientRect();
    return Math.max(0, Math.min(dur, ((clientX - rect.left) / rect.width) * dur));
  };
  let dragMode = null;
  let anchorMs = 0;
  let initS = 0;
  let initE = 0;

  svg.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
    const ms = toMs(e.clientX);
    initS = state.winStart;
    initE = state.winEnd;
    anchorMs = ms;
    const handle = e.target.closest("#mm-left, #mm-right");
    if (handle?.id === "mm-left") {
      dragMode = "left";
    } else if (handle?.id === "mm-right") {
      dragMode = "right";
    } else if (e.target.id === "mm-win") {
      if (initE - initS < dur * 0.995) {
        dragMode = "pan";
        $("#mm-win").style.cursor = "grabbing";
      } else {
        dragMode = "brush";
      }
    } else {
      const span = initE - initS;
      if (span < dur * 0.995) {
        const ns = Math.max(0, Math.min(dur - span, ms - span / 2));
        setWindow(ns, ns + span);
        initS = ns;
        initE = ns + span;
        anchorMs = ms;
        dragMode = "pan";
      } else {
        dragMode = "brush";
      }
    }
  });

  svg.addEventListener("pointermove", (e) => {
    if (!dragMode) return;
    const ms = toMs(e.clientX);
    const minS = Math.min(dur, 250);
    if (dragMode === "pan") {
      const span = initE - initS;
      const ns = Math.max(0, Math.min(dur - span, initS + (ms - anchorMs)));
      setWindow(ns, ns + span);
    } else if (dragMode === "left") {
      setWindow(Math.min(ms, initE - minS), initE);
    } else if (dragMode === "right") {
      setWindow(initS, Math.max(ms, initS + minS));
    } else if (dragMode === "brush") {
      if (Math.abs(ms - anchorMs) > dur * 0.003) {
        setWindow(Math.min(anchorMs, ms), Math.max(anchorMs, ms));
      }
    }
  });

  const endDrag = () => {
    if (!dragMode) return;
    dragMode = null;
    const winEl = $("#mm-win");
    if (winEl) winEl.style.cursor = "grab";
    renderTrajectory();
  };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);
  svg.addEventListener("dblclick", () => setWindow(0, totalDurationMs(), true));
  svg.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.15) {
        panByFraction(e.deltaX / 550);
        return;
      }
      const anchor = toMs(e.clientX);
      const factor = Math.exp(Math.max(-80, Math.min(80, e.deltaY)) * 0.0045);
      zoomAround(anchor, factor);
    },
    { passive: false },
  );

  syncMinimapSelection();
}

function syncMinimapSelection() {
  if (!state.run || state.scale !== "duration" || !$("#mm-svg")) return;
  const dur = totalDurationMs();
  const W = mmWidth || 960;
  const x1 = (state.winStart / dur) * W;
  const x2 = (state.winEnd / dur) * W;
  const bw = Math.max(12, x2 - x1);
  const bx1 = Math.min(W - bw, Math.max(0, x1));
  const bx2 = bx1 + bw;

  $("#mm-mask-l").setAttribute("width", bx1.toFixed(1));
  $("#mm-mask-r").setAttribute("x", bx2.toFixed(1));
  $("#mm-mask-r").setAttribute("width", Math.max(0, W - bx2).toFixed(1));
  $("#mm-win").setAttribute("x", bx1.toFixed(1));
  $("#mm-win").setAttribute("width", bw.toFixed(1));
  $("#mm-left").setAttribute("transform", `translate(${bx1.toFixed(1)}, 0)`);
  $("#mm-right").setAttribute("transform", `translate(${bx2.toFixed(1)}, 0)`);

  const zoomX = dur / Math.max(1, state.winEnd - state.winStart);
  $("#window-label").textContent =
    `${formatRel(state.winStart)} → ${formatRel(state.winEnd)} (${duration(state.winEnd - state.winStart)})`;
  $("#zoom-readout").textContent =
    zoomX < 1.05 ? "1.0×" : `${zoomX < 10 ? zoomX.toFixed(1) : Math.round(zoomX)}×`;
}

// ============================================================================
// ZERO-OVERLAP LAYOUT ENGINE (1px Gap Clamping + Sequential LOD Merging)
// ============================================================================
function layoutTrackBars(trackItems, xOf, isPointTrack) {
  if (!trackItems.length) return { rects: [], merged: 0, overlaps: 0 };
  const sorted = [...trackItems].sort(
    (a, b) => a.startedAt - b.startedAt || a.endedAt - b.endedAt,
  );
  const rects = [];
  let merged = 0;

  for (const it of sorted) {
    const x1 = xOf(it.startedAt - state.domainStart);
    const rawX2 =
      isPointTrack || it.isPoint
        ? x1 + 4.5
        : xOf(it.endedAt - state.domainStart);
    const last = rects[rects.length - 1];

    if (last && x1 < last.x2 + 1.2) {
      if (
        !isPointTrack &&
        !it.isPoint &&
        x1 >= last.rawX2 + 1.2 &&
        x1 - 1.2 - last.x1 >= 1.5
      ) {
        last.x2 = x1 - 1.2;
        rects.push({
          x1,
          x2: Math.max(x1 + 2, rawX2),
          rawX2,
          items: [it],
          hasError: it.isError,
        });
      } else {
        last.x2 = Math.max(last.x2, Math.max(x1 + 2.5, rawX2));
        last.rawX2 = Math.max(last.rawX2, rawX2);
        last.items.push(it);
        if (it.isError) last.hasError = true;
        merged++;
      }
    } else {
      const minW = isPointTrack || it.isPoint ? 5 : 2.5;
      rects.push({
        x1,
        x2: Math.max(x1 + minW, rawX2),
        rawX2,
        items: [it],
        hasError: it.isError,
      });
    }
  }

  let overlaps = 0;
  for (let i = 0; i < rects.length - 1; i++) {
    if (rects[i].x2 > rects[i + 1].x1 + 0.01) overlaps++;
  }
  return { rects, merged, overlaps };
}

// ============================================================================
// SWIMLANE RENDERER (Explicit Left Sub-Tracks: Input / Model / Tools / Service)
// ============================================================================
function matchesTimelineSearch(it) {
  const q = state.timelineSearch.trim().toLowerCase();
  if (!q) return true;
  return `${it.label} ${it.kind} ${it.status} ${it.detail} ${agentLabel(it.agentId)}`
    .toLowerCase()
    .includes(q);
}

function renderSwimlane() {
  const run = state.run;
  const host = $("#timeline");
  if (!run) return;
  host.replaceChildren();

  const scroller = $("#swimlane-scroll");
  const availW = Math.max(660, scroller.clientWidth || 960);
  const railW = 204;
  const padR = 18;
  const trackW = availW - railW - padR;
  const rulerH = 26;
  const headH = 24;
  const subH = 20;
  const laneGap = 8;

  const agents = (run.agents ?? []).filter(
    (ag) => !state.agentFilter || ag.id === state.agentFilter,
  );
  if (!agents.length || !state.timelineItems.length) {
    host.append(
      element(
        "div",
        "empty-state",
        "No recorded timing boundaries are available. Open the Events tab to inspect raw records.",
      ),
    );
    $("#overlap-badge").textContent = "0 OVERLAPS";
    return;
  }

  const dur = totalDurationMs();
  const winSpan = Math.max(1, state.winEnd - state.winStart);
  const xOf = (relMs) =>
    railW + 8 + ((relMs - state.winStart) / winSpan) * (trackW - 16);

  // Determine vertical geometry per Agent
  let curY = rulerH;
  const geom = [];
  for (const ag of agents) {
    const hasSvc = state.timelineItems.some(
      (i) => i.agentId === ag.id && i.kind === "service",
    );
    const tracks = TRACK_DEFS.filter((td) => td.key !== "service" || hasSvc);
    const startY = curY;
    const rowY = {};
    curY += headH;
    for (const td of tracks) {
      rowY[td.key] = curY;
      curY += subH;
    }
    curY += laneGap;
    geom.push({ ag, tracks, startY, rowY });
  }
  const totalH = curY;

  let seqItems = null;
  let totalW = availW;
  if (state.scale === "sequence") {
    seqItems = state.timelineItems.filter(
      (it) =>
        (!state.agentFilter || it.agentId === state.agentFilter) &&
        matchesTimelineSearch(it),
    );
    const slotW = Math.max(
      10,
      Math.min(28, (trackW - 16) / Math.max(1, seqItems.length)),
    );
    totalW = Math.max(availW, Math.round(railW + 24 + seqItems.length * slotW));
  }

  const isZoomed = state.scale === "duration" && winSpan < dur * 0.995;
  const svg = svgEl("svg", {
    id: "sl-svg",
    viewBox: `0 0 ${totalW} ${totalH}`,
    width: totalW,
    height: totalH,
    style: `cursor:${isZoomed ? "grab" : "default"};`,
  });

  // Defs: spawn arrow marker + diagonal hatch for sequential merged clusters
  const defs = svgEl("defs");
  const marker = svgEl("marker", {
    id: "arr-sp",
    viewBox: "0 0 10 10",
    refX: 8,
    refY: 5,
    markerWidth: 6,
    markerHeight: 6,
    orient: "auto",
  });
  marker.append(
    svgEl("path", {
      d: "M 1 1.5 L 8 5 L 1 8.5",
      fill: "none",
      stroke: "var(--teal)",
      "stroke-width": 1.8,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  );
  const hatch = svgEl("pattern", {
    id: "dense-hatch",
    width: 6,
    height: 6,
    patternTransform: "rotate(45)",
    patternUnits: "userSpaceOnUse",
  });
  hatch.append(
    svgEl("line", {
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 6,
      stroke: "rgba(255,255,255,0.24)",
      "stroke-width": 2,
    }),
  );
  defs.append(marker, hatch);
  svg.append(defs);

  // Background & Ruler
  svg.append(
    svgEl("rect", { x: 0, y: 0, width: totalW, height: totalH, fill: "var(--surface)" }),
    svgEl("rect", { x: 0, y: 0, width: totalW, height: rulerH, fill: "var(--subtle)" }),
    svgEl("line", { x1: 0, y1: rulerH, x2: totalW, y2: rulerH, stroke: "var(--border)", "stroke-width": 1 }),
    svgEl("line", { x1: railW, y1: 0, x2: railW, y2: totalH, stroke: "var(--strong)", "stroke-width": 1 }),
    svgEl(
      "text",
      {
        x: 14,
        y: 17,
        fill: "var(--muted)",
        "font-family": "var(--font-pixel)",
        "font-size": 9,
      },
      "AGENT / TRACK",
    ),
  );

  if (state.scale === "duration") {
    const ticks = 6;
    for (let i = 0; i <= ticks; i++) {
      const ms = state.winStart + (winSpan * i) / ticks;
      const x = xOf(ms);
      svg.append(
        svgEl("line", {
          x1: x,
          y1: rulerH,
          x2: x,
          y2: totalH,
          stroke: "var(--grid-svg)",
          "stroke-width": 1,
        }),
        svgEl(
          "text",
          {
            x,
            y: 17,
            "text-anchor": i === 0 ? "start" : i === ticks ? "end" : "middle",
            fill: "var(--muted)",
            "font-family": "var(--font-pixel)",
            "font-size": 9.5,
          },
          formatRel(ms),
        ),
      );
    }
  } else {
    svg.append(
      svgEl(
        "text",
        {
          x: railW + 10,
          y: 17,
          fill: "var(--muted)",
          "font-family": "var(--font-pixel)",
          "font-size": 9.5,
        },
        `EQUAL-WIDTH SEQUENCE (${seqItems.length} RECORDS · SCROLL HORIZONTALLY)`,
      ),
    );
  }

  // Lanes & Explicit Left Sub-Track Labels
  geom.forEach((g, idx) => {
    if (idx > 0) {
      svg.append(
        svgEl("line", {
          x1: 0,
          y1: g.startY,
          x2: totalW,
          y2: g.startY,
          stroke: "var(--strong)",
          "stroke-width": 1,
        }),
      );
    }
    const headerGroup = svgEl("g", { style: "cursor:pointer;" });
    headerGroup.append(
      svgEl("rect", {
        x: 0,
        y: g.startY,
        width: totalW,
        height: headH,
        fill: "var(--subtle)",
        opacity: 0.72,
      }),
      svgEl("circle", {
        cx: 15,
        cy: g.startY + headH / 2,
        r: 3.5,
        fill: agentColor(g.ag.id),
      }),
      svgEl(
        "text",
        {
          x: 24,
          y: g.startY + 15.5,
          fill: "var(--ink)",
          "font-family": "var(--font-mono)",
          "font-size": 11,
          "font-weight": 700,
        },
        (g.ag.label ?? shortId(g.ag.id)).slice(0, 21),
      ),
      svgEl(
        "text",
        {
          x: railW - 8,
          y: g.startY + 15,
          "text-anchor": "end",
          fill: "var(--muted)",
          "font-family": "var(--font-pixel)",
          "font-size": 8.5,
        },
        String(g.ag.profile ?? (g.ag.parentId ? "child" : "agent")).toUpperCase(),
      ),
      svgEl("line", {
        x1: 0,
        y1: g.startY + headH,
        x2: totalW,
        y2: g.startY + headH,
        stroke: "var(--border)",
        "stroke-width": 1,
      }),
    );
    headerGroup.addEventListener("click", () => inspectAgent(g.ag));
    svg.append(headerGroup);

    // Subtle execution bracket behind tracks when native execution spans exist
    if (state.scale === "duration") {
      const execSpans = (run.spans ?? []).filter(
        (sp) => sp.kind === "execution" && sp.agentId === g.ag.id,
      );
      const trackTop = g.startY + headH + 2;
      const trackH = g.tracks.length * subH - 4;
      for (const ex of execSpans) {
        const s = dateValue(ex.startedAt) - state.domainStart;
        const e = Number.isFinite(dateValue(ex.endedAt))
          ? dateValue(ex.endedAt) - state.domainStart
          : dur;
        if (e < state.winStart || s > state.winEnd) continue;
        const bx1 = Math.max(railW + 4, xOf(s));
        const bx2 = Math.min(totalW - 6, xOf(e));
        if (bx2 > bx1 + 2) {
          svg.append(
            svgEl("rect", {
              x: bx1.toFixed(1),
              y: trackTop,
              width: (bx2 - bx1).toFixed(1),
              height: trackH,
              rx: 4,
              fill: "var(--accent-soft)",
              opacity: 0.32,
              style: "pointer-events:none;",
            }),
          );
        }
      }
    }

    for (const td of g.tracks) {
      const y = g.rowY[td.key];
      svg.append(
        svgEl("line", {
          x1: railW,
          y1: y + subH,
          x2: totalW,
          y2: y + subH,
          stroke: "var(--border)",
          "stroke-width": 0.6,
          opacity: 0.55,
        }),
        svgEl("rect", {
          x: 24,
          y: y + 6,
          width: 5.5,
          height: 8,
          rx: 1.5,
          fill: td.color,
          opacity: 0.9,
        }),
        svgEl(
          "text",
          {
            x: railW - 10,
            y: y + 14,
            "text-anchor": "end",
            fill: "var(--secondary)",
            "font-family": "var(--font-mono)",
            "font-size": 10.5,
            "font-weight": 500,
          },
          td.label,
        ),
      );
    }
  });

  // Render Zero-Overlap Bars
  let totalMerged = 0;
  let totalOverlaps = 0;
  const blocksLayer = svgEl("g");
  const attachBlockEvents = (gNode, items, kind) => {
    const isCluster = items.length > 1;
    gNode.addEventListener("mouseenter", (e) => {
      if (!isCluster) setHovered(items[0].id);
      showTooltip(items, kind, e);
    });
    gNode.addEventListener("mousemove", moveTooltip);
    gNode.addEventListener("mouseleave", () => {
      setHovered(null);
      hideTooltip();
    });
    gNode.addEventListener("click", () => {
      if (swimlaneDragged) return;
      hideTooltip();
      if (isCluster) {
        const s = items[0].startedAt - state.domainStart;
        const e = items[items.length - 1].endedAt - state.domainStart;
        const pad = Math.max(2500, (e - s) * 0.45);
        setWindow(s - pad, e + pad, true);
      } else {
        inspectRecord(items[0].evidenceId);
      }
    });
  };

  if (state.scale === "duration") {
    for (const g of geom) {
      for (const td of g.tracks) {
        const y = g.rowY[td.key] + 3.5;
        const h = subH - 7;
        const trackItems = state.timelineItems.filter(
          (it) =>
            it.agentId === g.ag.id &&
            it.kind === td.key &&
            it.endedAt - state.domainStart >= state.winStart &&
            it.startedAt - state.domainStart <= state.winEnd &&
            matchesTimelineSearch(it),
        );
        const isPointTrack =
          td.key === "input" || (td.key === "tool" && !run.hasNative);
        const { rects, merged, overlaps } = layoutTrackBars(
          trackItems,
          xOf,
          isPointTrack,
        );
        totalMerged += merged;
        totalOverlaps += overlaps;

        for (const r of rects) {
          const bx1 = Math.max(railW + 4, r.x1);
          const bx2 = Math.min(totalW - 6, r.x2);
          const bw = Math.max(1.5, bx2 - bx1);
          const isCluster = r.items.length > 1;
          const first = r.items[0];
          const fill = r.hasError ? "var(--red)" : td.color;
          const isSel = !isCluster && state.selected === first.evidenceId;
          const isHov = !isCluster && state.hovered === first.id;

          const bGroup = svgEl("g", {
            class: `sl-block${isSel ? " active" : ""}${isHov ? " hovered" : ""}`,
            ...(isCluster ? {} : { "data-item-id": first.id }),
          });
          bGroup.append(
            svgEl("rect", {
              class: "sl-rect",
              x: bx1.toFixed(1),
              y,
              width: bw.toFixed(1),
              height: h,
              rx: isPointTrack && !isCluster ? 2 : 2.5,
              fill,
              "fill-opacity": isCluster ? 0.94 : 0.85,
              stroke: isSel || isHov ? "var(--ink)" : isCluster ? "var(--ink)" : "transparent",
              "stroke-width": isSel || isHov ? 1.8 : isCluster ? 0.75 : 0,
            }),
          );
          if (isCluster) {
            bGroup.append(
              svgEl("rect", {
                x: bx1.toFixed(1),
                y,
                width: bw.toFixed(1),
                height: h,
                rx: 2.5,
                fill: "url(#dense-hatch)",
                style: "pointer-events:none;",
              }),
            );
            if (bw >= 22) {
              bGroup.append(
                svgEl(
                  "text",
                  {
                    x: (bx1 + bw / 2).toFixed(1),
                    y: y + 9.8,
                    "text-anchor": "middle",
                    fill: "#ffffff",
                    "font-family": "var(--font-pixel)",
                    "font-size": 8,
                    style: "pointer-events:none;",
                  },
                  bw >= 44 ? `${r.items.length} seq` : String(r.items.length),
                ),
              );
            }
          } else if (bw >= 38 && (td.key === "tool" || td.key === "service")) {
            const shortName = first.label.split(".").pop();
            const maxChars = Math.max(3, Math.floor((bw - 8) / 5.6));
            bGroup.append(
              svgEl(
                "text",
                {
                  x: (bx1 + 4).toFixed(1),
                  y: y + 9.8,
                  fill: "#ffffff",
                  "font-family": "var(--font-mono)",
                  "font-size": 8.8,
                  "font-weight": 700,
                  style: "pointer-events:none;",
                },
                shortName.slice(0, maxChars),
              ),
            );
          }
          attachBlockEvents(bGroup, r.items, td.key);
          blocksLayer.append(bGroup);
        }
      }
    }
  } else {
    const slotW = Math.max(
      10,
      Math.min(28, (trackW - 16) / Math.max(1, seqItems.length)),
    );
    seqItems.forEach((it, idx) => {
      const g = geom.find((x) => x.ag.id === it.agentId);
      if (!g || g.rowY[it.kind] === undefined) return;
      const td = TRACK_DEFS.find((t) => t.key === it.kind);
      const x = railW + 8 + idx * slotW;
      const w = Math.max(6, slotW - 2);
      const y = g.rowY[it.kind] + 3.5;
      const h = subH - 7;
      const fill = it.isError ? "var(--red)" : td.color;
      const isSel = state.selected === it.evidenceId;
      const bGroup = svgEl("g", {
        class: `sl-block${isSel ? " active" : ""}`,
        "data-item-id": it.id,
      });
      bGroup.append(
        svgEl("rect", {
          class: "sl-rect",
          x: x.toFixed(1),
          y,
          width: w.toFixed(1),
          height: h,
          rx: 2.5,
          fill,
          "fill-opacity": 0.86,
          stroke: isSel ? "var(--ink)" : "transparent",
          "stroke-width": isSel ? 1.6 : 0,
        }),
      );
      attachBlockEvents(bGroup, [it], it.kind);
      blocksLayer.append(bGroup);
    });
  }
  svg.append(blocksLayer);

  // Spawn-only arrows (clear causal spawns only)
  if (state.scale === "duration" && state.showSpawn && !state.agentFilter) {
    for (const rel of run.relations ?? []) {
      if (rel.kind !== "spawn") continue;
      const relMs = dateValue(rel.time) - state.domainStart;
      if (!Number.isFinite(relMs) || relMs < state.winStart || relMs > state.winEnd)
        continue;
      const g1 = geom.find((g) => g.ag.id === rel.fromAgentId);
      const g2 = geom.find((g) => g.ag.id === rel.toAgentId);
      if (!g1 || !g2) continue;
      const x = xOf(relMs);
      const y1 = (g1.rowY.service ?? g1.rowY.model) + subH / 2;
      const y2 = g2.rowY.input + subH / 2;
      const d = `M ${x} ${y1} C ${x + 14} ${y1 + 14}, ${x - 14} ${y2 - 14}, ${x} ${y2}`;
      const path = svgEl("path", {
        d,
        fill: "none",
        stroke: "var(--teal)",
        "stroke-width": 1.5,
        "stroke-dasharray": "4 3",
        "marker-end": "url(#arr-sp)",
        opacity: 0.85,
        style: "cursor:pointer;",
      });
      path.addEventListener("click", () => inspectRelation(rel));
      svg.append(path);
    }
  }

  // Hover vertical crosshair
  const crosshair = svgEl("line", {
    id: "sl-ch",
    x1: 0,
    y1: rulerH,
    x2: 0,
    y2: totalH,
    stroke: "var(--ink)",
    "stroke-width": 1,
    "stroke-dasharray": "3 3",
    opacity: 0.35,
    style: "display:none; pointer-events:none;",
  });
  svg.append(crosshair);

  svg.addEventListener("mousemove", (e) => {
    if (state.scale !== "duration") return;
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * totalW;
    if (x < railW + 4 || x > totalW - 6) {
      crosshair.style.display = "none";
      return;
    }
    crosshair.style.display = "block";
    crosshair.setAttribute("x1", x);
    crosshair.setAttribute("x2", x);
    const ms =
      state.winStart +
      Math.max(0, Math.min(1, (x - (railW + 8)) / (trackW - 16))) * winSpan;
    $("#cursor-readout").textContent =
      `${formatRel(ms)} · ${clock(state.domainStart + ms)}`;
  });
  svg.addEventListener("mouseleave", () => {
    crosshair.style.display = "none";
    $("#cursor-readout").textContent =
      "Wheel to zoom · Drag or swipe to pan · W/S/A/D/0";
  });

  host.append(svg);

  $("#overlap-badge").textContent =
    totalMerged > 0
      ? `${totalOverlaps} OVERLAPS · ${totalMerged} MERGED AT THIS ZOOM`
      : `${totalOverlaps} OVERLAPS`;

  $("#timeline-note").textContent = run.spansTruncated
    ? "Showing the latest 5,000 recorded spans. Use the Events tab for earlier paginated records."
    : !run.hasNative
      ? "Historical schema: Tools track plots archived Session toolResult timestamps alongside recorded Model and Service intervals."
      : "Execution, Model, Tool, Service and Input tracks use recorded Run boundaries directly.";
}

function showTooltip(items, kind, e) {
  const tip = $("#tooltip");
  tip.replaceChildren();
  const isCluster = items.length > 1;
  const head = element("div", "tip-head");
  if (isCluster) {
    const first = items[0];
    const last = items[items.length - 1];
    head.append(
      element("span", `pill-badge ${kind}`, `${items.length} SEQUENTIAL ${kind.toUpperCase()}S`),
      element("span", "event-dur", duration(last.endedAt - first.startedAt)),
    );
    const names = [...new Set(items.map((x) => x.label))].slice(0, 4).join(", ");
    const errCnt = items.filter((x) => x.isError).length;
    tip.append(
      head,
      element("div", "tip-detail", `Grouped at current zoom: ${names}${items.length > 4 ? "…" : ""}`),
    );
    if (errCnt) {
      const errEl = element("div", "tip-detail", `Includes ${errCnt} error / interrupted`);
      errEl.style.color = "var(--red)";
      tip.append(errEl);
    }
    tip.append(element("div", "tip-action", "SCROLL OR CLICK TO SEPARATE →"));
  } else {
    const it = items[0];
    head.append(
      element(
        "span",
        `pill-badge ${it.isError ? "error" : it.kind}`,
        `${it.kind}${it.isError ? " · " + it.status : ""}`,
      ),
      element(
        "span",
        "event-dur",
        it.isPoint ? "recorded ts" : duration(it.endedAt - it.startedAt),
      ),
    );
    const foot = element("div", "tip-foot");
    foot.append(
      element("span", "", agentLabel(it.agentId)),
      element(
        "span",
        "",
        `${formatRel(it.startedAt - state.domainStart)}${
          it.isPoint ? "" : " → " + formatRel(it.endedAt - state.domainStart)
        }`,
      ),
    );
    tip.append(
      head,
      element("div", "tip-title", it.label),
      element("div", "tip-detail", it.detail || it.status),
      foot,
    );
  }
  tip.classList.add("visible");
  moveTooltip(e);
}

function moveTooltip(e) {
  const tip = $("#tooltip");
  tip.style.left = `${Math.min(window.innerWidth - 336, e.clientX + 14)}px`;
  tip.style.top = `${Math.min(window.innerHeight - 140, e.clientY + 14)}px`;
}

function hideTooltip() {
  $("#tooltip").classList.remove("visible");
}

function setHovered(itemId) {
  state.hovered = itemId;
  for (const el of document.querySelectorAll(".sl-block[data-item-id]")) {
    el.classList.toggle("hovered", el.dataset.itemId === itemId);
  }
  for (const el of document.querySelectorAll("#timeline-events .event-row[data-item-id]")) {
    el.classList.toggle("hovered", el.dataset.itemId === itemId);
  }
}

// ============================================================================
// WINDOW-SYNCED TRAJECTORY LIST (Below Swimlane)
// ============================================================================
function renderTrajectory() {
  const run = state.run;
  if (!run) return;
  const counts = {
    model: state.timelineItems.filter((i) => i.kind === "model").length,
    tool: state.timelineItems.filter((i) => i.kind === "tool").length,
    service: state.timelineItems.filter((i) => i.kind === "service").length,
    input: state.timelineItems.filter((i) => i.kind === "input").length,
    error: state.timelineItems.filter((i) => i.isError).length,
  };
  const pills = $("#track-filter-pills");
  pills.replaceChildren();
  const defs = [
    ["all", "All"],
    ["model", `Model (${counts.model})`],
    ["tool", `Tools (${counts.tool})`],
    ["service", `Service (${counts.service})`],
    ["input", `Input (${counts.input})`],
  ];
  if (counts.error) defs.push(["error", `Errors (${counts.error})`]);
  for (const [key, label] of defs) {
    const b = button(
      label,
      `seg-button${state.trackFilter === key ? " active" : ""}`,
      () => {
        state.trackFilter = key;
        state.trajLimit = 60;
        renderTrajectory();
      },
    );
    if (key === "error") b.style.color = "var(--red)";
    pills.append(b);
  }

  const list = state.timelineItems.filter((it) => {
    if (state.agentFilter && it.agentId !== state.agentFilter) return false;
    if (state.scale === "duration") {
      const s = it.startedAt - state.domainStart;
      const e = it.endedAt - state.domainStart;
      if (e < state.winStart || s > state.winEnd) return false;
    }
    if (state.trackFilter === "error" && !it.isError) return false;
    if (
      state.trackFilter !== "all" &&
      state.trackFilter !== "error" &&
      it.kind !== state.trackFilter
    ) {
      return false;
    }
    return matchesTimelineSearch(it);
  });

  const slice = list.slice(0, state.trajLimit);
  $("#traj-summary").textContent =
    `Showing ${slice.length} of ${list.length} records in window`;

  const box = $("#timeline-events");
  box.replaceChildren();
  if (!slice.length) {
    box.append(
      element("div", "empty-state", "No records match the current window and filter."),
    );
  } else {
    const frag = document.createDocumentFragment();
    for (const it of slice) {
      const row = button(
        "",
        `event-row${state.selected === it.evidenceId ? " selected" : ""}`,
        () => inspectRecord(it.evidenceId),
      );
      row.dataset.itemId = it.id;
      const agWrap = element("span", "event-agent");
      const dot = element("span", "status-dot");
      dot.style.background = agentColor(it.agentId);
      agWrap.append(dot, element("span", "event-agent-text", agentLabel(it.agentId)));

      const labelWrap = element("span", "event-label");
      labelWrap.append(
        element("strong", "", it.label),
        element("span", "event-detail", it.detail ? ` · ${it.detail}` : ""),
      );
      labelWrap.title = `${it.label}${it.detail ? " · " + it.detail : ""}`;

      row.append(
        element("span", "event-time", formatRel(it.startedAt - state.domainStart)),
        agWrap,
        element("span", `pill-badge ${it.isError ? "error" : it.kind}`, it.kind),
        labelWrap,
        element(
          "span",
          "event-dur",
          it.isPoint ? "ts" : duration(it.endedAt - it.startedAt),
        ),
      );
      row.addEventListener("mouseenter", () => setHovered(it.id));
      row.addEventListener("mouseleave", () => setHovered(null));
      frag.append(row);
    }
    box.append(frag);
  }

  const remaining = list.length - state.trajLimit;
  $("#traj-more-wrap").hidden = remaining <= 0;
  if (remaining > 0) {
    $("#traj-more").textContent = `Load more (${remaining} remaining)`;
  }
}

function renderTimelineArea() {
  $("#zoom-group").hidden = state.scale !== "duration";
  buildMinimapBase();
  renderSwimlane();
  renderTrajectory();
}

// ============================================================================
// EVENTS TAB (Server-paginated Raw Ledger)
// ============================================================================
async function loadPage(cursor) {
  const generation = state.generation;
  const pageGeneration = ++state.pageGeneration;
  const params = new URLSearchParams({ limit: "250" });
  if (cursor) params.set("cursor", String(cursor));
  if ($("#agent-filter").value) params.set("agentId", $("#agent-filter").value);
  if ($("#type-filter").value) params.set("type", $("#type-filter").value);
  const result = await api(runPath(`/events?${params}`));
  if (
    generation !== state.generation ||
    pageGeneration !== state.pageGeneration
  ) {
    return;
  }
  state.events = result.events;
  state.cursor = cursor;
  state.nextCursor = result.cursor;
  state.hasMore = result.hasMore;
  state.total = result.total;
  renderEvents();
}

function eventKind(event) {
  return event.kind ?? event.type?.split(".")[0] ?? "event";
}

function renderEvents() {
  const query = $("#event-search").value.trim().toLowerCase();
  const visible = state.events.filter((event) =>
    `${event.label} ${event.type} ${event.kind} ${event.agentId ?? ""} ${event.requestId ?? ""} ${event.operationId ?? ""}`
      .toLowerCase()
      .includes(query),
  );
  const container = $("#events");
  container.replaceChildren();
  for (const event of visible) {
    const kind = eventKind(event);
    const err = isErrorStatus(event.status);
    const row = button(
      "",
      `event-row${event.id === state.selected ? " selected" : ""}`,
      () => inspectRecord(event.id),
    );
    const agWrap = element("span", "event-agent");
    const dot = element("span", "status-dot");
    dot.style.background = agentColor(event.agentId);
    agWrap.append(dot, element("span", "event-agent-text", agentLabel(event.agentId)));

    const labelWrap = element("span", "event-label");
    labelWrap.append(
      element("strong", "", event.label ?? event.type ?? kind),
      element(
        "span",
        "event-detail",
        ` · ${event.type ?? ""}${event.status ? ` (${statusLabel(event.status)})` : ""}`,
      ),
    );
    row.append(
      element("span", "event-time", clock(event.time ?? event.startedAt)),
      agWrap,
      element("span", `pill-badge ${err ? "error" : kind}`, kind),
      labelWrap,
      element("span", "event-dur", event.source?.path?.split("/").pop() ?? ""),
    );
    container.append(row);
  }
  if (!visible.length) {
    container.append(
      element("div", "empty-state", "No events match this page and filter."),
    );
  }
  $("#page-info").textContent =
    `${visible.length} shown · ${state.total.toLocaleString()} total`;
  $("#pagination-info").textContent =
    `${state.events.length} on page · ${state.total.toLocaleString()} total`;
  $("#previous").disabled = !state.history.length;
  $("#next").disabled = !state.hasMore;
}

// ============================================================================
// COLLABORATION & FILES TABS
// ============================================================================
function renderRelations() {
  const root = $("#relations");
  root.replaceChildren();
  for (const relation of state.run.relations ?? []) {
    const card = element("article", "relation-card");
    const top = element("div", "relation-top");
    const route = element("div", "relation-route");
    route.append(
      element(
        "span",
        `pill-badge ${relation.kind === "spawn" ? "service" : "input"}`,
        relation.kind,
      ),
      element("span", "", agentLabel(relation.fromAgentId)),
      element("span", "relation-arrow", "→"),
      element("span", "", agentLabel(relation.toAgentId)),
    );
    const timeWrap = element("span", "event-time", clock(relation.time));
    top.append(route, timeWrap);

    const links = element("div", "evidence-links");
    links.append(
      button("Inspect handoff ↗", "button button-primary", () =>
        inspectRelation(relation),
      ),
    );
    for (const [index, id] of (relation.evidenceIds ?? []).entries()) {
      const label =
        relation.evidenceLabels?.[index] ?? `Evidence ${index + 1}`;
      links.append(button(label, "button", () => inspectRecord(id)));
    }
    const relTime = dateValue(relation.time);
    if (Number.isFinite(relTime)) {
      links.append(
        button("Zoom timeline ↗", "button", () => {
          switchView("timeline");
          const relMs = relTime - state.domainStart;
          setWindow(relMs - 15000, relMs + 30000, true);
        }),
      );
    }
    card.append(top, links);
    root.append(card);
  }
  if (!root.childElementCount) {
    const empty = element(
      "div",
      "blueprint-frame empty-state",
      "No causal handoffs are recorded for this Run. Generic Service calls remain available on Timeline and Events.",
    );
    root.append(empty);
  }
}

function renderFiles() {
  const outcome = $("#outcome");
  outcome.replaceChildren();
  const heading = element("div", "panel-heading");
  heading.append(
    element("h2", "", "Business result"),
    element("span", `pill-badge ${statusClass(state.run.outcome) === "bad" ? "error" : "service"}`, statusLabel(state.run.outcome)),
  );
  outcome.append(heading, element("pre", "outcome-body", pretty(state.run.outcome)));

  const files = $("#files");
  files.replaceChildren();
  for (const file of state.run.files ?? []) {
    const row = button("", "file-row", () => inspectFile(file.path));
    row.append(
      element("span", "", file.path),
      element(
        "span",
        "muted",
        file.bytes != null ? `${file.bytes.toLocaleString()} B ↗` : "↗",
      ),
    );
    files.append(row);
  }
  if (!files.childElementCount) {
    files.append(element("div", "empty-state", "No archived files were found."));
  }
}

// ============================================================================
// SLIDE-OVER EVIDENCE INSPECTOR (Structured + Raw JSON)
// ============================================================================
function openInspector() {
  $("#inspector").hidden = false;
  $("#ins-mode-struct").classList.toggle("active", state.inspectorMode === "struct");
  $("#ins-mode-raw").classList.toggle("active", state.inspectorMode === "raw");
}

function closeInspector() {
  ++state.inspectorGeneration;
  state.selected = null;
  $("#inspector").hidden = true;
  renderSwimlane();
  renderTrajectory();
  renderEvents();
}

function inspectorSection(title) {
  const section = element("section", "inspector-section");
  section.append(element("h4", "", title));
  return section;
}

function appendMetadata(container, values) {
  const list = element("dl", "inspector-data");
  for (const [label, value] of values) {
    if (value === undefined || value === null || value === "") continue;
    list.append(element("dt", "", label), element("dd", "", pretty(value)));
  }
  container.append(list);
}

function rawSection(title, value) {
  const section = inspectorSection(title);
  const heading = section.firstChild;
  const toolbar = element("div", "raw-toolbar");
  const copy = button("Copy", "button", async () => {
    try {
      await navigator.clipboard.writeText(pretty(value));
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1200);
    } catch {
      copy.textContent = "Copy unavailable";
    }
  });
  toolbar.append(heading, copy);
  section.append(toolbar, element("pre", "", pretty(value)));
  return section;
}

function extractStructuredMessages(record) {
  const input = record?.after?.input ?? record?.before?.input;
  if (!Array.isArray(input) || !input.length) return null;
  const cards = [];
  for (const item of input) {
    if (item?.type === "function_call") {
      cards.push({
        role: `TOOL CALL · ${item.name ?? "fn"}`,
        text: String(item.arguments ?? ""),
        highlight: false,
      });
    } else if (item?.type === "function_call_output") {
      cards.push({
        role: "TOOL RESULT",
        text: String(item.output ?? ""),
        highlight: false,
      });
    } else if (item?.role) {
      const blocks = Array.isArray(item.content) ? item.content : [];
      const text = blocks
        .map((b) => (typeof b?.text === "string" ? b.text : pretty(b)))
        .join("\n");
      let isEnvelope = false;
      let roleLabel = String(item.role).toUpperCase();
      try {
        const parsed = JSON.parse(text);
        if (
          parsed &&
          typeof parsed.id === "string" &&
          ["message", "result"].includes(parsed.kind) &&
          typeof parsed.from === "string"
        ) {
          isEnvelope = true;
          roleLabel = `COLLABORATION ${parsed.kind.toUpperCase()} · FROM ${parsed.from}`;
        }
      } catch {
        /* Ordinary text message. */
      }
      cards.push({ role: roleLabel, text, highlight: isEnvelope });
    }
  }
  return cards.length ? cards : null;
}

function contextMatchesSection(contextMatches) {
  const section = inspectorSection(
    `Actual model context (${contextMatches.length})`,
  );
  const renderList = (limit) => {
    while (section.children.length > 1) section.lastChild.remove();
    const visible = contextMatches.slice(0, limit);
    for (const [idx, match] of visible.entries()) {
      const prefix = idx === 0 ? "First match · " : "";
      const btn = button(
        `${prefix}${clock(match.startedAt)} · ${match.requestId} ↗`,
        idx === 0 ? "button button-primary" : "file-row",
        () => inspectRecord(match.recordId),
      );
      btn.style.marginBottom = "6px";
      section.append(btn);
    }
    if (contextMatches.length > limit) {
      const more = button(
        `Show all ${contextMatches.length} model requests`,
        "button",
        () => renderList(contextMatches.length),
      );
      section.append(more);
    }
  };
  renderList(5);
  return section;
}

function renderRecordDetail(detail) {
  state.lastDetail = detail;
  const event = detail.event;
  const kind = eventKind(event);
  const title = element("div", "inspector-title");
  title.append(
    element("span", `pill-badge ${isErrorStatus(event.status) ? "error" : kind}`, kind),
    element("h3", "", event.label ?? event.type),
    element("p", "muted", event.id),
  );

  const eventTime = dateValue(event.time ?? event.startedAt);
  if (Number.isFinite(eventTime)) {
    const zoomBtn = button("Zoom Timeline to this record ↗", "button", () => {
      switchView("timeline");
      const relMs = eventTime - state.domainStart;
      setWindow(relMs - 10000, relMs + 20000, true);
    });
    zoomBtn.style.marginTop = "10px";
    title.append(zoomBtn);
  }

  const nodes = [title];

  if (state.inspectorMode === "raw") {
    nodes.push(rawSection("Raw source record", detail.record));
  } else {
    const metadata = inspectorSection("Recorded identity");
    appendMetadata(metadata, [
      ["Agent", `${agentLabel(event.agentId)} (${shortId(event.agentId)})`],
      ["Event", event.type],
      ["Time", event.time ?? event.startedAt],
      ["State", event.status],
      ["Request", event.requestId],
      ["Input", event.inputId],
      ["Operation", event.operationId],
      ["Source", event.source?.path],
      ["Line", event.source?.line],
      ["Byte offset", event.source?.offset],
    ]);
    nodes.push(metadata);

    if (detail.contextMatches?.length) {
      nodes.push(contextMatchesSection(detail.contextMatches));
    }

    const structuredMsgs = extractStructuredMessages(detail.record);
    if (structuredMsgs) {
      const sec = inspectorSection(`Model context (${structuredMsgs.length} items)`);
      const stack = element("div", "msg-stack");
      for (const m of structuredMsgs) {
        const card = element("div", `msg-card${m.highlight ? " highlight" : ""}`);
        card.append(
          element("div", "msg-role", m.role),
          element("div", "msg-text", m.text),
        );
        stack.append(card);
      }
      sec.append(stack);
      nodes.push(sec);
    } else {
      nodes.push(rawSection("Source record", detail.record));
    }

    if (detail.files?.length) {
      const files = inspectorSection("Related evidence");
      for (const file of detail.files) {
        files.append(button(file.path, "file-row", () => inspectFile(file.path)));
      }
      nodes.push(files);
    }
  }

  $("#inspector-content").replaceChildren(...nodes);
}

async function inspectRecord(id) {
  const generation = ++state.inspectorGeneration;
  state.selected = id;
  openInspector();
  renderSwimlane();
  renderTrajectory();
  renderEvents();
  $("#inspector-content").replaceChildren(
    element("div", "inspect-loading", "Loading source record…"),
  );
  try {
    const detail = await api(runPath(`/records/${encodeURIComponent(id)}`));
    if (generation !== state.inspectorGeneration) return;
    renderRecordDetail(detail);
  } catch (error) {
    if (generation === state.inspectorGeneration) {
      $("#inspector-content").replaceChildren(
        element("div", "inspect-loading", error.message),
      );
    }
  }
}

function inspectAgent(agent) {
  ++state.inspectorGeneration;
  state.lastDetail = null;
  openInspector();
  const title = element("div", "inspector-title");
  title.append(
    element("span", "pill-badge input", "Agent"),
    element("h3", "", agent.label ?? shortId(agent.id)),
  );
  const identity = inspectorSection("Agent identity");
  appendMetadata(identity, [
    ["Agent ID", agent.id],
    ["Parent", agent.parentId],
    ["Profile", agent.profile],
    ["Execution", agent.execution],
    ["Outcome", agent.outcome],
    ["Cleanup", agent.cleanup],
  ]);
  $("#inspector-content").replaceChildren(
    title,
    identity,
    rawSection("Agent summary", agent),
  );
}

async function inspectRelation(relation) {
  const generation = ++state.inspectorGeneration;
  state.lastDetail = null;
  openInspector();
  const title = element("div", "inspector-title");
  title.append(
    element("span", "pill-badge service", relation.kind),
    element("h3", "", `${agentLabel(relation.fromAgentId)} → ${agentLabel(relation.toAgentId)}`),
  );
  const metadata = inspectorSection("Information handoff");
  appendMetadata(metadata, [
    ["From", `${agentLabel(relation.fromAgentId)} (${shortId(relation.fromAgentId)})`],
    ["To", `${agentLabel(relation.toAgentId)} (${shortId(relation.toAgentId)})`],
    ["Time", relation.time],
    ["Relation", relation.id],
  ]);
  const ctxHolder = element("div");
  const links = inspectorSection("Source evidence");
  for (const [index, id] of (relation.evidenceIds ?? []).entries()) {
    const label = relation.evidenceLabels?.[index] ?? `Open record ${index + 1}`;
    links.append(button(`${label} ↗`, "file-row", () => inspectRecord(id)));
  }
  $("#inspector-content").replaceChildren(
    title,
    metadata,
    ctxHolder,
    links,
    rawSection("Relation record", relation),
  );
  if (relation.id) {
    try {
      const detail = await api(runPath(`/records/${encodeURIComponent(relation.id)}`));
      if (generation === state.inspectorGeneration && detail.contextMatches?.length) {
        ctxHolder.replaceChildren(contextMatchesSection(detail.contextMatches));
      }
    } catch {
      /* Relation links remain available even if context lookup fails. */
    }
  }
}

async function inspectFile(path, offset = 0, append = false) {
  const generation = ++state.inspectorGeneration;
  state.lastDetail = null;
  openInspector();
  if (!append) {
    $("#inspector-content").replaceChildren(
      element("div", "inspect-loading", "Loading recorded file…"),
    );
  }
  try {
    const file = await api(
      runPath(
        `/files?${new URLSearchParams({ path, offset: String(offset), limit: "65536" })}`,
      ),
    );
    if (generation !== state.inspectorGeneration) return;
    if (!append) {
      const title = element("div", "inspector-title");
      title.append(
        element("span", "pill-badge service", "recorded file"),
        element("h3", "", path),
        element("p", "muted", "Raw text · loaded on demand"),
      );
      const section = rawSection("File content", file.text);
      section.id = "file-content";
      $("#inspector-content").replaceChildren(title, section);
    } else {
      $("#file-content pre").append(document.createTextNode(file.text));
      $("#load-file-more")?.remove();
    }
    if (file.truncated) {
      const more = button("Load next 64 KB", "file-row", () =>
        inspectFile(path, file.nextOffset, true),
      );
      more.id = "load-file-more";
      $("#inspector-content").append(more);
    }
  } catch (error) {
    if (generation === state.inspectorGeneration) {
      $("#inspector-content").replaceChildren(
        element("div", "inspect-loading", error.message),
      );
    }
  }
}

// ============================================================================
// LIVE SSE UPDATES
// ============================================================================
function connectLive(cursor) {
  state.stream?.close();
  const generation = state.generation;
  const stream = new EventSource(
    runPath(`/live?cursor=${encodeURIComponent(cursor)}`),
  );
  state.stream = stream;
  stream.onopen = () => {
    $("#live-state").textContent = "Connected";
    $("#live-state").classList.add("connected");
  };
  stream.onerror = () => {
    $("#live-state").textContent = "Reconnecting";
    $("#live-state").classList.remove("connected");
  };
  let updates = Promise.resolve();
  const refreshSummary = async () => {
    if (generation !== state.generation) return null;
    const run = await api(runPath());
    if (generation !== state.generation) return null;
    state.run = run;
    rebuildTimelineModel(false);
    renderSummary();
    return run;
  };
  const handleUpdateError = (error) => {
    if (generation === state.generation) showError(error);
  };
  stream.addEventListener("refresh", () => {
    updates = updates.then(refreshSummary).catch(handleUpdateError);
  });
  stream.addEventListener("trace", (message) => {
    updates = updates
      .then(async () => {
        if (generation !== state.generation) return;
        const result = JSON.parse(message.data);
        const pageGeneration = state.pageGeneration;
        const run = await refreshSummary();
        if (!run || pageGeneration !== state.pageGeneration) return;
        if (
          state.follow &&
          result.events?.length &&
          !$("#agent-filter").value &&
          !$("#type-filter").value
        ) {
          const byId = new Map(state.events.map((event) => [event.id, event]));
          for (const event of result.events) byId.set(event.id, event);
          ++state.pageGeneration;
          state.events = [...byId.values()].slice(-250);
          state.total = result.total ?? run.total ?? state.total;
          state.nextCursor = result.cursor;
          state.hasMore = result.hasMore;
          renderEvents();
        }
      })
      .catch(handleUpdateError);
  });
}

// ============================================================================
// VIDEO-EDITOR (NLE) WHEEL ZOOM & DRAG PAN ON SWIMLANE + GLOBAL CONTROLS
// ============================================================================
{
  const scroller = $("#swimlane-scroll");
  const railW = 204;
  const padR = 18;

  scroller.addEventListener(
    "wheel",
    (e) => {
      if (state.scale !== "duration" || !state.run) return;
      const rect = scroller.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      if (localX < railW) return;
      e.preventDefault();
      const trackW = Math.max(200, rect.width - railW - padR - 16);
      const frac = Math.max(0, Math.min(1, (localX - (railW + 8)) / trackW));
      const winSpan = state.winEnd - state.winStart;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.15) {
        panByFraction(e.deltaX / Math.max(300, trackW));
      } else {
        const anchor = state.winStart + frac * winSpan;
        const factor = Math.exp(Math.max(-90, Math.min(90, e.deltaY)) * 0.0042);
        zoomAround(anchor, factor);
      }
    },
    { passive: false },
  );

  let panning = false;
  let startX = 0;
  let panInitS = 0;
  let panInitE = 0;
  scroller.addEventListener("pointerdown", (e) => {
    if (state.scale !== "duration" || e.button !== 0 || !state.run) return;
    const dur = totalDurationMs();
    const rect = scroller.getBoundingClientRect();
    if (e.clientX - rect.left < railW) return;
    if (state.winEnd - state.winStart >= dur * 0.995) {
      swimlaneDragged = false;
      return;
    }
    panning = true;
    swimlaneDragged = false;
    startX = e.clientX;
    panInitS = state.winStart;
    panInitE = state.winEnd;
    scroller.setPointerCapture(e.pointerId);
  });
  scroller.addEventListener("pointermove", (e) => {
    if (!panning) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 4) {
      swimlaneDragged = true;
      const svg = $("#sl-svg");
      if (svg) svg.style.cursor = "grabbing";
    }
    if (!swimlaneDragged) return;
    const rect = scroller.getBoundingClientRect();
    const trackW = Math.max(200, rect.width - railW - padR - 16);
    const span = panInitE - panInitS;
    const dur = totalDurationMs();
    const ns = Math.max(0, Math.min(dur - span, panInitS - (dx / trackW) * span));
    setWindow(ns, ns + span);
  });
  const stopPan = () => {
    if (!panning) return;
    panning = false;
    const svg = $("#sl-svg");
    if (svg) svg.style.cursor = "grab";
    if (swimlaneDragged) {
      renderTrajectory();
      setTimeout(() => {
        swimlaneDragged = false;
      }, 30);
    }
  };
  scroller.addEventListener("pointerup", stopPan);
  scroller.addEventListener("pointercancel", stopPan);
}

function switchView(view) {
  state.view = view;
  for (const item of document.querySelectorAll("[data-view]")) {
    item.setAttribute("aria-selected", String(item.dataset.view === view));
  }
  for (const panel of document.querySelectorAll(".view-panel")) {
    panel.hidden = panel.id !== `${view}-panel`;
  }
  if (view === "timeline") renderTimelineArea();
}

$("#toggle-sidebar").addEventListener("click", () => {
  state.sidebarOpen = !state.sidebarOpen;
  $("#run-sidebar").hidden = !state.sidebarOpen;
  mmBuiltKey = "";
  if (state.run && state.view === "timeline") renderTimelineArea();
});

$("#run-search").addEventListener("input", renderRuns);
$("#refresh").addEventListener("click", loadRuns);
$("#timeline-search").addEventListener("input", (e) => {
  state.timelineSearch = e.target.value;
  state.trajLimit = 60;
  renderSwimlane();
  renderTrajectory();
});
$("#spawn-toggle").addEventListener("change", (e) => {
  state.showSpawn = e.target.checked;
  renderSwimlane();
});
$("#traj-more").addEventListener("click", () => {
  state.trajLimit += 80;
  renderTrajectory();
});

for (const btn of document.querySelectorAll("[data-scale]")) {
  btn.addEventListener("click", () => {
    state.scale = btn.dataset.scale;
    for (const item of document.querySelectorAll("[data-scale]")) {
      item.classList.toggle("active", item.dataset.scale === state.scale);
    }
    renderTimelineArea();
  });
}

$("#zoom-in").addEventListener("click", () =>
  zoomAround((state.winStart + state.winEnd) / 2, 0.5),
);
$("#zoom-out").addEventListener("click", () =>
  zoomAround((state.winStart + state.winEnd) / 2, 2.0),
);
$("#zoom-fit").addEventListener("click", () =>
  setWindow(0, totalDurationMs(), true),
);

$("#event-search").addEventListener("input", renderEvents);
for (const id of ["#agent-filter", "#type-filter"]) {
  $(id).addEventListener("change", () => {
    state.history = [];
    loadPage(0).catch(showError);
  });
}
$("#previous").addEventListener("click", () =>
  loadPage(state.history.pop() ?? 0).catch(showError),
);
$("#next").addEventListener("click", () => {
  state.history.push(state.cursor);
  loadPage(state.nextCursor).catch(showError);
});
$("#follow").addEventListener("click", () => {
  state.follow = !state.follow;
  $("#follow").setAttribute("aria-pressed", String(state.follow));
  $("#follow").classList.toggle("active", state.follow);
  $("#follow").textContent = state.follow ? "Follow live" : "Live paused";
});
$("#close-inspector").addEventListener("click", closeInspector);
$("#ins-mode-struct").addEventListener("click", () => {
  state.inspectorMode = "struct";
  openInspector();
  if (state.lastDetail) renderRecordDetail(state.lastDetail);
});
$("#ins-mode-raw").addEventListener("click", () => {
  state.inspectorMode = "raw";
  openInspector();
  if (state.lastDetail) renderRecordDetail(state.lastDetail);
});

for (const tab of document.querySelectorAll("[data-view]")) {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
}

// Theme sync (matching murm website localStorage key)
let storedTheme;
try {
  storedTheme = localStorage.getItem("murm:theme");
} catch {
  /* Storage may be disabled. */
}
document.documentElement.dataset.theme =
  storedTheme ??
  (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
$("#theme").addEventListener("click", () => {
  const nextTheme =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = nextTheme;
  try {
    localStorage.setItem("murm:theme", nextTheme);
  } catch {
    /* Active theme still applies. */
  }
});

window.addEventListener("resize", () => {
  mmBuiltKey = "";
  if (state.run && state.view === "timeline") renderTimelineArea();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeInspector();
    return;
  }
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName))
    return;
  if (!state.run || state.view !== "timeline" || state.scale !== "duration")
    return;
  const k = event.key.toLowerCase();
  if (k === "w" || k === "=" || k === "+") {
    event.preventDefault();
    zoomAround((state.winStart + state.winEnd) / 2, 0.65);
  } else if (k === "s" || k === "-") {
    event.preventDefault();
    zoomAround((state.winStart + state.winEnd) / 2, 1.55);
  } else if (k === "a" || event.key === "ArrowLeft") {
    event.preventDefault();
    panByFraction(-0.2);
  } else if (k === "d" || event.key === "ArrowRight") {
    event.preventDefault();
    panByFraction(0.2);
  } else if (k === "0") {
    event.preventDefault();
    setWindow(0, totalDurationMs(), true);
  }
});

window.addEventListener("pagehide", () => state.stream?.close());
loadRuns();
