# Evidence-first experiment analysis

## Executive conclusion

- **Fact:** The semantic run completed its one-hour protocol with
  `protocol_valid=true` and `audit_invalid=false`.
- **Fact:** No Agent turn reached a usable provider response. The run recorded
  zero claims, child Tasks, structure operations, Workspace writes, and
  Candidate checks.
- **Interpretation:** The run is a Provider-authentication environment result,
  not evidence that the semantic structure failed or that the problem was
  mathematically unsolved.
- **Acceptance:** Inconclusive. A clean rerun from the acceptance commit is
  required after local authentication is restored.

## Run and protocol

| Field | Value |
|---|---|
| Implementation commit | `0dd0df353a418b8bc6620599b80f3c078cd5fead` |
| Fixture / PutnamBench | `putnam_2025_b1` / `a635813f5edf297d928f9bd5ef8324a26bdde09c` |
| Route | `openai` / `gpt-6.1-sol` |
| Cores / timebox | 4 / 3,600,000 ms |
| Parallel mode | `semantic` |
| Elapsed | 3604772 ms |
| Worktree at launch | clean |

## Sanitized observations

| Observation | Value |
|---|---:|
| Tasks / child Tasks | 1 / 0 |
| Claims / structure operations | 0 / 0 |
| Readiness samples | 720 (READY) |
| Ready work / ready-unassigned | 3598367 ms / 3598367 ms |
| Agent-time utilization | 0 |
| Core turns / sessions | 0 / 4 |
| Solved / made progress | false / false |

The four Core summaries each contain one safe Provider-authentication failure
before a first turn. No credential, transcript, proof, Candidate, Workspace,
or raw process output is included here.

## Acceptance boundary

This run does not test simultaneous alternative branches, jointly required
subtasks, sibling claim overlap, Material consumption, Task-local completion,
branch/subtask satisfaction, Root completion, or a semantic-vs-Root-only
performance comparison. Those conclusions remain unknown until the required
clean authenticated rerun.
