# Sanitized Putnam 2025 B1 trajectory

This directory is a public, metadata-only export of the complete persisted
trajectory for the 8-hour `putnam_2025_b1` run.

Files:

- `trajectory.json`: Task, Execution, Material, CheckResult, Core state
  intervals, and aggregate parallelism facts.
- `operations.jsonl`: every project SQLite operation in event order. Result
  payloads are reduced to whitelisted IDs, states, hashes, wait types,
  verdicts, and error codes.
- `agent-events.jsonl`: every recorded Agent lifecycle/RPC event type in time
  order, with tool names and bounded error classes only.

The export intentionally excludes raw Agent messages, model reasoning,
workspace file contents, candidate source, proof contents, credentials, and
provider request IDs. Hashes and durable IDs are retained so the relationships
can be checked against the local experiment evidence without publishing proof
content.

The key finding is that the final child entered `parent_review` at
`2026-10-22T17:44:32.636Z`; the Root was assigned a RUNNING segment at
`17:44:33.804Z`, but the resumed Agent session then failed repeatedly and
never made another Service call. The final failure classes include context
window overflow, terminated requests, length termination, and 502 termination.
Heartbeats continued until cleanup, leaving the Execution apparently RUNNING.
