## Agent skills

### Issue tracker

Issues for this repository live in GitHub Issues and are managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five-label triage vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. Domain context belongs in the root `CONTEXT.md`, and architecture decisions belong in `docs/adr/`. See `docs/agents/domain.md`.

## Agent Core success standards

A healthy process lifecycle is not the same as a successful Agent experiment. Do not mark work complete merely because Pi processes stayed alive, leases were renewed, the runner reached its deadline, the report says protocol_valid or invalid=false, or an Execution entered WAITING.

Every real run must be evaluated on two separate axes:

- Protocol validity: no unauthorized input, placeholder candidate, path escape, stale fenced write, duplicate ownership, or corrupted Task/Execution state.
- Agent contribution: the Agent actually reads the Task and Workspace, changes or verifies work, creates or executes useful Tasks, publishes meaningful Materials, submits candidates, or processes Judge feedback.

An experiment that only lists Services, heartbeats, publishes a blocker, and waits has not succeeded. If there is no Workspace change, child Task work, useful Material, candidate, CheckResult, or parent integration, report the run as no progress and continue iterating.

Workspace is a real local project working surface. Setting Pi's cwd is necessary but insufficient: the Agent-facing tool surface must allow the Agent to list and read permitted files, create or edit files, read changes back, save an auditable revision, and use the permitted checker path. Workspace writes must remain inside the current Execution root, reject .swarm metadata, reject parent or other Execution paths, enforce fencing and revision CAS, and survive checkpoint, wait/resume, restart, and fork.

Agent Core is reusable worker capacity, not a permanent Task or proof role. The expected four-core flow starts with one root Task, lets the root Agent explore and create bounded child Tasks, lets other Core slots browse and explicitly claim those children, lets each child Execution produce Workspace or Material contributions, and lets the root resume or reopen to inspect, accept, request rework, and integrate the results. A root Agent waiting while child work proceeds is valid; a root Agent waiting because it cannot use the Workspace is a failure.

A final one-hour real experiment must use a pinned, previously unproved PutnamBench problem and preserve evidence for the Task tree, claims, Execution ownership, Workspace revisions and file hashes, checkpoints, Materials, candidates, CheckResults, waits/resumes, errors, and Core activity. It must distinguish protocol_valid, made_progress, solved, and ended_early. The mathematical proof may remain unsolved, but the run must demonstrate real, auditable work. Normal completion requires all applicable acceptance conditions to pass; otherwise fix the system and rerun.

## Default Agent Core iteration workflow

For work involving Agent Core, Task, Execution, Workspace, Services, or real experiments, use this workflow unless the user explicitly changes it:

1. Read AGENTS.md, CONTEXT.md, the relevant ADRs, the originating GitHub Issue, and the last experiment's report, SQLite state, Workspace metadata, and Service/tool logs.
2. State the user-visible goal, the intended code and documentation changes, and the test plan before implementation.
3. Turn each reported failure into a deterministic, minimal, red-capable regression test at the seam that reproduces the real behavior. Separate protocol-state assertions from contribution assertions.
4. For difficult bugs, rank falsifiable hypotheses before changing code. Instrument only the boundary needed to distinguish them, and remove temporary diagnostics before completion.
5. Work in a dedicated worktree under .worktrees, based on the latest main. Keep implementation commits and experiment evidence reviewable, and use a separate PR for the change.
6. Run the focused regression tests first, then the relevant integration tests and the full test suite. Do not accept a process-exit-only test as evidence of Agent success.
7. Run a short real Pi experiment before the final gate. The short run must show real Workspace read/write, meaningful Task or Material work, and the intended claim/wait/resume or Judge behavior.
8. Only after the short run passes, run the full one-hour real experiment. Inspect the report together with the SQLite state, Workspace revisions and file contents or hashes, bridge events, Service events, Material records, candidate records, and CheckResults.
9. If the one-hour run has no meaningful contribution, invalid tool behavior, missing Workspace capability, broken child scheduling, or incomplete feedback flow, do not declare success. Fix the relevant boundary and repeat the short and one-hour gates.
10. After the evidence passes, run the required code review against main, update the PR with exact evidence and known limits, verify the worktree and remote branch state, and only then report completion.
