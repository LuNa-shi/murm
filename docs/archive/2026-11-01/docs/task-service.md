# Task Service and Execution lifecycle

Task Service owns Task and Execution truth. It stores the Task specification,
priority, Workspace description, completion contract, state, and version
fields. It stores each Execution's lease, fencing version, Workspace selection,
Workspace revision reference, checkpoint, and candidate binding.

The normal worker path is:

1. Call `list_tasks` with the root ID and a bounded limit.
2. Select the Task that needs work.
3. Call `claim` with that Task ID, a claim key, and `workspace_mode`
   set to `clean` or `resume`.
4. Read the returned Task and Execution through the named Task and Execution
   tools.

`claim` is transactional and creates a new Execution for the selected Task,
subject to that Task's `parallel_quota`. A Task can therefore have multiple
active Execution branches. A resume selection may identify a prior Execution
and Workspace revision; Runtime materializes a new writable Workspace directory
with explicit parent lineage. A clean selection starts from the Task's
Workspace files.

An active Execution can call `create_child_task` when it discovers a separate
responsibility. The child receives a normal priority and enters the same root
Task list. The parent does not preallocate a fixed number of proof children.

Version checks, idempotency keys, leases, and fencing protect every write. A
waiting Execution whose wait condition is ready for work appears in the
available Task list. An explicit claim can
hand that same Execution and Workspace to the next Agent, incrementing its
attempt and changing it back to `CREATED`; timer waits and parent-review waits
remain unavailable until their controlling condition is satisfied. A failed
Judge result preserves this resumable waiting lineage so the next slot can
continue after reading the feedback.

Execution rows persist lifecycle metadata for bounded Runtime ownership:
`started_at`, `handoff_deadline`, `execution_deadline`, and the single-write
`handoff_reminder_sent_at` marker. A handoff records `terminal_reason` and
structured `handoff_metadata` alongside the checkpoint and Workspace lineage.
The `handoff_execution` operation fences the old owner, transitions the
unfinished Task back to `OPEN`, and rejects stale state or fencing versions.
Runtime uses the read-only wait validation seam before writing a checkpoint;
malformed waits therefore leave ownership unchanged. A result that arrives
before wait registration is detected as already resumable, so no duplicate
`WAITING` or wake event is created.
