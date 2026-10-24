# Testing and experiment rules

Use deterministic tests for state-machine and scheduler behavior, integration tests for Runtime and Agent boundaries, and a real Agent run for provider and model behavior.

## Experiment naming and storage

Keep every run under the checkout's single `experiments/` directory. Do not
scatter experiment state across `reports/`, temporary directories, or a
worktree-specific ad hoc path. Each run directory must use the sortable ID
format `exp-YYYYMMDD-<short-id>`, where `YYYYMMDD` is the UTC start date from
the experiment metadata. For example:

```text
experiments/exp-20261024-issue50-b1-1h-2fc0c87/
```

The suffix should identify the issue, fixture, and run variant without
including credentials or prompt contents. Keep raw state local and ignored;
the report is written to
`experiments/<id>/analysis/experiment-analysis.md`, with the independent
semantic review at `experiments/<id>/analysis/semantic-review.md`.

Before a PR:

1. Run the focused test file for the changed lifecycle.
2. Run `npm test`.
3. Run `git diff --check`.
4. For a benchmark, verify the worktree is clean and record the exact commit.
5. Publish only the sanitized report. Raw experiment state remains local.

The real benchmark loads `.env` for local routing. It must report the model, provider, fixture, timebox, commit, and parallelism summary without exporting credentials, candidate source, or transcripts.
