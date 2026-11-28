# murm — Coding Agent Instructions

These instructions apply to **Coding Agents developing murm**, not research Agents running inside it. They define the human/Agent decision boundary and the project-specific rules for using the installed **Matt Pocock engineering skills**.

## Current architecture and work requirements

The [architecture manual](docs/architecture/INDEX.md) is the maintained description of the current implementation. The [SDK and user guides](docs/INDEX.md) describe its supported public surface and are also the website's content source. Current code and schemas establish exact behavior; tests and experiments establish what has been verified. Keep these sources aligned in the same PR.

The [Core / Harness design](docs/designs/core-harness/README.md) and its linked extensions record reviewed product requirements and acceptance. Read them together with the relevant Issue and the owner's later explicit decisions; a later explicit decision supersedes an older conflicting clause without changing unrelated acceptance or resource limits. When an authorized change updates the design, include the design, implementation, migration, tests and documentation in the same PR. The design index links the [dynamic Lead-Worker extension](docs/designs/dynamic-lead-worker.md) and the open CLI/TUI work; current implemented behavior belongs in Architecture.

Human-approved GitHub Issues and explicit user instructions define work requirements, scope, acceptance and resources. Read the full relevant Issue, linked tickets, comments and accepted Agent Brief. Cite the exact revision of any reviewed design and preserve its acceptance. Superseded phase plans remain in Git history and linked Issues. Resource, research, merge and publication permissions follow the project rules below.

Use one Issue per complete implementation PR unless the owner explicitly requests a different split. Keep approvals, progress, dependencies and handoffs on GitHub. When source, the current manual and the approved change disagree, identify the discrepancy and resolve it within the authorized scope. Start from [docs/INDEX.md](docs/INDEX.md), [GLOSSARY.md](GLOSSARY.md), then the relevant source and tests; do not load every document by default.

## Human decisions and delegated autonomy

The human owner decides which research questions are valuable, their priority, what an Issue must deliver, and how success will be judged. Agents may propose new hypotheses with evidence but **must not select and execute a new research direction** without approval.

Within an approved Issue, an Agent may select implementation details and autonomously iterate **implement → review → test/probe → diagnose → fix → retest**. Use isolated branches/worktrees, not `main`. Create every new linked worktree under the primary repository checkout's `.worktree/<task-or-branch>/` directory (on this machine, `/home/ubuntu/murm/.worktree/`). Do not create worktrees beside the primary checkout or nest them under another linked worktree. Keep `/.worktree/` ignored; existing active worktrees must not be relocated while a run or process still depends on their paths. Repeated deterministic checks and bounded diagnostic probes need no per-run human report or new approval when their environment, provider/model, budget, and time limits are already authorized.

For a change not already authorized by an explicit owner instruction or the applicable Issue, return to the Issue for human review before changing intended behavior, acceptance criteria, architecture scope, research hypotheses, benchmark/checker/fixture, provider/model, or resource budget. Paid/external experiments require explicit authorization or a previously approved allowance. Technical difficulty does not confer permission to widen the Issue.

## Default engineering workflow — Matt skills

Follow the **installed skills** when applicable; do not claim a skill ran if it is unavailable. These skills govern the engineering *procedure*, not product requirements or research approval.

- **`/to-spec`**: turn the agreed scope into a GitHub spec Issue using the current architecture, glossary, applicable reviewed design and later explicit owner decisions. Link the exact design revision and distinguish confirmed direction from proposals awaiting review.
- **`/to-tickets`** (optional): propose complete vertical slices with blocking edges; obtain human agreement before publishing GitHub sub-Issues and dependencies. Keep the agreed one-Issue/one-PR boundary unless the owner requests another split.
- **`/implement`**: implement one Issue or ticket, use **`/tdd`** at pre-agreed public seams, run relevant checks, and finish with **`/code-review`**.
- **`/implement-spec`**: implement an approved Issue/ticket graph on an integration branch with per-ticket branches/worktrees and fresh contexts where supported. Track dependencies on GitHub, not in local Markdown.
- **`/diagnosing-bugs`**: reproduce, minimize, instrument, fix, and regression-test difficult failures.
- **`/code-review`**: evaluate **Spec** against the applicable approved Issue/Agent Brief, its reviewed design revision and later explicit owner decisions. Evaluate **Standards** (repository conventions and code quality) separately.
- **`/pr`**: present a concise Summary, before/after Evidence, and Merge Danger (reversibility and blast radius).

An explicit request to invoke a skill permits its normal in-scope operations; it does **not** authorize unapproved spending, new research goals, unrelated Issue changes, or merging PRs.

## Verification, evidence, and closeout

