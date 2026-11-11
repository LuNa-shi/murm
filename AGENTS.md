# SwarmEnv — Coding Agent Instructions

These instructions apply to **Coding Agents developing SwarmEnv**, not to research Agents running inside it. The purpose is to define how humans and Coding Agents work together, particularly which decisions are delegated and which require human approval.

## Authority and context

- **Human-reviewed design and approved phase documents define the intended behavior and work scope.** Current source code and tool schemas show the implementation; tests and experiments show what has been verified. Treat differences as gaps to investigate, not as permission to redefine the design to match existing code.
- Read [docs/INDEX.md](docs/INDEX.md) for the relevant [architecture](docs/architecture/INDEX.md), [phase](docs/phases/INDEX.md), and workflows. Read the affected source and tests. Do not load the entire documentation set by default.
- [GLOSSARY.md](GLOSSARY.md) defines domain vocabulary. ADRs explain accepted decisions; historic code and experiments do not override current human-reviewed specifications. If two active requirements conflict, surface the conflict rather than silently choosing one.
- Do not introduce new project-wide concepts, research directions, API semantics, or report conventions as settled requirements without human review.

## What you may do autonomously

Within an approved task or phase, you may:

1. Inspect code, identify implementation gaps, plan fixes, and edit code and tests in an isolated worktree/branch.
2. Review your implementation against the approved design, add regression tests, run them, investigate failures, fix issues, and repeat until the behavior is sufficiently supported by evidence. **Do not request approval or send a separate report after every test or debug iteration.**
3. Run local deterministic checks and **bounded diagnostic probes** within the previously approved environment, provider/model, time and cost limits. Paid or external-resource probes require explicit authorization or a pre-approved allowance; an open-ended research run is not implied.
4. Adjust implementation details that do not alter the approved contract. Record code versions, important failed checks, final test evidence, and unresolved gaps.
5. Suggest new research hypotheses and designs with supporting evidence, without assuming that a suggestion authorizes implementation or experiments.

The implementation loop is **implement → review against the approved design → test/probe → diagnose → fix → retest**. Continue autonomously while work remains within scope. Summarize meaningful results at completion, major milestones, or when a decision is required.

## What requires human approval

Humans decide the **value, importance, and priority of research hypotheses**, which questions a phase should answer, and the research direction. Do not select a new hypothesis and begin testing it on your own.

Seek an explicit decision before changing an approved hypothesis, architecture or task scope, acceptance criteria, benchmark/fixture/checker, provider/model, or resource budget; before launching an unapproved paid or large-scale experiment; or before merging PRs or changing Issue status. An approved phase may delegate a capped set of runs and repeated tests without requiring approval for each execution.

When an implementation failure reveals a contract bug, fix it autonomously if the correction stays within the approved design. If the evidence suggests the design itself is insufficient, document the failure and propose options for human review instead of quietly broadening the work.

## Development and evidence

- Pin the starting commit and describe the intended observable behavior and counterexamples. Implement complete, testable changes on a separate worktree or branch; do not work directly on `main`.
- Inspect the affected call chain where relevant: Agent prompt/capability, Bridge/SDK, domain services, Runtime/runner, tests and reports. Protect authorization, idempotency, execution fencing, and cleanup.
- Run relevant tests; for code changes when available, run `npm test` and `git diff --check`. Never claim a check passed if it was not run.
- Assess correctness against the approved design **and** engineering quality, security, and regression coverage. A passing test is not sufficient evidence if it tests the wrong contract.
- Link the implementation commit, observed results and reproducible tests to each requirement. Distinguish code inspection, deterministic tests, controlled probes and real-Agent experiments; label unverified behavior explicitly.
- Deliver a concise summary of changes, evidence, failures, open questions, and any decisions requested from the human owner.

Follow [the development workflow](docs/workflows/development.md). For formally approved research experiments, follow [the experiment workflow](docs/workflows/experiment.md) and use [experiment-analysis](.codex/skills/experiment-analysis/SKILL.md) to reconstruct evidence. **Unit tests and in-scope debugging probes do not require a formal Experiment ID or individual human reports.**

For research reports, **state what happened, what the evidence supports, and what remains uncertain**. Make proposed next steps clear, but never represent an Agent recommendation as a human-approved decision. Counts of Tasks, Materials, checks, or busy Cores do not by themselves prove useful collaboration.

## Repository and data boundaries

- Preserve original problem/checker semantics, execution identities, private per-Execution Workspaces, source version provenance, and credentials.
- Keep raw Agent conversations, proof/candidate code, stdout/stderr, secret values, private databases and personal paths out of committed reports. Local raw experiments belong in ignored `experiments/`.
- Keep current documentation indexed at [docs/INDEX.md](docs/INDEX.md). Do not recreate `archive/` directories or historical redirects; use pinned Git history for obsolete documentation. Update affected inbound references when moving files.
- Never rewrite historical experiment facts to make a new design appear verified. Documentation-only changes cannot establish new runtime acceptance.

If progress is blocked, report exactly what was tried, which facts are known and which human decision is needed.
