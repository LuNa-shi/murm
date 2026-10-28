# Experiment evidence map

Use the supplied experiment directory as the evidence boundary. Read metadata
first, then discover the project IDs and evidence stores. This map tells the
skill where to look; it does not turn an absent source into a zero count.

## Evidence classes

| Class | Typical location | What it can establish |
| --- | --- | --- |
| Metadata | `metadata/experiment.json`, `metadata/observability.json` | Run identity, commit, route, timebox, status, project/report paths |
| Agent | `logs/projects/<project>/agents/*.ndjson` and session metadata | Agent messages, tool requests/results, session and process facts |
| Bridge | `logs/projects/<project>/bridge/*.ndjson` | Agent-to-Service request and response envelopes |
| Runtime | `logs/projects/<project>/runtime/*.ndjson` | Core binding, heartbeat, wait, stop, release, fencing, and session facts |
| Controller/Daemon | observation records with `task-controller`/`core-daemon` source | reconcile, signal, discovery, selection, claim, conflict, release, and recovery; summary fields only locate records |
| Service | `logs/projects/<project>/services/*.ndjson` | Task, Context, Workspace, router, admission, and Judge operations |
| Judge/checker | `logs/projects/<project>/judge/*.ndjson` and Judge service records | preflight, checker process, verdict, CheckResult, and bounded diagnostics |
| State | `state/projects/<project>/project.sqlite` | authoritative Task, Execution, Material, CheckResult, and operation rows |
| Observation | configured `observability.sqlite` | ordered event IDs and cross-source correlation fields |
| Workspace | `workspaces/projects/<project>/<execution>/` | manifests, revisions, checkpoints, and file inventory |
| Summary | `report.json`, `aggregate-report.json` | supporting counts, hashes, and projections; not semantic proof |

For each class record `present`, `missing`, `malformed`, `empty`, or
`not applicable`. Missing Agent or service evidence limits a conclusion; it
does not prove that the activity never occurred.

If the metadata-declared Observation database or Controller/Daemon stream is
missing, keep Runtime/Task/Agent joins but mark exact reconcile→signal ordering
as unknown and the orchestration result as diagnostic-only. If authoritative
Task/Execution state is missing, do not present lifecycle or ownership facts as
durable. If a required Material, Workspace, or Judge source is missing, mark
that handoff or check unknown.

## Question-specific sources

- **Orchestration:** Controller/Daemon events, Runtime binding/release,
  Task Service admission and lifecycle, Core state, and the related Agent
  selection/claim response.
- **Coordination:** Task and Execution state, Material publish/read records,
  child and dependency relations, Workspace revisions, Candidate/CheckResult,
  review/rework, and the Agent actions that consume results.
- **Execution:** raw Agent JSONL first, then Runtime, Workspace, Material,
  Candidate, Judge, and lifecycle records needed to explain each window.
- **Tool contract:** Agent request/result records, Bridge, Service Router and
  Service results, current public tool schema/implementation, and Judge/checker
  records.

For the tool schema/implementation, prefer serialized metadata in the
experiment. Otherwise read the checked-out source at the exact implementation
commit recorded in metadata and cite it. Never silently use an unrelated
working tree; if neither source is available, record `schema unavailable`.

## Correlation precedence

Use the strongest key available:

1. observation `event_id` or `sequence` plus experiment ID;
2. `task_id`, `execution_id`, `session_id`, `core_id`, and
   operation/correlation ID;
3. `material_id`, Candidate, CheckResult, and Workspace revision IDs;
4. timestamp and Core lane only when no stable ID exists.

State when timestamp fallback was used. Keep an event unmatched when two
possible owners overlap.

## References and privacy

Use relative references such as:

- `logs/projects/demo/agents/core-1.ndjson:42`;
- `observability.sqlite#sequence=123`;
- `state/projects/demo/project.sqlite#executions.execution_id=<id>`;
- `workspaces/projects/demo/<execution>/.swarm/revisions/3.json`.

For a configured database or checked-out source outside the experiment
directory, use `<external>/<basename>` plus the relevant commit, table, or
identity. Never emit its absolute machine path.

Do not modify raw evidence or domain databases. Reports may contain bounded
metadata and references, but never raw transcripts, hidden reasoning,
proof/candidate source, credentials, authorization headers, stdout/stderr, or
unrestricted private paths.
