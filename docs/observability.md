# SwarmEnv observation and diagnosis

This document is the first implementation contract for the monitoring system.
It describes what the UI shows and the read surface that an Agent can use to
diagnose a running Experiment.

## The UI model

The top-level page is an Experiment list. Each row identifies one Root Task
run and shows its lifecycle, elapsed time, active Core count, active
Execution count, waiting ratio, Task counts, Material count, and current
diagnostic severity.

The Experiment page has four linked areas:

1. **Core timeline.** One horizontal lane per reusable Core slot. A colored
   segment is one continuous Execution segment. The segment points to the
   durable Execution ID and shows its Task, Agent Session, start/end time,
   working/waiting/error intervals, and current state. Empty lane time is
   visible so idle capacity and scheduling gaps can be diagnosed.
2. **Execution activity.** Selecting a segment opens the complete ordered
   Interaction stream for that Execution, including the worker handoff, Pi
   messages, named Service calls, tool results, state transitions, Workspace
   revisions, Judge results, errors, and wait/resume boundaries.
3. **Task and Context panels.** The Task panel shows the root-to-child tree,
   state transitions, active and historical Executions, contracts, and
   blocking or waiting reasons. The Context panel shows Materials with kind,
   evidence state, source Task/Execution, version, supersession, and links to
   the interaction that produced them.
4. **Service and diagnosis pages.** Service pages show call volume, latency,
   errors, and recent activity. The diagnosis page shows health signals and
   Diagnostic Findings with evidence links. Additional services can add pages
   by registering a query adapter without changing the Core timeline.

The first live transport is Server-Sent Events. The browser subscribes to an
Experiment and receives new normalized Observation Events plus invalidation
messages for Task, Execution, Material, and Service projections. Initial page
state always comes from a bounded JSON query, so reconnects and refreshes do
not depend on replaying an in-memory stream.

The first phase deliberately stops at structured execution observability. It
records Pi replies, RPC records, tool calls and results, Service calls, state
transitions, Judge results, and Workspace revisions as ordered events. It does
not infer a semantic Agent trace, thought graph, intent labels, or causal
explanation from model text. Those analyses can consume the bounded Agent view
later without changing the operator event contract.

## Static and live entry points

An existing sanitized benchmark report can be opened as a read-only
Experiment. Passing the report directory also imports the private local Agent
logs into the local Observation Store for operator diagnosis:

```sh
node scripts/serve-observability.mjs \
  --report .worktrees/issue-28-four-core-parallelism/reports/issue-28-real-gpt-6.1-sol-v10-20261020/ \
  --root experiments \
  --port 8787
```

The server uses `experiments/.observability/observability.sqlite` by default
and remains online after an imported or live Experiment finishes. The
benchmark runner starts or reuses this same server before the root Task is
created. The printed URL and `metadata/observability.json` are the operator
entry points for a run:

```sh
node scripts/run-putnambench-benchmark.mjs \
  --problems config/putnambench-12.json \
  --putnambench-root /home/ubuntu/PutnamBench \
  --problem putnam_2025_b1 \
  --cores 4 \
  --timebox-ms 3600000 \
  --provider openai \
  --model gpt-6.1-sol \
  --experiment-dir experiments/observability-dynamic-YYYYMMDD \
  --report-dir reports/observability-dynamic-YYYYMMDD \
  --observability-host 0.0.0.0 \
  --observability-advertise-host "$(tailscale ip -4)" \
  --observability-port 8787
```

All live experiment directories must be below `--experiment-root` (which
defaults to `experiments`). For a server and browser on different machines in
the same Tailscale network, open the advertised URL, such as
`http://100.78.32.56:8787/`. The browser refreshes the Experiment registry
periodically, so an already open tab discovers later RUNNING Experiments.

Every Execution segment carries its Workspace reference, current revision,
content hash, file manifest, and revision history. A selected segment opens
its ordered Interaction events and Workspace projection together. A standalone
operator server can derive the current Execution projection from Observation
Events when the live Task Service remains inside the benchmark process.

## Human API

The first read-only HTTP surface is:

| Route | Purpose |
| --- | --- |
| `GET /api/experiments` | List Experiments and summary health |
| `GET /api/experiments/:id` | Read one Experiment summary and Core lanes |
| `GET /api/experiments/:id/timeline` | Read time-bounded Core/Execution segments |
| `GET /api/experiments/:id/stream` | Subscribe to live events with SSE |
| `GET /api/executions/:id` | Read Execution, Task, segments, and summaries |
| `GET /api/executions/:id/events` | Read ordered Interaction and lifecycle events |
| `GET /api/tasks/:id` | Read Task, children, Executions, and state history |
| `GET /api/tasks/:id/materials` | Read Materials linked to a Task tree |
| `GET /api/context/materials` | Filter Materials by kind, scope, source, or evidence state |
| `GET /api/services` | Read Service health and recent call summaries |
| `GET /api/diagnostics/:id` | Read health signals and Diagnostic Findings |

Queries use cursors and limits. Event payloads are never returned without a
bounded size. The operator route can request a private transcript when the
server is running in local operator mode; the Agent route uses the sanitized
projection described below.

## Agent analysis API

The Agent-facing Service Catalog will eventually register these read-only
tools:

- `observability_list_experiments`
- `observability_get_experiment`
- `observability_get_execution_timeline`
- `observability_query_events`
- `observability_get_health`
- `observability_list_findings`

Each tool accepts an Experiment or Execution identity, a bounded time/cursor
range, and an explicit result limit. The response contains normalized facts,
event kinds, IDs, timestamps, hashes, state summaries, and diagnostic
signals. It excludes raw provider credentials, unrestricted filesystem paths,
and unbounded prompt or tool payloads. A finding that needs action becomes a
normal Task created through Task Service; its evidence is published through
Context Service.

## Health signals

The first health projection should identify:

- an active Task with no live or resumable Execution;
- an active Execution with no Session or with a stale lease;
- a Core that is idle while claimable work exists;
- a Core or Execution with repeated tool errors, process exits, or timeouts;
- a waiting Execution whose condition is ready but has not been reclaimed;
- a Task whose child results are terminal but whose parent has not reviewed
  them;
- an event sequence gap, duplicate event ID, or event that references an
  unknown Task, Execution, Session, or Core;
- a Service with rising error rate or latency;
- a Material or Judge result whose provenance does not match its source.

Health signals are observations. They do not directly change Task or
Execution state. A human or diagnostic Agent decides whether to create a
rework, repair, or investigation Task.

## Delivery order

The implementation should be delivered in vertical slices:

1. Add the Experiment registry, Observation Event envelope, append/query
   store, cursor pagination, and deterministic tests.
2. Instrument Pi sessions, Runtime assignment, ServicesBridge, Task/Context/
   Judge operations, Workspace revisions, and benchmark lifecycle with the
   same event writer.
3. Add the read model and HTTP/SSE API, then verify that a synthetic run can
   reconstruct Core lanes and an Execution interaction stream after restart.
4. Build the native browser UI for Experiment list, Core timeline, Execution
   details, Task tree, Context Materials, Service activity, and diagnostics.
5. Register bounded Observability tools and add an Agent analysis fixture that
   reads a failing run and publishes a Diagnostic Finding through Context
   Service.

The first acceptance run should use the existing deterministic fake Agent
path. A real Pi experiment is required after the event contract and restart
behavior pass, because model quality must not be confused with observability
correctness.
