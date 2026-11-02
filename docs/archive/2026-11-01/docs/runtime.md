# Runtime and Workspace Manager

Runtime owns process capacity and delegates versioned filesystem operations to
Workspace Manager. Before starting Pi it materializes the selected Workspace
in the Execution's working directory, writes the problem codebase and task
requirements, records a Workspace manifest, and passes the generic Agent
prompt directly to the Pi adapter.

The Workspace contains `README.md`, the formal problem file when present,
`workspace-manifest.json`, Runtime metadata, revision records, checkpoints,
and the Pi session directory. It does not create prompt or context snapshot
text files. The manifest records the Task, Workspace snapshot hash, selected
revision, and runtime information.

Every write checks the Execution ID and fencing version. A resumed Execution
copies the selected revision into a new writable Workspace and retains the
source reference and revision as lineage. A clean Execution materializes the
Task's Workspace directly. Old fenced processes cannot write the current
revision.

`request_wait` saves a revision and checkpoint, changes the Execution to
`WAITING`, stops Pi, and releases the process slot. Runtime can wake that
same Execution or fence it after lease expiry. The Task remains the scheduling
responsibility until the Execution reaches a terminal state.

Runtime bounds every started Execution with a configurable `executionTimeoutMs`
(60 minutes by default) and sends one persisted handoff reminder at
`handoffReminderMs` (55 minutes by default). The scheduler calls
`sweepExecutionTimeouts()` regularly; the sweep records the reminder before
queuing a Pi `followUp`, and fences an overdue Execution with terminal reason
`timeout`. A voluntary `handoffExecution()` follows the same durable boundary
with terminal reason `voluntary_handoff` (or the caller's stable reason), saves
the checkpoint and Workspace revision, stops the Session, and returns the
unfinished Task to the claimable `OPEN` projection. The operation is
idempotent, and the fencing version prevents the old Session from writing
after release.

## Session health and fresh-session recovery

Pi owns automatic context compaction and transient provider retry. Runtime
explicitly enables both for each bound Session and materializes project-local
Pi settings with compaction enabled, 15 agent-level retries, a 2-second base
backoff, and a 60-second maximum retry delay. The actual Provider/Model route
and context window remain runtime configuration and must be recorded by the
experiment.

Runtime observes Pi RPC lifecycle events separately from lease heartbeats.
Turn, retry, and compaction activity keeps a Session in an active phase; a
completed turn, successful tool execution, or successful retry is productive
activity. A heartbeat does not count as productive activity.

A final provider retry failure, failed compaction, process failure, or a
watchdog-detected heartbeat-only stall stops the old Session. Runtime fences
the current Workspace binding and recovers the same Execution in place with a
new fencing version, attempt number, Runtime generation, and Pi session
identity. The Task, Workspace lineage, checkpoint reference, and persisted
Materials remain unchanged. The fresh Session receives a bounded structured
recovery prompt rather than the old transcript. Recovery is bounded; after
its configured attempts are exhausted, Runtime fences the Execution and
records an exhausted disposition. When a Runtime owner supplies a session-start
observer, Runtime notifies it for every Session and marks recovery replacements
explicitly. The benchmark uses this handoff to replace the Core's old Session
reference, keep the recovered turn accounted for, and wait for the replacement
to settle; it never sends follow-up work to the fenced Session.

A watchdog only acts on a RUNNING Execution that is outside a normal turn,
provider retry, or compaction phase and has exceeded the configured
no-productive-progress window. The benchmark runner calls each Core Runtime's
watchdog periodically while a run is active and records sweep, recovery, and
watchdog-error counts. Normal long turns, compaction, retry, and semantic
WAITING are not watchdog failures.
