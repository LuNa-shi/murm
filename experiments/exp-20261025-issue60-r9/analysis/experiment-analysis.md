# Issue 60 short real-Agent run

This is a sanitized operator report for `putnam_2025_b1`. It contains runtime
and scheduler facts only; raw Agent transcripts, proof/candidate source,
credentials, stdout, and stderr are not included.

## Fixed boundary

| Field | Value |
|---|---|
| Implementation commit | `e7f4e144d447651892da86f3d1f4997af24f520a` |
| Worktree | clean (`repository_worktree_dirty=false`) |
| PutnamBench commit | `a635813f5edf297d928f9bd5ef8324a26bdde09c` |
| Cores | 4 |
| Timebox | 120000 ms |
| Provider/model | `openai` / `gpt-6.1-sol` |
| Run interval | `2026-10-25T06:19:43.386Z` to `2026-10-25T06:21:43.850Z` |

The local route probe returned `READY_TO_LAUNCH` before this run. The probe
found Node `v24.21.0`, NuRouter `0.2.14`, Pi `1.4.0`, Lean `4.33.1`, and Lake
`5.0.0`; it recorded no secret values.

## Result

- `protocol_valid=true`; `audit.invalid=false`
- `solved=false`; `made_progress=false`
- One root Task remained `OPEN`; no Execution was created
- `claim_count=0`, `child_claim_count=0`, `resumed_execution_count=0`
- `max_active_core_count=0`; `ready_work_ms=120460`; `ready_unassigned_ms=0`
- No checker, Material, wait, wake, or Agent-turn events were recorded
- Scheduler recorded 12 startup attempts, 12 startup failures, four bounded
  startup exhaustions, zero successful dispatches, and zero duplicate
  suppressions

The observation lifecycle recorded 12 unbound session starts and 12 closes.
The sessions exited during their first prompt, before Task claim. This is a
provider/Pi session-path blocker after a successful command-availability probe;
it is not evidence of a mathematical result.

The sanitized numerical projections are adjacent to this report:

- `aggregate-report.json`
- `putnam_2025_b1/report.json`
