# SwarmEnv — Coding Agent Instructions

These instructions apply to **Coding Agents developing SwarmEnv**, not research Agents running inside it. They define the human/Agent decision boundary and the project-specific rules for using the installed **Matt Pocock engineering skills**.

## One source for requirements: GitHub Issues

- **The human-approved GitHub Issue is the sole authority for work requirements:** why the change matters, desired behavior, research hypotheses, constraints, observable outcomes, and acceptance criteria. Read the full Issue, its linked tickets, comments, and explicit human decisions. An accepted Agent Brief is part of the Issue's discussion, not a separate specification.
- An Issue can cover several PRs or be split into dependent GitHub tickets using `/to-tickets`. Keep the approved decisions and ticket graph on GitHub. **Do not create local Phase Charters, Implementation Specs, or a second requirement source.**
- [Architecture](docs/architecture/INDEX.md) documents the previously accepted system baseline; [ADRs](docs/adr/INDEX.md) explain why past decisions were made. They are references, **not independent approval to change the current Issue's scope**. When they conflict with an approved Issue, surface the discrepancy and obtain clarification rather than editing requirements to match code.
- Current code and schemas describe what executes. Tests and experiments establish what is verified. [STATUS](docs/STATUS.md) records implementation and evidence gaps, without defining new requirements. Start from [docs/INDEX.md](docs/INDEX.md), [GLOSSARY.md](GLOSSARY.md), then relevant source/tests; do not load every document by default.

## Human decisions and delegated autonomy

The human owner decides which research questions are valuable, their priority, what an Issue must deliver, and how success will be judged. Agents may propose new hypotheses with evidence but **must not select and execute a new research direction** without approval.

Within an approved Issue, an Agent may select implementation details and autonomously iterate **implement → review → test/probe → diagnose → fix → retest**. Use isolated branches/worktrees, not `main`. Repeated deterministic checks and bounded diagnostic probes need no per-run human report or new approval when their environment, provider/model, budget, and time limits are already authorized.

Return to the Issue for human review before changing intended behavior, acceptance criteria, architecture scope, research hypotheses, benchmark/checker/fixture, provider/model, or resource budget. Paid/external experiments require explicit authorization or a previously approved allowance. Technical difficulty does not confer permission to widen the Issue.

## Default engineering workflow — Matt skills

Follow the **installed skills** when applicable; do not claim a skill ran if it is unavailable. These skills govern the engineering *procedure*, not product requirements or research approval.

- **`/to-spec`**: turn an agreed discussion into a **GitHub spec Issue**, using the project glossary and accepted ADRs. The Issue is the specification.
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
- At meaningful milestones, link commits, tests/probes, PR review findings, real-run evidence, and remaining gaps **to the GitHub Issue/PR**; summarize them in [STATUS](docs/STATUS.md). Do not require human review after every debugging iteration.
- When a design-changing PR is accepted for merge, synchronize the affected [Architecture](docs/architecture/INDEX.md); reconcile at Issue closeout. Never describe an unverified proposal as accepted or a passing tool call as scientific progress.
- Use plain **Results / Analysis / Next steps** in formal research reporting. Keep observations distinct from interpretations and unapproved recommendations.
- Keep raw Agent conversations, proof/candidate source, credentials, stdout/stderr, private state databases, and personal paths out of committed reports. Store raw experiment evidence only in ignored local `experiments/`.
- Do not create `docs/phases/`, `archive/`, historical redirect files, or `CONTEXT.md`. Git history preserves obsolete tracked documentation.
- Do not merge PRs, close unrelated Issues, or run unapproved paid experiments without the user's authorization.

## Agent skills configuration

### Issue tracker
GitHub Issues and sub-Issues own specs, approved briefs, comments, and dependencies. See [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

### Triage labels
See [docs/agents/triage-labels.md](docs/agents/triage-labels.md).

### Domain docs
Single-context repository: root [GLOSSARY.md](GLOSSARY.md), [docs/adr/](docs/adr/INDEX.md), and [docs/agents/domain.md](docs/agents/domain.md).
