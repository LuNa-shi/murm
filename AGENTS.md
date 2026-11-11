# SwarmEnv — Coding Agent Instructions

These instructions are for **Coding Agents developing SwarmEnv**, not Agents running inside SwarmEnv. They define what an Agent may do independently and when a human decision is required.

## Authority and entry points

- **The human-approved GitHub Issue is the primary work contract:** why the problem matters, what behavior must change, expected observations, constraints, and acceptance criteria. Creating or drafting an Issue alone does not imply approval; look for an explicit human decision in the Issue or the current instruction.
- [docs/architecture/](docs/architecture/INDEX.md) records the accepted system baseline. An approved Issue may specify a change to that baseline **only within its stated scope**. Otherwise preserve it. If documents conflict, report the discrepancy rather than silently choosing the existing code.
- [docs/phases/](docs/phases/INDEX.md) holds optional **Issue-numbered implementation specs** prepared by Coding Agents, not separate plans requiring human approval. Such specs explain how to implement an approved Issue, and must never redefine its goal or acceptance criteria.
- Source code and tool schemas show what currently executes. [docs/STATUS.md](docs/STATUS.md) tracks implementation progress and verification evidence. Tests and experiments establish which behaviors have actually been observed.
- Use [docs/INDEX.md](docs/INDEX.md) to find relevant references and [GLOSSARY.md](GLOSSARY.md) for domain vocabulary. Read the affected sources and tests; do not load every document by default.

## Autonomy within an approved Issue

1. Inspect the implementation, propose technical approaches, write or revise the Issue's implementation spec when useful, and implement changes in an isolated branch/worktree. Never work directly on `main`.
2. Independently repeat **implement → review against the approved contract → test/probe → diagnose → fix → retest**. Add regression tests and inspect all affected boundaries. No approval or standalone report is required after each debugging iteration.
3. Run deterministic checks and bounded diagnostics within authorized tool, provider/model, time and cost limits. Paid probes require explicit permission or a previously approved allowance.
4. Record significant implementation milestones, clean commits, relevant failures, test evidence and unresolved gaps in the PR and [STATUS.md](docs/STATUS.md), without turning STATUS into a turn-by-turn diary.
5. Suggest alternative research hypotheses or architecture directions with evidence. Do not independently approve or execute a new research question.

## Human decisions

Humans decide **why an Issue is worth pursuing, what should be implemented, which outcomes matter, and what success means**. They also select and prioritize new research hypotheses.

Escalate before changing an Issue's objective, expected behavior, acceptance conditions, architecture scope, benchmark/checker/fixture, provider/model, or resource budget. A formal research experiment needs the authorization described in [the experiment workflow](docs/workflows/experiment.md); an approved set of runs may be executed without per-run permission.

The Agent may revise implementation details and fix approved-contract defects autonomously. An implementation spec is not permission to enlarge the Issue. Important new design decisions require human review, with an [ADR](docs/adr/INDEX.md) when they should endure beyond this Issue.

## Evidence and closeout

- Pin the starting commit and link each material requirement to source changes, tests, probes and any real-run evidence. Distinguish implementation, deterministic verification, controlled probes, natural runs and unknowns.
- Run relevant tests and, for code changes when available, `npm test` and `git diff --check`. Never claim that an unrun check passed. Review both the **Spec** (behavior/counterexamples) and **Standards** (quality, privacy, regression and security).
- At milestones or completion, report the current result on the GitHub Issue/PR and maintain [STATUS.md](docs/STATUS.md). Do not require human review after every test.
- When a design-changing PR is accepted for merge, synchronize the affected [architecture](docs/architecture/INDEX.md) documentation. At Issue closeout, verify that the accepted design, implementation evidence, STATUS and Issue links agree. Do not write unverified proposals into Architecture as established behavior.
- Summarize research evidence as **Results**, **Analysis**, and **Next steps**; separate Agent suggestions from human decisions. More Tasks, Materials, Judge calls or Core activity do not by themselves establish useful progress.

Detailed instructions: [development workflow](docs/workflows/development.md), [experiment workflow](docs/workflows/experiment.md), and [experiment-analysis skill](.codex/skills/experiment-analysis/SKILL.md). Implementation unit tests and in-scope debugging probes need no formal Experiment ID.

## Safety and repository boundaries

- Preserve original problem/checker semantics, execution identities, private per-Execution Workspaces and source/version provenance.
- Keep raw Agent conversations, proof/candidate code, secrets, stdout/stderr, private databases and personal paths out of committed reports. Raw experiment evidence belongs in ignored local `experiments/`.
- Do not recreate `archive/` directories, obsolete redirects or a second `CONTEXT.md`. Recover historical documents from pinned Git history.
- Do not merge a PR, change Issue status or launch an unapproved paid run without explicit authorization. When blocked, report the attempted work, available evidence and required human decision.
