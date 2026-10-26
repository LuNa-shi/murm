# Issue 60 semantic experiment evidence

This bundle records the sanitized analysis of the 2-hour semantic run for `putnam_2025_b1` using implementation commit `a0412fba65a8ab22bd1df2531f901a7c6dbe363a`.

Public files in this directory:

- `experiment-analysis.md`: deterministic evidence-first analysis with 10-minute windows.
- `experiment-explainer.pdf`: reader-facing walkthrough of the 2-hour run, the real four-Core time lanes, per-Execution Core durations, timeline, and all 35 Execution attempts.
- `semantic-review.md`: independent semantic review and rubric score.
- `optimization-directions.md`: prioritized follow-up work and validation gates.
- `aggregate-report.json`: sanitized aggregate metrics.
- `putnam_2025_b1-report.json`: sanitized project report.
- `raw-evidence-manifest.json`: file counts, sizes, and selected checksums for the local raw evidence.

The complete raw evidence remains in the PR worktree at `experiments/exp-20261025-issue60-pr68-semantic-2h/run/` and `.observability/`. It includes Agent/Bridge/Runtime/Service/Judge logs, the project SQLite state, Workspace revisions, checker work directories, and observation data. Those files are intentionally ignored and local-only because the repository work agreement forbids publishing raw Agent transcripts, proof/candidate source, credentials, or unredacted experiment state.
