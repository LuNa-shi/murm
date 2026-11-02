# ADR 0011: Observation and diagnosis are a separate read model

Status: proposed.

## Context

SwarmEnv already persists the domain state needed to run work: Task and
Execution state, shared Materials, Workspace revisions, Judge results, and
Core capacity managed by Runtime. It also writes service and Pi adapter logs.
The logs are useful evidence, but they have no stable query contract. In
particular, a UI cannot reliably reconstruct a Core timeline, an Execution
conversation, or a live health view from independent text files.

The system needs a human-facing Web UI for fast diagnosis and a bounded
Agent-facing interface for later parallel analysis. These consumers need
different visibility and data-shaping rules.

## Decision

Add an Observation and Diagnosis layer with these rules:

1. `Experiment` is one complete observed run of one Root Task and is keyed by
   the runner's `run_id`. It owns the observation scope for Core lanes,
   Sessions, Executions, Tasks, Materials, Workspace revisions, and Services.
2. Domain Services remain the source of truth. Observation Events record facts
   and references emitted by those Services, Runtime, Workspace Manager, Judge,
   and Pi sessions. They do not become a second Task or Execution state
   machine.
3. An `Execution segment` is a continuous assignment of one Execution to one
   Core lane and Agent Session. A durable Execution may have multiple segments
   across wait, resume, and Core reuse.
4. The observation store is append-only and queryable by Experiment, Core,
   Session, Task, Execution, event kind, and time cursor. It supports a live
   subscription for the Web UI.
5. The local operator projection can read the complete private transcript for
   an Experiment. Agent-facing Observability tools expose structured,
   bounded, redacted records and health summaries. They do not expose provider
   credentials, private Runtime files, or unrestricted raw log paths.
6. The first UI uses a small Node HTTP server, JSON endpoints, Server-Sent
   Events, and a browser-native frontend. A later frontend build system can
   consume the same endpoints without changing the model.
7. An Agent analysis pass is read-only at the observation boundary. If it finds
   a problem, it creates a normal diagnostic Task and writes evidence or a
   conclusion through the existing Context Service.

## Observation Event contract

Every event has an immutable envelope:

```json
{
  "event_id": "uuid",
  "experiment_id": "run-id",
  "sequence": 42,
  "occurred_at": "2026-10-20T12:00:00.000Z",
  "source": "agent|runtime|task|context|judge|workspace|router",
  "kind": "tool_call_started",
  "core_id": "core-1",
  "session_id": "session-id",
  "task_id": "task-id",
  "execution_id": "execution-id",
  "correlation_id": "operation-or-rpc-id",
  "visibility": "private|operator|agent",
  "payload": {},
  "payload_hash": "sha256"
}
```

The first event kinds include `experiment_started`, `experiment_finished`,
`core_state_changed`, `session_started`, `session_ready`, `session_closed`,
`execution_assigned`, `execution_released`, `rpc_request`, `rpc_record`,
`assistant_message`, `tool_call_started`, `tool_call_finished`,
`service_call_started`, `service_call_finished`, `task_state_changed`,
`material_published`, `workspace_revision_saved`, `judge_check_finished`,
`process_error`, and `diagnostic_finding`.

The raw adapter record remains available to the operator projection as a
private payload. The normalized fields are required for timeline and query
behavior; a new Pi record shape must not force every consumer to understand
the raw protocol.

## Consequences

The UI can show a stable live timeline even when an Execution moves between
Core slots. It can open a single Execution and reconstruct the full ordered
interaction history from Session and Service events. Agents can inspect the
same run through a bounded contract without receiving private transcripts or
credentials.

The Runtime and Service code must emit correlation IDs and lifecycle events.
Existing text logs remain useful for forensic debugging, but new UI features
must use the observation store rather than parsing arbitrary log filenames.

## Alternatives considered

- **Query only the Task/Execution SQLite tables.** This loses Pi replies,
  tool results, process failures, and the exact order of interactions.
- **Expose the raw NDJSON files as the Web API.** This couples the UI to file
  layout and makes it too easy to leak raw prompts, credentials, or private
  Workspace data to an Agent.
- **Make observation events the domain event source for all state.** This
  would turn the current MVP into an event-sourced rewrite and make Runtime
  recovery and Task state migration harder before the monitoring need is
  proven.