- Pin the implementation commit; validate affected Agent/Bridge/Service/Runtime paths, authorization, idempotency, fencing, checker integrity, privacy, and cleanup as relevant. Run focused tests and, for code changes when available, `npm test` and `git diff --check`. Report skipped checks honestly.
- Formal research runs follow [the experiment workflow](docs/workflows/experiment.md) and [historical evidence guidance](https://github.com/LuNa-shi/SwarmEnv/blob/dc011003fa0354a881b7a3ba9ba901fe36cbcac9/.codex/skills/experiment-analysis/SKILL.md). Ordinary in-scope tests and diagnostic probes do not require an EXP ID or individual report.
- At meaningful milestones, link commits, tests/probes, PR review findings, real-run evidence, and remaining gaps **to the GitHub Issue/PR**; the Issue/PR remains the record of progress. Do not require human review after every debugging iteration.
- Update affected [Architecture](docs/architecture/INDEX.md) in the implementation PR, ready for review with the code. Reconcile the complete affected flow at Issue/stage closeout; documentation is part of completion. Never describe an unverified proposal as accepted or a passing tool call as scientific progress.
- Use plain **Results / Analysis / Next steps** in formal research reporting. Keep observations distinct from interpretations and unapproved recommendations.
- Keep raw Agent conversations, proof/candidate source, credentials, stdout/stderr, private state databases, and personal paths out of committed reports. Store raw experiment evidence only in ignored local `experiments/`.
- Keep active target designs in `docs/designs/`, linked to their Issue and review PR and clearly marked as pending implementation. Reconcile implemented behavior into Architecture and retire superseded plans through Git history. Do not create `STATUS.md`, `archive/`, historical redirect files, or `CONTEXT.md`.
- Do not merge PRs, close unrelated Issues, or run unapproved paid experiments without the user's authorization.

## Architecture documentation is a required deliverable

The owner reads `docs/architecture/` to understand the implementation **without reading source code**. It must be a complete implementation manual, not only module summaries or pointers to source. Code references support verification; they must not replace the explanation.

- For every runtime-affecting change, explain the entry point, call/event order, inputs and defaults, guards, state/storage writes, outputs, failure/retry/timeout behavior, cleanup, and observable evidence. Cover compatibility paths still executable in the reviewed tree and distinguish them from approved pending changes.
- Maintain the explicit file-to-chapter inventory in [source-map.json](docs/architecture/source-map.json). New or removed runtime, CLI, service, configuration, storage, UI or build files require a deliberate inventory update. A file mapping is a coverage aid, not proof that every behavior has been explained.
- Maintain full repository-controlled prompt text, composition conditions, dynamic field provenance and actual send paths in [Prompts](docs/architecture/08-prompts.md). Include discovery, ordinary turns, tool instructions, feedback, lifecycle rejection, notification, recovery, compaction/rotation and legacy paths. Distinguish composed snapshots from messages actually sent; external Pi/provider context is not recoverable from repository templates alone.
- Regenerate the prompt/API/storage references and source fingerprints with `npm run docs:generate`; then run `npm run docs:check` and `git diff --check`. Read the generated diff and update the explanatory chapters as well. Do not treat regeneration or a successful check as semantic approval.
- The implementation PR must link changed code areas to the changed architecture chapters, report the checks performed, and identify implemented limitations or unresolved discrepancies. If a change has no architecture effect, state the reason. At stage closeout, verify the final merged code revision, generated references, narrative, Issue acceptance and linked verification evidence together.
- Keep historical experiment reports in Git history. Register new formal runs and link reviewed conclusions in their originating Issue/PR; retain raw evidence only in ignored local directories. Explain current rationale and tradeoffs alongside the relevant architecture. Active designs explain a reviewed change; Architecture explains what actually runs. An accepted design is not evidence of implementation or successful research.

## Engineering record conventions

GitHub Issues and PRs in [LuNa-shi/murm](https://github.com/LuNa-shi/murm) own execution briefs, scope, dependencies, progress and evidence. Read the relevant Issue's body, comments, labels, linked tickets and accepted Agent Brief before implementing. Explicit user instructions take precedence over older plans. Record a reviewed design's exact revision when the Issue relies on it, and keep a requirement change with its implementation PR. Use structured tool arguments or `gh --body-file` for multiline text.

A readiness label records triage state; it does not independently authorize a new research question, spending, merging or publication. The repository uses these labels when they are needed:

| State | Label |
| --- | --- |
| Maintainer evaluation required | `needs-triage` |
| More information needed | `needs-info` |
| Scope sufficiently clear for implementation | `ready-for-agent` |
| Human decision or intervention required | `ready-for-human` |
| Work will not be pursued | `wontfix` |

Use [GLOSSARY.md](GLOSSARY.md), the [architecture manual](docs/architecture/INDEX.md) and the [SDK guides](docs/INDEX.md) for domain language. Mission, Task, Execution, Material and Workspace belong to TaskPool; other Harnesses do not need them. The English and Chinese guides are also the website source. Keep API examples aligned with public exports and runnable examples. The [development workflow](docs/workflows/development.md) contains the build and validation commands.
