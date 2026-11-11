# 05. Workspace and continuity

Each Execution receives an independent writable Workspace. Shared Mission
participants do not share a mutable directory or a global latest commit.

## Progress and local Git

`execution_progress` records completed work, findings, open questions and the
next step. For file work, Runtime may save a local Git revision and the
Progress Material references the actual commit/revision. A successor must be
able to identify the source Execution, source Workspace and source revision.

Checkpoint attempts to save progress and continues the current Execution. Handoff ends
only that Execution's authority and leaves the responsibility unfinished.
Saving failure is bounded: the system records the failure and may discard the
unsaved state while preserving the last valid Material/commit. The Task Service's
`task_register(take: true)` switch and the preceding Runtime checkpoint are not
one file/database transaction; inspect `save_status` rather than assuming success.

## Identity rotation

The identity lane carries the compaction count across successive Tasks. The
documented default rule is at most three successful compactions; after the
third, the identity may continue until the next 80% context-window threshold,
then triggers **identity/Session rotation**. A fourth compaction is not allowed.

Confirm current configuration and observed context-window measurements for each run; an unspecified usage value is not proof that the threshold was avoided.

Implementation detail: `Runtime.#rotateIdentity` calls `restartSession`, which normally keeps the **same Execution ID** while replacing its Pi Session and updating session/fencing generation via `recover_execution`. This differs from a **Task/Execution handoff**, which releases the existing Execution so a successor can claim the responsibility. After the third compaction, an unknown post-compaction usage measurement may also trigger conservative rotation. These behaviors need run-level verification of context measurements.

The rotation path must preserve the effective Task, last valid Workspace/Git snapshot, pending feedback boundaries and fencing. The Session change alone must not create a new research responsibility.

## What a continuity report must prove

Use actual file/commit and database evidence to show:

- where the source Workspace came from;
- what revision was saved successfully;
- which successor read or resumed it;
- which old writes were fenced;
- which pending feedback was delivered and handled;
- what was lost when a save failed.

The words `resume`, `handoff` or `checkpoint` in a log are not sufficient
without the corresponding source and state records.
