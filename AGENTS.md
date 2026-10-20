# SwarmEnv agent instructions

SwarmEnv is a local-first runtime for durable, checkable Agent work. This file
is a short map of repository rules. Read the linked source of truth before
changing the corresponding area.

## Work agreement

- Work from a GitHub Issue with explicit acceptance criteria.
- Use one dedicated worktree and branch per Issue. Keep `main` free of feature development.
- Run relevant tests, commit the work, open a separate PR, and review the PR against `main` before merge.
- Use the repository's Matt Pocock skills when applicable: `to-tickets`, `implement`, `pr`, and `code-review`.
- Do not commit credentials, tokens, raw Agent transcripts, proof contents, or unredacted experiment state.

See [docs/agents/workflow.md](docs/agents/workflow.md) and [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

## Repository map

- Domain vocabulary: `CONTEXT.md`
- Architecture decisions: `docs/adr/`
- Agent-generated documentation and reports: `docs/`
- Human-provided documents: `documents/`
- Runtime and service boundaries: `src/`
- Deterministic and integration tests: `test/`
- Benchmark entry points: `scripts/` and `src/benchmark/`

Use `CONTEXT.md` and the relevant ADR before changing Task, Execution, Workspace, Material, Runtime, or Judge behavior.

## Engineering rules

- Task and Execution state transitions belong to Task Service and Runtime. Agents request transitions through registered Service tools.
- `WAITING` requires a persisted checkpoint and a concrete typed condition. An empty queue is `IDLE` or bounded backoff, never semantic waiting.
- A root Agent should create bounded direct child Tasks for genuinely separable work before waiting. Each child needs a goal, expected output, acceptance condition, and result delivery path.
- Effective Agent Time counts only auditable Runtime `RUNNING` intervals. Keep `IDLE`, semantic `WAITING`, scheduler polling, Judge time, and turn occupancy separate.
- Prefer integration tests for lifecycle and Agent behavior. Run `npm test` and `git diff --check` before opening a PR.

## Documentation ownership

Files under `docs/` are generated or maintained engineering documentation. Files under `documents/` are supplied by humans and must not be rewritten by an Agent unless the Issue explicitly requests it.
