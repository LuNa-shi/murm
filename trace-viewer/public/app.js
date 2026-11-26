const $ = (selector) => document.querySelector(selector);
const state = {
  runs: [],
  run: null,
  events: [],
  cursor: 0,
  nextCursor: 0,
  history: [],
  hasMore: false,
  total: 0,
  view: "timeline",
  selected: null,
  follow: true,
  stream: null,
  generation: 0,
  inspectorGeneration: 0,
  pageGeneration: 0,
};
const colors = [
  "var(--accent)",
  "var(--teal)",
  "var(--purple)",
  "var(--amber)",
];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
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
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.floor(value / 60000)}m ${Math.floor((value % 60000) / 1000)}s`;
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

function statusClass(value) {
  const text = statusLabel(value).toLowerCase();
  if (/fail|error|rejected/.test(text)) return "bad";
  if (/pending|unknown|gap|incomplete/.test(text)) return "warning";
  if (/closed|complete|clean|success|pass/.test(text)) return "good";
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
      /* Keep the HTTP status for non-JSON errors. */
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

async function loadRuns() {
  try {
    const result = await api("/api/runs");
    state.runs = result.runs ?? result;
    renderRuns();
    const requested = new URLSearchParams(location.hash.slice(1)).get("run");
    if (
      !state.run &&
      requested &&
      state.runs.some((run) => run.id === requested)
    )
      await openRun(requested);
    if (!state.runs.length)
      $("#empty-help").textContent =
        "No Runs found in the configured root. Add a recorded Run directory, then refresh.";
    $("#error").hidden = true;
  } catch (error) {
    showError(error);
  }
}

function renderRuns() {
  const query = $("#run-search").value.toLowerCase();
  const runs = state.runs.filter((run) =>
    `${run.label ?? ""} ${run.id} ${run.runtimeId ?? ""}`
      .toLowerCase()
      .includes(query),
  );
  $("#run-count").textContent =
    `${runs.length} recorded ${runs.length === 1 ? "Run" : "Runs"}`;
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
    const title = element("div", "run-card-title");
    title.append(
      element(
        "span",
        `status-dot ${statusClass(run.status) || (/running|active/.test(statusLabel(run.status)) ? "active" : "")}`,
      ),
      element("span", "", run.label ?? shortId(run.id)),
    );
    const meta = element("div", "run-card-meta");
    const started = dateValue(run.startedAt);
    meta.append(
      element(
        "span",
        "",
        Number.isFinite(started)
          ? new Date(started).toISOString().slice(0, 10)
          : shortId(run.runtimeId ?? run.id),
      ),
      element("span", "", statusLabel(run.status)),
    );
    card.append(title, meta);
    $("#runs").append(card);
  }
  if (!runs.length)
    $("#runs").append(element("p", "empty-state", "No matching Runs."));
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
  $("#inspector").hidden = true;
  $("#welcome").hidden = true;
  $("#run-view").hidden = false;
  $("#error").hidden = true;
  location.hash = new URLSearchParams({ run: id }).toString();
  $("#agent-filter").value = "";
  $("#type-filter").value = "";
  $("#event-search").value = "";
  renderSummary();
  renderRuns();
  await loadPage(0);
  if (generation === state.generation) connectLive(run.cursor ?? 0);
}

function renderSummary() {
  const run = state.run;
  $("#run-title").textContent = run.label ?? "Run trace";
  $("#run-harness").textContent = run.harness ?? "Trace";
  $("#run-subtitle").textContent =
    `RUNTIME ${run.runtimeId ?? run.id}  ·  ${Number.isFinite(dateValue(run.startedAt)) ? new Date(dateValue(run.startedAt)).toISOString().replace("T", " ").replace("Z", " UTC") : "Start time unavailable"}`;
  const start = dateValue(run.startedAt);
  const end = dateValue(run.endedAt);
  const cells = [
    ["Run", run.status],
    ["Agents", run.agents?.length ?? 0],
    [
      "Recorded duration",
      Number.isFinite(end) && Number.isFinite(start)
        ? duration(end - start)
        : "Open boundary",
    ],
    ["Business result", run.outcome],
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
  const previousAgent = $("#agent-filter").value;
  $("#agent-filter").replaceChildren(new Option("All Agents", ""));
  for (const agent of run.agents ?? [])
    $("#agent-filter").append(
      new Option(agent.label ?? shortId(agent.id), agent.id),
    );
  $("#agent-filter").value = previousAgent;
  $("#gaps").replaceChildren(
    ...(run.gaps ?? []).map((gap) =>
      element("div", "gap", `Trace gap · ${gap.message ?? pretty(gap)}`),
    ),
  );
  $("#relation-count").textContent = run.relations?.length ?? 0;
  renderTimeline();
  renderRelations();
  renderFiles();
}

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
  )
    return;
  state.events = result.events;
  state.cursor = cursor;
  state.nextCursor = result.cursor;
  state.hasMore = result.hasMore;
  state.total = result.total;
  renderEvents();
  renderTimeline();
}

function visibleEvents() {
  const query = $("#event-search").value.toLowerCase();
  return state.events.filter((event) =>
    `${event.label} ${event.type} ${event.kind} ${event.agentId ?? ""} ${event.requestId ?? ""} ${event.operationId ?? ""}`
      .toLowerCase()
      .includes(query),
  );
}

function eventKind(event) {
  return event.kind ?? event.type?.split(".")[0] ?? "event";
}

function eventRow(event) {
  const row = button(
    "",
    `event-row${event.id === state.selected ? " selected" : ""}`,
    () => inspectRecord(event.id),
  );
  row.dataset.recordId = event.id;
  row.append(
    element("span", "event-time", clock(event.time ?? event.startedAt)),
    element("span", "event-agent", agentLabel(event.agentId)),
  );
  const label = element(
    "span",
    "event-label",
    event.label ?? event.type ?? eventKind(event),
  );
  label.title = event.label ?? event.type ?? event.id;
  label.append(
    element(
      "span",
      "event-secondary",
      `${event.type ?? ""}${event.status ? ` · ${statusLabel(event.status)}` : ""}`,
    ),
  );
  row.append(
    label,
    element("span", `event-kind ${eventKind(event)}`, eventKind(event)),
  );
  return row;
}

function renderEvents() {
  const events = visibleEvents();
  for (const container of [$("#events"), $("#timeline-events")]) {
    container.replaceChildren(...events.map(eventRow));
    if (!events.length)
      container.append(
        element("div", "empty-state", "No events match this page and filter."),
      );
  }
  $("#page-info").textContent =
    `${events.length} shown · ${state.total.toLocaleString()} records`;
  $("#pagination-info").textContent =
    `${state.events.length} records on this page · ${state.total.toLocaleString()} total`;
  $("#previous").disabled = !state.history.length;
  $("#next").disabled = !state.hasMore;
}

function renderTimeline() {
  if (!state.run) return;
  const root = $("#timeline");
  root.replaceChildren();
  const selectedAgent = $("#agent-filter").value;
  const agents = (state.run.agents ?? []).filter(
    (agent) => !selectedAgent || agent.id === selectedAgent,
  );
  const spans = (state.run.spans ?? []).filter(
    (span) => !selectedAgent || span.agentId === selectedAgent,
  );
  const note = $(".timeline-note");
  note.textContent = state.run.spansTruncated
    ? "Showing the latest 1,000 recorded spans. Use the paginated event ledger below to inspect earlier evidence."
    : "Execution spans use recorded boundaries. Markers show recorded timestamps where execution boundaries are unavailable.";
  const timedAgents = new Set(spans.map((span) => span.agentId));
  for (const event of state.events) {
    if (
      timedAgents.has(event.agentId) ||
      !Number.isFinite(dateValue(event.time))
    )
      continue;
    if (selectedAgent && selectedAgent !== event.agentId) continue;
    spans.push({
      id: event.id,
      agentId: event.agentId,
      kind: event.kind,
      label: `${event.label} · recorded timestamp`,
      startedAt: event.time,
      status: event.status,
      evidenceIds: [event.id],
    });
  }
  const times = spans
    .flatMap((span) => [dateValue(span.startedAt), dateValue(span.endedAt)])
    .filter(Number.isFinite);
  const start = Number.isFinite(dateValue(state.run.startedAt))
    ? dateValue(state.run.startedAt)
    : Math.min(...times);
  const end = Math.max(dateValue(state.run.endedAt) || start, ...times);
  if (!agents.length || !Number.isFinite(start) || !Number.isFinite(end)) {
    root.append(
      element(
        "div",
        "empty-state",
        "No recorded timing boundaries are available. Inspect the event ledger for raw evidence.",
      ),
    );
    return;
  }
  const domain = Math.max(end - start, 1);
  const percent = (value) =>
    Math.min(100, Math.max(0, ((dateValue(value) - start) / domain) * 100));
  const ruler = element("div", "timeline-ruler");
  for (let index = 0; index <= 5; index++) {
    const tick = element(
      "span",
      "ruler-tick",
      index === 0 ? "+0 s" : duration((domain * index) / 5),
    );
    tick.style.left = `${index * 20}%`;
    ruler.append(tick);
  }
  root.append(ruler);
  for (const [index, agent] of agents.entries()) {
    const lane = element("div", "lane");
    lane.style.setProperty("--lane-color", colors[index % colors.length]);
    const label = button("", "lane-label", () => inspectAgent(agent));
    const name = element("div", "agent-name");
    name.append(
      element("span", "agent-color"),
      document.createTextNode(agent.label ?? shortId(agent.id)),
    );
    name.title = agent.id;
    label.append(
      name,
      element(
        "div",
        "agent-role",
        `${agent.profile ?? (agent.parentId ? "Child Agent" : "Root Agent")} · ${statusLabel(agent.execution)}`,
      ),
    );
    const track = element("div", "lane-track");
    for (const span of spans.filter((item) => item.agentId === agent.id)) {
      if (!Number.isFinite(dateValue(span.startedAt))) continue;
      const hasEnd = Number.isFinite(dateValue(span.endedAt));
      const bar = button(
        span.kind === "execution" && hasEnd ? "execution" : "",
        `trace-span ${span.kind}${hasEnd ? "" : " marker"}`,
        () => inspectEvidence(span.evidenceIds ?? [], span.label),
      );
      bar.style.left = `${percent(span.startedAt)}%`;
      bar.style.width = hasEnd
        ? `${Math.max(0.15, percent(span.endedAt) - percent(span.startedAt))}%`
        : "3px";
      bar.title = `${span.label ?? span.kind} · ${clock(span.startedAt)} → ${hasEnd ? clock(span.endedAt) : "end boundary unavailable"} · ${statusLabel(span.status)}`;
      bar.setAttribute("aria-label", bar.title);
      track.append(bar);
    }
    lane.append(label, track);
    root.append(lane);
  }
  // Connections use recorded relation identity. The time position uses the relation's recorded time.
  const width = root.clientWidth - 143;
  for (const relation of state.run.relations ?? []) {
    const from = agents.findIndex((agent) => agent.id === relation.fromAgentId);
    const to = agents.findIndex((agent) => agent.id === relation.toAgentId);
    if (
      from < 0 ||
      to < 0 ||
      from === to ||
      !Number.isFinite(dateValue(relation.time))
    )
      continue;
    const line = button("", "relation-line", () => inspectRelation(relation));
    const dy = (to - from) * 82;
    const dx = 15;
    line.style.left = `${143 + (percent(relation.time) * Math.max(width - 20, 1)) / 100}px`;
    line.style.top = `${30 + from * 82 + 40}px`;
    line.style.width = `${Math.hypot(dx, dy)}px`;
    line.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
    line.title = `${relation.kind} · ${agentLabel(relation.fromAgentId)} → ${agentLabel(relation.toAgentId)}`;
    line.setAttribute("aria-label", line.title);
    root.append(line);
  }
}

function renderRelations() {
  const root = $("#relations");
  root.replaceChildren();
  for (const relation of state.run.relations ?? []) {
    const card = element("article", "relation-card");
    card.append(element("h3", "", relation.kind));
    const route = element("div", "relation-route");
    route.append(
      element("span", "", agentLabel(relation.fromAgentId)),
      element("span", "arrow", "→"),
      element("span", "", agentLabel(relation.toAgentId)),
      element("span", "muted", clock(relation.time)),
    );
    const links = element("div", "evidence-links");
    links.append(
      button("Inspect handoff ↗", "button", () => inspectRelation(relation)),
    );
    for (const [index, id] of (relation.evidenceIds ?? []).entries())
      links.append(
        button(`Evidence ${index + 1}`, "button", () => inspectRecord(id)),
      );
    card.append(route, links);
    root.append(card);
  }
  if (!root.childElementCount)
    root.append(
      element(
        "div",
        "empty-state",
        "No causal handoffs are recorded for this Run. Generic Service calls remain available in Events.",
      ),
    );
}

function renderFiles() {
  const outcome = $("#outcome");
  outcome.replaceChildren();
  const result = element("div", "outcome-block");
  result.append(
    element("h2", "", "Business result"),
    element("pre", "", pretty(state.run.outcome)),
  );
  outcome.append(result);
  const files = $("#files");
  files.replaceChildren();
  for (const file of state.run.files ?? [])
    files.append(button(file.path, "file-row", () => inspectFile(file.path)));
  if (!files.childElementCount)
    files.append(
      element("div", "empty-state", "No archived files were found."),
    );
}

function inspectEvidence(ids, label) {
  ++state.inspectorGeneration;
  openInspector();
  const title = element("div", "inspector-title");
  title.append(
    element("span", "event-kind", "timing span"),
    element("h3", "", label ?? "Recorded interval"),
  );
  const sources = inspectorSection("Boundary evidence");
  for (const [index, id] of ids.entries()) {
    sources.append(
      button(`Open source record ${index + 1} ↗`, "file-row", () =>
        inspectRecord(id),
      ),
    );
  }
  if (!ids.length)
    sources.append(
      element("p", "muted", "No raw evidence reference is available."),
    );
  $("#inspector-content").replaceChildren(title, sources);
}

function openInspector() {
  $("#inspector").hidden = false;
  renderTimeline();
}

function inspectorSection(title) {
  const section = element("section", "inspector-section");
  section.append(element("h4", "", title));
  return section;
}

function appendMetadata(container, values) {
  const list = element("dl", "inspector-data");
  for (const [label, value] of values) {
    if (value === undefined || value === null) continue;
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
    } catch {
      copy.textContent = "Copy unavailable";
    }
  });
  toolbar.append(heading, copy);
  section.append(toolbar, element("pre", "", pretty(value)));
  return section;
}

async function inspectRecord(id) {
  const generation = ++state.inspectorGeneration;
  state.selected = id;
  openInspector();
  renderEvents();
  $("#inspector-content").replaceChildren(
    element("div", "inspect-loading", "Loading source record…"),
  );
  try {
    const detail = await api(runPath(`/records/${encodeURIComponent(id)}`));
    if (generation !== state.inspectorGeneration) return;
    const event = detail.event;
    const title = element("div", "inspector-title");
    title.append(
      element("span", `event-kind ${eventKind(event)}`, eventKind(event)),
      element("h3", "", event.label ?? event.type),
      element("p", "muted", event.id),
    );
    const metadata = inspectorSection("Recorded identity");
    appendMetadata(metadata, [
      ["Agent", event.agentId],
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
    const nodes = [title, metadata, rawSection("Source record", detail.record)];
    if (detail.contextMatches?.length) {
      const matches = inspectorSection("Actual model context");
      for (const match of detail.contextMatches) {
        matches.append(
          button(
            `${clock(match.startedAt)} · ${match.requestId} ↗`,
            "file-row",
            () => inspectRecord(match.recordId),
          ),
        );
      }
      nodes.push(matches);
    }
    if (detail.files?.length) {
      const files = inspectorSection("Related evidence");
      for (const file of detail.files)
        files.append(
          button(file.path, "file-row", () => inspectFile(file.path)),
        );
      nodes.push(files);
    }
    $("#inspector-content").replaceChildren(...nodes);
  } catch (error) {
    if (generation === state.inspectorGeneration)
      $("#inspector-content").replaceChildren(
        element("div", "inspect-loading", error.message),
      );
  }
}

function inspectAgent(agent) {
  ++state.inspectorGeneration;
  openInspector();
  const title = element("div", "inspector-title");
  title.append(
    element("span", "event-kind", "Agent"),
    element("h3", "", agent.label ?? shortId(agent.id)),
  );
  const identity = inspectorSection("Agent identity");
  appendMetadata(identity, [
    ["Agent", agent.id],
    ["Parent", agent.parentId],
    ["Profile", agent.profile],
  ]);
  $("#inspector-content").replaceChildren(
    title,
    identity,
    rawSection("Input acceptance", agent.inputs),
    rawSection("Actual execution", agent.execution),
    rawSection("Execution outcome", agent.outcome),
    rawSection("Resource cleanup", agent.cleanup),
  );
}

function inspectRelation(relation) {
  ++state.inspectorGeneration;
  openInspector();
  const title = element("div", "inspector-title");
  title.append(
    element("span", "event-kind", "collaboration"),
    element("h3", "", relation.kind),
  );
  const metadata = inspectorSection("Information handoff");
  appendMetadata(metadata, [
    ["From", relation.fromAgentId],
    ["To", relation.toAgentId],
    ["Time", relation.time],
    ["Relation", relation.id],
  ]);
  const links = inspectorSection("Source evidence");
  for (const [index, id] of (relation.evidenceIds ?? []).entries())
    links.append(
      button(`Open record ${index + 1} ↗`, "file-row", () =>
        inspectRecord(id),
      ),
    );
  if (!relation.evidenceIds?.length)
    links.append(element("p", "muted", "Source records unavailable."));
  $("#inspector-content").replaceChildren(
    title,
    metadata,
    links,
    rawSection("Relation record", relation),
  );
}

async function inspectFile(path, offset = 0, append = false) {
  const generation = ++state.inspectorGeneration;
  openInspector();
  if (!append)
    $("#inspector-content").replaceChildren(
      element("div", "inspect-loading", "Loading recorded file…"),
    );
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
        element("span", "event-kind", "recorded file"),
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
    if (generation === state.inspectorGeneration)
      $("#inspector-content").replaceChildren(
        element("div", "inspect-loading", error.message),
      );
  }
}

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

$("#run-search").addEventListener("input", renderRuns);
$("#refresh").addEventListener("click", loadRuns);
$("#event-search").addEventListener("input", renderEvents);
for (const id of ["#agent-filter", "#type-filter"])
  $(id).addEventListener("change", () => {
    state.history = [];
    loadPage(0).catch(showError);
  });
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
  $("#follow").textContent = state.follow ? "Follow live" : "Live paused";
});
$("#close-inspector").addEventListener("click", () => {
  ++state.inspectorGeneration;
  $("#inspector").hidden = true;
  renderTimeline();
});
for (const tab of document.querySelectorAll("[data-view]"))
  tab.addEventListener("click", () => {
    state.view = tab.dataset.view;
    for (const item of document.querySelectorAll("[data-view]"))
      item.setAttribute("aria-selected", String(item === tab));
    for (const panel of document.querySelectorAll(".view-panel"))
      panel.hidden = panel.id !== `${state.view}-panel`;
    $(".pagination").hidden =
      state.view === "collaboration" || state.view === "artifacts";
    $(".filters").hidden =
      state.view === "collaboration" || state.view === "artifacts";
    if (state.view === "timeline") renderTimeline();
  });

let theme;
try {
  theme = localStorage.getItem("murm:theme");
} catch {
  /* Browser storage may be disabled. */
}
document.documentElement.dataset.theme =
  theme ??
  (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
$("#theme").addEventListener("click", () => {
  const theme =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("murm:theme", theme);
  } catch {
    /* The active theme still applies for this page. */
  }
});
window.addEventListener("resize", renderTimeline);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    ++state.inspectorGeneration;
    $("#inspector").hidden = true;
    renderTimeline();
  }
});
window.addEventListener("pagehide", () => state.stream?.close());
loadRuns();
