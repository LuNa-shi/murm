# Testing and experiment rules

Use deterministic tests for state-machine and scheduler behavior, integration tests for Runtime and Agent boundaries, and a real Agent run for provider and model behavior.

Before a PR:

1. Run the focused test file for the changed lifecycle.
2. Run `npm test`.
3. Run `git diff --check`.
4. For a benchmark, verify the worktree is clean and record the exact commit.
5. Publish only the sanitized report. Raw experiment state remains local.

The real benchmark loads `.env` for local routing. It must report the model, provider, fixture, timebox, commit, and parallelism summary without exporting credentials, candidate source, or transcripts.
