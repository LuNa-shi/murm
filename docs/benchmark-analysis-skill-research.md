# Reusable experiment-analysis skill research

## Question

How should SwarmEnv replace ad-hoc reading of `report.json` with a repeatable, evidence-first analysis skill that accepts an experiment directory or ID and writes a readable analysis report inside that experiment's directory?

## Findings

### 1. The current SOP already defines the intended analysis, but not an executable skill

`docs/benchmark-analysis-sop.md` defines six analysis stages: environment/audit, Task/Execution reconstruction, timeline reconstruction, collaboration closure, scheduler/waste analysis, and candidate/distance analysis. It also requires evidence to point to Task/Execution state, claims, Workspace revisions, Materials, candidates, Judge results, parent review, wake/resume, Core state, and Agent turns.

The gap is operational: the SOP does not specify an invocation contract, evidence inventory, completeness checks, deterministic extraction commands, report file schema, or how an Agent should cite exact trace records.

Source: `docs/benchmark-analysis-sop.md`.

### 2. `report.json` is a summary surface, not the complete experiment record

The benchmark runner writes a sanitized `report.json` from `projectReport(...)`. The report contains counts, hashes, states, timing summaries, and audit flags. It intentionally excludes raw transcript and proof contents; current reports explicitly contain `raw_transcript_exported: false` and `proof_contents_exported: false`.

Source: `src/benchmark/putnam-runner.js`, `docs/benchmark-environment.md`, and `reports/observability-dynamic-20261020/putnam_2025_b1/report.json`.

### 3. Local experiments contain richer evidence across several stores

A completed experiment directory can contain:

- Agent RPC/session records under `logs/projects/<problem>/agents/`;
- ServicesBridge records under `logs/projects/<problem>/bridge/`;
- Runtime records under `logs/projects/<problem>/runtime/`;
- Task, Context, Judge, and router records under `logs/projects/<problem>/services/`;
- checker records under `logs/projects/<problem>/judge/`;
- `state/projects/<problem>/project.sqlite`;
- `observability.sqlite` and metadata;
- per-Execution Workspace directories and manifests under `workspaces/`.

The local Agent records include prompts, RPC requests/responses, tool calls/results, stdout/stderr, and session metadata. Service records include operation inputs/results/errors. These records are sufficient to reconstruct a human-readable Execution timeline when correlated by Execution ID, Task ID, session/core ID, operation ID, and timestamp.

Source: `src/observability/benchmark-report-importer.js`, `src/observability/observation-store.js`, `src/agent/pi-adapter.js`, `src/agent/services-bridge.js`, `src/benchmark/putnam-runner.js`, and the completed experiment `experiments/observability-dynamic-20261020/`.

### 4. The current importer and report do not provide a single semantic view

`importBenchmarkReport()` imports the summary plus selected static events and optional raw Agent NDJSON into the Observation Store. It does not itself produce a complete, ordered, per-Execution narrative combining Agent, bridge, Service, Runtime, database, Judge, and Workspace evidence. The HTTP observability surface exposes events and projections, but the reusable analysis procedure is still manual.

Source: `src/observability/benchmark-report-importer.js` and `src/observability/observability-server.js`.

### 5. Existing real-run analysis demonstrates the desired output style

`docs/issue-30-real-run-analysis-20261022.md` shows the useful shape of a report: fixed evidence boundary, per-project outcome table, concrete Execution narratives, collaboration closure, explicit uncertainty, and recommendations. It also demonstrates why metrics such as `made_progress`, `eligible_window_ms`, and `agent_time_utilization_v0` must not be treated as semantic conclusions by themselves.

Source: `docs/issue-30-real-run-analysis-20261022.md`.

## Proposed direction

Treat #38 and #39 as one feature about **evidence-complete experiment analysis**, not as proven Runtime or Task bugs.

The feature should:

1. Build an analysis input inventory for an experiment directory/ID and report which evidence classes are present, missing, malformed, or inaccessible.
2. Add instrumentation only for data needed by the analysis and proven missing by the inventory; do not create speculative Goal-progress semantics.
3. Reconstruct a normalized event stream and per-Execution views by joining existing records.
4. Run the existing SOP as explicit analysis phases: audit, lifecycle graph, timeline, collaboration handoff, candidate/Judge sequence, progress/stall intervals, and privacy/completeness review.
5. Produce a readable Markdown report inside the experiment directory, with exact evidence references (file, sequence/line, database identity, event ID, timestamp, and related IDs).
6. Keep numerical summaries as supporting evidence, not the primary semantic conclusion. A JSON machine-readable result may be generated as an optional derived artifact, but `report.json` must not be treated as the analysis source of truth.
7. Make the skill invocable with an experiment path or ID and an explicit local/private output mode. Raw transcripts, proof contents, credentials, and unredacted experiment state must not be committed or copied into sanitized reports.

## Proposed acceptance shape

- Deterministic fixtures cover complete evidence, missing Agent log, missing Service log, malformed record, and cross-Execution correlation cases.
- The analysis command/skill refuses to claim completeness when required evidence is missing and lists the exact missing evidence.
- A fixture report contains one section per Execution and traces Task claim, tool calls, Workspace revisions, Material publication, Task creation, Service interactions, candidate submission, Judge result, wait/wake/review, and terminal state where present.
- The report distinguishes observed fact, derived metric, semantic interpretation, and unknown; it never labels a Material useful merely because it was published or read.
- Running the skill twice on the same experiment produces the same fact extraction and stable references.
- A real completed experiment produces a readable report under that experiment directory and preserves privacy boundaries.
- Existing lifecycle, protocol-validity, fencing, Judge, and cleanup tests remain passing.
