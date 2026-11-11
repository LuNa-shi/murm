# 05. Workspace and continuity

Each Execution receives an independent writable Workspace. Shared Mission
participants do not share a mutable directory or a global latest commit.

## Progress and local Git

`execution_progress` records completed work, findings, open questions and the
next step. For file work, Runtime may save a local Git revision and the
Progress Material references the actual commit/revision. A successor must be
able to identify the source Execution, source Workspace and source revision.

Checkpoint saves progress and continues the current Execution. Handoff ends
only that Execution's authority and leaves the responsibility unfinished.
Saving failure is bounded: the system records the failure and may discard the
unsaved state while preserving the last valid Material/commit.

## Identity rotation

The identity lane carries the compaction count across successive Tasks. The
documented default rule is at most three successful compactions; after the
third, the identity may continue until the next 80% context-window threshold,
then hands off to a new identity. A fourth compaction is not allowed.

Confirm current configuration and observed context-window measurements for each run; an unspecified usage value is not proof that the threshold was avoided.

The rotation path must preserve the effective Task, last valid Workspace/Git
snapshot, pending feedback boundaries and fencing. It must not create a new
research responsibility merely because the Session changed.

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
