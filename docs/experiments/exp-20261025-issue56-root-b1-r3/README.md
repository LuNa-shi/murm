# Issue #56 root-only diagnostic publication

This is the sanitized, reviewable publication for the Issue #56 root-only
run. The run is diagnostic-only: Provider authentication failed before the
first Agent turn, so it does not establish the real-Agent acceptance gate.

## Run identity

| Field | Value |
|---|---|
| Publication ID | `exp-20261025-issue56-root-b1-r3` |
| Source experiment ID | `issue56-root-only-1h-final-20261025-r3` |
| Implementation commit executed | `0dd0df353a418b8bc6620599b80f3c078cd5fead` |
| Acceptance commit required for rerun | `90f7b94f845fef640877031a6e38b64b6036e5f7` |
| PutnamBench commit | `a635813f5edf297d928f9bd5ef8324a26bdde09c` |
| Fixture | `putnam_2025_b1` (`putnam-putnam_2025_b1`) |
| Provider / model | `openai` / `gpt-6.1-sol` |
| Cores / timebox | 4 / 3,600,000 ms |
| Parallel mode | `root-only` |
| Status | completed, environment-blocked before Agent work |

## Published files

- [Sanitized run summary](run-summary.json)
- [Evidence-first analysis](analysis/experiment-analysis.md)
- [Independent semantic review](analysis/semantic-review.md)

## Evidence boundary

Only lifecycle, protocol, readiness, utilization, and blocker classifications
are published. Raw Agent transcripts, proof or Candidate source, Workspace
contents, SQLite databases, credentials, stdout, stderr, and unredacted
experiment state remain local and ignored.
