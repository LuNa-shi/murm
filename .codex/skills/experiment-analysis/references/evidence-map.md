# Evidence map

Use this map after resolving the input. The paths are relative to the experiment directory unless an external path is explicitly marked in metadata. The analyzer records a class as `present`, `missing`, `malformed`, `empty`, or `not applicable`; a missing class is not a zero count.

## Evidence classes

| Class | Expected location | What it can establish | Do not infer from absence |
|---|---|---|---|
| Metadata | `metadata/experiment.json`, `metadata/observability.json` | Experiment ID, problem IDs, commits, model/provider, timebox, status, configured observation DB | That the run had no work if metadata is absent |
| Agent | `logs/projects/<problem>/agents/*.ndjson` and private Workspace Pi session files | RPC requests/records, tool calls/results, turn/session/process facts | That an unlogged tool call never happened |
| Bridge | `logs/projects/<problem>/bridge/*.ndjson` | Agent-to-Service bridge operation and result envelopes | That a Service was never reached if the bridge log is missing |
| Runtime | `logs/projects/<problem>/runtime/*.ndjson` | Bind, heartbeat, wait, stop, release and Core-lane facts | Effective work from heartbeat count alone |
| Service | `logs/projects/<problem>/services/*.ndjson` | Task, Context, Workspace, router and Judge Service operations/results | Semantic usefulness from publication or acceptance |
| Judge | `logs/projects/<problem>/judge/*.ndjson` and `services/judge-service.ndjson` | Checker requests, verdicts, check IDs and bounded diagnostic categories | Feedback use by the Agent unless a later read/action is recorded |
| SQLite/state | `state/projects/<problem>/project.sqlite` | Authoritative Task, Execution, Material, CheckResult and operation rows | State transitions that are not persisted or whose DB is malformed |
| Observation | `observability.sqlite`, or the DB configured by `metadata/observability.json` | Ordered event IDs, sequence, stable correlation fields, session/Core/Execution joins | Raw payload privacy permission; payloads still require redaction |
| Workspace | `workspaces/projects/<problem>/<execution>/` | Workspace manifest, revision/checkpoint lineage and file inventory | Proof/candidate contents in a shareable report |
| Summary | `report.json`, `aggregate-report.json`, or metadata-configured report path | Supporting counts, hashes, audit flags and numerical timing projections | The semantic account of an Execution |

The authoritative owner remains the relevant domain Service and its state database. Observation and log records are evidence references and projections, not a replacement Task or Execution state machine.

## Resolver rules

1. A directory input is used directly.
2. An ID input is resolved under `--experiments-root` (default `./experiments`).
3. Metadata is read first. It supplies the experiment ID, project/report paths, and external observation DB location.
4. The analyzer discovers project IDs from `logs/projects`, `state/projects`, and `workspaces/projects`, then adds IDs listed in metadata.
5. A summary is optional. If present, it is retained as supporting evidence and never replaces local traces.

## Correlation precedence

Use the strongest available key in this order:

1. `experiment_id` and Observation `sequence`/`event_id`;
2. `task_id`, `execution_id`, `session_id`, `core_id`, and operation/correlation ID;
3. Material, Candidate, CheckResult, Workspace revision, and request key;
4. timestamp and Core lane, only when no stable ID exists.

Timestamp fallback must be stated in the fact or report. A timestamp can associate a raw Agent event with a Runtime bind interval, but it cannot prove ownership when two Executions overlap. Keep the event unmatched in that case.

## Source reference format

Every normalized fact carries one or more stable references:

- NDJSON: `logs/projects/demo/services/task-service.ndjson:42`;
- observation store: `observability.sqlite#observation_events.sequence=123`;
- domain state: `state/projects/demo/project.sqlite#executions.execution_id=<id>`;
- Workspace metadata: `workspaces/projects/demo/<execution>/.swarm/revisions/3.json`.

Use relative paths in generated reports. External configured databases are labeled `<external>/<basename>` so the report does not leak unrestricted machine paths. The local analyzer may still read them in private mode.

## Normalized facts

The first implementation recognizes these high-value facts:

- Agent tool call/result, turn, session, process, and RPC events;
- Service call start/finish, Task creation/claim/state change/review/rework;
- Execution assignment/state/terminal/wait/wake/resume and heartbeat;
- Workspace manifest/revision;
- Material publication and explicit Material reads;
- Candidate submission and Judge/checker result;
- authoritative Task/Execution/Material/CheckResult snapshots and operation rows.

A fact may have multiple source references after de-duplication. The preferred source is an Observation event when it exists, followed by raw logs, Workspace metadata, and database snapshots. De-duplication never deletes an unmatched event reference from the evidence set.

## Privacy boundary

Full local mode may read private traces for analysis, but reports contain only bounded metadata and source references by default. Sanitized mode avoids raw logs and Workspace contents. Never copy these into the report or Git:

- raw transcript or hidden chain-of-thought;
- candidate/proof source or unrestricted Workspace file content;
- credentials, tokens, authorization headers;
- stdout/stderr, unrestricted error payloads, or private absolute paths.

If a needed field is only present in a redacted or missing source, write `unknown` or an explicit evidence limitation.
