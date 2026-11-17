# SwarmEnv — Coding Agent Instructions

These instructions apply to **Coding Agents developing SwarmEnv**, not research Agents running inside it. They define the human/Agent decision boundary and the project-specific rules for using the installed **Matt Pocock engineering skills**.

## One source for requirements: GitHub Issues

- **The human-approved GitHub Issue is the sole authority for work requirements:** why the change matters, desired behavior, research hypotheses, constraints, observable outcomes, and acceptance criteria. Read the full Issue, its linked tickets, comments, and explicit human decisions. An accepted Agent Brief is part of the Issue's discussion, not a separate specification.
- An Issue can cover several PRs or be split into dependent GitHub tickets using `/to-tickets`. Keep approvals, progress and the ticket graph on GitHub. Numbered [phase designs](docs/phases/INDEX.md) are version-controlled design attachments to a linked Issue, reviewed in PRs. The Issue incorporates an explicitly approved document revision; editing a document does not independently change approved scope, acceptance or budget. Do not create a second approval or status ledger.
- [Architecture](docs/architecture/INDEX.md) documents the previously accepted system baseline; [ADRs](docs/adr/INDEX.md) explain why past decisions were made. They are references, **not independent approval to change the current Issue's scope**. When they conflict with an approved Issue, surface the discrepancy and obtain clarification rather than editing requirements to match code.
- Current code and schemas describe what executes. Tests and experiments establish what is verified. Keep implementation progress, validation evidence and unresolved gaps in the relevant GitHub Issue/PR, with formal run evidence in experiment reports. Start from [docs/INDEX.md](docs/INDEX.md), [GLOSSARY.md](GLOSSARY.md), then relevant source/tests; do not load every document by default.

## Human decisions and delegated autonomy

The human owner decides which research questions are valuable, their priority, what an Issue must deliver, and how success will be judged. Agents may propose new hypotheses with evidence but **must not select and execute a new research direction** without approval.

Within an approved Issue, an Agent may select implementation details and autonomously iterate **implement → review → test/probe → diagnose → fix → retest**. Use isolated branches/worktrees, not `main`. Create every new linked worktree under the primary repository checkout's `.worktree/<task-or-branch>/` directory (on this machine, `/home/ubuntu/SwarmEnv/.worktree/`). Do not create worktrees beside the primary checkout or nest them under another linked worktree. Keep `/.worktree/` ignored; existing active worktrees must not be relocated while a run or process still depends on their paths. Repeated deterministic checks and bounded diagnostic probes need no per-run human report or new approval when their environment, provider/model, budget, and time limits are already authorized.

Return to the Issue for human review before changing intended behavior, acceptance criteria, architecture scope, research hypotheses, benchmark/checker/fixture, provider/model, or resource budget. Paid/external experiments require explicit authorization or a previously approved allowance. Technical difficulty does not confer permission to widen the Issue.

## Default engineering workflow — Matt skills

Follow the **installed skills** when applicable; do not claim a skill ran if it is unavailable. These skills govern the engineering *procedure*, not product requirements or research approval.

- **`/to-spec`**: turn an agreed discussion into a **GitHub spec Issue**, using the project glossary and accepted ADRs. For a substantial stage, link its complete phase design and distinguish confirmed direction from proposals awaiting review. The Issue owns approval of the specification and its document revision.
- **`/to-tickets`** (optional): propose complete vertical slices with blocking edges; obtain human agreement before publishing GitHub sub-Issues and dependencies. One Issue with multiple implementation PRs is also valid.
- **`/implement`**: implement one Issue or ticket, use **`/tdd`** at pre-agreed public seams, run relevant checks, and finish with **`/code-review`**.
- **`/implement-spec`**: implement an approved Issue/ticket graph on an integration branch with per-ticket branches/worktrees and fresh contexts where supported. Track dependencies on GitHub, not in local Markdown.
- **`/diagnosing-bugs`**: reproduce, minimize, instrument, fix, and regression-test difficult failures.
- **`/code-review`**: evaluate **Spec** (against the approved Issue/Agent Brief) and **Standards** (repository conventions and code quality) separately.
- **`/pr`**: present a concise Summary, before/after Evidence, and Merge Danger (reversibility and blast radius).

