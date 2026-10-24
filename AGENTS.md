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
- When creating a worktree for a real-Agent or benchmark run, check the local
  `main` checkout for `.env`. If it exists and the target worktree does not
  have its own environment file, copy it into the target worktree before
  launching the run (for example, `cp /home/ubuntu/SwarmEnv/.env <worktree>/.env`).
  Keep `.env` ignored, never print or commit its values, and verify only that
  required route variables such as `NUROUTER_PI_PROVIDER` and
  `NUROUTER_PI_MODEL` are present.

## Real-Agent experiment SOP

- Use `openai` with `gpt-6.1-sol` as the default local route unless the Issue
  specifies another provider or model. Keep the route in `.env` or in the
  process environment; never put credentials in this file.
- Before launching, record the exact `git rev-parse HEAD` and
  `git status --porcelain` result, PutnamBench commit, Lean project root
  (normally `<PutnamBench>/lean4`), Core count, timebox, provider, and model.
  Acceptance evidence must point at the exact clean implementation commit; a
  dirty or different-commit run is diagnostic-only until rerun.
- Run the real-agent probe first and require `READY_TO_LAUNCH`; a `BLOCKED`
  probe is an environment result, not a failed Agent experiment. If the local
  `main` checkout has no `.env`, provide the required route explicitly in the
  process environment or stop with `BLOCKED`; do not silently use an
  unverified default.
- Use the locked fixture and its project root. Confirm that the local
  PutnamBench checkout matches the fixture commit and that `lean`, `lake`,
  `nurouter`, and `pi` are available before spending the experiment timebox.
- Runtime sends the Execution's initial `agent_prompt` during
  `startExecution`/`wakeExecution`. A harness must wait for that turn to
  settle or explicitly queue a follow-up with `streamingBehavior: followUp` or
  `steer`; never issue a second concurrent prompt.
- Keep raw experiment output in an ignored experiment/temp directory. Inspect
  only sanitized status, lifecycle, checker, and report fields in summaries;
  never paste raw Agent transcripts, proof contents, credentials, stdout, or
  stderr into GitHub, `AGENTS.md`, or a report.
- Record the final experiment status, blocker or result, report path, and the
  exact rerun command in the PR or experiment evidence document. The
  sanitized report must repeat the exact implementation commit whose runtime
  and harness code was executed. A later documentation-only commit that
  records randomized task/check IDs does not change that implementation and
  does not require another run; any later code or harness commit does require
  fresh acceptance evidence.

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
- Work unit evidence records Task, Execution, Core, and progress kind. Task and Execution identity, Workspace lineage, leases, fencing, and quota remain the ownership evidence; do not add semantic fingerprint or deduplication policy to benchmark progress.
- Prefer integration tests for lifecycle and Agent behavior. Run `npm test` and `git diff --check` before opening a PR.

## Documentation ownership

Files under `docs/` are generated or maintained engineering documentation. Files under `documents/` are supplied by humans and must not be rewritten by an Agent unless the Issue explicitly requests it.