An explicit request to invoke a skill permits its normal in-scope operations; it does **not** authorize unapproved spending, new research goals, unrelated Issue changes, or merging PRs.

## Verification, evidence, and closeout

- Pin the implementation commit; validate affected Agent/Bridge/Service/Runtime paths, authorization, idempotency, fencing, checker integrity, privacy, and cleanup as relevant. Run focused tests and, for code changes when available, `npm test` and `git diff --check`. Report skipped checks honestly.
- Formal research runs follow [the experiment workflow](docs/workflows/experiment.md) and [experiment-analysis skill](.codex/skills/experiment-analysis/SKILL.md). Ordinary in-scope tests and diagnostic probes do not require an EXP ID or individual report.
- At meaningful milestones, link commits, tests/probes, PR review findings, real-run evidence, and remaining gaps **to the GitHub Issue/PR**; the Issue/PR remains the record of progress. Do not require human review after every debugging iteration.
- Update affected [Architecture](docs/architecture/INDEX.md) in the implementation PR, ready for review with the code. Reconcile the complete affected flow at Issue/stage closeout; documentation is part of completion. Never describe an unverified proposal as accepted or a passing tool call as scientific progress.
- Use plain **Results / Analysis / Next steps** in formal research reporting. Keep observations distinct from interpretations and unapproved recommendations.
- Keep raw Agent conversations, proof/candidate source, credentials, stdout/stderr, private state databases, and personal paths out of committed reports. Store raw experiment evidence only in ignored local `experiments/`.
- Keep proposed stage designs in numbered `docs/phases/` entries, linked to their Issue and review PR. Label target behavior separately from the implemented Architecture. Do not create `STATUS.md`, `archive/`, historical redirect files, or `CONTEXT.md`; Git history preserves obsolete tracked documentation.
- Do not merge PRs, close unrelated Issues, or run unapproved paid experiments without the user's authorization.

## Architecture documentation is a required deliverable

The owner reads `docs/architecture/` to understand the implementation **without reading source code**. It must be a complete implementation manual, not only module summaries or pointers to source. Code references support verification; they must not replace the explanation.

- For every runtime-affecting change, explain the entry point, call/event order, inputs and defaults, guards, state/storage writes, outputs, failure/retry/timeout behavior, cleanup, and observable evidence. Cover compatibility paths still executable in the reviewed tree and distinguish them from approved pending changes.
- Maintain the explicit file-to-chapter inventory in [source-map.json](docs/architecture/source-map.json). New or removed runtime, CLI, service, configuration, storage, UI or build files require a deliberate inventory update. A file mapping is a coverage aid, not proof that every behavior has been explained.
- Maintain full repository-controlled prompt text, composition conditions, dynamic field provenance and actual send paths in [Prompts](docs/architecture/08-prompts.md). Include discovery, ordinary turns, tool instructions, feedback, lifecycle rejection, notification, recovery, compaction/rotation and legacy paths. Distinguish composed snapshots from messages actually sent; external Pi/provider context is not recoverable from repository templates alone.
- Regenerate the prompt/API/storage references and source fingerprints with `npm run docs:generate`; then run `npm run docs:check` and `git diff --check`. Read the generated diff and update the explanatory chapters as well. Do not treat regeneration or a successful check as semantic approval.
- The implementation PR must link changed code areas to the changed architecture chapters, report the checks performed, and identify implemented limitations or unresolved discrepancies. If a change has no architecture effect, state the reason. At stage closeout, verify the final merged code revision, generated references, narrative, Issue acceptance and linked verification evidence together.
- Keep `docs/experiments/` for version-bound experimental evidence. Keep ADRs only for durable rationale and tradeoffs worth retaining; no ADR is required for every Issue or stage. Phase designs explain the reviewed target and migration; Architecture explains what actually runs. An accepted design is not evidence of implementation or successful research.

## Agent skills configuration

### Issue tracker
GitHub Issues and sub-Issues own specs, approved briefs, comments, and dependencies. See [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

### Triage labels
See [docs/agents/triage-labels.md](docs/agents/triage-labels.md).

### Domain docs
Single-context repository: root [GLOSSARY.md](GLOSSARY.md), [docs/adr/](docs/adr/INDEX.md), and [docs/agents/domain.md](docs/agents/domain.md).
